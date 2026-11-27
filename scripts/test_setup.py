"""setup.sh with no server: its real functions run in bash with the system tools (systemctl, ss, apt-get,
tailscale, curl, runuser ...) replaced by stubs that log what would have happened.
Run: python3 -I -m unittest discover -s scripts -p 'test_*.py'
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETUP_SH = os.path.join(ROOT, "setup.sh")
UNITS = os.path.join(ROOT, "deploy", "units")


def read(path):
    with open(path) as f:
        return f.read()


def setup_sh_parts():
    """setup.sh's top-level constants and functions, without its root checks or the call to main."""
    src = read(SETUP_SH)
    skip = {"SVC_USER", "SVC_HOME", "APP_DIR", "ROTATE_PW", "TS_HOST", "TS_IP", "CONFIG_DIR"}
    consts = [l for l in src.splitlines() if re.match(r"^[A-Z_]+=", l) and l.split("=", 1)[0] not in skip]
    funcs = [m.group(0) for m in re.finditer(r"(?ms)^(\w+)\(\) \{\n.*?^\}\n", src)]
    return "\n".join(consts) + "\n" + "\n".join(funcs)


def main_steps():
    main = re.search(r"(?ms)^main\(\) \{\n.*?^\}\n", read(SETUP_SH)).group(0)
    return main, re.findall(r"(?m)^  (\w+)$", main)


PKG_CADDYFILE = ":80 {\n\troot * /usr/share/caddy\n\tfile_server\n}\n"
SS_LINE = 'LISTEN 0 4096 *:{port} *:* users:(("{name}",pid={pid},fd=7))'


