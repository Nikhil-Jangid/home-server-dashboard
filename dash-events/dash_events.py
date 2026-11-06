#!/usr/bin/env python3
"""dash-events: follows the systemd journal and serves grouped events over SSE.

Read-only by design: it never reads request bodies or query strings and never runs
a command derived from a request.
"""
from __future__ import annotations

import argparse
import collections
import fcntl
import ipaddress
import http.client
import json
import os
import platform
import pwd
import queue
import re
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CATEGORY_RULES = [
    ("memory", re.compile(r"out of memory|oom-kill|oom_reaper|invoked oom-killer", re.I)),
    ("disk_io", re.compile(
        r"I/O error|blk_update_request|Buffer I/O|\bata\d+(\.\d+)?:.*(error|link down|hard resetting|failed command)"
        r"|\bsmartd\b|\bSMART (usage|prefailure|error)|medium error|nvme\d*.*(timeout|reset)", re.I)),
    ("filesystem", re.compile(
        r"\bEXT4-fs\b|\bXFS\b|\bbtrfs\b|Remounting .*read-only|Read-only file system|mount.*fail"
        r"|failed to mount|unionfs|fsck", re.I)),
    ("hardware", re.compile(
        r"thermal|temperature (above|over)|Hardware Error|\bmce:|EDAC|over-?current|clock throttled", re.I)),
    ("network", re.compile(
        r"link is down|NETDEV WATCHDOG|carrier (lost|off)|dhcp.*(fail|timeout)|tailscaled.*(error|fail)"
        r"|DNS (server|resolution).*(fail|timeout|unreachable)|no route to host|network is unreachable", re.I)),
    ("service", re.compile(r"Failed to start|Main process exited|entered failed state|Failed with result|core-?dump|segfault", re.I)),
]

# One left-to-right pass, first alternative wins at each position. Block-device and partition
# names are kept verbatim so that sdb1 and sdb2 (or nvme0n1p1 and nvme0n1p2) stay separate groups;
# UUIDs, 0x-hex, bare hex runs of 8+ chars and remaining digit runs collapse to "#".
_NORMALIZE_RX = re.compile(r"""
    \b(?P<dev>sd[a-z]+\d*|nvme\d+n\d+(?:p\d+)?|md\d+|dm-\d+|loop\d+|mmcblk\d+(?:p\d+)?)\b
  | \b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b
  | 0x[0-9a-f]+
  | \b[0-9a-f]{8,}\b
  | \d+
""", re.I | re.X)


def categorize(source: str, message: str) -> str:
    text = f"{source} {message}"
    for name, rx in CATEGORY_RULES:
        if rx.search(text):
            return name
    return "other"


def normalize(message: str) -> str:
    return _NORMALIZE_RX.sub(lambda m: m.group("dev") or "#", message.strip())[:300]


AUTH_FACILITIES = {"4", "10"}          # syslog auth, authpriv
AUTH_SOURCES = {"sudo", "su", "pkexec"}
_COMMAND_RX = re.compile(r"COMMAND=.*", re.S)   # re.S: a multi-line command must not leak past "\n"


def parse_journal_line(line: str) -> dict | None:
    try:
        e = json.loads(line)
    except ValueError:
        return None
    if not isinstance(e, dict):
        return None
    msg = e.get("MESSAGE")
    if isinstance(msg, list):  # journald emits non-UTF-8 messages as byte arrays
        msg = bytes(b & 0xFF for b in msg if isinstance(b, int)).decode("utf-8", "replace")
    if not isinstance(msg, str) or not msg.strip():
        return None
    try:
        priority = int(e.get("PRIORITY", 6))
    except (TypeError, ValueError):
        priority = 6
    if priority > 5:
        return None
    try:
        uid = int(e["_UID"])
    except (KeyError, TypeError, ValueError):
        uid = None
    transport = e.get("_TRANSPORT")
    transport = transport if isinstance(transport, str) else None
    source = str(e.get("SYSLOG_IDENTIFIER") or e.get("_SYSTEMD_UNIT") or e.get("_COMM") or "unknown")[:80]
    if transport == "kernel":
        source = "kernel"
    elif source == "kernel":
        # Anyone can log with an identifier of "kernel"; keep it from impersonating the kernel.
        source = "kernel?"
    unit = e.get("_SYSTEMD_UNIT")
    unit = unit[:80] if isinstance(unit, str) and unit else None
    if str(e.get("SYSLOG_FACILITY")) in AUTH_FACILITIES or source in AUTH_SOURCES:
        # sudo/su log full command lines, which can carry secrets; the Errors feed is readable by
        # every tailnet peer. Keep who/as-whom, hide the command (same reason as the Glances filter).
        msg = _COMMAND_RX.sub("COMMAND=<hidden>", msg)
        if msg.lstrip().startswith("(command continued)"):
            msg = "(command continued) <hidden>"   # sudo splits long commands into extra entries
    try:
        ts = int(e["__REALTIME_TIMESTAMP"]) // 1000
    except (KeyError, TypeError, ValueError):
        ts = int(time.time() * 1000)
    return {"source": source, "message": msg.strip()[:2000], "priority": priority,
            "ts": ts, "cursor": e.get("__CURSOR"), "uid": uid, "transport": transport,
            "unit": unit}


def entry_is_trusted(e: dict) -> bool:
    """Only kernel-transport entries are exempt from the per-source rate limit."""
    return e.get("transport") == "kernel"


