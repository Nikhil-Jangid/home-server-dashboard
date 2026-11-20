import contextlib
import inspect
import io
import json
import socket
import shutil
import platform
import os
import re
import subprocess
import unittest

import dash_events as de


class DashServerTest(unittest.TestCase):
    def test_listen_backlog_survives_a_parallel_page_load(self):
        self.assertGreaterEqual(de.DashServer.request_queue_size, 64)
        self.assertTrue(de.DashServer.daemon_threads)
        self.assertIn("DashServer(", inspect.getsource(de.main))


class CategorizeTest(unittest.TestCase):
    CASES = [
        ("kernel", "blk_update_request: I/O error, dev sdb, sector 1234", "disk_io"),
        ("kernel", "ata3.00: failed command: READ FPDMA QUEUED", "disk_io"),
        ("smartd", "Device: /dev/sda [SAT], Failed SMART usage Attribute: 194 Temperature_Celsius.", "disk_io"),
        ("kernel", "EXT4-fs (sdc1): failed to initialize system zone (-117)", "filesystem"),
        ("systemd-fsck", "SSD_128GB: UNEXPECTED INCONSISTENCY; RUN fsck MANUALLY.", "filesystem"),
        ("kernel", "EXT4-fs (sdb1): Remounting filesystem read-only", "filesystem"),
        ("kernel", "e1000e 0000:00:19.0 enp0s25: NIC Link is Down", "network"),
        ("systemd", "Failed to start nginx.service - A high performance web server.", "service"),
        ("kernel", "Out of memory: Killed process 4242 (nginx)", "memory"),
        ("kernel", "CPU0: Core temperature above threshold, cpu clock throttled", "hardware"),
        ("sshd", "Accepted publickey for demo", "other"),
    ]

    NEGATIVE = [
        ("systemd", "Started smartmontools.service", "other"),
        ("sshd", "Could not load host key: smartcard", "other"),
        ("dockerd", 'level=error msg="read-only"', "other"),
        ("systemd", "rate throttling client", "other"),
        ("systemd-resolved", "Using degraded feature set UDP for DNS server 1.1.1.1.", "other"),
    ]

    def test_table(self):
        for source, msg, want in self.CASES:
            with self.subTest(msg=msg):
                self.assertEqual(de.categorize(source, msg), want)

    def test_false_positives_are_other(self):
        for source, msg, want in self.NEGATIVE:
            with self.subTest(msg=msg):
                self.assertEqual(de.categorize(source, msg), want)


class NormalizeTest(unittest.TestCase):
    def test_numbers_hex_uuid_collapse(self):
        a = de.normalize("I/O error, dev sdb, sector 1234 op 0x0:(READ)")
        b = de.normalize("I/O error, dev sdb, sector 98765 op 0x1f:(READ)")
        self.assertEqual(a, b)
        self.assertEqual(de.normalize("uuid 806c5591-7052-47aa-96e9-3f663f76e717 bad"), "uuid # bad")

    def test_truncates(self):
        self.assertEqual(len(de.normalize("x" * 1000)), 300)

    def test_block_device_and_partition_names_stay_distinct(self):
        names = ["sda", "sdb", "sdb1", "sdb2", "sdaa3", "nvme0n1", "nvme0n1p2", "nvme1n1p2", "md0", "md127",
                 "dm-0", "dm-3", "loop0", "loop12", "mmcblk0", "mmcblk0p1"]
        for name in names:
            with self.subTest(name=name):
                self.assertEqual(de.normalize(f"EXT4-fs ({name}): error 5"), f"EXT#-fs ({name}): error #")
        self.assertNotEqual(de.normalize("I/O error, dev sdb1, sector 1"), de.normalize("I/O error, dev sdb2, sector 1"))
        self.assertEqual(de.normalize("Buffer I/O error on /dev/sdb1"), "Buffer I/O error on /dev/sdb1")

    def test_bare_hex_runs_collapse(self):
        a = de.normalize("container deadbeefcafe0123 died, image 0xffffabcd")
        b = de.normalize("container abcdef9876543210 died, image 0x1")
        self.assertEqual(a, b)
        self.assertEqual(a, "container # died, image #")
        self.assertEqual(de.normalize("task 4a5b6c7d8e failed"), "task # failed")
        # short hex-looking words are left alone
        self.assertEqual(de.normalize("accessed a cafe bead"), "accessed a cafe bead")


def jline(**over):
    e = {"MESSAGE": "hello", "PRIORITY": "3", "SYSLOG_IDENTIFIER": "smartd",
         "__REALTIME_TIMESTAMP": "1760500000123456", "__CURSOR": "s=abc"}
    e.update(over)
    return json.dumps(e)


class ParseJournalTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(de.parse_journal_line(jline()),
                         {"source": "smartd", "message": "hello", "priority": 3, "ts": 1760500000123,
                          "cursor": "s=abc", "uid": None, "transport": None, "unit": None})

    def test_auth_command_lines_are_redacted(self):
        # sudo logs the full command line at notice level; the Errors feed is readable by every tailnet
        # peer, and command lines can carry secrets (same reason Glances command lines are filtered).
        m = "demo : TTY=pts/0 ; PWD=/home/n ; USER=root ; COMMAND=/usr/bin/mysql -pS3cret db"
        for extra in ({"SYSLOG_IDENTIFIER": "sudo", "SYSLOG_FACILITY": "10"},
                      {"SYSLOG_IDENTIFIER": "sudo"},
                      {"SYSLOG_IDENTIFIER": "x", "SYSLOG_FACILITY": "4"}):
            out = de.parse_journal_line(jline(MESSAGE=m, PRIORITY="5", **extra))["message"]
            self.assertNotIn("S3cret", out)
            self.assertIn("USER=root ; COMMAND=<hidden>", out)
        # multi-line commands must not leak past the first newline
        ml = de.parse_journal_line(jline(MESSAGE="u : USER=root ; COMMAND=/bin/sh -c 'a\nexport T=S3cret'",
                                         PRIORITY="5", SYSLOG_IDENTIFIER="sudo"))["message"]
        self.assertNotIn("S3cret", ml)
        # sudo splits long commands into extra entries with no COMMAND= marker
        for ident in ("sudo", "su", "pkexec"):
            cont = de.parse_journal_line(jline(MESSAGE="(command continued) --token S3cret",
                                               PRIORITY="5", SYSLOG_IDENTIFIER=ident))["message"]
            self.assertEqual(cont, "(command continued) <hidden>")
        other = de.parse_journal_line(jline(MESSAGE="COMMAND=/bin/x kept", SYSLOG_IDENTIFIER="smartd"))
        self.assertEqual(other["message"], "COMMAND=/bin/x kept")

    def test_unit_is_captured_and_capped(self):
        self.assertEqual(de.parse_journal_line(jline(_SYSTEMD_UNIT="docker.service"))["unit"], "docker.service")
        self.assertEqual(len(de.parse_journal_line(jline(_SYSTEMD_UNIT="u" * 500))["unit"]), 80)
        self.assertIsNone(de.parse_journal_line(jline(_SYSTEMD_UNIT=["x"]))["unit"])

    def test_kernel_transport_and_byte_message(self):
        e = de.parse_journal_line(jline(_TRANSPORT="kernel", MESSAGE=list(b"I/O \xff error")))
        self.assertEqual(e["source"], "kernel")
        self.assertEqual(e["message"], "I/O � error")

    def test_rejects(self):
        self.assertIsNone(de.parse_journal_line("not json"))
        self.assertIsNone(de.parse_journal_line(jline(MESSAGE="   ")))
        self.assertIsNone(de.parse_journal_line(jline(PRIORITY="6")))

    def test_fallback_source(self):
        e = de.parse_journal_line(jline(SYSLOG_IDENTIFIER=None, _SYSTEMD_UNIT="foo.service"))
        self.assertEqual(e["source"], "foo.service")

    def test_spoofed_kernel_identifier_is_renamed(self):
        spoof = de.parse_journal_line(jline(_TRANSPORT="syslog", SYSLOG_IDENTIFIER="kernel"))
        real = de.parse_journal_line(jline(_TRANSPORT="kernel", SYSLOG_IDENTIFIER="kernel"))
        self.assertEqual(spoof["source"], "kernel?")
        self.assertEqual(real["source"], "kernel")

    def test_uid_and_trust(self):
        self.assertEqual(de.parse_journal_line(jline(_UID="1000"))["uid"], 1000)
        self.assertIsNone(de.parse_journal_line(jline(_UID="nope"))["uid"])
        self.assertTrue(de.entry_is_trusted(de.parse_journal_line(jline(_TRANSPORT="kernel"))))
        self.assertFalse(de.entry_is_trusted(de.parse_journal_line(jline(_UID="0", _TRANSPORT="syslog"))))
        self.assertFalse(de.entry_is_trusted(de.parse_journal_line(jline(_UID="0"))))
        self.assertFalse(de.entry_is_trusted(de.parse_journal_line(jline(_UID="1000"))))
        self.assertFalse(de.entry_is_trusted(de.parse_journal_line(jline())))