class Harness(unittest.TestCase):
    """A fake machine: a home dir, /etc paths in a temp dir, a fake /proc for cgroups, stubbed tools."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="setuptest."))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, "home")
        self.config = os.path.join(self.home, ".config", "home-server-dashboard")
        self.etc = os.path.join(self.tmp, "etc")
        self.proc = os.path.join(self.tmp, "proc")
        for d in (self.home, os.path.join(self.etc, "caddy"), os.path.join(self.etc, "systemd"), self.proc):
            os.makedirs(d)
        self.caddyfile = os.path.join(self.etc, "caddy", "Caddyfile")
        self.log = os.path.join(self.tmp, "calls.log")
        open(self.log, "w").close()
        self.listeners = []       # (port, name, pid, unit)
        self.tailscale = None     # None = not installed; else dict(status=json, serve=json)
        self.groups = {"docker"}
        self.tty = True
        self.curl = {}            # "host url" -> code ("000" = unreachable)
        self.stock_ttyd = "not-found"
        self.answer = "n"

    def listen(self, port, name, unit, pid=None):
        pid = pid or 1000 + len(self.listeners)
        self.listeners.append((port, name, pid, unit))
        os.makedirs(os.path.join(self.proc, str(pid)), exist_ok=True)
        with open(os.path.join(self.proc, str(pid), "cgroup"), "w") as f:
            f.write(f"0::/system.slice/{unit}\n")

    def bash(self, body, stdin=None):
        ss_cases = "\n".join(
            f'    *":{p} "*) echo \'{SS_LINE.format(port=p, name=n, pid=pid)}\' ;;' for p, n, pid, _ in self.listeners)
        ts = self.tailscale
        ts_fn = 'tailscale() { echo "tailscale $*" >> "$LOG"; return 127; }\n' \
                'command() { if [ "$1 $2" = "-v tailscale" ]; then return 1; fi; builtin command "$@"; }'
        if ts is not None:
            ts_fn = textwrap.dedent(f"""\
                tailscale() {{
                  echo "tailscale $*" >> "$LOG"
                  case "$*" in
                    "status --json") printf '%s' {ts['status']!r} ;;
                    "serve status --json") printf '%s' {ts['serve']!r} ;;
                    status) echo "100.64.0.10 demo-server demo@ linux -" ;;
                    *) return 0 ;;
                  esac
                }}""")
        curl_cases = "\n".join(f'    "{k}") code={v} ;;' for k, v in self.curl.items())
        script = textwrap.dedent(f"""\
            set -euo pipefail
            SVC_USER="$(id -un)"; SVC_HOME={self.home!r}; APP_DIR={ROOT!r}; ROTATE_PW=0
            CONFIG_DIR={self.config!r}; TS_HOST=""; TS_IP=""
            LOG={self.log!r}
            """) + setup_sh_parts() + textwrap.dedent(f"""
            CADDYFILE={self.caddyfile!r}; UNIT_DIR={os.path.join(self.etc, "systemd")!r}; PROC_ROOT={self.proc!r}
            ETC_DIR={os.path.join(self.etc, "home-server-dashboard")!r}; GLANCES_HOME={os.path.join(self.tmp, "opt", "glances")!r}
            useradd() {{ echo "useradd $*" >> "$LOG"; }}
            ROUTE_WAIT_S=0
            runuser() {{ shift 3; "$@"; }}
            as_user() {{ "$@"; }}
            usermod() {{ echo "usermod $*" >> "$LOG"; }}
            getent() {{ if [ "$1 ${{2-}}" = "passwd hsd-glances" ]; then [ -e "$LOG.glances-user" ]; return; fi; if [ "$1" = group ]; then case " {' '.join(sorted(self.groups))} " in *" $2 "*) echo "$2:x:999:" ;; *) return 2 ;; esac; else builtin command getent "$@"; fi; }}
            id() {{ if [ "${{1-}}" = -nG ]; then echo "$SVC_USER"; else builtin command id "$@"; fi; }}
            systemctl() {{
              echo "systemctl $*" >> "$LOG"
              case "$1" in
                is-active) [ "${{2-}}" = --quiet ] && [ "${{3-}}" = ttyd.service ] && {{ [ {self.stock_ttyd!r} = active ]; return; }}; return 0 ;;
                show) echo {self.stock_ttyd!r} ;;
              esac
            }}
            ss() {{
              case "$* " in
            {ss_cases}
                *) : ;;
              esac
            }}
            apt-get() {{ echo "apt-get $*" >> "$LOG"; }}
            dpkg-query() {{ printf ' /etc/caddy/Caddyfile %s\\n' "$(printf '%b' {PKG_CADDYFILE!r} | md5sum | cut -d' ' -f1)"; }}
            caddy() {{ echo "caddy $1" >> "$LOG"; }}
            install() {{ echo "install $*" >> "$LOG"; if [ "$1" = -d ]; then mkdir -p "${{@: -1}}"; else cp "${{@: -2:1}}" "${{@: -1}}"; fi; }}
            pipx() {{ echo "pipx $*" >> "$LOG"; }}
            hostname() {{ if [ "${{1-}}" = -I ]; then echo "172.17.0.1 192.0.2.10"; else echo demo-server; fi; }}
            ip() {{ echo "1.1.1.1 via 192.0.2.1 dev eth0 src 192.0.2.10 uid 1000"; }}
            sleep() {{ :; }}
            timeout() {{ shift; "$@"; }}
            has_tty() {{ {'true' if self.tty else 'false'}; }}
            ufw() {{ echo "Status: active"; }}
            curl() {{
              local host="" url="" code=200 a
              for a in "$@"; do :; done
              while [ $# -gt 0 ]; do case "$1" in -H) host="${{2#Host: }}"; shift 2 ;; --resolve) host="${{2%%:*}}"; shift 2 ;; -o|-w|--max-time) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
              echo "curl $host $url" >> "$LOG"
              case "$host $url" in
            {curl_cases}
                "evil.example "*) code=403 ;;
              esac
              printf '%s' "$code"
            }}
            {ts_fn}
            """) + body
        script = script.replace("/usr/bin/python3", sys.executable)
        return subprocess.run(["bash", "-c", script], capture_output=True, text=True, input=stdin, timeout=60)

    def calls(self):
        return [l.rstrip("\n") for l in open(self.log)]

    def changes(self):
        """Calls that would change the machine."""
        return [c for c in self.calls()
                if c.startswith(("apt-get", "install", "usermod", "pipx", "systemctl enable", "systemctl restart",
                                 "systemctl mask", "systemctl disable", "systemctl daemon-reload"))
                or (c.startswith("tailscale serve") and "status" not in c)]


class PreflightTest(Harness):
    """Every stop rule stops before anything changes; our own services from an earlier run pass."""

    def stops(self, needle):
        r = self.bash("preflight")
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertIn(needle, r.stderr)
        self.assertEqual(self.changes(), [])
        return r

    def test_fresh_machine_passes(self):
        r = self.bash("preflight")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.changes(), [])

    def test_port_80_held_by_another_program(self):
        self.listen(80, "nginx", "nginx.service")
        r = self.stops("nginx")
        self.assertIn("port 80", r.stderr)
        self.assertIn("reboot", r.stderr)

    def test_port_80_held_by_a_caddy_not_started_by_systemd_caddy(self):
        self.listen(80, "caddy", "docker-abc.scope")
        self.stops("port 80")

    def test_a_caddyfile_someone_else_wrote(self):
        with open(self.caddyfile, "w") as f:
            f.write("example.com {\n\treverse_proxy 127.0.0.1:3000\n}\n")
        self.stops("Caddyfile")

    def test_the_package_caddyfile_and_ours_are_fine(self):
        for text in (PKG_CADDYFILE, "# Installed by home-server-dashboard setup.sh\n:80 {}\n"):
            with open(self.caddyfile, "w") as f:
                f.write(text)
            r = self.bash("preflight")
            self.assertEqual(r.returncode, 0, r.stderr)

    def test_backend_ports_held_by_other_programs(self):
        for port, name in ((7681, "ttyd"), (7682, "node"), (61208, "python3")):
            self.listeners = []
            open(self.log, "w").close()
            self.listen(port, name, "something-else.service")
            r = self.stops(str(port))
            self.assertIn(name, r.stderr)

    def test_stock_ttyd_running(self):
        self.stock_ttyd = "active"
        self.stops("ttyd.service")

    def test_rerun_with_our_own_services_passes(self):
        with open(self.caddyfile, "w") as f:
            f.write("# Installed by home-server-dashboard setup.sh\n")
        os.makedirs(self.config)
        with open(os.path.join(self.config, "term.pass"), "w") as f:
            f.write("hash\n")
        open(os.path.join(self.etc, "systemd", "ttyd-dash.service"), "w").close()
        self.listen(80, "caddy", "caddy.service")
        self.listen(7681, "ttyd", "ttyd-dash.service")
        self.listen(7682, "python3", "dash-events.service")
        self.listen(61208, "glances", "glances-web.service")
        self.tty = False   # a hash exists, so no prompt is needed
        r = self.bash("preflight")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.changes(), [])

    def test_no_terminal_and_no_password_yet(self):
        self.tty = False
        self.stops("interactively")

    def test_not_via_sudo(self):
        r = self.bash('SUDO_USER="" require_sudo_user')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("sudo", r.stderr)
        r = self.bash('SUDO_USER=root require_sudo_user')
        self.assertNotEqual(r.returncode, 0)

    def test_repo_owned_by_someone_else(self):
        r = self.bash('SVC_USER=nobody-else check_app_dir')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("owned by", r.stderr)
        r = self.bash("check_app_dir")
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_paths_with_odd_characters_are_refused(self):
        r = self.bash("SVC_HOME='/home/a b' check_app_dir")
        self.assertNotEqual(r.returncode, 0)


class UserFilesTest(Harness):
    def test_created_once_from_the_templates_and_never_overwritten(self):
        r = self.bash("setup_user_files")
        self.assertEqual(r.returncode, 0, r.stderr)
        for name in ("quicklaunch", "ignore", "mutes"):
            self.assertEqual(read(os.path.join(self.config, name)), read(os.path.join(ROOT, "config", name + ".example")))
        with open(os.path.join(self.config, "ignore"), "w") as f:
            f.write("my-container\n")
        r = self.bash("setup_user_files")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(read(os.path.join(self.config, "ignore")), "my-container\n")

    def test_templates_are_examples_only(self):
        for name in ("quicklaunch", "ignore"):
            live = [l for l in read(os.path.join(ROOT, "config", name + ".example")).splitlines()
                    if l.strip() and not l.lstrip().startswith("#")]
            self.assertEqual(live, [], name)
        ql = read(os.path.join(ROOT, "config", "quicklaunch.example"))
        for key in ("container =", "port =", "desc ="):
            self.assertIn(key, ql)


class DockerTest(Harness):
    def test_no_docker_means_no_group_change_and_no_docker_group_in_units(self):
        self.groups = set()
        r = self.bash('setup_docker_access; render_unit glances-web.service; cat "$UNIT_DIR/glances-web.service"')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse([c for c in self.calls() if c.startswith("usermod")])
        self.assertNotIn("SupplementaryGroups=docker", r.stdout)
        self.assertIn("Docker not found", r.stdout)

    def test_docker_present_gives_only_glances_the_group_never_the_account(self):
        r = self.bash('setup_docker_access; render_unit glances-web.service; cat "$UNIT_DIR/glances-web.service"')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse([c for c in self.calls() if c.startswith("usermod")])   # docker group = root for the web terminal
        self.assertIn("SupplementaryGroups=docker", r.stdout)
        self.assertNotIn("usermod", read(SETUP_SH))


class UnitsTest(Harness):
    def test_rendered_units_have_no_placeholders(self):
        for unit in ("glances-web.service", "dash-events.service", "ttyd-dash.service"):
            r = self.bash(f'render_unit {unit}; cat "$UNIT_DIR/{unit}"')
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertNotIn("@", r.stdout.replace("@.service", ""), unit)
            if unit != "glances-web.service":
                self.assertIn(ROOT, r.stdout)

    def test_dash_events_unit_gets_the_tailnet_name_only_when_there_is_one(self):
        r = self.bash('render_unit dash-events.service; cat "$UNIT_DIR/dash-events.service"')
        self.assertNotIn("--allowed-host", r.stdout)
        self.assertIn("--config-dir " + self.config, r.stdout)
        r = self.bash('TS_HOST=demo-server.example-tailnet.ts.net; render_unit dash-events.service; cat "$UNIT_DIR/dash-events.service"')
        self.assertIn("--allowed-host demo-server.example-tailnet.ts.net", r.stdout)

    def test_templates_keep_the_security_posture(self):
        ttyd = read(os.path.join(UNITS, "ttyd-dash.service"))
        self.assertIn("-m 4 -i lo -p 7681", ttyd)
        self.assertIn(" -O -- /usr/bin/python3 -I @APP_DIR@/term/term_login.py", ttyd)
        de = read(os.path.join(UNITS, "dash-events.service"))
        self.assertIn("--host 127.0.0.1 --port 7682", de)
        for opt in ("NoNewPrivileges=true", "ProtectSystem=strict", "ProtectHome=read-only"):
            self.assertIn(opt, de)
        gl = read(os.path.join(UNITS, "glances-web.service"))
        self.assertIn("--bind 127.0.0.1 --port 61208", gl)
        # Glances may get the docker group, so nothing it runs or reads may be writable by the login account
        self.assertIn("User=hsd-glances", gl)
        self.assertIn("ExecStart=@GLANCES_HOME@/bin/glances ", gl)
        self.assertIn("-C @ETC_DIR@/glances.conf", gl)
        self.assertNotIn("@USER@", gl)
        self.assertNotIn("@HOME@", gl)
        self.assertNotIn("@APP_DIR@", gl)
        self.assertIn("@DOCKER_GROUP@", gl)
        self.assertNotIn("SupplementaryGroups=docker", gl)


class CaddyTest(Harness):
    def test_caddyfile_routes_and_safety(self):
        cf = read(os.path.join(ROOT, "deploy", "Caddyfile"))
        self.assertTrue(cf.startswith("# Installed by home-server-dashboard setup.sh\n"))
        self.assertIn("# example.com {", cf)
        self.assertIn("#\treverse_proxy 127.0.0.1:7682", cf)
        for want in ("auto_https off", "admin off", "http://:80", "@term path /term/ws /term/token",
                     "forward_auth 127.0.0.1:7682", "uri /_host_ok",
                     "reverse_proxy 127.0.0.1:7681", '@nohost expression {host} == ""'):
            self.assertIn(want, cf)
        site = cf[cf.index("http://:80"):]
        self.assertLess(site.index("handle @nohost"), site.index("handle @term"))
        term = site[site.index("handle @term"):]
        self.assertLess(term.index("forward_auth"), term.index("reverse_proxy 127.0.0.1:7681"))
        self.assertNotIn("header_up Host", cf)

    def test_installs_validated_config_and_keeps_the_package_original(self):
        with open(self.caddyfile, "w") as f:
            f.write(PKG_CADDYFILE)
        r = self.bash("setup_caddy")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(read(self.caddyfile), read(os.path.join(ROOT, "deploy", "Caddyfile")))
        self.assertEqual(read(self.caddyfile + ".orig"), PKG_CADDYFILE)
        calls = self.calls()
        self.assertLess(calls.index("caddy validate"), [i for i, c in enumerate(calls) if c.startswith("install")][0])
        self.assertIn("systemctl restart caddy.service", calls)
        open(self.log, "w").close()
        r = self.bash("setup_caddy")
        self.assertEqual([c for c in self.calls() if "restart" in c or c.startswith("install")], [])


class TailscaleTest(Harness):
    STATUS = '{"BackendState":"Running","Self":{"DNSName":"demo-server.example-tailnet.ts.net.","TailscaleIPs":["100.64.0.10","fd7a:115c:a1e0::a"]}}'

    def test_absent_means_no_prompt_and_no_tailnet_name(self):
        r = self.bash('detect_tailscale; offer_serve; echo "TS=[$TS_HOST]"')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("TS=[]", r.stdout)
        self.assertNotIn("[y/N]", r.stdout)

    def test_logged_out_or_broken_never_stops(self):
        self.tailscale = {"status": "not json", "serve": "{}"}
        r = self.bash('detect_tailscale; offer_serve; echo "TS=[$TS_HOST]"')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("TS=[]", r.stdout)

    def test_detected_and_serve_empty_asks_and_no_is_the_default(self):
        self.tailscale = {"status": self.STATUS, "serve": "{}"}
        r = self.bash("detect_tailscale; offer_serve", stdin="\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("https://demo-server.example-tailnet.ts.net/", r.stdout)
        self.assertIn("[y/N]", r.stdout)
        self.assertEqual([c for c in self.calls() if c.startswith("tailscale serve --")], [])

    def test_yes_mounts_the_dashboard_and_the_two_terminal_paths(self):
        self.tailscale = {"status": self.STATUS, "serve": "{}"}
        r = self.bash("detect_tailscale; offer_serve", stdin="y\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        mounts = [c for c in self.calls() if c.startswith("tailscale serve --")]
        self.assertEqual(mounts, [
            "tailscale serve --bg --https=443 --set-path / http://127.0.0.1:7682",
            "tailscale serve --bg --https=443 --set-path /term/token http://127.0.0.1:7681/term/token",
            "tailscale serve --bg --https=443 --set-path /term/ws http://127.0.0.1:7681/term/ws"])

    def test_existing_serve_config_is_left_alone(self):
        self.tailscale = {"status": self.STATUS,
                          "serve": '{"Web":{"demo-server.example-tailnet.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}'}
        r = self.bash("detect_tailscale; offer_serve")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("[y/N]", r.stdout)
        self.assertIn("already", r.stdout)
        self.assertIn("http://demo-server.example-tailnet.ts.net/", r.stdout)
        self.assertEqual([c for c in self.calls() if c.startswith("tailscale serve") and "status" not in c], [])

    OURS = '{"Web":{"demo-server.example-tailnet.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7682"}}}}}'
    OFF = ["tailscale serve --https=443 --set-path / off",
           "tailscale serve --https=443 --set-path /term/token off",
           "tailscale serve --https=443 --set-path /term/ws off"]

    def test_our_mounts_under_funnel_are_removed_never_left_public(self):
        self.tailscale = {"status": self.STATUS, "serve": self.OURS[:-1] + ',"AllowFunnel":{"demo-server.example-tailnet.ts.net:443":true}}'}
        r = self.bash('detect_tailscale; offer_serve; echo "SERVE=$SERVE_ON"')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual([c for c in self.calls() if c.endswith(" off")], self.OFF)
        self.assertIn("SERVE=0", r.stdout)
        self.assertIn("Funnel", r.stdout)

    def test_our_mounts_without_funnel_are_kept(self):
        self.tailscale = {"status": self.STATUS, "serve": self.OURS}
        r = self.bash('detect_tailscale; offer_serve; echo "SERVE=$SERVE_ON"')
        self.assertEqual([c for c in self.calls() if c.endswith(" off")], [])
        self.assertIn("SERVE=1", r.stdout)

    def test_tailnet_route_failure_prints_a_diagnostic_and_setup_still_succeeds(self):
        self.tailscale = {"status": self.STATUS, "serve": "{}"}
        self.curl = {"demo-server.example-tailnet.ts.net http://demo-server.example-tailnet.ts.net/": "000"}
        r = self.bash("detect_tailscale; verify_routes; echo DONE")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        out = r.stdout + r.stderr
        self.assertIn("DONE", out)
        for want in ("100.64.0.10", "demo-server.example-tailnet.ts.net", "tailscale status", "000", "ufw"):
            self.assertIn(want, out)

    def test_tailnet_route_ok_prints_the_http_address(self):
        self.tailscale = {"status": self.STATUS, "serve": "{}"}
        r = self.bash("detect_tailscale; verify_routes")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("http://demo-server.example-tailnet.ts.net/", r.stdout)


class RoutesTest(Harness):
    def test_local_names_must_answer(self):
        r = self.bash("verify_routes")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        hosts = {c.split()[1] for c in self.calls() if c.startswith("curl ")}
        self.assertTrue({"demo-server", "192.0.2.10", "evil.example"} <= hosts, hosts)
        self.assertNotIn("172.17.0.1", hosts)
        self.assertIn("http://192.0.2.10/", r.stdout)

    def test_a_refused_local_name_stops(self):
        self.curl = {"demo-server http://127.0.0.1/": "403"}
        r = self.bash("verify_routes")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("demo-server", r.stderr)

    def test_an_unknown_host_getting_through_stops(self):
        self.curl = {"evil.example http://127.0.0.1/": "200"}
        r = self.bash("verify_routes")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("evil.example", r.stderr)


class TerminalPasswordTest(Harness):
    def test_hash_present_means_no_prompt(self):
        os.makedirs(self.config)
        with open(os.path.join(self.config, "term.pass"), "w") as f:
            f.write("existing\n")
        r = self.bash("setup_terminal_password; setup_ttyd", stdin="")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn("Choose a terminal password", r.stdout + r.stderr)
        self.assertEqual(read(os.path.join(self.config, "term.pass")), "existing\n")
        self.assertIn("unchanged", r.stdout)

    def test_password_with_edge_spaces_round_trips_and_xtrace_hides_it(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("term_login", os.path.join(ROOT, "term", "term_login.py"))
        tl = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tl)
        pw = "  spaced pass phrase  "
        hashfile = os.path.join(self.config, "term.pass")
        r = self.bash(f"set -x\nwrite_terminal_hash {hashfile!r}", stdin=f"{pw}\n{pw}\n")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn("spaced pass", r.stderr)
        self.assertTrue(tl.verify_password(pw, tl.load_hash(hashfile)))
        self.assertFalse(tl.verify_password(pw.strip(), tl.load_hash(hashfile)))

    def test_asked_before_anything_is_installed_and_setup_ttyd_never_asks(self):
        body = re.search(r"(?ms)^setup_ttyd\(\) \{\n.*?^\}\n", read(SETUP_SH)).group(0)
        self.assertNotIn("write_terminal_hash", body)
        r = self.bash("setup_terminal_password", stdin="a long enough pw\na long enough pw\n")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(os.path.getsize(os.path.join(self.config, "term.pass")) > 0)

    def test_setup_ttyd_starts_a_stopped_terminal_but_never_restarts_a_running_one(self):
        r = self.bash("setup_ttyd")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("systemctl start ttyd-dash.service", self.calls())   # fresh install: running before the route check
        self.assertNotIn("systemctl restart ttyd-dash.service", self.calls())

    def test_installers_never_read_the_terminal(self):
        src = read(SETUP_SH)
        for line in src.splitlines():
            if re.search(r"\b(apt-get install|pipx install)\b", line):
                self.assertIn("</dev/null", line, line)

    def test_term_login_reads_the_same_file_setup_writes(self):
        src = read(os.path.join(ROOT, "term", "term_login.py"))
        self.assertIn('"~/.config/home-server-dashboard/term.pass"', src)
        self.assertIn('CONFIG_DIR="$SVC_HOME/.config/home-server-dashboard"', read(SETUP_SH))

    def test_stock_ttyd_is_masked_before_the_package_is_installed(self):
        r = self.bash('TTYD_BIN=/bin/echo\ncommand() { if [ "$1 $2" = "-v ttyd" ]; then return 1; fi; builtin command "$@"; }\ninstall_packages')
        self.assertEqual(r.returncode, 0, r.stderr)
        calls = self.calls()
        apt = [i for i, c in enumerate(calls) if c.startswith("apt-get install")]
        self.assertTrue(apt, calls)
        self.assertLess(calls.index("systemctl mask ttyd.service"), apt[0])


class MainTest(Harness):
    def test_order(self):
        main, steps = main_steps()
        want = ["require_sudo_user", "check_app_dir", "preflight", "check_scrypt", "setup_terminal_password", "install_packages", "setup_user_files",
                "setup_docker_access", "setup_glances", "detect_tailscale", "setup_dash_events", "setup_ttyd",
                "setup_caddy", "offer_serve", "verify_routes", "print_summary", "restart_ttyd"]
        self.assertEqual([s for s in steps if s in want], want)
        self.assertLess(main.index("verify_routes"), main.index('echo "SETUP COMPLETE"'))
        self.assertEqual(steps[-1], "restart_ttyd")

    def test_restart_is_the_last_action_and_follows_complete(self):
        main, steps = main_steps()
        stubs = "\n".join(f'{n}() {{ echo "{n}" >> "$LOG"; }}' for n in steps if n != "restart_ttyd")
        r = self.bash(stubs + "\n" + main + "\nmain\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.calls()[-1], "systemctl restart ttyd-dash.service")
        self.assertLess(r.stdout.index("SETUP COMPLETE"), r.stdout.index("Restarting"))

    def test_nothing_private_or_owner_specific(self):
        src = read(SETUP_SH)
        for gone in ("deploy key", "sudoers", "gateway.ini", "port=81", "git clone", "ssh-keygen", "Funnel is enabled on this node. Disable"):
            self.assertNotIn(gone.lower(), src.lower(), gone)

    def test_password_never_in_argv(self):
        body = re.search(r"(?ms)^write_terminal_hash\(\) \{\n.*?^\}\n", read(SETUP_SH)).group(0)
        self.assertIn("printf '%s\\n' \"$pw\" | as_user /usr/bin/python3 -I", body)
        self.assertNotRegex(body, r"(?m)^\s*(export|declare -x)\b")
        self.assertIn("unset pw pw2", body)

    def test_scrypt_checked_with_the_system_python(self):
        self.assertRegex(read(SETUP_SH), r"/usr/bin/python3 -I -c 'import hashlib; hashlib\.scrypt")

    def test_glances_pinned_with_gpu_support(self):
        self.assertIn('"glances[web,containers,gpu]==$GLANCES_VERSION"', read(SETUP_SH))
        self.assertIn('GLANCES_VERSION="4.5.8"', read(SETUP_SH))

    def test_glances_conf_is_generic(self):
        conf = read(os.path.join(ROOT, "deploy", "glances.conf"))
        self.assertNotIn("allow=", conf)
        self.assertIn("hide=/boot.*,/snap.*,/etc,/usr,/tmp,/var/tmp,/run.*,/dev.*", conf)
        self.assertIn("hide=lo,docker.*,br-.*,veth.*", conf)


if __name__ == "__main__":
    unittest.main()


class ReadmeTest(unittest.TestCase):
    def test_readme_warns_first_and_documents_the_user_files(self):
        readme = read(os.path.join(ROOT, "README.md"))
        first_screen = readme[:readme.index("## Install")]
        for must in ("port 80", "unencrypted"):
            self.assertIn(must, first_screen)
        for want in ("~/.config/home-server-dashboard/quicklaunch", "~/.config/home-server-dashboard/ignore",
                     "~/.config/home-server-dashboard/mutes", "git pull && sudo ./setup.sh",
                     "--rotate-terminal-password", "Caddyfile.orig", "PolyForm Noncommercial", "warranty"):
            self.assertIn(want, readme)

    def test_licence_and_version(self):
        lic = read(os.path.join(ROOT, "LICENSE"))
        self.assertTrue(lic.startswith("Required Notice: Copyright Nikhil Jangid (https://github.com/Nikhil-Jangid/home-server-dashboard)\n"))
        self.assertIn("# PolyForm Noncommercial License 1.0.0", lic)
        self.assertRegex(read(os.path.join(ROOT, "VERSION")), r"\A\d+\.\d+\.\d+\n?\Z")


class GlancesIsolationTest(Harness):
    def test_runs_as_its_own_system_user_from_root_owned_files(self):
        r = self.bash("setup_glances")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        calls = self.calls()
        self.assertTrue(any(c.startswith("useradd --system") and c.endswith(" hsd-glances") for c in calls), calls)
        pipx = [c for c in calls if c.startswith("pipx install")]
        self.assertEqual(len(pipx), 1, calls)
        self.assertFalse(any(c.startswith("as_user") for c in calls))
        conf = os.path.join(self.etc, "home-server-dashboard", "glances.conf")
        self.assertEqual(read(conf), read(os.path.join(ROOT, "deploy", "glances.conf")))
        unit = read(os.path.join(self.etc, "systemd", "glances-web.service"))
        self.assertIn(os.path.join(self.tmp, "opt", "glances") + "/bin/glances", unit)
        self.assertIn("-C " + conf, unit)

    def test_pipx_install_goes_to_the_shared_root_owned_home(self):
        src = read(SETUP_SH)
        self.assertRegex(src, r'PIPX_HOME="\$GLANCES_HOME" PIPX_BIN_DIR="\$GLANCES_HOME/bin" pipx install')
        self.assertNotRegex(src, r"as_user pipx")


class CaddyReachTest(unittest.TestCase):
    def test_only_private_and_tailnet_addresses_reach_the_dashboard(self):
        cf = read(os.path.join(ROOT, "deploy", "Caddyfile"))
        site = cf[cf.index("http://:80"):]
        m = re.search(r"@outside not remote_ip ([^\n]+)", site)
        self.assertIsNotNone(m)
        ranges = set(m.group(1).split())
        self.assertEqual(ranges, {"127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16",
                                  "100.64.0.0/10", "::1/128", "fc00::/7", "fe80::/10"})
        self.assertLess(site.index("handle @outside"), site.index("handle @term"))
        self.assertIn("respond 403", site[site.index("handle @outside"):site.index("handle @nohost")])


class RerunAndZipTest(Harness):
    STATUS = TailscaleTest.STATUS

    def test_a_no_to_tailscale_https_is_remembered(self):
        self.tailscale = {"status": self.STATUS, "serve": "{}"}
        os.makedirs(self.config)   # setup_user_files made it earlier in a real run
        r = self.bash("detect_tailscale; offer_serve", stdin="n\n")
        self.assertIn("[y/N]", r.stdout)
        r = self.bash("detect_tailscale; offer_serve", stdin="")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("[y/N]", r.stdout)
        self.assertIn("tailscale-https", r.stdout)            # says which file to delete to be asked again

    def test_summary_update_line_matches_how_it_was_installed(self):
        r = self.bash("print_summary")
        self.assertIn("git pull && sudo ./setup.sh", r.stdout)     # ROOT is a git clone
        r = self.bash("APP_DIR=" + repr(self.tmp) + "; print_summary")
        self.assertNotIn("git pull", r.stdout)
        self.assertIn("ZIP", r.stdout)

    def test_hostname_with_a_domain(self):
        r = self.bash('hostname() { if [ "${1-}" = -I ]; then echo 192.0.2.10; else echo nas.lan; fi; }\nverify_routes')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        hosts = {c.split()[1] for c in self.calls() if c.startswith("curl ")}
        self.assertTrue({"nas.lan", "nas.local"} <= hosts, hosts)
        self.assertNotIn("nas.lan.local", hosts)
