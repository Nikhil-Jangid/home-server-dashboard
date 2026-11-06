"""Tests for term_login.py (the in-terminal login run by ttyd).

term_login.py runs under `python3 -I`, which drops the script directory from sys.path, so it is a single
file and these tests load it by path. Every test uses throwaway hashes in temp dirs; no real credential.
"""
import hashlib
import importlib.util
import io
import json
import os
import pty
import resource
import signal
import stat
import syslog
import tempfile
import termios
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

_spec = importlib.util.spec_from_file_location("term_login", Path(__file__).with_name("term_login.py"))
tl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tl)

GOOD_PW = "correct horse battery"
SERVICE_USER = "owner"
RCFILE = str(Path(__file__).resolve().with_name("dashboard.bashrc"))


class FakeIO:
    """Stands in for TtyIO. Items are strings to return or exception instances to raise."""

    def __init__(self, lines):
        self.lines = list(lines)
        self.writes = []
        self.discards = 0
        self.reads = []      # (limit, echo, timeout) per read_line call
        self.events = []     # ordered ('write', s) / ('discard',) / ('read', echo)

    def write(self, s):
        self.writes.append(s)
        self.events.append(("write", s))

    def read_line(self, limit, echo, timeout):
        self.reads.append((limit, echo, timeout))
        self.events.append(("read", echo))
        if not self.lines:
            raise EOFError
        item = self.lines.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item

    def discard_pending(self):
        self.discards += 1
        self.events.append(("discard",))


