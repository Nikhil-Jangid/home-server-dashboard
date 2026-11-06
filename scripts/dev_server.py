#!/usr/bin/env python3
"""Local dev server that mirrors production routing.

    ssh -N -L 7682:127.0.0.1:7682 -L 7681:127.0.0.1:7681 demo-server.local &
    python3 -I scripts/dev_server.py          # then open http://127.0.0.1:8080

Like Tailscale Serve + dash-events in production:
  /api/4/all, /api/units, /events/* -> the tunnelled dash-events on 127.0.0.1:7682
  /term/token, /term/ws     -> the tunnelled ttyd on 127.0.0.1:7681 (WebSocket upgrade relayed)
  everything else           -> local www/, served by dash-events' own static handler, so the
                               headers, path containment, MIME allow-list and Host check match prod.
No other path is proxied.
"""
import http.client
import importlib.util
import socket
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WWW = ROOT / "www"
PORT = 8080
EVENTS_PORT = 7682
TERM_PORT = 7681

# Request headers passed upstream (the rest, Host included, are dropped or set by http.client).
FORWARD_HEADERS = ("Accept", "Sec-Fetch-Site", "Last-Event-ID", "Authorization", "Origin", "Cache-Control")
# Response headers not copied back: hop-by-hop, length (we close to delimit), and the ones our
# own end_headers() always adds.
DROP_RESPONSE = {"transfer-encoding", "connection", "content-length", "keep-alive",
                 "x-frame-options", "referrer-policy", "server", "date"}


def _load_dash_events():
    spec = importlib.util.spec_from_file_location("dash_events", ROOT / "dash-events" / "dash_events.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


de = _load_dash_events()


def make_dev_handler(www=WWW, events_port=EVENTS_PORT, term_port=TERM_PORT):
    base = de.make_handler(de.Grouper(), de.Hub(), www=str(www))

    def route(path):
        if path in ("/api/4/all", "/api/units") or path.startswith("/events/"):
            return events_port
        if path in ("/term/token", "/term/ws"):
            return term_port
        return None

    class DevHandler(base):
        def do_GET(self):
            port = route(self.path.split("?", 1)[0])
            if port is None:
                return super().do_GET()  # static www, exactly as production
            if self.headers.get("Upgrade", "").lower() == "websocket":
                return self._tunnel(port)
            return self._proxy(port)

        def _proxy(self, port):
            headers = {k: self.headers[k] for k in FORWARD_HEADERS if self.headers.get(k) is not None}
            try:
                up = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
                up.request("GET", self.path, headers=headers)
                r = up.getresponse()
            except (OSError, http.client.HTTPException) as e:
                self.send_error(502, f"upstream :{port} unreachable ({type(e).__name__})")
                return
            self.send_response(r.status)
            for k, v in r.getheaders():
                if k.lower() not in DROP_RESPONSE:
                    self.send_header(k, v)
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            try:
                while chunk := r.read1(65536):
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (OSError, http.client.HTTPException):
                pass
            finally:
                up.close()

        def _tunnel(self, port):
            """Relay a WebSocket upgrade byte-for-byte. Host and Origin are kept as the browser sent
            them, so ttyd's -O origin check sees the same pair it would in production."""
            try:
                up = socket.create_connection(("127.0.0.1", port), timeout=10)
            except OSError as e:
                self.send_error(502, f"upstream :{port} unreachable ({type(e).__name__})")
                return
            head = self.requestline + "\r\n" + "".join(f"{k}: {v}\r\n" for k, v in self.headers.items()) + "\r\n"
            self.close_connection = True
            try:
                up.sendall(head.encode("latin-1"))
                up.settimeout(None)
                self.connection.settimeout(None)

                def upstream_to_client():
                    try:
                        while data := up.recv(65536):
                            self.connection.sendall(data)
                    except OSError:
                        pass
                    finally:
                        try:
                            self.connection.shutdown(socket.SHUT_WR)
                        except OSError:
                            pass

                back = threading.Thread(target=upstream_to_client, daemon=True)
                back.start()
                try:
                    while data := self.rfile.read1(65536):  # read1 also drains anything already buffered
                        up.sendall(data)
                except OSError:
                    pass
                try:
                    up.shutdown(socket.SHUT_WR)
                except OSError:
                    pass
                back.join()
            finally:
                up.close()

    return DevHandler


if __name__ == "__main__":
    srv = de.DashServer(("127.0.0.1", PORT), make_dev_handler())
    srv.daemon_threads = True
    print(f"http://127.0.0.1:{PORT}")
    srv.serve_forever()