# Per-uid cap on NEW groups per minute, on top of the per-source limit. Without it one uid could
# rotate SYSLOG_IDENTIFIER (each identifier is a fresh "source") to dodge the per-source limit and
# flush real groups out of the buffer. Bumping an existing group never counts against either cap.
UID_NEW_GROUPS_PER_MIN = 30


def uid_budget_key(e: dict) -> object:
    """Key of the per-uid new-group budget. uid 0 is shared by every root daemon and container, so
    it is split by the journald-supplied systemd unit (no unit: one shared bucket); other uids keep one budget each."""
    uid = e.get("uid")
    if uid == 0:
        return (0, e.get("unit"))  # never the writer-controlled source/identifier
    return uid


class Grouper:
    """Folds repeated messages into groups; bounded in size, per-source rate and per-uid rate.

    When the buffer is full the oldest untrusted group is evicted first; trusted (kernel-transport
    and dash-events' own) groups are evicted only when nothing else is left.
    """

    def __init__(self, window_s: int = 600, max_entries: int = 1000, rate_limit: int = 20,
                 uid_rate_limit: int = UID_NEW_GROUPS_PER_MIN):
        self.window_ms = window_s * 1000
        self.max_entries = max_entries
        self.rate_limit = rate_limit
        self.uid_rate_limit = uid_rate_limit
        self._groups: collections.OrderedDict[str, dict] = collections.OrderedDict()
        self._index: dict[tuple, str] = {}
        self._key_of: dict[str, tuple] = {}
        self._trusted_ids: set[str] = set()
        self._new_by_source: dict[object, collections.deque] = {}
        self._new_by_uid: dict[object, collections.deque] = {}
        self._epoch = int(time.time())  # makes ids unique across restarts
        self._seq = 0
        self._lock = threading.Lock()

    def add(self, source: str, message: str, priority: int, ts: int, category: str | None = None,
            trusted: bool = False, rate_key: object = None, uid_key: object = None) -> dict:
        """uid_key: the writer's uid; None disables the per-uid cap (used by tests and trusted callers)."""
        with self._lock:
            key = (source, normalize(message))
            existing = self._live_group(key, ts)
            if existing:
                return self._bump(existing, message, priority, ts)
            if trusted:
                return self._create(key, source, message, priority, ts, category or categorize(source, message),
                                    trusted=True)
            rk = source if rate_key is None else rate_key
            if self._at_limit(self._new_by_source, rk, ts, self.rate_limit):
                key = (source, "\0suppressed")
                message = f"further messages from {source} suppressed (more than {self.rate_limit} distinct per minute)"
                category = "other"
                existing = self._live_group(key, ts)
                if existing:
                    return self._bump(existing, message, priority, ts)
                rk = None  # the suppressed group itself does not count against the source
            if uid_key is not None and self._at_limit(self._new_by_uid, uid_key, ts, self.uid_rate_limit):
                who = f"uid {uid_key[0]} ({uid_key[1]})" if isinstance(uid_key, tuple) else f"uid {uid_key}"
                ukey = (who, "\0suppressed")
                umsg = (f"further messages from {who} suppressed "
                        f"(more than {self.uid_rate_limit} new groups per minute)")
                existing = self._live_group(ukey, ts)
                if existing:
                    return self._bump(existing, umsg, priority, ts)
                return self._create(ukey, who, umsg, priority, ts, "other")
            if rk is not None:
                self._note(self._new_by_source, rk, ts)
            if uid_key is not None:
                self._note(self._new_by_uid, uid_key, ts)
            return self._create(key, source, message, priority, ts, category or categorize(source, message))

    @staticmethod
    def _at_limit(table: dict, k: object, ts: int, limit: int) -> bool:
        recent = table.get(k)
        if recent is None:
            return False
        while recent and ts - recent[0] > 60_000:
            recent.popleft()
        if not recent:
            del table[k]
            return False
        return len(recent) >= limit

    def _note(self, table: dict, k: object, ts: int) -> None:
        table.setdefault(k, collections.deque()).append(ts)
        while len(table) > self.max_entries:
            del table[next(iter(table))]

    def recent(self, n: int = 500) -> list[dict]:
        with self._lock:
            rows = sorted(self._groups.values(), key=lambda g: g["last_ts"], reverse=True)
            return [dict(g) for g in rows[:n]]

    def _live_group(self, key: tuple, ts: int) -> dict | None:
        gid = self._index.get(key)
        g = self._groups.get(gid) if gid else None
        if g and ts - g["last_ts"] <= self.window_ms:
            return g
        return None

    def _bump(self, g: dict, message: str, priority: int, ts: int) -> dict:
        g["count"] += 1
        g["last_ts"] = max(g["last_ts"], ts)
        g["message"] = message
        g["priority"] = min(g["priority"], priority)
        self._groups.move_to_end(g["id"])
        return dict(g)

    def _create(self, key: tuple, source: str, message: str, priority: int, ts: int, category: str,
                trusted: bool = False) -> dict:
        self._seq += 1
        gid = f"{self._epoch}-{self._seq}"
        g = {"id": gid, "source": source, "message": message, "category": category,
             "priority": priority, "first_ts": ts, "last_ts": ts, "count": 1}
        self._groups[gid] = g
        self._index[key] = gid
        self._key_of[gid] = key
        if trusted:
            self._trusted_ids.add(gid)
        while len(self._groups) > self.max_entries:
            self._evict_one()
        return dict(g)

    def _evict_one(self) -> None:
        """Oldest untrusted group first; trusted groups go only when nothing else is left."""
        old_id = next((gid for gid in self._groups if gid not in self._trusted_ids), None)
        if old_id is None:
            old_id = next(iter(self._groups))
        del self._groups[old_id]
        self._trusted_ids.discard(old_id)
        old_key = self._key_of.pop(old_id)
        if self._index.get(old_key) == old_id:
            del self._index[old_key]