class GrouperTest(unittest.TestCase):
    def test_groups_repeats_within_window(self):
        g = de.Grouper(window_s=600)
        a = g.add("kernel", "I/O error sector 1", 3, 1_000)
        b = g.add("kernel", "I/O error sector 2", 4, 2_000)
        self.assertEqual(a["id"], b["id"])
        self.assertEqual(b["count"], 2)
        self.assertEqual(b["priority"], 3)  # most severe kept
        self.assertEqual(b["first_ts"], 1_000)
        self.assertEqual(b["last_ts"], 2_000)
        self.assertEqual(b["message"], "I/O error sector 2")
        self.assertEqual(b["category"], "disk_io")
        self.assertRegex(b["id"], r"^\d+-\d+$")

    def test_new_group_after_window(self):
        g = de.Grouper(window_s=600)
        a = g.add("kernel", "I/O error", 3, 0)
        b = g.add("kernel", "I/O error", 3, 600_001)
        self.assertNotEqual(a["id"], b["id"])

    def test_category_override(self):
        g = de.Grouper()
        self.assertEqual(g.add("dash-events", "/ is not mounted", 3, 0, category="filesystem")["category"], "filesystem")

    def test_rate_limit_folds_excess_groups_into_one_suppressed_entry(self):
        g = de.Grouper(rate_limit=20)
        for i in range(50):
            g.add("spammy", f"distinct message {chr(65 + i % 26)}{chr(97 + i // 26)}", 5, 1_000 + i)
        rows = [r for r in g.recent(1000) if r["source"] == "spammy"]
        suppressed = [r for r in rows if "suppressed" in r["message"]]
        self.assertEqual(len(rows), 21)
        self.assertEqual(len(suppressed), 1)
        self.assertEqual(suppressed[0]["count"], 30)

    def test_rate_limit_window_slides(self):
        g = de.Grouper(rate_limit=2)
        g.add("s", "a", 5, 0)
        g.add("s", "b", 5, 1)
        g.add("s", "c", 5, 61_000)
        self.assertFalse(any("suppressed" in r["message"] for r in g.recent()))

    def test_trusted_entries_bypass_rate_limit(self):
        g = de.Grouper(rate_limit=20)
        for i in range(50):
            g.add("kernel?", f"spoof {chr(65 + i % 26)}{chr(97 + i // 26)}", 5, 1_000 + i,
                  rate_key=(1000, "kernel?"))
        r = g.add("kernel", "I/O error sector 9", 3, 2_000, trusted=True)
        self.assertNotIn("suppressed", r["message"])
        self.assertEqual(r["category"], "disk_io")

    def test_rate_limit_is_per_rate_key(self):
        g = de.Grouper(rate_limit=20)
        for i in range(50):
            g.add("x", f"distinct message {chr(65 + i % 26)}{chr(97 + i // 26)}", 5, 1_000 + i,
                  rate_key=(1000, "x"))
        g.add("x", "fresh unique message", 5, 2_000, rate_key=(0, "x"))
        rows = [r["message"] for r in g.recent(1000) if r["source"] == "x" and "suppressed" not in r["message"]]
        self.assertIn("fresh unique message", rows)

    def test_per_uid_cap_stops_identifier_rotation(self):
        g = de.Grouper(rate_limit=20, uid_rate_limit=30)
        for i in range(200):  # a fresh SYSLOG_IDENTIFIER for every message
            g.add(f"rot{i}", "spam", 5, 1_000 + i, rate_key=(1000, f"rot{i}"), uid_key=1000)
        rows = g.recent(1000)
        real = [r for r in rows if "suppressed" not in r["message"]]
        suppressed = [r for r in rows if "suppressed" in r["message"]]
        self.assertEqual(len(real), 30)
        self.assertEqual(len(suppressed), 1)
        self.assertEqual(suppressed[0]["count"], 170)
        self.assertIn("uid 1000", suppressed[0]["message"])
        # another uid is unaffected, and the cap window slides
        self.assertNotIn("suppressed", g.add("sshd", "other uid", 5, 2_000, uid_key=0)["message"])
        self.assertNotIn("suppressed", g.add("late", "after a minute", 5, 62_000, uid_key=1000)["message"])

    def test_uid_budget_key_splits_root_by_unit_only(self):
        k = de.uid_budget_key
        self.assertEqual(k({"uid": 0, "unit": "docker.service", "source": "dockerd"}), (0, "docker.service"))
        self.assertEqual(k({"uid": 0, "unit": None, "source": "cron"}), (0, None))
        self.assertEqual(k({"uid": 1000, "unit": "x.service", "source": "x"}), 1000)
        self.assertIsNone(k({"uid": None, "unit": "x.service", "source": "x"}))

    def test_root_units_get_separate_budgets(self):
        g = de.Grouper(rate_limit=10_000, uid_rate_limit=30)
        for i in range(100):
            for unit in ("a.service", "b.service"):
                g.add(f"{unit}-{i}", "err", 3, 1_000 + i, uid_key=(0, unit))
        rows = g.recent(1000)
        real = [r for r in rows if "suppressed" not in r["message"]]
        supp = [r for r in rows if "suppressed" in r["message"]]
        self.assertEqual(len(real), 60)  # 30 per unit
        self.assertEqual(len(supp), 2)
        self.assertEqual(sorted(r["source"] for r in supp), ["uid 0 (a.service)", "uid 0 (b.service)"])
        # an untouched third root unit still gets through
        self.assertNotIn("suppressed", g.add("c", "err", 3, 2_000, uid_key=(0, "c.service"))["message"])

    def test_nonroot_uid_rotation_still_capped_via_budget_key(self):
        g = de.Grouper(rate_limit=10_000, uid_rate_limit=30)
        for i in range(100):
            e = {"uid": 1000, "unit": f"u{i}.service", "source": f"s{i}"}
            g.add(e["source"], "spam", 5, 1_000 + i, uid_key=de.uid_budget_key(e))
        real = [r for r in g.recent(1000) if "suppressed" not in r["message"]]
        self.assertEqual(len(real), 30)

    def test_root_without_unit_shares_one_budget_despite_identifier_rotation(self):
        g = de.Grouper(rate_limit=10_000, uid_rate_limit=30)
        for i in range(100):
            e = {"uid": 0, "unit": None, "source": f"rot{i}"}
            g.add(e["source"], "spam", 5, 1_000 + i, uid_key=de.uid_budget_key(e))
        real = [r for r in g.recent(1000) if "suppressed" not in r["message"]]
        self.assertEqual(len(real), 30)

    def test_root_unit_budget_table_stays_bounded(self):
        g = de.Grouper(max_entries=20, rate_limit=10_000, uid_rate_limit=30)
        for i in range(500):
            g.add(f"s{i}", "err", 3, 1_000 + i, uid_key=(0, f"unit{i}.service"))
        self.assertLessEqual(len(g._new_by_uid), 20)
        self.assertLessEqual(len(g._groups), 20)

    def test_per_uid_cap_constant_is_documented_default(self):
        self.assertEqual(de.Grouper().uid_rate_limit, de.UID_NEW_GROUPS_PER_MIN)
        self.assertEqual(de.UID_NEW_GROUPS_PER_MIN, 30)

    def test_eviction_prefers_untrusted_groups(self):
        g = de.Grouper(max_entries=5, rate_limit=10_000, uid_rate_limit=10_000)
        g.add("kernel", "I/O error, dev sdb1", 3, 0, trusted=True)
        g.add("kernel", "EXT4-fs (sdc1): error", 3, 1, trusted=True)
        for i in range(50):
            g.add(f"noise{i}", "flood", 5, 10 + i)
        sources = [r["source"] for r in g.recent(100)]
        self.assertEqual(len(sources), 5)
        self.assertEqual(sources.count("kernel"), 2)
        self.assertEqual(sources[:3], ["noise49", "noise48", "noise47"])

    def test_trusted_groups_evicted_only_when_all_are_trusted(self):
        g = de.Grouper(max_entries=3, rate_limit=10_000)
        for i in range(5):
            g.add("kernel", f"I/O error, dev sd{chr(97 + i)}", 3, i, trusted=True)
        msgs = [r["message"] for r in g.recent(100)]
        self.assertEqual(msgs, ["I/O error, dev sde", "I/O error, dev sdd", "I/O error, dev sdc"])
        self.assertEqual(len(g._index), 3)
        self.assertEqual(len(g._trusted_ids), 3)

    def test_source_table_is_bounded(self):
        g = de.Grouper(max_entries=10, rate_limit=20)
        for i in range(5000):
            g.add(f"src{i}", "hello", 5, i)
        self.assertLessEqual(len(g._new_by_source), 10)

    def test_index_and_key_tables_stay_in_step(self):
        g = de.Grouper(max_entries=3, rate_limit=10_000)
        for i in range(20):
            g.add("s", f"m {chr(65 + i)}", 5, i)
        self.assertEqual(len(g._index), 3)
        self.assertEqual(len(g._key_of), 3)

    def test_buffer_never_exceeds_max_entries(self):
        g = de.Grouper(max_entries=10, rate_limit=10_000)
        for i in range(10_000):
            g.add(f"src{i % 7}", f"m {chr(65 + i % 26)}{chr(65 + (i // 26) % 26)}{chr(65 + (i // 676) % 26)}", 5, i)
        self.assertLessEqual(len(g.recent(10_000)), 10)

    def test_recent_newest_first_and_limited(self):
        g = de.Grouper()
        g.add("a", "x", 3, 5)
        g.add("b", "y", 3, 9)
        g.add("c", "z", 3, 7)
        self.assertEqual([r["source"] for r in g.recent(2)], ["b", "c"])

    def test_add_returns_copy(self):
        g = de.Grouper()
        r = g.add("a", "x", 3, 5)
        r["count"] = 999
        self.assertEqual(g.recent()[0]["count"], 1)