class Clock:
    def __init__(self, t=1_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


class AdvancingSleep:
    """Fake sleep that records its argument and moves the fake clock forward."""

    def __init__(self, clock):
        self.clock = clock
        self.calls = []

    def __call__(self, s):
        self.calls.append(s)
        self.clock.t += s


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.good_hash = tl.hash_password(GOOD_PW)

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = self._tmp.name
        self.hash_path = os.path.join(self.home, ".config", "home-server-dashboard", "term.pass")
        self.state_path = os.path.join(self.home, ".local", "state", "home-server-dashboard", "term-login.json")
        self.clock = Clock()
        self.sleep = AdvancingSleep(self.clock)
        self.logs = []

    def tearDown(self):
        self._tmp.cleanup()

    def write_hash_file(self, content=None, mode=0o600):
        os.makedirs(os.path.dirname(self.hash_path), mode=0o700, exist_ok=True)
        with open(self.hash_path, "w") as f:
            f.write((content if content is not None else self.good_hash) + "\n")
        os.chmod(self.hash_path, mode)

    def throttle(self):
        return tl.Throttle(self.state_path, now=self.clock)

    def log(self, priority, message):
        self.logs.append((priority, message))

    def run_login(self, lines, throttle=None):
        fio = FakeIO(lines)
        ok = tl.login(fio, user=SERVICE_USER, host="box", hash_path=self.hash_path,
                      throttle=throttle or self.throttle(), log=self.log, sleep=self.sleep)
        return ok, fio

    def state(self):
        with open(self.state_path) as f:
            return json.load(f)


class HashTest(Base):
    def test_hash_format_round_trip(self):
        h = tl.hash_password("correct horse battery")
        self.assertRegex(h, r"^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$")
        self.assertTrue(tl.verify_password("correct horse battery", h))
        self.assertFalse(tl.verify_password("correct horse batterY", h))
        for bad in ["", "scrypt$1$8$1$AA==$AA==", "scrypt$33554432$8$1$AA==$AA==", "md5$x",
                    h.replace("$8$", "$99$")]:
            with self.subTest(bad=bad):
                self.assertFalse(tl.verify_password("x", bad))

    def test_verify_rejects_malformed_and_out_of_range(self):
        parts = self.good_hash.split("$")
        bad = [
            "$".join(parts[:-1]),                                      # missing field
            self.good_hash + "$extra",                                 # extra field
            "$".join(parts[:1] + ["30000"] + parts[2:]),               # N not a power of 2
            "$".join(parts[:1] + ["8192"] + parts[2:]),                # N below 2**14
            "$".join(parts[:1] + ["2097152"] + parts[2:]),             # N above 2**20
            "$".join(parts[:2] + ["0"] + parts[3:]),                   # r below 1
            "$".join(parts[:3] + ["17"] + parts[4:]),                  # p above 16
            "$".join(parts[:3] + ["-1"] + parts[4:]),                  # signed
            "$".join(parts[:4] + ["not*base64"] + parts[5:]),          # bad salt b64
            "$".join(parts[:5] + ["AAAA"]),                            # wrong hash length
            "SCRYPT" + self.good_hash[6:],                             # wrong scheme case
        ]
        for b in bad:
            with self.subTest(b=b):
                self.assertFalse(tl.verify_password(GOOD_PW, b))

    def test_scrypt_params_need_maxmem(self):
        with self.assertRaises(ValueError):
            hashlib.scrypt(b"x", salt=b"0" * 16, n=2**15, r=8, p=1)     # default maxmem (32 MiB) is too small
        self.assertTrue(tl.verify_password("pw-long-enough", tl.hash_password("pw-long-enough")))

    def test_salt_is_random(self):
        self.assertNotEqual(tl.hash_password("same-password"), tl.hash_password("same-password"))

    def test_constants(self):
        self.assertEqual((tl.HASH_N, tl.HASH_R, tl.HASH_P, tl.SALT_LEN, tl.DKLEN, tl.MAXMEM),
                         (2**15, 8, 1, 16, 32, 64 * 1024 * 1024))
        self.assertEqual((tl.USER_MAX, tl.PASS_MAX, tl.IDLE_S, tl.MAX_TRIES, tl.FAIL_DELAY_S, tl.DECAY_S),
                         (64, 256, 60, 3, 2, 900))
        self.assertEqual(tl.HASH_PATH, os.path.expanduser("~/.config/home-server-dashboard/term.pass"))
        self.assertEqual(tl.STATE_PATH, os.path.expanduser("~/.local/state/home-server-dashboard/term-login.json"))


class LoginFlowTest(Base):
    def setUp(self):
        super().setUp()
        self.write_hash_file()

    def test_wrong_user_and_wrong_password_look_the_same(self):
        real_verify = tl.verify_password
        with mock.patch.object(tl, "verify_password", side_effect=real_verify) as spy:
            ok1, io1 = self.run_login(["root", GOOD_PW, EOFError()])
            ok2, io2 = self.run_login([SERVICE_USER, "wrong password", EOFError()])
        self.assertFalse(ok1)
        self.assertFalse(ok2)
        self.assertEqual(io1.writes, io2.writes)
        self.assertIn("Login incorrect\n", io1.writes)
        self.assertEqual(spy.call_count, 2)
        self.assertEqual(self.state()["failures"], 2)
        # the password is always read with echo off, the username with echo on
        self.assertEqual(io1.reads[0][:2], (tl.USER_MAX, True))
        self.assertEqual(io1.reads[1][:2], (tl.PASS_MAX, False))
        self.assertAlmostEqual(io1.reads[0][2], tl.IDLE_S, places=1)

    def test_exact_copy(self):
        ok, fio = self.run_login([SERVICE_USER, GOOD_PW])
        self.assertTrue(ok)
        self.assertEqual(fio.writes, ["\nbox — web terminal\n\n", "box login: ", "Password: ", "\n"])

    def test_progressive_delay_engages_after_5_grows_to_cap_decays_and_resets(self):
        self.assertEqual([tl.penalty(n) for n in range(1, 12)], [0, 0, 0, 0, 5, 10, 20, 40, 60, 60, 60])
        th = self.throttle()
        for i in range(1, 5):
            self.assertEqual(th.record_failure(), i)
            self.assertEqual(th.wait_remaining(), 0)
        self.assertEqual(th.record_failure(), 5)
        self.assertEqual(th.wait_remaining(), 5.0)
        self.clock.t += 2
        self.assertEqual(th.wait_remaining(), 3.0)
        self.assertEqual(th.record_failure(), 6)
        self.assertEqual(th.wait_remaining(), 10.0)
        for _ in range(4):
            th.record_failure()
        self.assertEqual(th.wait_remaining(), 60.0)                    # capped
        self.clock.t += 901
        self.assertEqual(th.wait_remaining(), 0)                       # decayed
        self.assertEqual(th.record_failure(), 1)
        for _ in range(4):
            th.record_failure()
        self.assertEqual(th.wait_remaining(), 5.0)
        th.record_success()
        self.assertEqual(self.state()["failures"], 0)
        self.assertEqual(th.wait_remaining(), 0)

    def test_delay_active_logged_exactly_once_on_the_5th(self):
        for _ in range(3):   # 3 connections x 3 tries = 9 failures
            ok, _ = self.run_login([SERVICE_USER, "nope"] * 3)
            self.assertFalse(ok)
        self.assertEqual(self.state()["failures"], 9)
        errs = [m for p, m in self.logs if p == syslog.LOG_ERR]
        self.assertEqual(errs, ["login delay active (5 failures)"])

    def test_waiting_connection_sees_message_waits_and_drops_type_ahead(self):
        th = self.throttle()
        for _ in range(6):
            th.record_failure()
        self.assertEqual(th.wait_remaining(), 10.0)
        ok, fio = self.run_login([SERVICE_USER, GOOD_PW], throttle=th)
        self.assertTrue(ok)
        self.assertIn("Too many failed attempts; wait 10 s\n", fio.writes)
        self.assertEqual(self.sleep.calls[0], 10.0)
        self.assertEqual(fio.discards, 1)
        first_prompt = fio.events.index(("write", "box login: "))
        self.assertIn(("discard",), fio.events[:first_prompt])
        self.assertNotIn(("read", True), fio.events[:first_prompt])

    def test_wait_message_rounds_up(self):
        th = self.throttle()
        for _ in range(5):
            th.record_failure()
        self.clock.t += 0.5
        ok, fio = self.run_login([EOFError()], throttle=th)
        self.assertFalse(ok)
        self.assertIn("Too many failed attempts; wait 5 s\n", fio.writes)

    def test_wait_is_rechecked_after_sleeping(self):
        # another connection failed while this one slept: it must wait again before its prompt
        th = self.throttle()
        for _ in range(5):
            th.record_failure()
        other = self.throttle()

        def sleep(s):
            self.sleep(s)
            if len(self.sleep.calls) == 1:
                other.record_failure()     # 6th failure lands during our wait -> 10 s more

        fio = FakeIO([EOFError()])
        tl.login(fio, user=SERVICE_USER, host="box", hash_path=self.hash_path, throttle=th,
                 log=self.log, sleep=sleep)
        self.assertEqual(self.sleep.calls, [5.0, 10.0])

    def test_concurrent_failures_counted_with_flock(self):
        self.clock.t = 5_000.0
        errors = []

        def worker():
            try:
                th = tl.Throttle(self.state_path, now=self.clock)
                for _ in range(5):
                    th.record_failure()
            except Exception as e:   # pragma: no cover - surfaced below
                errors.append(e)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        self.assertEqual(self.state()["failures"], 40)

    def test_interrupt_during_verify_still_counts_the_failure(self):
        # Ctrl+C / hang-up while scrypt runs must not let a guess go uncounted
        with mock.patch.object(tl, "verify_password", side_effect=KeyboardInterrupt):
            ok, _ = self.run_login([SERVICE_USER, "guess"])
        self.assertFalse(ok)
        self.assertEqual(self.state()["failures"], 1)

    def test_success_does_not_log_delay_even_on_5th_attempt(self):
        th = self.throttle()
        for _ in range(4):
            th.record_failure()
        ok, _ = self.run_login([SERVICE_USER, GOOD_PW], throttle=th)
        self.assertTrue(ok)
        self.assertNotIn((syslog.LOG_ERR, "login delay active (5 failures)"), self.logs)
        self.assertEqual(self.state()["failures"], 0)

    def test_over_long_input_rejected(self):
        ok, fio = self.run_login([ValueError(), ValueError(), EOFError()])
        self.assertFalse(ok)
        self.assertEqual(fio.writes.count("Login incorrect\n"), 1)
        self.assertEqual(self.state()["failures"], 1)
        # a too-long username still reads (and discards) a password before failing
        self.assertEqual([r[1] for r in fio.reads[:2]], [True, False])

    def test_over_long_password_still_runs_verify(self):
        real_verify = tl.verify_password
        with mock.patch.object(tl, "verify_password", side_effect=real_verify) as spy:
            ok, _ = self.run_login([SERVICE_USER, ValueError(), EOFError()])
        self.assertFalse(ok)
        self.assertEqual(spy.call_count, 1)

    def test_three_tries_per_connection(self):
        ok, fio = self.run_login([SERVICE_USER, "a", SERVICE_USER, "b", SERVICE_USER, "c", SERVICE_USER, GOOD_PW])
        self.assertFalse(ok)
        self.assertEqual(fio.writes.count("Login incorrect\n"), 3)
        self.assertEqual(fio.lines, [SERVICE_USER, GOOD_PW])         # the 4th attempt is never read
        self.assertEqual(self.sleep.calls.count(tl.FAIL_DELAY_S), 3)

    def test_failure_sleeps_before_saying_incorrect(self):
        order = []
        fio = FakeIO([SERVICE_USER, "x", EOFError()])
        orig_write = fio.write
        fio.write = lambda s: (order.append(("write", s)), orig_write(s))
        tl.login(fio, user=SERVICE_USER, host="box", hash_path=self.hash_path, throttle=self.throttle(),
                 log=self.log, sleep=lambda s: order.append(("sleep", s)))
        i = order.index(("write", "Login incorrect\n"))
        self.assertEqual(order[i - 1], ("sleep", tl.FAIL_DELAY_S))


class ThrottleStateTest(Base):
    """Fix round 2 (R49): scheduled future attempts must never reset the counter."""

    def write_state(self, obj):
        os.makedirs(os.path.dirname(self.state_path), mode=0o700, exist_ok=True)
        with open(self.state_path, "w") as f:
            f.write(obj if isinstance(obj, str) else json.dumps(obj))
        os.chmod(self.state_path, 0o600)

    def test_short_write_fails_closed_and_keeps_old_record(self):     # R3
        t = self.throttle()
        for _ in range(9):
            t.record_attempt()
        before = self.state()
        real = os.pwrite
        with mock.patch.object(tl.os, "pwrite", side_effect=lambda fd, data, off: real(fd, data[:40], off)):
            with self.assertRaises(OSError):
                t.record_attempt()
        # nothing was truncated or padded into a lower count
        self.assertGreaterEqual(self.state()["failures"], before["failures"])

    def test_stacked_attempts_never_reset_failures(self):             # (a)
        conns = [self.throttle() for _ in range(4)]
        prev = 0
        for rnd in range(12):
            for c in conns:                     # 4 connections submit about 1 s apart, without waiting
                n, w = c.record_attempt()
                self.assertEqual(n, prev + 1, f"round {rnd}: count went from {prev} to {n}")
                prev = n
                if n >= 5:
                    self.assertGreater(conns[0].wait_remaining(), 0, f"delay dropped to 0 at {n} failures")
                self.clock.t += 1
        self.assertEqual(self.state()["failures"], 48)
        # still no reset after the queue drains, until genuine decay from the last real failure
        self.clock.t += tl.NEXT_CAP_S
        self.assertEqual(conns[1].record_attempt()[0], 49)
        self.clock.t += tl.DECAY_S + 1
        self.assertEqual(conns[2].wait_remaining(), 0)
        self.assertEqual(conns[2].record_failure(), 1)
        for _ in range(6):
            conns[3].record_failure()
        conns[3].record_success()
        self.assertEqual(conns[0].wait_remaining(), 0)
        self.assertEqual(self.state()["failures"], 0)

    def test_scheduled_wait_is_capped(self):
        th = self.throttle()
        for _ in range(40):
            _, w = th.record_attempt()
            self.assertLessEqual(w, tl.NEXT_CAP_S)
        self.assertLessEqual(th.wait_remaining(), tl.NEXT_CAP_S)

    def test_backward_clock_jump_does_not_reset(self):                 # (b)
        th = self.throttle()
        for _ in range(6):
            th.record_failure()
        self.clock.t -= 5000                                          # NTP / RTC jump backwards
        self.assertGreater(th.wait_remaining(), 0)
        self.assertLessEqual(th.wait_remaining(), tl.NEXT_CAP_S)
        self.assertEqual(th.record_failure(), 7)
        self.assertLessEqual(self.state()["last_failure"], self.clock.t)   # clamped to now
        self.clock.t += tl.DECAY_S + 1                                # decay still works from the clamped time
        self.assertEqual(th.wait_remaining(), 0)

    def test_forward_clock_jump_decays_normally(self):
        th = self.throttle()
        for _ in range(6):
            th.record_failure()
        self.clock.t += tl.DECAY_S
        self.assertEqual(th.wait_remaining(), 0)
        self.assertEqual(th.record_failure(), 1)

    def test_far_future_next_allowed_is_clamped(self):                 # (c)
        now = self.clock.t
        for bad in (now + 1e9, "Infinity", "NaN"):
            with self.subTest(bad=bad):
                raw = ('{"failures": 6, "last_failure": %s, "next_allowed": %s}' % (now, bad))
                self.write_state(raw)
                th = self.throttle()
                w = th.wait_remaining()
                self.assertGreater(w, 0)
                self.assertLessEqual(w, tl.NEXT_CAP_S)
                self.assertEqual(th.record_failure(), 7)
                self.assertLessEqual(self.state()["next_allowed"], self.clock.t + tl.NEXT_CAP_S)
        self.write_state({"failures": 6, "last_failure": now + 1e9, "next_allowed": now + 1e9})
        th = self.throttle()
        self.assertLessEqual(th.wait_remaining(), tl.NEXT_CAP_S)     # future last_failure is clamped, kept
        self.assertEqual(th.record_failure(), 7)

    def test_old_format_state_is_kept(self):                           # (d)
        now = self.clock.t
        self.write_state({"failures": 6, "last": now - 2})
        th = self.throttle()
        self.assertEqual(th.wait_remaining(), 8.0)                    # penalty(6)=10 from the old stamp
        self.assertEqual(th.record_failure(), 7)
        st = self.state()
        self.assertEqual(set(st), {"failures", "last_failure", "next_allowed"})
        # an old file whose stamp lies far in the future (the round-1 bug) keeps its count
        self.write_state({"failures": 9, "last": now + 5000})
        th = self.throttle()
        self.assertGreater(th.wait_remaining(), 0)
        self.assertEqual(th.record_failure(), 10)
        # old and decayed: a genuine reset
        self.write_state({"failures": 9, "last": now - tl.DECAY_S - 1})
        self.assertEqual(self.throttle().wait_remaining(), 0)

    def wait_until_open(self, th, bound, step=1.0):
        """Advance the clock until wait_remaining() is 0; return the seconds that took (fails past bound)."""
        start = self.clock.t
        while True:
            w = th.wait_remaining()
            if w == 0:
                return self.clock.t - start
            self.assertLessEqual(self.clock.t - start, bound, f"still {w} s to wait after {bound} s: lockout")
            self.clock.t += step

    def test_every_normalised_state_expires(self):                    # R51: no permanent lockout
        now = self.clock.t
        p5, p6 = tl.penalty(tl.FAIL_CLOSED_FAILURES), tl.penalty(6)
        cases = [
            ("garbage", "{not json at all", p5),
            ("nul bytes (torn write)", "\x00" * 128, p5),
            ("last_failure 1e400", '{"failures": 6, "last_failure": 1e400, "next_allowed": 0}', p6),
            ("last_failure Infinity", '{"failures": 6, "last_failure": Infinity, "next_allowed": 0}', p6),
            ("last_failure NaN", '{"failures": 6, "last_failure": NaN, "next_allowed": 0}', p6),
            ("next_allowed far future",
             '{"failures": 6, "last_failure": %r, "next_allowed": %r}' % (now, now + 1e9), tl.NEXT_CAP_S),
        ]
        for name, raw, bound in cases:
            with self.subTest(case=name):
                self.clock.t = now
                self.write_state(raw)
                took = self.wait_until_open(self.throttle(), bound + 1)
                self.assertGreater(took, 0)                        # failed closed first
                st = self.state()                                  # and the file now holds a valid record
                self.assertEqual(set(st), {"failures", "last_failure", "next_allowed"})
                self.clock.t += tl.DECAY_S + 1                     # then ordinary decay applies
                self.assertEqual(self.throttle().record_failure(), 1)

    def test_clock_stepped_back_a_day_expires(self):                   # R51 (4)
        th = self.throttle()
        for _ in range(6):
            th.record_failure()
        self.clock.t -= 86400
        took = self.wait_until_open(th, tl.NEXT_CAP_S + 1)
        self.assertGreater(took, 0)
        self.assertEqual(self.state()["failures"], 6)              # the count was never reset
        self.assertLessEqual(self.state()["last_failure"], self.clock.t)

    def test_normalising_read_is_persisted_once(self):
        self.write_state("{garbage")
        th = self.throttle()
        first = th.wait_remaining()
        with open(self.state_path, "rb") as f:
            after_first = f.read()
        self.clock.t += 1
        self.assertEqual(th.wait_remaining(), first - 1)           # anchored once, not re-anchored to now
        with open(self.state_path, "rb") as f:
            self.assertEqual(f.read(), after_first)                # a clean record is not rewritten

    def test_huge_failure_count_stays_writable(self):
        self.write_state({"failures": 10**40, "last_failure": self.clock.t, "next_allowed": 0})
        th = self.throttle()
        self.assertEqual(th.wait_remaining(), 60.0)
        n = th.record_failure()
        self.assertGreater(n, 5)
        self.assertGreater(self.state()["failures"], 5)


class HardeningTest(Base):
    def setUp(self):
        super().setUp()
        self.write_hash_file()

    def login(self, fio, throttle=None, sleep=None):
        return tl.login(fio, user=SERVICE_USER, host="box", hash_path=self.hash_path,
                        throttle=throttle or self.throttle(), log=self.log, sleep=sleep or self.sleep)

    def test_one_deadline_for_the_whole_prompt(self):                   # M6
        mono = Clock(100.0)

        class SlowIO(FakeIO):
            def read_line(s, limit, echo, timeout):
                r = FakeIO.read_line(s, limit, echo, timeout)
                mono.t += 50          # the user took 50 s at this prompt
                return r

        fio = SlowIO([SERVICE_USER, "wrong", SERVICE_USER, GOOD_PW])
        with mock.patch.object(tl.time, "monotonic", mono):
            self.assertTrue(self.login(fio))
        self.assertEqual([r[2] for r in fio.reads], [60, 10, 60, 10])     # each attempt: one 60 s budget

    def test_deadline_spent_before_password_times_out(self):            # M6
        mono = Clock(100.0)

        class SlowIO(FakeIO):
            def read_line(s, limit, echo, timeout):
                if timeout <= 0:
                    s.reads.append((limit, echo, timeout))
                    raise TimeoutError
                r = FakeIO.read_line(s, limit, echo, timeout)
                mono.t += 61
                return r

        fio = SlowIO([SERVICE_USER, GOOD_PW])
        with mock.patch.object(tl.time, "monotonic", mono):
            self.assertFalse(self.login(fio))
        self.assertEqual(fio.reads[1][2], 0)
        self.assertIn(tl.MSG_TIMEOUT, fio.writes)

    def test_penalty_is_enforced_at_verify_time(self):                  # security scan: TOCTOU
        th, other = self.throttle(), self.throttle()
        events = []

        class RacingIO(FakeIO):
            def read_line(s, limit, echo, timeout):
                r = FakeIO.read_line(s, limit, echo, timeout)
                if not echo:      # while this connection sits at its prompt, others fail 5 times
                    for _ in range(5):
                        other.record_failure()
                return r

        real_verify = tl.verify_password

        def spy(pw, stored):
            events.append(("verify", self.clock.t))
            return real_verify(pw, stored)

        def sleep(s):
            events.append(("sleep", s))
            self.clock.t += s

        start = self.clock.t
        fio = RacingIO([SERVICE_USER, GOOD_PW])
        with mock.patch.object(tl, "verify_password", side_effect=spy):
            self.assertTrue(self.login(fio, throttle=th, sleep=sleep))
        self.assertEqual(events, [("sleep", 5.0), ("verify", start + 5.0)])
        self.assertIn("Too many failed attempts; wait 5 s\n", fio.writes)
        self.assertEqual(self.state()["failures"], 0)                  # success resets

    def test_interrupted_while_waiting_at_verify_is_counted(self):
        th = self.throttle()
        for _ in range(5):
            th.record_failure()
        self.clock.t += 5            # the gate is open when the prompt is shown...

        class RacingIO(FakeIO):
            def read_line(s, limit, echo, timeout):
                r = FakeIO.read_line(s, limit, echo, timeout)
                if not echo:
                    th.record_failure()     # ...then another connection fails (6 -> 10 s)
                return r

        def sleep(s):
            raise KeyboardInterrupt

        verify = mock.Mock(return_value=True)
        with mock.patch.object(tl, "verify_password", verify):
            self.assertFalse(self.login(RacingIO([SERVICE_USER, GOOD_PW]), throttle=th, sleep=sleep))
        verify.assert_not_called()
        self.assertEqual(self.state()["failures"], 7)

    def test_record_attempt_serialises_concurrent_guesses(self):
        th = self.throttle()
        self.assertEqual(th.record_attempt(), (1, 0))
        for _ in range(3):
            th.record_failure()
        self.assertEqual(th.record_attempt(), (5, 0))          # 5th attempt: nothing pending yet
        self.assertEqual(th.wait_remaining(), 5.0)
        # two connections submit at the same instant: the second verifies a full penalty after the first
        n1, w1 = th.record_attempt()
        n2, w2 = th.record_attempt()
        self.assertEqual((n1, w1), (6, 5.0))
        self.assertEqual((n2, w2), (7, 5.0 + 10.0))
        self.assertEqual(th.wait_remaining(), 15.0 + 20.0)


class MainTest(Base):
    """main() end to end with a FakeIO, mocked syslog and execv, and the paths pointed at temp dirs."""

    def setUp(self):
        super().setUp()
        self.write_hash_file()
        import pwd
        self.me = pwd.getpwuid(os.getuid()).pw_name
        patches = [
            mock.patch.object(tl, "HASH_PATH", self.hash_path),
            mock.patch.object(tl, "STATE_PATH", self.state_path),
            mock.patch.object(tl.time, "sleep", self.sleep),     # advances the fake clock
            mock.patch.object(tl.time, "time", self.clock),
            mock.patch.object(tl.syslog, "openlog"),
            mock.patch.object(tl.syslog, "syslog"),
            mock.patch.object(tl.os, "chdir"),
            mock.patch.dict(tl.os.environ, {}, clear=False),
            mock.patch("signal.signal"),
            mock.patch("resource.getrlimit", return_value=(7, 99)),
            mock.patch("resource.setrlimit"),
        ]
        self.mocks = [p.start() for p in patches]
        for p in patches:
            self.addCleanup(p.stop)
        self.openlog, self.syslog = self.mocks[4], self.mocks[5]
        self.signal, self.setrlimit = self.mocks[8], self.mocks[10]

    def test_eof_ctrl_c_and_timeout_exit_without_shell(self):
        for item in [EOFError(), KeyboardInterrupt(), TimeoutError()]:
            with self.subTest(item=type(item).__name__):
                execv = mock.Mock()
                fio = FakeIO([item])
                self.assertEqual(tl.main([], io=fio, execv=execv), 1)
                execv.assert_not_called()
                if isinstance(item, TimeoutError):
                    self.assertIn("\nLogin timed out after 60 seconds.\n", fio.writes)
        # the same at the password prompt
        for item in [EOFError(), KeyboardInterrupt(), TimeoutError()]:
            execv = mock.Mock()
            self.assertEqual(tl.main([], io=FakeIO([self.me, item]), execv=execv), 1)
            execv.assert_not_called()

    def test_syslog_priorities_and_no_password_anywhere(self):
        secret = "hunter2-secret-guess"
        fio = FakeIO([self.me, secret, "eve", secret + "x", self.me, GOOD_PW])
        execv = mock.Mock()
        self.assertEqual(tl.main([], io=fio, execv=execv), 0)
        self.openlog.assert_called_once_with(ident="term-login", logoption=0, facility=syslog.LOG_AUTH)
        calls = [c.args for c in self.syslog.call_args_list]
        self.assertEqual(calls, [
            (syslog.LOG_WARNING, f"failed login for {self.me}"),
            (syslog.LOG_WARNING, "failed login (unknown user)"),
            (syslog.LOG_INFO, f"login ok for {self.me}"),
        ])
        everything = repr(calls) + repr(self.openlog.call_args_list) + "".join(fio.writes)
        for s in (secret, GOOD_PW, "eve"):
            self.assertNotIn(s, repr(calls))
        for s in (secret, GOOD_PW):
            self.assertNotIn(s, everything)
        execv.assert_called_once()

    def test_exec_only_after_success(self):
        order = []
        real_success = tl.Throttle.record_success

        def spy_success(th):
            order.append("record_success")
            return real_success(th)

        execv = mock.Mock(side_effect=lambda *a: order.append("execv"))
        with mock.patch.object(tl.Throttle, "record_success", spy_success):
            self.assertEqual(tl.main([], io=FakeIO([self.me, GOOD_PW]), execv=execv), 0)
        execv.assert_called_once_with("/bin/bash", ["bash", "--rcfile", RCFILE, "-i"])
        self.assertTrue(os.path.isabs(execv.call_args.args[1][2]))
        self.assertEqual(order, ["record_success", "execv"])

        for lines in ([self.me, "wrong"] * 3, ["root", GOOD_PW] * 3, [self.me, ValueError()] * 3, []):
            with self.subTest(lines=lines):
                execv = mock.Mock()
                self.assertEqual(tl.main([], io=FakeIO(lines), execv=execv), 1)
                execv.assert_not_called()

    def test_exec_failure_is_logged_without_traceback(self):            # M4
        err = io.StringIO()
        fio = FakeIO([self.me, GOOD_PW])
        execv = mock.Mock(side_effect=OSError(2, "No such file", "/bin/bash"))
        with mock.patch("sys.stderr", err):
            self.assertEqual(tl.main([], io=fio, execv=execv), 1)
        self.assertEqual(err.getvalue(), "")
        self.assertEqual(fio.writes[-1], tl.MSG_INTERNAL)
        self.assertIn((syslog.LOG_ERR, "exec failed"), [c.args for c in self.syslog.call_args_list])
        self.assertNotIn("/bin/bash", "".join(fio.writes))

    def test_getpwuid_failure_is_logged_without_traceback(self):        # M4
        err = io.StringIO()
        fio = FakeIO([self.me, GOOD_PW])
        execv = mock.Mock()
        with mock.patch.object(tl.pwd, "getpwuid", side_effect=KeyError("uid 501")), mock.patch("sys.stderr", err):
            self.assertEqual(tl.main([], io=fio, execv=execv), 1)
        execv.assert_not_called()
        self.assertEqual(err.getvalue(), "")
        self.assertEqual(fio.writes, [tl.MSG_INTERNAL])
        logged = [c.args for c in self.syslog.call_args_list]
        self.assertEqual(logged, [(syslog.LOG_ERR, "login error")])

    def test_no_core_dumps_and_sigquit_ignored_until_exec(self):        # M5
        order = []
        self.setrlimit.side_effect = lambda *a: order.append(("setrlimit",) + a)
        self.signal.side_effect = lambda *a: order.append(("signal",) + a)

        class OrderIO(FakeIO):
            def read_line(s, *a):
                order.append(("read",))
                return FakeIO.read_line(s, *a)

        execv = mock.Mock(side_effect=lambda *a: order.append(("execv",)))
        self.assertEqual(tl.main([], io=OrderIO([self.me, GOOD_PW]), execv=execv), 0)
        first_read = order.index(("read",))
        self.assertIn(("setrlimit", resource.RLIMIT_CORE, (0, 99)), order[:first_read])
        self.assertIn(("signal", signal.SIGQUIT, signal.SIG_IGN), order[:first_read])
        before_exec = order[first_read:order.index(("execv",))]
        self.assertIn(("signal", signal.SIGQUIT, signal.SIG_DFL), before_exec)
        self.assertIn(("setrlimit", resource.RLIMIT_CORE, (7, 99)), before_exec)
        self.assertIn(("signal", signal.SIGPIPE, signal.SIG_DFL), before_exec)     # Python ignores it

    def test_unexpected_error_never_execs(self):
        execv = mock.Mock()
        with mock.patch.object(tl.Throttle, "wait_remaining", side_effect=OSError("disk gone")):
            self.assertEqual(tl.main([], io=FakeIO([self.me, GOOD_PW]), execv=execv), 1)
        execv.assert_not_called()

    def test_unknown_arguments_refused(self):
        execv = mock.Mock()
        for argv in (["--bogus"], ["--write-hash"], ["--write-hash", "a", "b"], ["x"]):
            with self.subTest(argv=argv), mock.patch("sys.stderr", io.StringIO()):
                self.assertEqual(tl.main(argv, io=FakeIO([self.me, GOOD_PW]), execv=execv), 2)
        execv.assert_not_called()

    def test_exec_shell_sets_environment(self):
        execv = mock.Mock()
        tl.exec_shell(self.home, execv=execv)
        tl.os.chdir.assert_called_with(self.home)
        import pwd
        me = pwd.getpwuid(os.getuid()).pw_name
        for k, v in {"HOME": self.home, "USER": me, "LOGNAME": me, "SHELL": "/bin/bash"}.items():
            self.assertEqual(os.environ[k], v)
        execv.assert_called_once_with("/bin/bash", ["bash", "--rcfile", RCFILE, "-i"])

    def test_missing_or_corrupt_state_and_hash_files(self):   # Review Focus 4
        # state path missing -> 0 wait, first failure is 1, file created 0600 in a 0700 dir
        th = tl.Throttle(self.state_path, now=self.clock)
        self.assertEqual(th.wait_remaining(), 0)
        self.assertEqual(th.record_failure(), 1)
        self.assertEqual(stat.S_IMODE(os.stat(self.state_path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(self.state_path)).st_mode), 0o700)
        # garbled state fails closed (R49): treated as FAIL_CLOSED_FAILURES, never as a reset
        for junk in ("{not json", "[]", '{"failures": "x", "last": null}', '{"failures": -4, "last": 0}',
                     '{"failures": true, "last_failure": 0, "next_allowed": 0}', "\x00\x01garbage"):
            with self.subTest(junk=junk):
                with open(self.state_path, "w") as f:
                    f.write(junk)
                th = tl.Throttle(self.state_path, now=self.clock)
                self.assertEqual(th.wait_remaining(), float(tl.penalty(tl.FAIL_CLOSED_FAILURES)))
                self.assertEqual(th.record_failure(), tl.FAIL_CLOSED_FAILURES + 1)
                st = self.state()                                 # rewritten as valid JSON
                self.assertEqual(st["failures"], tl.FAIL_CLOSED_FAILURES + 1)
        with open(self.state_path, "w") as f:                     # empty file: a fresh start
            f.write("")
        th = tl.Throttle(self.state_path, now=self.clock)
        self.assertEqual(th.wait_remaining(), 0)
        self.assertEqual(th.record_failure(), 1)

        # term.pass missing / 0644 / symlink / garbage -> not-set-up message, LOG_ERR, no read, no exec
        def bad_missing():
            os.unlink(self.hash_path)

        def bad_mode():
            self.write_hash_file(mode=0o644)

        def bad_symlink():
            real = self.hash_path + ".real"
            self.write_hash_file()
            os.rename(self.hash_path, real)
            os.symlink(real, self.hash_path)

        def bad_garbage():
            self.write_hash_file(content="garbage")

        for setup in (bad_missing, bad_mode, bad_symlink, bad_garbage):
            with self.subTest(case=setup.__name__):
                for p in (self.hash_path, self.hash_path + ".real"):
                    if os.path.lexists(p):
                        os.unlink(p)
                self.write_hash_file()
                setup()
                self.syslog.reset_mock()
                execv = mock.Mock()
                fio = FakeIO([self.me, GOOD_PW])
                self.assertEqual(tl.main([], io=fio, execv=execv), 1)
                self.assertEqual(fio.writes, ["Terminal login is not set up. On the server run: "
                                              "cd home-server-dashboard && sudo ./setup.sh\n"])
                self.assertEqual(fio.reads, [])
                execv.assert_not_called()
                self.assertEqual([c.args for c in self.syslog.call_args_list],
                                 [(syslog.LOG_ERR, "term.pass missing or unsafe; refusing logins")])

    def test_load_hash(self):
        self.assertEqual(tl.load_hash(self.hash_path), self.good_hash)
        os.chmod(self.hash_path, 0o640)
        self.assertIsNone(tl.load_hash(self.hash_path))
        os.chmod(self.hash_path, 0o600)
        self.assertIsNone(tl.load_hash(os.path.dirname(self.hash_path)))   # a directory
        self.assertIsNone(tl.load_hash(self.hash_path + ".nope"))

    def _stdin(self, data):
        return mock.patch.object(tl.sys, "stdin", types.SimpleNamespace(buffer=io.BytesIO(data)))

    def test_write_hash_mode_reads_stdin_and_writes_0600(self):
        p = os.path.join(self.home, "newcfg", "term.pass")
        out, err = io.StringIO(), io.StringIO()
        with self._stdin(b"a-long-password\n"), mock.patch("sys.stdout", out), mock.patch("sys.stderr", err):
            self.assertEqual(tl.main(["--write-hash", p]), 0)
        self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(p)).st_mode), 0o700)
        with open(p) as f:
            content = f.read()
        self.assertTrue(content.endswith("\n"))
        self.assertTrue(tl.verify_password("a-long-password", content.strip()))
        self.assertEqual(tl.load_hash(p), content.strip())
        self.assertNotIn("a-long-password", out.getvalue() + err.getvalue())
        self.assertEqual(os.listdir(os.path.dirname(p)), ["term.pass"])    # no temp file left

        # rewriting (rotation) replaces the hash
        with self._stdin(b"another-long-password\n"), mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(tl.main(["--write-hash", p]), 0)
        self.assertTrue(tl.verify_password("another-long-password", tl.load_hash(p)))

        # too short -> 2 and no file
        q = os.path.join(self.home, "short", "term.pass")
        with self._stdin(b"short\n"), mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(tl.main(["--write-hash", q]), 2)
        self.assertFalse(os.path.exists(q))

        # a symlink -> 2, target untouched
        target = os.path.join(self.home, "target")
        with open(target, "w") as f:
            f.write("keep\n")
        link = os.path.join(self.home, "link.pass")
        os.symlink(target, link)
        with self._stdin(b"a-long-password\n"), mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(tl.main(["--write-hash", link]), 2)
        with open(target) as f:
            self.assertEqual(f.read(), "keep\n")

        # a symlinked directory -> 2
        realdir = os.path.join(self.home, "realdir")
        os.mkdir(realdir, 0o700)
        os.symlink(realdir, os.path.join(self.home, "linkdir"))
        with self._stdin(b"a-long-password\n"), mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(tl.main(["--write-hash", os.path.join(self.home, "linkdir", "term.pass")]), 2)
        self.assertEqual(os.listdir(realdir), [])

    def test_write_hash_input_limits(self):
        p = os.path.join(self.home, "cfg", "term.pass")
        cases = [
            (b"x" * 1025, 2),                        # over 1024 bytes
            (b"twelve-chars", 0),                    # exactly 12, no newline
            (b"eleven-char\n", 2),                   # 11 chars
            (b"line-one-long\nline-two\n", 2),       # embedded newline: could never be typed at a tty
            (b"\xff\xfe-not-utf8-at-all\n", 2),
            (b"", 2),
        ]
        for data, rc in cases:
            with self.subTest(data=data), self._stdin(data), mock.patch("sys.stderr", io.StringIO()):
                self.assertEqual(tl.main(["--write-hash", p]), rc)
        self.assertTrue(tl.verify_password("twelve-chars", tl.load_hash(p)))