def _unescape_mount(path: str) -> str:
    raw = path.encode("utf-8", "surrogateescape")
    decoded = re.sub(rb"\\([0-7]{3})", lambda m: bytes([int(m.group(1), 8) & 0xFF]), raw)
    return decoded.decode("utf-8", "replace")


def check_mounts(expected: list[str], mounts_text: str) -> list[tuple[str, str]]:
    mounted: dict[str, list[str]] = {}
    for line in mounts_text.splitlines():
        parts = line.split()
        if len(parts) >= 4:
            mounted[_unescape_mount(parts[1])] = parts[3].split(",")
    problems = []
    for mnt in expected:
        if mnt not in mounted:
            problems.append((f"mount-missing:{mnt}", f"{mnt} is not mounted"))
        elif "ro" in mounted[mnt]:
            problems.append((f"mount-ro:{mnt}", f"{mnt} is mounted read-only"))
    return problems


def parse_failed_units(json_text: str) -> list[str]:
    try:
        data = json.loads(json_text or "[]")
    except ValueError:
        return []
    if not isinstance(data, list):
        return []
    return [u["unit"] for u in data if isinstance(u, dict) and u.get("unit")]


HOST_MOUNTS = "/proc/1/mounts"  # host namespace: our own view is all-ro under ProtectSystem=strict


GLANCES_URL = "http://127.0.0.1:61208/api/4/all"


MAX_STR = 512
MAX_UPSTREAM = 4 * 1024 * 1024


def _scalar(v):
    """str/int/float only (no bool, None, dict, list); long strings are truncated."""
    if isinstance(v, str):
        return v[:MAX_STR]
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v
    return None


def _pick(d, keys):
    if not isinstance(d, dict):
        return {}
    out = {}
    for k in keys:
        v = _scalar(d.get(k))
        if v is not None:
            out[k] = v
    return out


def _image(v):
    if isinstance(v, str):
        return v[:MAX_STR]
    if isinstance(v, list):
        return [x[:MAX_STR] for x in v if isinstance(x, str)] or None
    return None


# Well-known ports that never serve a web page: an auto tile prefers any other published port.
NON_WEB_PORTS = frozenset({21, 22, 23, 25, 53, 110, 143, 389, 445, 465, 587, 993, 995, 1433, 1883, 3306, 5432,
                           6379, 8883, 11211, 27017})


def _host_ports(v):
    """TCP host ports from a Glances container `ports` string, e.g. "0.0.0.0:8097->8096/tcp, 53->53/udp"."""
    if not isinstance(v, str):
        return None
    found = []
    for item in v.split(","):
        left, arrow, right = item.partition("->")
        if not arrow or right.partition("/")[2].strip().lower() not in ("", "tcp"):
            continue
        first = left.strip().rsplit(":", 1)[-1].split("-", 1)[0]
        if first.isascii() and first.isdigit() and 1 <= int(first) <= 65535 and int(first) not in found:
            found.append(int(first))
    found.sort(key=lambda p: (p in NON_WEB_PORTS, p))   # the Open button takes the first one
    return found[:8] or None


def _items(lst, fn):
    return [fn(x) for x in lst if isinstance(x, dict)] if isinstance(lst, list) else []


def filter_glances(d) -> dict:
    """Allow-list of the Glances fields the dashboard renders.

    Everything else (container command lines, ports, process lists, ...) is dropped,
    because those can carry credentials and the browser never needs them.
    """
    if not isinstance(d, dict):
        return {}
    out = {}
    for key, fields in (("cpu", ["total"]), ("mem", ["total", "used", "available"]),
                        ("memswap", ["total", "percent"]), ("load", ["min1", "min5", "min15"]),
                        ("processcount", ["total", "running"])):
        if isinstance(d.get(key), dict):
            out[key] = _pick(d[key], fields)
    if isinstance(d.get("uptime"), str):
        out["uptime"] = d["uptime"][:MAX_STR]
    if "fs" in d:
        out["fs"] = _items(d["fs"], lambda f: _pick(f, ["mnt_point", "device_name", "fs_type", "size", "used", "free", "percent"]))
    if "network" in d:
        out["network"] = _items(d["network"], lambda n: _pick(
            n, ["interface_name", "bytes_recv_rate_per_sec", "bytes_sent_rate_per_sec"]))
    if "sensors" in d:
        out["sensors"] = _items(d["sensors"], lambda s: _pick(s, ["label", "value", "unit"]))
    if "gpu" in d:
        out["gpu"] = _items(d["gpu"], lambda g: _pick(g, ["name", "proc", "mem", "temperature"]))
    if "containers" in d:
        def container(c):
            row = _pick(c, ["name", "status", "uptime"])
            cid = c.get("id")
            if isinstance(cid, str) and re.fullmatch(r"[0-9a-fA-F]{4,}", cid[:64]):
                row["id"] = cid[:64].lower()   # for ID matching in the user's ignore and quicklaunch files
            image = _image(c.get("image"))
            if image is not None:
                row["image"] = image
            ports = _host_ports(c.get("ports"))
            if ports is not None:
                row["ports"] = ports
            if isinstance(c.get("cpu"), dict):
                row["cpu"] = _pick(c["cpu"], ["total"])
            if isinstance(c.get("memory"), dict):
                row["memory"] = _pick(c["memory"], ["usage"])
            return row
        out["containers"] = _items(d["containers"], container)
    return out