MOUNTS = """/dev/sda2 / ext4 rw,relatime 0 0
/dev/sdb1 /srv/internal ext4 rw,relatime 0 0
/dev/sdc1 /srv/fast ext4 ro,relatime 0 0
ssd:internal /srv/data fuse.unionfs rw,relatime 0 0
/dev/sdz1 /mnt/with\\040space ext4 rw 0 0
"""


class ChecksTest(unittest.TestCase):
    def test_check_mounts(self):
        got = de.check_mounts(["/", "/srv/data", "/srv/fast", "/srv/big", "/mnt/with space"], MOUNTS)
        self.assertEqual(got, [
            ("mount-ro:/srv/fast", "/srv/fast is mounted read-only"),
            ("mount-missing:/srv/big", "/srv/big is not mounted"),
        ])

    def test_check_mounts_utf8_octal_escape(self):
        got = de.check_mounts(["/mnt/café"], "/dev/sdd1 /mnt/caf\\303\\251 ext4 ro 0 0\n")
        self.assertEqual(got, [("mount-ro:/mnt/café", "/mnt/café is mounted read-only")])

    def test_parse_failed_units(self):
        text = json.dumps([{"unit": "systemd-fsck@x.service", "load": "loaded", "active": "failed", "sub": "failed"}, {"bogus": 1}])
        self.assertEqual(de.parse_failed_units(text), ["systemd-fsck@x.service"])
        self.assertEqual(de.parse_failed_units(""), [])
        self.assertEqual(de.parse_failed_units("garbage"), [])


import http.client
import sys
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.grouper = de.Grouper()
        self.hub = de.Hub()
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), de.make_handler(self.grouper, self.hub, heartbeat_s=0.5))
        self.srv.daemon_threads = True
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.port = self.srv.server_address[1]

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()

    def conn(self):
        return http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)

    def test_recent_returns_json(self):
        self.grouper.add("kernel", "I/O error", 3, 1)
        c = self.conn()
        c.request("GET", "/events/recent")
        r = c.getresponse()
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader("Content-Type"), "application/json")
        self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")
        self.assertEqual(json.loads(r.read())[0]["message"], "I/O error")

    def test_unknown_path_404_and_post_405(self):
        c = self.conn()
        c.request("GET", "/etc/passwd")
        self.assertEqual(c.getresponse().status, 404)
        c = self.conn()
        c.request("POST", "/events/recent", body=b"x")
        self.assertEqual(c.getresponse().status, 405)

    def test_stream_delivers_upserts_and_heartbeats(self):
        c = self.conn()
        c.request("GET", "/events/stream")
        r = c.getresponse()
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader("Content-Type"), "text/event-stream")
        self.assertEqual(r.readline(), b": connected\n")
        r.readline()
        for _ in range(50):  # wait for subscription to register
            if self.hub.count():
                break
            time.sleep(0.01)
        self.hub.publish({"id": "1-1", "message": "hi"})
        lines = [r.readline() for _ in range(3)]
        self.assertEqual(lines[0], b"event: upsert\n")
        self.assertEqual(json.loads(lines[1][len(b"data: "):]), {"id": "1-1", "message": "hi"})
        self.assertEqual(r.readline(), b": hb\n")

    def test_events_recent_refuses_cross_site_allows_same_origin(self):
        for site, want in (("cross-site", 403), ("same-origin", 200)):
            c = self.conn()
            c.request("GET", "/events/recent", headers={"Sec-Fetch-Site": site})
            self.assertEqual(c.getresponse().status, want)

    def test_stream_cap_returns_503(self):
        self.hub.max_subscribers = 0
        c = self.conn()
        c.request("GET", "/events/stream")
        self.assertEqual(c.getresponse().status, 503)

    def test_frame_protection_on_json_sse_and_errors(self):
        c = self.conn()
        c.request("GET", "/events/recent")
        r = c.getresponse()
        r.read()
        self.assertEqual(r.getheader("X-Frame-Options"), "DENY")
        c = self.conn()
        c.request("GET", "/events/stream")
        r = c.getresponse()
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader("X-Frame-Options"), "DENY")
        c.close()
        for method, path, want in (("GET", "/events/nope", 404), ("GET", "/", 404), ("POST", "/events/recent", 405)):
            c = self.conn()
            c.request(method, path)
            r = c.getresponse()
            r.read()
            self.assertEqual(r.status, want, path)
            self.assertEqual(r.getheader("X-Frame-Options"), "DENY", path)
            self.assertEqual(r.getheader("Referrer-Policy"), "no-referrer", path)

    def test_head_on_api_and_events_is_405_with_allow(self):
        for path in ("/events/recent", "/events/stream", "/api/4/all", "/events/nope"):
            c = self.conn()
            c.request("HEAD", path)
            r = c.getresponse()
            self.assertEqual(r.status, 405, path)
            self.assertEqual(r.getheader("Allow"), "GET", path)
            self.assertEqual(r.read(), b"", path)


def raw_request(port, data, timeout=5):
    import socket
    s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    try:
        s.sendall(data)
        buf = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                return buf
            buf += chunk
    finally:
        s.close()