class TtyIOTest(unittest.TestCase):
    """TtyIO against a real pty: echo control, limits, timeout, EOF."""

    def setUp(self):
        self.master, self.slave = pty.openpty()
        self.tio = tl.TtyIO(fd_in=self.slave, fd_out=self.slave)

    def tearDown(self):
        os.close(self.master)
        os.close(self.slave)

    def feed_later(self, data, delay=0.2):
        t = threading.Timer(delay, os.write, (self.master, data))
        t.start()
        self.addCleanup(t.join)

    def drain_master(self):
        import select
        out = b""
        while select.select([self.master], [], [], 0.2)[0]:
            try:
                chunk = os.read(self.master, 4096)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
        return out

    def test_password_read_without_echo_and_echo_restored(self):
        self.feed_later(b"s3cret-value\n")
        self.assertEqual(self.tio.read_line(256, False, 5), "s3cret-value")
        self.assertNotIn(b"s3cret-value", self.drain_master())
        self.assertTrue(termios.tcgetattr(self.slave)[3] & termios.ECHO)

    def test_pasted_user_and_password_never_echo_the_password(self):    # M3
        self.tio.start()
        try:
            os.write(self.master, b"someone\nSECRETPASTE\n")      # one write, like a browser paste
            self.assertEqual(self.tio.read_line(64, True, 5), "someone")
            # the pasted password is discarded (TCSAFLUSH) and must be retyped
            self.feed_later(b"typed-again\n")
            self.assertEqual(self.tio.read_line(256, False, 5), "typed-again")
        finally:
            self.tio.restore()
        out = self.drain_master()
        self.assertIn(b"someone", out)
        self.assertNotIn(b"SECRETPASTE", out)
        self.assertNotIn(b"typed-again", out)
        self.assertTrue(termios.tcgetattr(self.slave)[3] & termios.ECHO)
        self.assertTrue(termios.tcgetattr(self.slave)[3] & termios.ICANON)

    def test_typeahead_before_the_prompt_is_not_echoed(self):           # M3
        self.tio.start()
        try:
            os.write(self.master, b"early\n")
            time.sleep(0.1)
            self.assertNotIn(b"early", self.drain_master())
            self.assertEqual(self.tio.read_line(64, True, 5), "early")  # echoed by us once it is read
        finally:
            self.tio.restore()

    def test_username_line_editing(self):
        self.feed_later(b"usx\x7fer\x08\x08er\n")
        self.assertEqual(self.tio.read_line(64, True, 5), "user")
        self.feed_later(b"junk\x15me\n")                            # Ctrl+U clears the line
        self.assertEqual(self.tio.read_line(64, True, 5), "me")
        self.assertTrue(termios.tcgetattr(self.slave)[3] & termios.ECHO)

    def test_username_read_with_echo(self):
        self.feed_later(b"someone\n")
        self.assertEqual(self.tio.read_line(64, True, 5), "someone")
        self.assertIn(b"someone", self.drain_master())

    def test_echo_restored_after_timeout(self):
        t0 = time.monotonic()
        with self.assertRaises(TimeoutError):
            self.tio.read_line(256, False, 0.3)
        self.assertLess(time.monotonic() - t0, 3)
        self.assertTrue(termios.tcgetattr(self.slave)[3] & termios.ECHO)

    def test_over_limit_drains_the_rest_of_the_line(self):
        self.feed_later(b"A" * 100 + b"\n")
        with self.assertRaises(ValueError):
            self.tio.read_line(64, True, 5)
        self.feed_later(b"next\n")
        self.assertEqual(self.tio.read_line(64, True, 5), "next")

    def test_exactly_at_limit_ok(self):
        self.feed_later(b"B" * 64 + b"\n")
        self.assertEqual(self.tio.read_line(64, True, 5), "B" * 64)

    def test_endless_line_times_out(self):
        stop = threading.Event()

        def spam():
            while not stop.is_set():
                try:
                    os.write(self.master, b"C" * 50)
                except OSError:
                    return
                time.sleep(0.02)

        t = threading.Thread(target=spam)
        t.start()
        try:
            with self.assertRaises((TimeoutError, ValueError)):
                self.tio.read_line(64, True, 0.5)
        finally:
            stop.set()
            t.join()

    def test_ctrl_d_is_eof(self):
        self.feed_later(b"\x04")
        with self.assertRaises(EOFError):
            self.tio.read_line(64, True, 5)

    def test_discard_pending(self):
        os.write(self.master, b"typed-ahead\n")
        time.sleep(0.1)
        self.tio.discard_pending()
        self.feed_later(b"fresh\n")
        self.assertEqual(self.tio.read_line(64, True, 5), "fresh")

    def test_pipe_lines_and_eof(self):
        r, w = os.pipe()
        try:
            os.write(w, b"first\nsecond\r\n")
            os.close(w)
            w = None
            p = tl.TtyIO(fd_in=r, fd_out=self.slave)
            self.assertEqual(p.read_line(64, True, 1), "first")
            self.assertEqual(p.read_line(64, False, 1), "second")
            with self.assertRaises(EOFError):
                p.read_line(64, True, 1)
        finally:
            os.close(r)
            if w is not None:
                os.close(w)

    def test_write(self):
        self.tio.write("héllo")
        self.assertIn("héllo".encode(), self.drain_master())


if __name__ == "__main__":
    unittest.main()