# ── user settings (the owner's own files; never shipped, created from config/*.example) ─────────

QL_KEYS = ("container", "port", "desc")
MAX_TILES, MAX_IGNORE, MAX_IGNORE_LEN, MAX_MUTES = 64, 256, 128, 64


def _sections(text: str, *, inline_comments: bool) -> tuple[list[tuple[str, dict]], list[str]]:
    """A forgiving INI reader for hand-edited files: [section] then key = value lines.

    A bad line never costs the user the rest of the file: every good section is kept and each bad line is
    named by its line number. A repeated section is named and only the first one is used. '%' is literal.
    With inline_comments, ' # ...' or ' ; ...' ends a value (quicklaunch); mute patterns keep them (regex).
    """
    sections, problems, seen = [], [], set()
    cur, skipping = None, False
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line[0] in "#;":
            continue
        if line.startswith("[") and line.endswith("]"):
            name = line[1:-1].strip()
            if not name:
                problems.append(f"line {n}: a section needs a name, like [My tile]")
                cur, skipping = None, True
            elif name in seen:
                problems.append(f"line {n}: [{name[:60]}] appears twice; only the first one is used")
                cur, skipping = None, True
            else:
                seen.add(name)
                cur, skipping = {}, False
                sections.append((name, cur))
            continue
        if skipping:
            continue
        if cur is None:
            problems.append(f"line {n}: {line[:60]!r} is outside any [section]")
            continue
        key, sep, value = line.partition("=")
        if not sep:
            key, sep, value = line.partition(":")
        if not sep or not key.strip():
            problems.append(f"line {n}: {line[:60]!r} is not 'key = value'")
            continue
        if inline_comments:
            value = re.split(r"\s[#;]", value, maxsplit=1)[0]
        cur.setdefault(key.strip().lower(), value.strip())
    return sections, problems


def parse_quicklaunch(text: str) -> tuple[list[dict], list[str]]:
    """INI sections -> tiles {name, container, port, desc}; bad entries are skipped and named in problems."""
    sections, line_problems = _sections(text, inline_comments=True)
    tiles, problems = [], ["quicklaunch: " + p for p in line_problems]
    for name, sec in sections:
        unknown = [k for k in sec if k not in QL_KEYS]
        if unknown:
            problems.append(f"quicklaunch: [{name}] unknown key {', '.join(unknown)} (use container, port, desc)")
        container = sec.get("container", "").strip() or None
        port_raw = sec.get("port", "").strip()
        port = None
        if port_raw:
            if not (port_raw.isdigit() and 1 <= int(port_raw) <= 65535):
                problems.append(f"quicklaunch: [{name}] port must be a number from 1 to 65535, got {port_raw[:20]!r}")
                continue
            port = int(port_raw)
        if container is None and port is None:
            problems.append(f"quicklaunch: [{name}] needs a container or a port")
            continue
        if len(tiles) == MAX_TILES:
            problems.append(f"quicklaunch: more than {MAX_TILES} tiles; the rest are ignored")
            break
        tiles.append({"name": name[:80], "container": container[:128] if container else None, "port": port,
                      "desc": sec.get("desc", "").strip()[:200]})
    return tiles, problems


def parse_ignore(text: str) -> list[str]:
    """One container name or ID per line; blank lines and '#' comments skipped."""
    out = []
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            out.append(line[:MAX_IGNORE_LEN])
            if len(out) == MAX_IGNORE:
                break
    return out


def parse_mutes(text: str) -> tuple[list[dict], list[str]]:
    """INI sections -> errors-panel mute rules {source?, pattern?}; the pattern must be a valid regex."""
    sections, line_problems = _sections(text, inline_comments=False)
    mutes, problems = [], ["mutes: " + p for p in line_problems]
    for name, sec in sections:
        rule = {k: sec[k].strip() for k in ("source", "pattern") if sec.get(k, "").strip()}
        if not rule:
            problems.append(f"mutes: [{name}] needs a source or a pattern")
            continue
        if "pattern" in rule:
            try:
                re.compile(rule["pattern"])
            except re.error as exc:
                problems.append(f"mutes: [{name}] pattern is not a valid regular expression ({exc})")
                continue
        if len(mutes) == MAX_MUTES:
            problems.append(f"mutes: more than {MAX_MUTES} rules; the rest are ignored")
            break
        mutes.append(rule)
    return mutes, problems


def host_facts(*, hostname=None, cpuinfo_path="/proc/cpuinfo", user=None) -> dict:
    """Host name, the account dash-events runs as (the dashboard's owner) and a CPU label, all read locally."""
    if user is None:
        try:
            user = pwd.getpwuid(os.getuid()).pw_name
        except KeyError:
            user = str(os.getuid())
    model, threads = None, 0
    try:
        with open(cpuinfo_path, encoding="utf-8", errors="replace") as f:
            for line in f:
                key, _, val = line.partition(":")
                key = key.strip().lower()
                if key == "processor":
                    threads += 1
                elif key == "model name" and model is None:
                    model = " ".join(val.split())
    except OSError:
        pass
    threads = threads or os.cpu_count() or 1
    return {"name": hostname or socket.gethostname(), "user": user,
            "cpu": f"{model or platform.machine() or 'CPU'} · {threads} threads"}