class HostAllowListTest(unittest.TestCase):
    def setUp(self):
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), de.make_handler(
            de.Grouper(), de.Hub(), allowed_hosts=["Demo-server.Tail1234.ts.net"]))
        self.srv.daemon_threads = True
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (self.srv.shutdown(), self.srv.server_close()))
        self.port = self.srv.server_address[1]

    def status(self, host):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.putrequest("GET", "/events/recent", skip_host=True)
        if host is not None:
            c.putheader("Host", host)
        c.endheaders()
        r = c.getresponse()
        r.read()
        return r

    def test_allowed_hosts(self):
        p = self.port
        for host in (f"127.0.0.1:{p}", f"localhost:{p}", f"LOCALHOST:{p}", f"[::1]:{p}", f"localhost.:{p}",
                     "demo-server.tail1234.ts.net", "DEMO-SERVER.tail1234.ts.net.", "demo-server.tail1234.ts.net:443",
                     "demo-server.tail1234.ts.net.:443"):
            with self.subTest(host=host):
                self.assertEqual(self.status(host).status, 200)

    def test_other_hosts_refused(self):
        p = self.port
        for host in ("attacker.example", f"attacker.example:{p}", "127.0.0.1", f"127.0.0.1:{p + 1}",
                     "localhost:80", "demo-server.tail1234.ts.net:8443", "evil.demo-server.tail1234.ts.net",
                     "demo-server.tail1234.ts.net.evil", "", "[::1]", f"user@127.0.0.1:{p}"):
            with self.subTest(host=host):
                r = self.status(host)
                self.assertEqual(r.status, 403)
                self.assertEqual(r.getheader("X-Frame-Options"), "DENY")

    def test_configured_name_with_its_own_port(self):
        hl = de.HostAllowList(["box.example:8443", "plain.example"])
        self.assertTrue(hl.allows("box.example:8443", 7682))
        self.assertFalse(hl.allows("box.example", 7682))       # a configured port is the only one accepted
        self.assertFalse(hl.allows("box.example:80", 7682))
        self.assertTrue(hl.allows("plain.example:80", 7682))
        self.assertFalse(hl.allows("plain.example:8443", 7682))

    def test_backend_refuses_a_foreign_origin(self):
        # Sec-Fetch-Site is only sent over https; on plain http the Origin header is what a browser sends
        def status(origin):
            c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
            c.request("GET", "/events/recent", headers={"Host": "demo-server.tail1234.ts.net", "Origin": origin})
            r = c.getresponse(); r.read()
            return r.status
        for origin, want in (("http://evil.example", 403), ("null", 403), ("https://demo-server.tail1234.ts.net", 200),
                             ("http://demo-server.tail1234.ts.net:80", 200), ("http://demo-server.tail1234.ts.net:8080", 403),
                             ("garbage", 403)):
            with self.subTest(origin=origin):
                self.assertEqual(status(origin), want)

    def test_missing_host_refused(self):
        self.assertEqual(self.status(None).status, 403)
        resp = raw_request(self.port, b"GET /events/recent HTTP/1.0\r\n\r\n")
        self.assertTrue(resp.startswith(b"HTTP/1.0 403"), resp[:40])

    def test_refused_before_routing(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("POST", "/nope", body=b"x", headers={"Host": "attacker.example"})
        self.assertEqual(c.getresponse().status, 403)
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("HEAD", "/", headers={"Host": "attacker.example"})
        self.assertEqual(c.getresponse().status, 403)


class DynamicHostTest(unittest.TestCase):
    ROUTE = "Iface\tDestination\tGateway\nbr-x\tAC120000\t00000000\neth0\t00000000\t010200C0\n"
    INET6 = ("fd7a115ca1e00000000000000000000a 05 80 00 80 tailscale0\n"
             "fe80000000000000a1b2c3fffed4e5f6 02 40 20 80 eth0\n"
             "20010db8000000000000000000000001 02 40 00 00 eth0\n"
             "00000000000000000000000000000001 01 80 10 80 lo\n")
    IPS = {"eth0": "192.0.2.10", "tailscale0": "100.64.0.10", "docker0": "172.17.0.1", "br-x": "172.18.0.1"}

    def tmp(self, text):
        d = self.enterContext(tempfile.TemporaryDirectory()) if hasattr(self, "enterContext") else tempfile.mkdtemp()
        path = os.path.join(d, "f")
        with open(path, "w") as f:
            f.write(text)
        return path

    def test_discover_names_from_fixtures(self):
        names = de.discover_names(["demo-server.example-tailnet.ts.net"], hostname="Demo-server",
                                  route_path=self.tmp(self.ROUTE), if_inet6_path=self.tmp(self.INET6),
                                  ipv4_of=self.IPS.get)
        self.assertEqual(names, {"demo-server", "demo-server.local", "192.0.2.10", "100.64.0.10",
                                 "[fd7a:115c:a1e0::a]"})   # no fe80, no 2001:db8:…, no docker, no lo

    def test_a_hostname_with_a_domain_is_allowed_whole_and_short(self):
        names = de.discover_names([], hostname="NAS.lan", route_path="/nonexistent/route",
                                  if_inet6_path="/nonexistent/if_inet6", ipv4_of=lambda i: None)
        self.assertEqual(names, {"nas", "nas.local", "nas.lan"})

    def test_discover_names_survives_missing_sources(self):
        names = de.discover_names([], hostname="box", route_path="/nonexistent/route",
                                  if_inet6_path="/nonexistent/if_inet6", ipv4_of=lambda i: None)
        self.assertEqual(names, {"box", "box.local"})

    def test_ports_for_discovered_names(self):
        h = de.HostAllowList(["demo-server.example-tailnet.ts.net"],
                             discover=lambda: {"demo-server.local", "192.0.2.10", "[fd7a:115c:a1e0::a]"})
        for ok in ("demo-server.local", "demo-server.local:80", "192.0.2.10", "192.0.2.10:80",
                   "[fd7a:115c:a1e0::a]", "[fd7a:115c:a1e0::a]:80",
                   "demo-server.example-tailnet.ts.net", "demo-server.example-tailnet.ts.net:443",
                   "demo-server.example-tailnet.ts.net:80", "127.0.0.1:7682"):
            with self.subTest(host=ok):
                self.assertTrue(h.allows(ok, 7682))
        for bad in ("demo-server.local:8080", "evil.example", "127.0.0.1", "localhost:80",
                    "[2001:db8:1:2::1]", "172.17.0.1", None, ""):
            with self.subTest(host=bad):
                self.assertFalse(h.allows(bad, 7682))

    def test_refresh_picks_up_new_address(self):
        now = [0.0]
        current = [{"192.0.2.10"}]
        h = de.HostAllowList([], discover=lambda: set(current[0]), refresh_s=30, clock=lambda: now[0])
        self.assertTrue(h.allows("192.0.2.10", 7682))
        current[0] = {"192.0.2.50"}
        now[0] = 10
        self.assertFalse(h.allows("192.0.2.50", 7682))      # refresh is rate-limited
        now[0] = 31
        self.assertTrue(h.allows("192.0.2.50", 7682))
        self.assertFalse(h.allows("192.0.2.10", 7682))

    def test_discover_failure_keeps_configured_names(self):
        def boom():
            raise OSError("no /proc")
        h = de.HostAllowList(["demo-server.example-tailnet.ts.net"], discover=boom)
        self.assertTrue(h.allows("demo-server.example-tailnet.ts.net", 7682))
        self.assertFalse(h.allows("demo-server.local", 7682))

    def test_discovered_names_must_be_valid(self):
        h = de.HostAllowList([], discover=lambda: {"good.local", "bad name", "x/y"})
        self.assertTrue(h.allows("good.local", 7682))
        self.assertFalse(h.allows("bad name", 7682))


class HostCheckEndpointTest(unittest.TestCase):
    def setUp(self):
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), de.make_handler(
            de.Grouper(), de.Hub(), allowed_hosts=["demo-server.example-tailnet.ts.net"],
            host_discover=lambda: {"demo-server.local"}))
        self.srv.daemon_threads = True
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (self.srv.shutdown(), self.srv.server_close()))
        self.port = self.srv.server_address[1]

    def req(self, method, path, host):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request(method, path, headers={"Host": host})
        r = c.getresponse()
        return r.status, r.read()

    def test_host_ok_endpoint(self):
        self.assertEqual(self.req("GET", "/_host_ok", "demo-server.local"), (204, b""))
        self.assertEqual(self.req("HEAD", "/_host_ok", "demo-server.local")[0], 204)
        self.assertEqual(self.req("GET", "/_host_ok?x=1", "demo-server.local:80")[0], 204)

    def test_unknown_host_refused_on_check_endpoint(self):
        for path in ("/_host_ok", "/", "/api/units", "/events/recent"):
            with self.subTest(path=path):
                self.assertEqual(self.req("GET", path, "evil.example")[0], 403)

    def test_main_passes_discovery(self):
        self.assertIn("host_discover=", inspect.getsource(de.main))


class RequestTimeoutTest(unittest.TestCase):
    def setUp(self):
        self.hub = de.Hub()
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), de.make_handler(
            de.Grouper(), self.hub, heartbeat_s=0.2, request_timeout=0.3))
        self.srv.daemon_threads = True
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (self.srv.shutdown(), self.srv.server_close()))
        self.port = self.srv.server_address[1]

    def test_default_timeout_is_ten_seconds(self):
        self.assertEqual(de.make_handler(de.Grouper(), de.Hub()).timeout, 10)

    def test_slow_headers_are_cut_off(self):
        started = time.monotonic()
        resp = raw_request(self.port, b"GET /events/recent HTTP/1.1\r\nHost: x", timeout=5)
        self.assertLess(time.monotonic() - started, 3)
        self.assertNotIn(b"200 OK", resp)

    def test_stream_outlives_request_timeout(self):
        import socket
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", "/events/stream")
        r = c.getresponse()
        self.assertEqual(r.status, 200)
        time.sleep(1.0)  # > 3x the request timeout
        lines = [r.readline() for _ in range(6)]
        self.assertIn(b": hb\n", lines)
        for _ in range(50):
            if self.hub.count():
                break
            time.sleep(0.01)
        self.hub.publish({"id": "1-1"})
        got = b""
        for _ in range(20):
            got += r.readline()
            if b"event: upsert" in got:
                break
        self.assertIn(b"event: upsert", got)
        c.close()


class StreamTimeoutAppliedTest(unittest.TestCase):
    def test_stream_resets_connection_timeout_above_request_timeout(self):
        seen = []
        base = de.make_handler(de.Grouper(), de.Hub(), heartbeat_s=0.2, request_timeout=0.3)

        class Spy(base):
            def send_response(self, *a, **k):
                seen.append(self.connection.gettimeout())
                super().send_response(*a, **k)

        srv = ThreadingHTTPServer(("127.0.0.1", 0), Spy)
        srv.daemon_threads = True
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (srv.shutdown(), srv.server_close()))
        c = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=5)
        c.request("GET", "/events/stream")
        self.assertEqual(c.getresponse().status, 200)
        c.close()
        self.assertEqual(len(seen), 1)
        self.assertGreater(seen[0], 0.3 * 10)


class FetchUpstreamCancelTest(unittest.TestCase):
    def test_worker_cancelled_when_deadline_expires_during_connect(self):
        import socket
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        self.addCleanup(listener.close)
        port = listener.getsockname()[1]
        requests = []
        real = de.http.client.HTTPConnection

        class SlowConnect(real):
            def connect(self):
                time.sleep(0.5)  # outlives the 0.1s deadline
                super().connect()

            def request(self, *a, **k):
                requests.append(a)
                return super().request(*a, **k)

        de.http.client.HTTPConnection = SlowConnect
        try:
            with self.assertRaises(TimeoutError):
                de.fetch_upstream(f"http://127.0.0.1:{port}/x", 0.1, 1000)
            for _ in range(100):
                if not any(t.name == "upstream" for t in threading.enumerate()):
                    break
                time.sleep(0.02)
        finally:
            de.http.client.HTTPConnection = real
        self.assertFalse([t for t in threading.enumerate() if t.name == "upstream"])
        self.assertEqual(requests, [])  # cancelled worker never sent the request

    def test_connect_timeout_is_capped_by_deadline(self):
        seen = []
        real = de.http.client.HTTPConnection

        class Spy(real):
            def connect(self):
                seen.append(self.timeout)
                raise OSError("stop")

        de.http.client.HTTPConnection = Spy
        try:
            with self.assertRaises(OSError):
                de.fetch_upstream("http://127.0.0.1:9/x", 2, 1000)
        finally:
            de.http.client.HTTPConnection = real
        self.assertLessEqual(seen[0], 2)


class HubTest(unittest.TestCase):
    def test_slow_subscriber_is_dropped_not_blocking(self):
        hub = de.Hub(queue_size=2)
        q = hub.subscribe()
        for i in range(5):
            hub.publish({"i": i})
        self.assertTrue(q.dropped)
        self.assertEqual(hub.count(), 0)


class JournalFollowerTest(unittest.TestCase):
    def test_reads_entries_from_command_output(self):
        line = jline(MESSAGE="I/O error, dev sdz")
        fake = (sys.executable, "-c", f"print({line!r})")
        got = []
        f = de.JournalFollower(got.append, base_cmd=fake)
        self.addCleanup(f.stop)
        f.start()
        for _ in range(100):
            if got:
                break
            time.sleep(0.02)
        self.assertEqual(got[0]["message"], "I/O error, dev sdz")