class UserSettings:
    """The owner's files in config_dir (quicklaunch, ignore, mutes), re-read when their mtime changes."""

    FILES = ("quicklaunch", "ignore", "mutes")

    def __init__(self, config_dir: str, version: str, clock=time.monotonic, recheck_s: float = 2.0):
        self.dir, self.version, self._clock, self._recheck = config_dir, version, clock, recheck_s
        self._lock = threading.Lock()
        self._seen = {}            # name -> mtime (or None when missing)
        self._parsed = {"quicklaunch": ([], []), "ignore": ([], []), "mutes": ([], [])}
        self._checked = None
        self._host = host_facts()

    def _load(self, name):
        path = os.path.join(self.dir, name)
        try:
            mtime = os.stat(path).st_mtime_ns
        except FileNotFoundError:
            mtime = None
        except OSError as exc:
            self._seen[name], self._parsed[name] = ("error", []), ([], [f"{name}: cannot read ({exc.strerror})"])
            return
        if name in self._seen and self._seen[name] == mtime:
            return
        self._seen[name] = mtime
        if mtime is None:
            self._parsed[name] = ([], [])
            return
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                text = f.read(256 * 1024)
        except OSError as exc:
            self._seen[name] = ("error", mtime)
            self._parsed[name] = ([], [f"{name}: cannot read ({exc.strerror or exc.__class__.__name__})"])
            return
        if name == "ignore":
            self._parsed[name] = (parse_ignore(text), [])
        elif name == "quicklaunch":
            self._parsed[name] = parse_quicklaunch(text)
        else:
            self._parsed[name] = parse_mutes(text)

    def get(self) -> dict:
        with self._lock:
            now = self._clock()
            if self._checked is None or now - self._checked >= self._recheck:
                self._checked = now
                for name in self.FILES:
                    self._load(name)
            problems = [p for name in self.FILES for p in self._parsed[name][1]]
            return {"version": self.version, "host": dict(self._host),
                    "quicklaunch": list(self._parsed["quicklaunch"][0]), "ignore": list(self._parsed["ignore"][0]),
                    "mutes": list(self._parsed["mutes"][0]), "problems": problems,
                    "docker": os.path.exists("/var/run/docker.sock")}


class PortProbe:
    """'up'/'down' for the ports of port-only Quick Launch tiles (TCP connect to 127.0.0.1), cached briefly."""

    def __init__(self, ports_fn, ttl_s: float = 10.0, timeout_s: float = 0.5, clock=time.monotonic):
        self._ports_fn, self._ttl, self._timeout, self._clock = ports_fn, ttl_s, timeout_s, clock
        self._lock = threading.Lock()
        self._cache, self._fetched = None, 0.0

    def states(self) -> dict:
        with self._lock:
            if self._cache is None or self._clock() - self._fetched >= self._ttl:
                self._cache, self._fetched = self._probe(), self._clock()
            return dict(self._cache)

    def _probe(self) -> dict:
        try:
            ports = sorted({int(p) for p in self._ports_fn() if 0 < int(p) < 65536})[:MAX_TILES]
        except Exception:
            return {}
        out = {}
        for p in ports:
            try:
                with socket.create_connection(("127.0.0.1", p), timeout=self._timeout):
                    out[str(p)] = "up"
            except OSError:
                out[str(p)] = "down"
        return out


def read_version(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as f:
            v = f.read(64).strip()
        return v if re.fullmatch(r"[0-9A-Za-z.+-]{1,32}", v) else "unknown"
    except OSError:
        return "unknown"


# ── server ─────────────────────────────────────────────────────────────────


class Hub:
    """Fan-out of events to SSE subscribers. Slow subscribers are dropped, never waited on."""

    def __init__(self, queue_size: int = 1000, max_subscribers: int = 20):
        self.queue_size = queue_size
        self.max_subscribers = max_subscribers
        self._subs: set = set()
        self._lock = threading.Lock()

    def subscribe(self):
        with self._lock:
            if len(self._subs) >= self.max_subscribers:
                return None
            q = queue.Queue(maxsize=self.queue_size)
            q.dropped = False
            self._subs.add(q)
            return q

    def unsubscribe(self, q) -> None:
        with self._lock:
            self._subs.discard(q)

    def count(self) -> int:
        with self._lock:
            return len(self._subs)

    def publish(self, event: dict) -> None:
        data = json.dumps(event, separators=(",", ":"))
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(data)
            except queue.Full:
                q.dropped = True
                self.unsubscribe(q)


STATIC_TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
    ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2",
}

# The policy from www/index.html's <meta> tag, plus frame-ancestors (which browsers ignore in a
# <meta> CSP). The header is authoritative; a test keeps the two in step.
STATIC_CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; "
              "font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; "
              "form-action 'none'; object-src 'none'; frame-ancestors 'none'")

HOST_CHECK_PATH = "/_host_ok"  # 204 if the Host header is allowed (Caddy forward_auth)
REQUEST_TIMEOUT_S = 10   # reading the request line and headers (slowloris)
STREAM_WRITE_TIMEOUT_S = 60  # once an SSE stream is open: only a stalled write can hit this


def _split_host(value: str) -> tuple[str, str] | None:
    """'Name:port' -> ('name', 'port'); lower-cased, one trailing dot dropped. None if malformed."""
    value = value.strip().lower()
    if value.startswith("["):
        close = value.find("]")
        if close < 0:
            return None
        name, rest = value[:close + 1], value[close + 1:]
    else:
        name, _, port = value.partition(":")
        rest = ":" + port if _ else ""
    if rest and not (rest.startswith(":") and rest[1:].isdigit()):
        return None
    name = name[:-1] if name.endswith(".") else name
    if not name or not re.fullmatch(r"[a-z0-9.-]+|\[[0-9a-f:.]+\]", name):
        return None
    return name, rest[1:]