class CheckerTest(unittest.TestCase):
    def test_reports_new_problems_once(self):
        with tempfile.NamedTemporaryFile("w", suffix=".mounts", delete=False) as f:
            f.write("/dev/sda2 / ext4 rw 0 0\n")
        failed = json.dumps([{"unit": "bad.service"}])

        class Done:
            stdout = failed

        seen = []
        ck = de.Checker(["/", "/srv/data"], lambda k, m: seen.append(k), mounts_path=f.name,
                        run=lambda *a, **kw: Done())
        ck.check_once()
        ck.check_once()
        self.assertEqual(seen, ["mount-missing:/srv/data", "unit-failed:bad.service"])
        Done.stdout = "[]"
        ck.check_once()
        Done.stdout = failed
        ck.check_once()
        self.assertEqual(seen[-1], "unit-failed:bad.service")
        self.assertEqual(len(seen), 3)


class ResilienceTest(unittest.TestCase):
    def test_follower_survives_on_entry_exception(self):
        code = f"print({jline(MESSAGE='first')!r}); print({jline(MESSAGE='second')!r})"
        got = []

        def on_entry(e):
            if e["message"] == "first":
                raise RuntimeError("boom")
            got.append(e["message"])

        with contextlib.redirect_stderr(io.StringIO()):
            f = de.JournalFollower(on_entry, base_cmd=(sys.executable, "-c", code), retry_s=60)
            self.addCleanup(f.stop)
            f.start()
            for _ in range(100):
                if got:
                    break
                time.sleep(0.02)
        self.assertEqual(got[0], "second")

    def test_cursor_cleared_when_journalctl_exits_fast(self):
        code = f"import sys; print({jline(MESSAGE='x')!r}.replace('\"x\"', '\"' + ' '.join(sys.argv[1:]) + '\"'))"
        got = []
        f = de.JournalFollower(lambda e: got.append(e["message"]), base_cmd=(sys.executable, "-c", code),
                               retry_s=0.05)
        self.addCleanup(f.stop)
        f.start()
        for _ in range(150):
            if len(got) >= 2:
                break
            time.sleep(0.02)
        self.assertGreaterEqual(len(got), 2)
        self.assertIn("--since", got[1])
        self.assertNotIn("--after-cursor", got[1])

    def test_stop_ends_the_respawn_loop(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        log = os.path.join(tmp.name, "runs")
        code = f"open({log!r}, 'a').write('x')"
        f = de.JournalFollower(lambda e: None, base_cmd=(sys.executable, "-c", code), retry_s=0.02)
        f.start()
        time.sleep(0.5)
        f.stop()
        f.join(5)
        self.assertFalse(f.is_alive())
        with open(log) as fh:
            n = len(fh.read())
        self.assertGreater(n, 0)
        time.sleep(0.3)
        with open(log) as fh:
            self.assertEqual(len(fh.read()), n)

    def test_checker_reports_own_failure_once(self):
        seen = []
        ck = de.Checker(["/"], lambda k, m: seen.append((k, m)), mounts_path="/nonexistent/mounts")
        with contextlib.redirect_stderr(io.StringIO()):
            ck.tick()
            ck.tick()
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0][0], "checker-error")
        self.assertIn("FileNotFoundError", seen[0][1])