TAILNET_V6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")
SIOCGIFADDR = 0x8915


def _ipv4_of(iface: str) -> str | None:
    """IPv4 address of a network interface (unprivileged ioctl), or None."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            raw = fcntl.ioctl(s.fileno(), SIOCGIFADDR, struct.pack("256s", iface.encode()[:15]))
        return socket.inet_ntoa(raw[20:24])
    except (OSError, ValueError):
        return None


def discover_names(configured, *, hostname: str | None = None, route_path: str = "/proc/net/route",
                   if_inet6_path: str = "/proc/net/if_inet6", ipv4_of=_ipv4_of) -> set[str]:
    """Names a browser may use to reach this host: hostname, hostname.local, the tailnet short name, the
    default-route interface's IPv4, and the tailnet IPv4/IPv6. Link-local, Docker bridge and non-tailnet
    global IPv6 addresses are left out (a raw global IPv6 Host would only come from outside the home).
    Every source is best-effort: one that can't be read contributes nothing."""
    names = set()
    full = (hostname if hostname is not None else socket.gethostname()).strip().lower().rstrip(".")
    host = full.split(".")[0]
    if host:
        names |= {host, host + ".local"}
    if "." in full and _split_host(full):
        names.add(full)   # a hostname set with its domain (nas.lan) is reachable by that name too
    for n in configured:
        parsed = _split_host(n)
        if parsed and parsed[0].endswith(".ts.net"):
            names.add(parsed[0].split(".")[0])
    try:
        with open(route_path) as f:
            for line in f.readlines()[1:]:
                cols = line.split()
                if len(cols) > 1 and cols[1] == "00000000":
                    ip = ipv4_of(cols[0])
                    if ip:
                        names.add(ip)
                    break
    except OSError:
        pass
    ip = ipv4_of("tailscale0")
    if ip:
        names.add(ip)
    try:
        with open(if_inet6_path) as f:
            for line in f:
                cols = line.split()
                if len(cols) == 6 and cols[5] == "tailscale0":
                    addr = ipaddress.IPv6Address(int(cols[0], 16))
                    if addr in TAILNET_V6:
                        names.add(f"[{addr.compressed}]")
    except (OSError, ValueError):
        pass
    return names


class HostAllowList:
    """Loopback names on our own port; configured and discovered names with no port, :80 or :443.

    `discover` (optional) returns the host's current names (see discover_names); it is re-run at most
    every `refresh_s` seconds, so a new LAN address is accepted without a restart. A discovery error keeps
    the previous set; configured names always stay allowed."""

    LOOPBACK = ("127.0.0.1", "localhost", "[::1]")
    PORTS = ("", "80", "443")

    def __init__(self, names=(), discover=None, refresh_s: float = 30, clock=time.monotonic):
        self.names = set()
        for n in names:
            parsed = _split_host(n)
            if parsed is None:
                raise ValueError(f"bad --allowed-host value: {n!r}")
            self.names.add(parsed)
        self._discover, self._refresh_s, self._clock = discover, refresh_s, clock
        self._found: set[str] = set()
        self._at = None
        self._lock = threading.Lock()

    def _discovered(self) -> set[str]:
        if self._discover is None:
            return set()
        with self._lock:
            now = self._clock()
            if self._at is None or now - self._at >= self._refresh_s:
                self._at = now
                try:
                    found = set()
                    for n in self._discover():
                        parsed = _split_host(n)
                        if parsed and not parsed[1]:
                            found.add(parsed[0])
                    self._found = found
                except Exception:  # never let discovery break request handling
                    pass
            return self._found

    def allows(self, header: str | None, port: int) -> bool:
        parsed = _split_host(header) if header else None
        if parsed is None:
            return False
        name, p = parsed
        if name in self.LOOPBACK:
            return p == str(port)
        # a configured name with a port accepts exactly that port; without one, the implicit web ports
        if any(name == n and (p == np if np else p in self.PORTS) for n, np in self.names):
            return True
        if p not in self.PORTS:
            return False
        return name in self._discovered()


def fetch_upstream(url: str, deadline_s: float, limit: int) -> bytes:
    """GET url with a total deadline across connect, headers and body (not a per-read timeout).

    The fetch runs in a worker thread that we wait on for at most deadline_s. On expiry the socket is
    shut down (which also unblocks the worker on Linux) and TimeoutError is raised. The caller also
    sets a cancel flag, so a worker still connecting at expiry closes its socket and exits as soon
    as the connect returns; the connect timeout is capped at the time remaining.
    """
    u = urllib.parse.urlsplit(url)
    if u.scheme != "http" or not u.hostname:
        raise ValueError("unsupported upstream URL")
    conn = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=deadline_s)
    result: dict = {}
    cancelled = threading.Event()
    started = time.monotonic()

    def work():
        try:
            conn.timeout = max(0.001, deadline_s - (time.monotonic() - started))
            conn.connect()
            if cancelled.is_set():
                return
            conn.request("GET", u.path + ("?" + u.query if u.query else ""))
            r = conn.getresponse()
            if r.status != 200:
                raise ValueError(f"upstream status {r.status}")
            result["raw"] = r.read(limit + 1)
        except BaseException as exc:  # handed to the caller below
            result["error"] = exc
        finally:
            conn.close()

    worker = threading.Thread(target=work, daemon=True, name="upstream")
    worker.start()
    worker.join(deadline_s)
    if worker.is_alive():
        cancelled.set()
        sock = conn.sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        raise TimeoutError("upstream deadline exceeded")
    if "error" in result:
        raise result["error"]
    raw = result["raw"]
    if len(raw) > limit:
        raise ValueError("upstream too large")
    return raw


class DashServer(ThreadingHTTPServer):
    """A page load fetches ~15 static modules in parallel; Python's default listen backlog of 5
    makes the kernel reset some of those connections, leaving the page half-loaded."""
    request_queue_size = 128
    daemon_threads = True


def make_handler(grouper: Grouper, hub: Hub, heartbeat_s: float = 15, glances_url: str = GLANCES_URL,
                 www: str = None, allowed_hosts=(), host_discover=None, request_timeout: float = REQUEST_TIMEOUT_S,
                 glances_deadline_s: float = 4, settings=None, ports=None):
    www_root = os.path.realpath(www) if www else None
    hosts = HostAllowList(allowed_hosts, discover=host_discover)

    class Handler(BaseHTTPRequestHandler):
        server_version = "dash-events"
        sys_version = ""
        timeout = request_timeout  # applied to the socket in setup(), before the request is read

        def log_message(self, *args):  # journal noise from our own access log is not useful
            pass

        def parse_request(self):
            self._extra_headers = []
            if not super().parse_request():
                return False
            # DNS-rebinding guard: refuse unknown Host values before any routing.
            if not hosts.allows(self.headers.get("Host"), self.server.server_address[1]):
                self.send_error(403, "unknown host")
                return False
            return True

        def end_headers(self):
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            for name, value in getattr(self, "_extra_headers", ()):
                self.send_header(name, value)
            super().end_headers()

        @staticmethod
        def _is_backend(path):
            return path.startswith("/events/") or path.startswith("/api/")

        def _foreign_origin(self):
            # Sec-Fetch-Site is only sent to https origins; on plain http a browser's cross-origin
            # request carries Origin instead. No Origin (same-origin GET, curl) is fine.
            origin = self.headers.get("Origin")
            if origin is None:
                return False
            u = urllib.parse.urlsplit(origin)
            if u.scheme not in ("http", "https") or not u.netloc:
                return True
            return not hosts.allows(u.netloc, self.server.server_address[1])

        def _host_ok(self):
            # Reached only after parse_request accepted the Host: Caddy's forward_auth for /term/*.
            self.send_response(204)
            self.end_headers()

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == HOST_CHECK_PATH:
                self._host_ok()
            elif self._is_backend(path):
                if self.headers.get("Sec-Fetch-Site") == "cross-site" or self._foreign_origin():
                    self.send_error(403)
                elif path == "/events/recent":
                    self._json(grouper.recent(500))
                elif path == "/events/stream":
                    self._stream()
                elif path == "/api/4/all":
                    self._glances()
                elif path == "/api/settings":
                    self._json(settings.get() if settings else {})
                elif path == "/api/ports":
                    self._json(ports.states() if ports else {})
                else:
                    self.send_error(404)
            else:
                self._static(path)

        def do_HEAD(self):
            path = self.path.split("?", 1)[0]
            if path == HOST_CHECK_PATH:
                self._host_ok()
            elif self._is_backend(path):
                self._not_allowed()
            else:
                self._static(path, head=True)

        def _static(self, path, head=False):
            ctype = rel = None
            if www_root:
                rel = urllib.parse.unquote(path).lstrip("/") or "index.html"
                ctype = STATIC_TYPES.get(os.path.splitext(rel)[1].lower())
            if ctype is None or "\0" in rel:
                self.send_error(404)
                return
            real = os.path.realpath(os.path.join(www_root, rel))
            try:
                inside = os.path.commonpath([real, www_root]) == www_root
                if not inside or not os.path.isfile(real):
                    raise OSError
                with open(real, "rb") as f:
                    body = f.read()
            except (OSError, ValueError):
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", STATIC_CSP)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head:
                self.wfile.write(body)

        def _not_allowed(self):
            path = self.path.split("?", 1)[0]
            self._extra_headers.append(("Allow", "GET" if self._is_backend(path) else "GET, HEAD"))
            self.send_error(405)

        do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _not_allowed

        def _json(self, obj, status=200):
            body = json.dumps(obj, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _glances(self):
            try:
                data = json.loads(fetch_upstream(glances_url, glances_deadline_s, MAX_UPSTREAM))
            except (OSError, ValueError, http.client.HTTPException):
                self._json({"error": "glances unreachable"}, status=502)
                return
            self._json(filter_glances(data))

        def _stream(self):
            q = hub.subscribe()
            if q is None:
                self.send_error(503, "too many streams")
                return
            try:
                # The request has been read; from here on only a stalled write can block.
                self.connection.settimeout(max(STREAM_WRITE_TIMEOUT_S, heartbeat_s * 4))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                self.wfile.write(b": connected\n\n")
                self.wfile.flush()
                while not q.dropped:
                    try:
                        chunk = f"event: upsert\ndata: {q.get(timeout=heartbeat_s)}\n\n"
                    except queue.Empty:
                        chunk = ": hb\n\n"
                    self.wfile.write(chunk.encode())
                    self.wfile.flush()
            except OSError:  # client went away (or a write stalled past the timeout)
                pass
            finally:
                hub.unsubscribe(q)

    return Handler


class JournalFollower(threading.Thread):
    """Runs `journalctl -f -o json` and hands parsed entries to on_entry. Restarts on exit."""

    def __init__(self, on_entry, since: str = "-24h", base_cmd: tuple = ("journalctl",), retry_s: float = 5):
        super().__init__(daemon=True, name="journal")
        self.on_entry = on_entry
        self.since = since
        self.base_cmd = tuple(base_cmd)
        self.retry_s = retry_s
        self._stopping = threading.Event()
        self._proc = None

    def stop(self):
        """Ends the restart loop and the current journalctl (main() never calls it; tests do)."""
        self._stopping.set()
        proc = self._proc
        if proc is not None:
            try:
                proc.terminate()
            except OSError:
                pass

    def run(self):
        cursor = None
        while not self._stopping.is_set():
            args = [*self.base_cmd, "-f", "-o", "json", "-p", "notice", "--no-pager"]
            args += [f"--after-cursor={cursor}"] if cursor else ["--since", self.since]
            started = time.monotonic()
            try:
                proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        text=True, encoding="utf-8", errors="replace")
                self._proc = proc
                if self._stopping.is_set():
                    proc.terminate()
                try:
                    for line in proc.stdout:
                        entry = parse_journal_line(line)
                        if not entry:
                            continue
                        cursor = entry["cursor"] or cursor
                        try:
                            self.on_entry(entry)
                        except Exception as exc:
                            print(f"dash-events: on_entry failed: {exc!r}", file=sys.stderr)
                finally:
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait()
                    proc.stdout.close()
                    self._proc = None
            except Exception as exc:
                print(f"dash-events: journal follower error: {exc!r}", file=sys.stderr)
            if cursor and time.monotonic() - started < 2:
                cursor = None  # likely an invalid cursor; fall back to --since
            self._stopping.wait(self.retry_s)