class StaticServeTest(unittest.TestCase):
    def setUp(self):
        import tempfile, pathlib
        self.tmp = tempfile.TemporaryDirectory()
        base = pathlib.Path(self.tmp.name).resolve()
        self.www = base / "www"
        (self.www / "js").mkdir(parents=True)
        (self.www / "sub").mkdir()
        (self.www / "index.html").write_text("<h1>hi</h1>")
        (self.www / "js" / "x.js").write_text("export {}")
        (self.www / "notes.txt").write_text("nope")
        (base / "secret.txt").write_text("secret")
        (self.www / "out.html").symlink_to(base / "secret.txt")
        (self.www / "in.html").symlink_to(self.www / "index.html")
        self.grouper, self.hub = de.Grouper(), de.Hub()
        self.srv = self._serve(str(self.www))
        self.port = self.srv.server_address[1]

    def _serve(self, www):
        srv = ThreadingHTTPServer(("127.0.0.1", 0), de.make_handler(self.grouper, self.hub, www=www))
        srv.daemon_threads = True
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (srv.shutdown(), srv.server_close()))
        return srv

    def get(self, path, headers=None, port=None):
        c = http.client.HTTPConnection("127.0.0.1", port or self.port, timeout=5)
        c.request("GET", path, headers=headers or {})
        r = c.getresponse()
        r.body = r.read()
        return r

    def tearDown(self):
        self.tmp.cleanup()

    def test_root_serves_index(self):
        r = self.get("/")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.body, b"<h1>hi</h1>")
        self.assertEqual(r.getheader("Content-Type"), "text/html; charset=utf-8")
        self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")
        self.assertEqual(r.getheader("Cache-Control"), "no-cache")

    def test_js_content_type(self):
        r = self.get("/js/x.js")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader("Content-Type"), "text/javascript; charset=utf-8")

    def test_traversal_refused(self):
        for p in ("/../etc/passwd", "/%2e%2e/etc/passwd", "/js/%2e%2e/%2e%2e/secret.txt", "/..%2fsecret.txt"):
            self.assertEqual(self.get(p).status, 404, p)

    def test_symlink_outside_refused_inside_allowed(self):
        self.assertEqual(self.get("/out.html").status, 404)
        r = self.get("/in.html")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.body, b"<h1>hi</h1>")

    def test_directory_and_extension_refused(self):
        self.assertEqual(self.get("/sub").status, 404)
        self.assertEqual(self.get("/sub/").status, 404)
        self.assertEqual(self.get("/js").status, 404)
        self.assertEqual(self.get("/notes.txt").status, 404)

    def test_query_string_ignored(self):
        self.assertEqual(self.get("/js/x.js?v=3").status, 200)

    def test_api_lookalikes_404(self):
        for p in ("/api/4/all/x", "/api/4/allx", "/api/4/cpu", "/api/4/", "/events/nope"):
            self.assertEqual(self.get(p).status, 404, p)

    def test_cross_site_static_ok_events_refused(self):
        h = {"Sec-Fetch-Site": "cross-site"}
        self.assertEqual(self.get("/", h).status, 200)
        self.assertEqual(self.get("/events/recent", h).status, 403)

    def test_static_security_headers(self):
        r = self.get("/")
        self.assertEqual(r.getheader("X-Frame-Options"), "DENY")
        self.assertEqual(r.getheader("Referrer-Policy"), "no-referrer")
        csp = r.getheader("Content-Security-Policy")
        self.assertEqual(csp, de.STATIC_CSP)
        self.assertIn("frame-ancestors 'none'", csp)
        r404 = self.get("/nope.html")
        self.assertEqual(r404.status, 404)
        self.assertEqual(r404.getheader("X-Frame-Options"), "DENY")

    def test_static_csp_matches_index_meta_policy(self):
        index = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "www", "index.html")
        with open(index, encoding="utf-8") as f:
            meta = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', f.read()).group(1)
        self.assertEqual(de.STATIC_CSP, meta + "; frame-ancestors 'none'")

    def test_csp_allows_self_hosted_fonts(self):
        self.assertIn("font-src 'self';", de.STATIC_CSP)
        self.assertIn("style-src 'self';", de.STATIC_CSP)
        self.assertNotIn("https:", de.STATIC_CSP)   # nothing is loaded from other sites

    def test_nul_byte_refused(self):
        for p in ("/index.html%00", "/index.html%00.js", "/%00", "/js/x.js%00.html"):
            self.assertEqual(self.get(p).status, 404, p)

    def test_sibling_dir_with_common_prefix_refused(self):
        evil = self.www.parent / "www-evil"
        evil.mkdir()
        (evil / "x.html").write_text("evil")
        (self.www / "evil.html").symlink_to(evil / "x.html")
        for p in ("/../www-evil/x.html", "/%2e%2e/www-evil/x.html", "/evil.html"):
            self.assertEqual(self.get(p).status, 404, p)

    def test_each_allowed_mime_type(self):
        want = {".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
                ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2"}
        for ext, ctype in want.items():
            with self.subTest(ext=ext):
                (self.www / f"f{ext}").write_bytes(b"data")
                r = self.get(f"/f{ext}")
                self.assertEqual(r.status, 200)
                self.assertEqual(r.getheader("Content-Type"), ctype)
                self.assertEqual(r.body, b"data")

    def head(self, path):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("HEAD", path)
        r = c.getresponse()
        r.body = r.read()
        return r

    def test_head_static_matches_get_without_body(self):
        for path in ("/", "/js/x.js", "/nope.html", "/notes.txt", "/out.html"):
            with self.subTest(path=path):
                g, h = self.get(path), self.head(path)
                self.assertEqual(h.status, g.status)
                self.assertEqual(h.body, b"")
                for name in ("Content-Type", "Content-Length", "Cache-Control", "X-Content-Type-Options",
                             "Content-Security-Policy", "X-Frame-Options", "Referrer-Policy"):
                    self.assertEqual(h.getheader(name), g.getheader(name), name)

    def test_other_methods_on_static_get_allow(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("POST", "/", body=b"x")
        r = c.getresponse()
        self.assertEqual(r.status, 405)
        self.assertEqual(r.getheader("Allow"), "GET, HEAD")

    def test_disabled_without_www(self):
        srv = self._serve(None)
        self.assertEqual(self.get("/", port=srv.server_address[1]).status, 404)


class MainArgsTest(unittest.TestCase):
    def test_checker_reads_host_mount_table(self):
        self.assertEqual(de.HOST_MOUNTS, "/proc/1/mounts")
        self.assertIn("mounts_path=HOST_MOUNTS", inspect.getsource(de.main))

    def test_allowed_host_option_is_repeatable(self):
        ns = de.parse_args(["--allowed-host", "a.ts.net", "--allowed-host", "b.ts.net"])
        self.assertEqual(ns.allowed_host, ["a.ts.net", "b.ts.net"])
        self.assertEqual(de.parse_args([]).allowed_host, [])
        self.assertIn("allowed_hosts=args.allowed_host", inspect.getsource(de.main))



    def test_refuses_non_loopback_bind(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            de.main(["--host", "0.0.0.0", "--port", "0"])


import os
from http.server import BaseHTTPRequestHandler


def _walk_keys(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from _walk_keys(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk_keys(v)


SAMPLE = {
    "cpu": {"total": 12.5, "user": 3},
    "mem": {"total": 8, "used": 4, "available": 3, "buffers": 1},
    "memswap": {"total": 2, "percent": 10, "sin": 5},
    "load": {"min1": 1, "min5": 2, "min15": 3, "cpucore": 4},
    "processcount": {"total": 200, "running": 2, "sleeping": 198},
    "uptime": "3 days, 4:05:06",
    "fs": [{"mnt_point": "/", "size": 10, "used": 5, "free": 5, "percent": 50, "device_name": "/dev/sda2"}],
    "network": [{"interface_name": "eth0", "bytes_recv_rate_per_sec": 1, "bytes_sent_rate_per_sec": 2, "alias": None}],
    "sensors": [{"label": "Package id 0", "value": 55, "unit": "C", "warning": 80}],
    "containers": [{"name": "busybox", "status": "running", "image": ["demo/busybox"], "uptime": "2 days",
                    "cpu": {"total": 1.5, "system": 9}, "memory": {"usage": 100, "limit": 999},
                    "command": "./app -email someone@example.com -pass hunter2", "ports": "0.0.0.0:80", "id": "abc"}],
    "processlist": [{"cmdline": ["secret"]}],
    "system": {"hostname": "x"},
}


ALLOWED = {
    "cpu": {"total"}, "mem": {"total", "used", "available"}, "memswap": {"total", "percent"},
    "load": {"min1", "min5", "min15"}, "processcount": {"total", "running"},
    "fs": {"mnt_point", "device_name", "fs_type", "size", "used", "free", "percent"},
    "gpu": {"name", "proc", "mem", "temperature"},
    "network": {"interface_name", "bytes_recv_rate_per_sec", "bytes_sent_rate_per_sec"},
    "sensors": {"label", "value", "unit"},
    "containers": {"name", "id", "status", "image", "uptime", "cpu", "memory", "ports"},
}


class FilterGlancesKeepsWhatThePageUsesTest(unittest.TestCase):
    """The page reads these fields; the proxy must pass them (and only safe forms of them)."""

    def test_gpu_container_id_and_filesystem_identity(self):
        out = de.filter_glances({
            "gpu": [{"name": "Demo GPU", "proc": 12.5, "mem": 40, "temperature": 55, "fan_speed": 30, "secret": "x"}],
            "containers": [{"name": "nginx", "id": "f6747af2c86cb9e08a1f" * 4, "status": "running", "command": "x --pw=1"}],
            "fs": [{"mnt_point": "/", "device_name": "/dev/sda1", "fs_type": "ext4", "size": 1, "used": 1, "free": 0,
                    "percent": 100, "options": "rw"}]})
        self.assertEqual(out["gpu"], [{"name": "Demo GPU", "proc": 12.5, "mem": 40, "temperature": 55}])
        self.assertEqual(out["containers"][0]["id"], ("f6747af2c86cb9e08a1f" * 4)[:64])
        self.assertNotIn("command", out["containers"][0])
        self.assertEqual((out["fs"][0]["device_name"], out["fs"][0]["fs_type"]), ("/dev/sda1", "ext4"))
        self.assertNotIn("options", out["fs"][0])

    def test_a_non_hex_container_id_is_dropped(self):
        out = de.filter_glances({"containers": [{"name": "a", "id": "<script>"}]})
        self.assertNotIn("id", out["containers"][0])

    def test_auto_tile_port_is_the_lowest_web_like_port(self):
        self.assertEqual(de._host_ports("0.0.0.0:8443->443/tcp, 0.0.0.0:80->80/tcp"), [80, 8443])
        self.assertEqual(de._host_ports("0.0.0.0:53->53/tcp, 0.0.0.0:53->53/udp, 0.0.0.0:8053->80/tcp"), [8053, 53])
        self.assertEqual(de._host_ports("0.0.0.0:5432->5432/tcp"), [5432])   # only non-web ports: still listed


class FilterGlancesTest(unittest.TestCase):
    def test_keeps_exactly_the_allow_list(self):
        self.assertEqual(de.filter_glances(SAMPLE), {
            "cpu": {"total": 12.5},
            "mem": {"total": 8, "used": 4, "available": 3},
            "memswap": {"total": 2, "percent": 10},
            "load": {"min1": 1, "min5": 2, "min15": 3},
            "processcount": {"total": 200, "running": 2},
            "uptime": "3 days, 4:05:06",
            "fs": [{"mnt_point": "/", "device_name": "/dev/sda2", "size": 10, "used": 5, "free": 5, "percent": 50}],
            "network": [{"interface_name": "eth0", "bytes_recv_rate_per_sec": 1, "bytes_sent_rate_per_sec": 2}],
            "sensors": [{"label": "Package id 0", "value": 55, "unit": "C"}],
            "containers": [{"name": "busybox", "status": "running", "image": ["demo/busybox"],
                            "uptime": "2 days", "cpu": {"total": 1.5}, "memory": {"usage": 100}}],
        })

    def test_never_contains_command_or_credentials(self):
        out = json.dumps(de.filter_glances(SAMPLE))
        for needle in ("command", "hunter2", "someone@example.com", "processlist", "cmdline", "ports"):
            self.assertNotIn(needle, out)

    def test_tolerates_wrong_types(self):
        self.assertEqual(de.filter_glances({"cpu": 5, "fs": "x", "containers": [1, None, {"name": "a"}], "uptime": 7}),
                         {"fs": [], "containers": [{"name": "a"}]})
        self.assertEqual(de.filter_glances([]), {})

    def test_live_fixture_survives_filter_without_command_keys(self):
        path = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "glances-all.json")
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        for c in data["containers"]:
            c["command"] = "x -pass hunter2"
            c["Config"] = {"Env": ["SECRET=1"]}
        out = de.filter_glances(data)
        dumped = json.dumps(out)
        for needle in ("hunter2", "SECRET", "command"):
            self.assertNotIn(needle, dumped)
        self.assertTrue(out["containers"])
        self.assertTrue(any(fs["mnt_point"] == "/srv/data" for fs in out["fs"]))
        for section, allowed in ALLOWED.items():
            rows = out.get(section, [])
            for row in (rows if isinstance(rows, list) else [rows]):
                self.assertLessEqual(set(row), allowed, section)

    def test_non_scalar_leaves_dropped(self):
        out = de.filter_glances({"containers": [
            {"name": "a", "image": {"cmd": "secret"}},
            {"name": ["x", {"pass": "y"}], "status": {"a": 1}},
            {"name": "b", "image": ["a", {"b": 1}]},
            {"name": "c", "image": [{"b": 1}]},
            {"name": "d", "uptime": True, "cpu": {"total": {"x": 1}}},
        ]})
        self.assertEqual(out["containers"], [
            {"name": "a"}, {}, {"name": "b", "image": ["a"]}, {"name": "c"}, {"name": "d", "cpu": {}}])

    def test_long_strings_truncated(self):
        out = de.filter_glances({"containers": [{"name": "n" * 600, "image": ["i" * 600]}]})
        self.assertEqual(len(out["containers"][0]["name"]), 512)
        self.assertEqual(len(out["containers"][0]["image"][0]), 512)


class HostPortsTest(unittest.TestCase):
    def test_host_ports_real_world_variants(self):
        table = [
            ("3001->3001/tcp", [3001]),
            ("0.0.0.0:8097->8096/tcp, :::8097->8096/tcp", [8097]),
            ("[::]:9000->9000/tcp", [9000]),
            ("8000-8002->8000-8002/tcp", [8000]),
            ("53->53/udp", None),
            ("80/tcp", None),
            ("", None),
            ("abc->1/tcp, 70000->1/tcp, 0->1/tcp", None),
            (", ".join(f"{p}->{p}/tcp" for p in range(1000, 1020)), list(range(1000, 1008))),
            (["3001->3001/tcp"], None), ({"a": 1}, None), (None, None), (3001, None),
        ]
        for raw, want in table:
            self.assertEqual(de._host_ports(raw), want, raw)

    def test_container_ports_pass_as_ints_only(self):
        out = de.filter_glances({"containers": [
            {"name": "k", "ports": "0.0.0.0:3001->3001/tcp", "command": "x -pass hunter2"},
            {"name": "h", "ports": ""}]})
        self.assertEqual(out["containers"], [{"name": "k", "ports": [3001]}, {"name": "h"}])
        self.assertNotIn("hunter2", json.dumps(out))


def _fake_systemctl(stdout="", rc=0, exc=None):
    calls = []

    def run(argv, **kw):
        calls.append((argv, kw))
        if exc:
            raise exc
        return subprocess.CompletedProcess(argv, rc, stdout=stdout, stderr="")
    return run, calls


BOND_ETH_ACTIVE = """Ethernet Channel Bonding Driver: v6.8.0

Bonding Mode: fault-tolerance (active-backup) (fail_over_mac active)
Primary Slave: enp3s0 (primary_reselect always)
Currently Active Slave: enp3s0
MII Status: up
MII Polling Interval (ms): 100

Slave Interface: enp3s0
MII Status: up
Speed: 1000 Mbps
Duplex: full
Link Failure Count: 1

Slave Interface: wlp2s0
MII Status: up
Speed: Unknown
Link Failure Count: 0
"""


class BondingTest(unittest.TestCase):
    def test_parses_active_port_and_link_states(self):
        self.assertEqual(de.parse_bonding(BOND_ETH_ACTIVE), {
            "active": "enp3s0",
            "ports": [{"name": "enp3s0", "up": True}, {"name": "wlp2s0", "up": True}],
        })

    def test_failover_to_wifi_with_cable_down(self):
        text = BOND_ETH_ACTIVE.replace("Currently Active Slave: enp3s0", "Currently Active Slave: wlp2s0")
        text = text.replace("Slave Interface: enp3s0\nMII Status: up", "Slave Interface: enp3s0\nMII Status: down")
        self.assertEqual(de.parse_bonding(text), {
            "active": "wlp2s0",
            "ports": [{"name": "enp3s0", "up": False}, {"name": "wlp2s0", "up": True}],
        })

    def test_no_active_port(self):
        text = BOND_ETH_ACTIVE.replace("Currently Active Slave: enp3s0", "Currently Active Slave: None")
        self.assertIsNone(de.parse_bonding(text)["active"])

    def test_rejects_odd_names_and_garbage(self):
        text = BOND_ETH_ACTIVE.replace("Slave Interface: wlp2s0", "Slave Interface: <script>x</script>")
        self.assertEqual([p["name"] for p in de.parse_bonding(text)["ports"]], ["enp3s0"])
        self.assertEqual(de.parse_bonding("nonsense\n\x00"), {"active": None, "ports": []})

    def test_read_bonds_from_directory(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "bond0"), "w") as f:
                f.write(BOND_ETH_ACTIVE)
            with open(os.path.join(d, "bad name!"), "w") as f:
                f.write(BOND_ETH_ACTIVE)
            self.assertEqual(de.read_bonds(d), [{"name": "bond0", **de.parse_bonding(BOND_ETH_ACTIVE)}])

    def test_read_bonds_missing_directory_is_empty(self):
        self.assertEqual(de.read_bonds("/nonexistent/bonding"), [])


class GlancesProxyTest(unittest.TestCase):
    def _serve(self, handler_cls):
        srv = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        srv.daemon_threads = True
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        return srv.server_address[1]

    def _get(self, port):
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        c.request("GET", "/api/4/all")
        r = c.getresponse()
        return r.status, r.getheader("Content-Type"), json.loads(r.read())

    def test_proxies_and_filters(self):
        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                body = json.dumps(SAMPLE).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        up = self._serve(Upstream)
        port = self._serve(de.make_handler(de.Grouper(), de.Hub(), glances_url=f"http://127.0.0.1:{up}/api/4/all"))
        status, ctype, body = self._get(port)
        self.assertEqual((status, ctype), (200, "application/json"))
        self.assertEqual(body["containers"][0]["name"], "busybox")
        self.assertNotIn("command", body["containers"][0])

    def test_attaches_bond_state(self):
        import tempfile

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                body = json.dumps(SAMPLE).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        up = self._serve(Upstream)
        url = f"http://127.0.0.1:{up}/api/4/all"
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "bond0"), "w") as f:
                f.write(BOND_ETH_ACTIVE)
            port = self._serve(de.make_handler(de.Grouper(), de.Hub(), glances_url=url, bonding_dir=d))
            _, _, body = self._get(port)
        self.assertEqual(body["bond"], [{"name": "bond0", "active": "enp3s0",
                                          "ports": [{"name": "enp3s0", "up": True}, {"name": "wlp2s0", "up": True}]}])
        port = self._serve(de.make_handler(de.Grouper(), de.Hub(), glances_url=url, bonding_dir="/nonexistent"))
        self.assertNotIn("bond", self._get(port)[2])

    def test_upstream_down_is_502(self):
        port = self._serve(de.make_handler(de.Grouper(), de.Hub(), glances_url="http://127.0.0.1:9/api/4/all"))
        status, _, body = self._get(port)
        self.assertEqual(status, 502)
        self.assertEqual(body, {"error": "glances unreachable"})

    def test_502_headers(self):
        port = self._serve(de.make_handler(de.Grouper(), de.Hub(), glances_url="http://127.0.0.1:9/api/4/all"))
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        c.request("GET", "/api/4/all")
        r = c.getresponse()
        r.read()
        self.assertEqual(r.getheader("Content-Type"), "application/json")
        self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")

    def test_garbage_upstream_is_502(self):
        import socketserver

        class Garbage(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.recv(1024)
                self.request.sendall(b"\x00\xffnot http at all\r\n\r\n")

        srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Garbage)
        srv.daemon_threads = True
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        port = self._serve(de.make_handler(
            de.Grouper(), de.Hub(), glances_url=f"http://127.0.0.1:{srv.server_address[1]}/api/4/all"))
        status, _, body = self._get(port)
        self.assertEqual((status, body), (502, {"error": "glances unreachable"}))

    def test_oversized_upstream_is_502(self):
        class Big(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                body = b'{"x": "' + b"a" * (4 * 1024 * 1024 + 10) + b'"}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        up = self._serve(Big)
        port = self._serve(de.make_handler(de.Grouper(), de.Hub(), glances_url=f"http://127.0.0.1:{up}/api/4/all"))
        self.assertEqual(self._get(port)[0], 502)

    def test_trickling_upstream_hits_total_deadline(self):
        import socketserver

        class Trickle(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.recv(1024)
                try:
                    self.request.sendall(b"HTTP/1.0 200 OK\r\nContent-Length: 1000\r\n\r\n")
                    for _ in range(100):  # one byte every 0.2 s: each read is fast, the total is not
                        self.request.sendall(b" ")
                        time.sleep(0.2)
                except OSError:
                    pass

        srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Trickle)
        srv.daemon_threads = True
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        port = self._serve(de.make_handler(
            de.Grouper(), de.Hub(), glances_url=f"http://127.0.0.1:{srv.server_address[1]}/api/4/all",
            glances_deadline_s=1))
        started = time.monotonic()
        status, _, body = self._get(port)
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual((status, body), (502, {"error": "glances unreachable"}))

    def test_default_glances_deadline_is_four_seconds(self):
        self.assertEqual(inspect.signature(de.make_handler).parameters["glances_deadline_s"].default, 4)

    def test_upstream_error_status_is_502(self):
        class Err(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                body = json.dumps(SAMPLE).encode()
                self.send_response(500)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        up = self._serve(Err)
        port = self._serve(de.make_handler(de.Grouper(), de.Hub(), glances_url=f"http://127.0.0.1:{up}/api/4/all"))
        self.assertEqual(self._get(port)[0], 502)

    def test_api_all_refuses_cross_site(self):
        port = self._serve(de.make_handler(de.Grouper(), de.Hub(), glances_url="http://127.0.0.1:9/api/4/all"))
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        c.request("GET", "/api/4/all", headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(c.getresponse().status, 403)


if __name__ == "__main__":
    unittest.main()


class QuickLaunchParseTest(unittest.TestCase):
    def test_container_entry(self):
        tiles, problems = de.parse_quicklaunch("[Media]\ncontainer = nginx\nport = 8080\ndesc = Web\n")
        self.assertEqual(tiles, [{"name": "Media", "container": "nginx", "port": 8080, "desc": "Web"}])
        self.assertEqual(problems, [])

    def test_port_only_entry_and_comments(self):
        tiles, problems = de.parse_quicklaunch("# my tiles\n[NAS]\n; admin page\nport = 5000\n")
        self.assertEqual(tiles, [{"name": "NAS", "container": None, "port": 5000, "desc": ""}])
        self.assertEqual(problems, [])

    def test_bad_entries_are_skipped_and_named_good_ones_kept(self):
        text = "[Good]\nport = 1\n[Bad]\nport = abc\n[Empty]\ndesc = x\n[Odd]\nport = 2\ncolour = red\n[High]\nport = 70000\n"
        tiles, problems = de.parse_quicklaunch(text)
        self.assertEqual([t["name"] for t in tiles], ["Good", "Odd"])
        joined = "\n".join(problems)
        for want in ("[Bad]", "[Empty]", "[Odd] unknown key colour", "[High]"):
            self.assertIn(want, joined)
        self.assertTrue(all(p.startswith("quicklaunch: ") for p in problems))

    def test_unparseable_file(self):
        tiles, problems = de.parse_quicklaunch("port = 80 without a section\n")
        self.assertEqual(tiles, [])
        self.assertEqual(len(problems), 1)
        self.assertTrue(problems[0].startswith("quicklaunch: line 1: "))

    def test_one_bad_line_keeps_every_other_tile_and_names_the_line(self):
        text = "stray text\n[Good]\nport = 8080\nport 9000\n[Also]\nport = 81\n"
        tiles, problems = de.parse_quicklaunch(text)
        self.assertEqual([(t["name"], t["port"]) for t in tiles], [("Good", 8080), ("Also", 81)])
        self.assertEqual(len(problems), 2, problems)
        self.assertIn("line 1", problems[0])
        self.assertIn("line 4", problems[1])
        self.assertIn("port 9000", problems[1])

    def test_a_repeated_section_is_named_and_the_first_one_wins(self):
        tiles, problems = de.parse_quicklaunch("[A]\nport = 80\n[A]\ncontainer = x\n")
        self.assertEqual(tiles, [{"name": "A", "container": None, "port": 80, "desc": ""}])
        self.assertTrue(any("[A]" in p and "line 3" in p and "twice" in p for p in problems), problems)

    def test_inline_comments(self):
        tiles, problems = de.parse_quicklaunch("[Web]\nport = 8080   # the main one\ndesc = home # page\n")
        self.assertEqual(tiles[0]["port"], 8080)
        self.assertEqual(tiles[0]["desc"], "home")
        self.assertEqual(problems, [])

    def test_at_most_64_tiles(self):
        tiles, problems = de.parse_quicklaunch("".join(f"[T{i}]\nport = {i + 1}\n" for i in range(70)))
        self.assertEqual(len(tiles), 64)
        self.assertTrue(any("64" in p for p in problems))


class IgnoreParseTest(unittest.TestCase):
    def test_lines(self):
        self.assertEqual(de.parse_ignore("# hidden\nnginx\n\n  whoami  \n#postgres\nf6747af2c86c\n"),
                         ["nginx", "whoami", "f6747af2c86c"])

    def test_limits(self):
        got = de.parse_ignore("".join(f"c{i}\n" for i in range(300)) + "x" * 200 + "\n")
        self.assertEqual(len(got), 256)
        self.assertTrue(all(len(x) <= 128 for x in got))


class MutesParseTest(unittest.TestCase):
    def test_sections(self):
        mutes, problems = de.parse_mutes("[pam]\npattern = pam_unix\\(.*:session\\): session (opened|closed)\n"
                                         "[kernel]\nsource = kernel\npattern = 100% sure\n[Src only]\nsource = cron\n")
        self.assertEqual(mutes, [{"pattern": "pam_unix\\(.*:session\\): session (opened|closed)"},
                                 {"source": "kernel", "pattern": "100% sure"}, {"source": "cron"}])
        self.assertEqual(problems, [])

    def test_a_bad_line_keeps_the_other_rules(self):
        mutes, problems = de.parse_mutes("[a]\nsource = cron\nthis is not a setting\n[b]\npattern = x # y\n")
        self.assertEqual(mutes, [{"source": "cron"}, {"pattern": "x # y"}])   # '#' may be part of a regex
        self.assertEqual(len(problems), 1)
        self.assertTrue(problems[0].startswith("mutes: line 3: "), problems)

    def test_bad_regex_and_empty_section(self):
        mutes, problems = de.parse_mutes("[bad]\npattern = (\n[empty]\n[ok]\nsource = x\n")
        self.assertEqual(mutes, [{"source": "x"}])
        joined = "\n".join(problems)
        self.assertIn("[bad]", joined)
        self.assertIn("[empty]", joined)
        self.assertTrue(all(p.startswith("mutes: ") for p in problems))


class HostFactsTest(unittest.TestCase):
    def cpuinfo(self, text):
        d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, d, True)
        p = os.path.join(d, "cpuinfo")
        with open(p, "w") as f:
            f.write(text)
        return p

    def test_x86(self):
        p = self.cpuinfo("".join(f"processor\t: {i}\nmodel name\t: Demo CPU @ 2.00GHz\n\n" for i in range(4)))
        self.assertEqual(de.host_facts(hostname="box", cpuinfo_path=p, user="demo"),
                         {"name": "box", "user": "demo", "cpu": "Demo CPU @ 2.00GHz · 4 threads"})

    def test_arm_without_model_name(self):
        p = self.cpuinfo("processor\t: 0\nBogoMIPS\t: 108\n\nprocessor\t: 1\nBogoMIPS\t: 108\n\n")
        cpu = de.host_facts(hostname="pi", cpuinfo_path=p, user="demo")["cpu"]
        self.assertEqual(cpu, platform.machine() + " · 2 threads")

    def test_missing_cpuinfo(self):
        facts = de.host_facts(hostname="box", cpuinfo_path="/nonexistent", user="demo")
        self.assertEqual(facts["name"], "box")
        self.assertTrue(facts["cpu"])

    def test_defaults_come_from_the_machine(self):
        facts = de.host_facts()
        self.assertEqual(facts["name"], socket.gethostname())
        self.assertTrue(facts["user"])


class UserSettingsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, self.dir, True)
        self.now = [0.0]

    def settings(self, d=None):
        return de.UserSettings(d or self.dir, "1.2.3", clock=lambda: self.now[0])

    def write(self, name, text, mtime):
        p = os.path.join(self.dir, name)
        with open(p, "w") as f:
            f.write(text)
        os.utime(p, (mtime, mtime))

    def test_missing_dir_is_empty_and_quiet(self):
        got = self.settings("/nonexistent/dir").get()
        self.assertEqual((got["quicklaunch"], got["ignore"], got["mutes"], got["problems"]), ([], [], [], []))
        self.assertEqual(got["version"], "1.2.3")
        self.assertEqual(set(got), {"version", "host", "quicklaunch", "ignore", "mutes", "problems", "docker"})
        self.assertIsInstance(got["docker"], bool)

    def test_reads_files_and_follows_edits(self):
        self.write("ignore", "nginx\n", 1000)
        self.write("quicklaunch", "[A]\nport = 1\n", 1000)
        s = self.settings()
        self.assertEqual(s.get()["ignore"], ["nginx"])
        self.write("ignore", "whoami\n", 2000)
        self.assertEqual(s.get()["ignore"], ["nginx"])      # re-checked at most every 2 s
        self.now[0] = 3
        self.assertEqual(s.get()["ignore"], ["whoami"])
        self.assertEqual(s.get()["quicklaunch"][0]["name"], "A")

    def test_unreadable_file_is_a_problem_not_a_crash(self):
        os.mkdir(os.path.join(self.dir, "quicklaunch"))      # a directory where a file should be
        got = self.settings().get()
        self.assertEqual(got["quicklaunch"], [])
        self.assertTrue(any(p.startswith("quicklaunch: ") for p in got["problems"]))

    def test_problems_from_every_file(self):
        self.write("quicklaunch", "[Bad]\nport = x\n", 1)
        self.write("mutes", "[m]\npattern = (\n", 1)
        probs = self.settings().get()["problems"]
        self.assertTrue(any(p.startswith("quicklaunch: ") for p in probs))
        self.assertTrue(any(p.startswith("mutes: ") for p in probs))


class PortProbeTest(unittest.TestCase):
    def test_up_down_and_cache(self):
        lsock = socket.socket(); lsock.bind(("127.0.0.1", 0)); lsock.listen(4)
        self.addCleanup(lsock.close)
        up = lsock.getsockname()[1]
        closed = socket.socket(); closed.bind(("127.0.0.1", 0)); down = closed.getsockname()[1]; closed.close()
        calls = []
        now = [0.0]
        probe = de.PortProbe(lambda: calls.append(1) or [up, down], ttl_s=10, clock=lambda: now[0])
        self.assertEqual(probe.states(), {str(up): "up", str(down): "down"})
        probe.states()
        self.assertEqual(len(calls), 1)                      # cached within ttl
        now[0] = 11
        probe.states()
        self.assertEqual(len(calls), 2)

    def test_ports_fn_failure_is_empty(self):
        self.assertEqual(de.PortProbe(lambda: 1 / 0).states(), {})


class SettingsEndpointTest(unittest.TestCase):
    def _serve(self, **kw):
        srv = ThreadingHTTPServer(("127.0.0.1", 0), de.make_handler(de.Grouper(), de.Hub(), **kw))
        srv.daemon_threads = True
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        return srv.server_address[1]

    def _get(self, port, path, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        c.request("GET", path, headers=headers or {})
        r = c.getresponse()
        return r, r.read()

    def test_settings_and_ports(self):
        class S:
            def get(self):
                return {"version": "1.0.0", "quicklaunch": []}

        class P:
            def states(self):
                return {"5000": "up"}
        port = self._serve(settings=S(), ports=P())
        r, body = self._get(port, "/api/settings")
        self.assertEqual((r.status, json.loads(body)["version"]), (200, "1.0.0"))
        self.assertEqual(r.getheader("Cache-Control"), "no-store")
        r, body = self._get(port, "/api/ports")
        self.assertEqual((r.status, json.loads(body)), (200, {"5000": "up"}))
        for path in ("/api/settings", "/api/ports"):
            r, _ = self._get(port, path, {"Host": "evil.example"})
            self.assertEqual(r.status, 403)
            r, _ = self._get(port, path, {"Sec-Fetch-Site": "cross-site"})
            self.assertEqual(r.status, 403)

    def test_unconfigured_endpoints_and_units_gone(self):
        port = self._serve()
        self.assertEqual(json.loads(self._get(port, "/api/settings")[1]), {})
        self.assertEqual(json.loads(self._get(port, "/api/ports")[1]), {})
        self.assertEqual(self._get(port, "/api/units")[0].status, 404)

    def test_cli_paths(self):
        a = de.parse_args(["--config-dir", "/x", "--version-file", "/v"])
        self.assertEqual((a.config_dir, a.version_file), ("/x", "/v"))
        b = de.parse_args([])
        self.assertTrue(b.config_dir.endswith(os.path.join(".config", "home-server-dashboard")))
        self.assertTrue(b.version_file.endswith("VERSION"))