class Checker(threading.Thread):
    """Every interval: expected mounts present and writable, no failed systemd units."""

    def __init__(self, expected_mounts, on_problem, interval_s: float = 30,
                 mounts_path: str = "/proc/self/mounts", run=subprocess.run):
        super().__init__(daemon=True, name="checker")
        self.expected = list(expected_mounts)
        self.on_problem = on_problem
        self.interval_s = interval_s
        self.mounts_path = mounts_path
        self.run_cmd = run
        self._active: set[str] = set()

    def check_once(self):
        with open(self.mounts_path, encoding="utf-8", errors="replace") as f:
            problems = check_mounts(self.expected, f.read())
        out = self.run_cmd(["systemctl", "--failed", "--output=json", "--no-pager"],
                           capture_output=True, text=True, timeout=10)
        problems += [(f"unit-failed:{u}", f"{u} has failed") for u in parse_failed_units(out.stdout)]
        self._report(problems)

    def _report(self, problems):
        for key, message in problems:
            if key not in self._active:
                self.on_problem(key, message)
        self._active = {k for k, _ in problems}

    def tick(self):
        """One check; a failing check is itself reported (once per distinct error), never fatal."""
        try:
            self.check_once()
        except Exception as exc:
            print(f"dash-events: check failed: {exc!r}", file=sys.stderr)
            msg = f"dash-events self-check failed: {type(exc).__name__}: {exc}"
            if "checker-error" not in self._active:
                self._active.add("checker-error")
                self.on_problem("checker-error", msg)

    def run(self):
        while True:
            self.tick()
            time.sleep(self.interval_s)


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=7682)
    ap.add_argument("--mounts", default="", help="comma-separated mountpoints that must be mounted rw")
    ap.add_argument("--www", default=None, help="directory of static frontend files to serve (disabled if unset)")
    ap.add_argument("--since", default="-24h")
    ap.add_argument("--allowed-host", action="append", default=[], metavar="NAME",
                    help="extra Host header value to accept (repeatable), e.g. the Tailscale MagicDNS name; "
                         "127.0.0.1/localhost/[::1] on our own port are always accepted")
    ap.add_argument("--config-dir", default=os.path.join(os.path.expanduser("~"), ".config", "home-server-dashboard"),
                    help="directory holding the owner's quicklaunch, ignore and mutes files")
    ap.add_argument("--version-file", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                                           "VERSION"))
    args = ap.parse_args(argv)
    if args.host not in ("127.0.0.1", "::1"):
        ap.error("dash-events must bind to loopback (127.0.0.1 or ::1)")
    try:
        HostAllowList(args.allowed_host)
    except ValueError as exc:
        ap.error(str(exc))
    return args


def main(argv=None):
    args = parse_args(argv)

    grouper, hub = Grouper(), Hub()

    def on_entry(e):
        hub.publish(grouper.add(e["source"], e["message"], e["priority"], e["ts"],
                                trusted=entry_is_trusted(e), rate_key=(e["uid"], e["source"]),
                                uid_key=uid_budget_key(e)))

    def on_problem(key, message):
        category = "filesystem" if key.startswith("mount-") else "service"  # incl. checker-*
        hub.publish(grouper.add("dash-events", message, 3, int(time.time() * 1000),
                                category=category, trusted=True))

    settings = UserSettings(args.config_dir, read_version(args.version_file))
    ports = PortProbe(lambda: [t["port"] for t in settings.get()["quicklaunch"] if t["port"] and not t["container"]])
    JournalFollower(on_entry, since=args.since).start()
    Checker([m for m in args.mounts.split(",") if m], on_problem, mounts_path=HOST_MOUNTS).start()
    srv = DashServer((args.host, args.port), make_handler(grouper, hub, www=args.www,
                                                                     allowed_hosts=args.allowed_host,
                                                                     host_discover=lambda: discover_names(args.allowed_host),
                                                                     settings=settings, ports=ports))
    srv.daemon_threads = True
    srv.serve_forever()


if __name__ == "__main__":
    main()
