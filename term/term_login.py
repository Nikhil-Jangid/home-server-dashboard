#!/usr/bin/python3
"""In-terminal login for the dashboard's web terminal.

ttyd runs this once per connection, as the service user, in place of a shell:
    /usr/bin/python3 -I <repo>/term/term_login.py
It prints `<host> login:` / `Password:` like login(1), checks the username against the service user and
the password against a scrypt hash in ~/.config/home-server-dashboard/term.pass, and only on success execs bash
with the dashboard rc file. A global failure counter (flock-protected) adds a growing delay after 5
consecutive failures.

`--write-hash PATH` (used by setup.sh, never reachable from ttyd, which passes no arguments) reads a new
password from stdin and writes its hash to PATH.

Single file, stdlib only: `python3 -I` drops this file's directory from sys.path.
"""
import base64
import binascii
import errno
import fcntl
import hashlib
import hmac
import json
import math
import os
import pwd
import resource
import select
import signal
import socket
import stat
import sys
import syslog
import tempfile
import termios
import time

HASH_N = 2**15
HASH_R = 8
HASH_P = 1
SALT_LEN = 16
DKLEN = 32
MAXMEM = 64 * 1024 * 1024   # N=2**15, r=8 needs 32 MiB plus overhead; OpenSSL's default cap is 32 MiB

USER_MAX = 64
PASS_MAX = 256
IDLE_S = 60
MAX_TRIES = 3
FAIL_DELAY_S = 2
DECAY_S = 900
MAX_PENALTY_S = 60
MAX_CONCURRENT = 4           # ttyd -m 4: at most this many attempts can be scheduled ahead at once
NEXT_CAP_S = MAX_PENALTY_S * MAX_CONCURRENT   # next_allowed is never further than this from now
# (the owner's total worst case is ~7 min: gate wait + verify wait; see Throttle)
FAIL_CLOSED_FAILURES = 5     # unreadable non-empty state counts as this many failures (penalty on)
_FAILURES_MAX = 10**6

HASH_PATH = os.path.expanduser("~/.config/home-server-dashboard/term.pass")
STATE_PATH = os.path.expanduser("~/.local/state/home-server-dashboard/term-login.json")

RCFILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard.bashrc")

WRITE_HASH_MAX = 1024
WRITE_HASH_MIN_CHARS = 12
_HASH_FILE_MAX = 4096
_STATE_SIZE = 128            # state is rewritten as one fixed-size write, so a kill can't half-write it

MSG_NOT_SET_UP = ("Terminal login is not set up. On the server run: "
                  "cd home-server-dashboard && sudo ./setup.sh\n")
MSG_INCORRECT = "Login incorrect\n"
MSG_TIMEOUT = f"\nLogin timed out after {IDLE_S} seconds.\n"
MSG_INTERNAL = "\nInternal error; no shell was started.\n"

_saved_core = None           # RLIMIT_CORE before main() lowered it; restored for the shell


# ---------------------------------------------------------------- hashing

def _b64(b):
    return base64.b64encode(b).decode("ascii")


def _scrypt(password, salt, n, r, p):
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, maxmem=MAXMEM, dklen=DKLEN)


def hash_password(password, salt=None):
    if salt is None:
        salt = os.urandom(SALT_LEN)
    dk = _scrypt(password, salt, HASH_N, HASH_R, HASH_P)
    return f"scrypt${HASH_N}${HASH_R}${HASH_P}${_b64(salt)}${_b64(dk)}"


def _parse_int(s, lo, hi):
    if not (s.isascii() and s.isdigit()) or len(s) > 8:
        raise ValueError("bad int")
    v = int(s)
    if not lo <= v <= hi:
        raise ValueError("out of range")
    return v


def _parse_hash(stored):
    """Return (n, r, p, salt, dk) or raise ValueError."""
    if not isinstance(stored, str):
        raise ValueError("not a string")
    parts = stored.split("$")
    if len(parts) != 6 or parts[0] != "scrypt":
        raise ValueError("bad format")
    n = _parse_int(parts[1], 2**14, 2**20)
    if n & (n - 1):
        raise ValueError("N not a power of 2")
    r = _parse_int(parts[2], 1, 32)
    p = _parse_int(parts[3], 1, 16)
    try:
        salt = base64.b64decode(parts[4], validate=True)
        dk = base64.b64decode(parts[5], validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("bad base64") from None
    if len(salt) != SALT_LEN or len(dk) != DKLEN:
        raise ValueError("bad lengths")
    return n, r, p, salt, dk


def verify_password(password, stored):
    try:
        n, r, p, salt, dk = _parse_hash(stored)
        got = _scrypt(password, salt, n, r, p)
    except (ValueError, TypeError, MemoryError, UnicodeError):
        return False
    return hmac.compare_digest(got, dk)


def load_hash(path):
    """The stored hash, or None unless `path` is a safe file: regular, not a symlink, ours, mode 0?00."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0))
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
            return None
        data = os.read(fd, _HASH_FILE_MAX + 1)
    except OSError:
        return None
    finally:
        os.close(fd)
    if len(data) > _HASH_FILE_MAX:
        return None
    try:
        text = data.decode("ascii").strip()
        _parse_hash(text)
    except (UnicodeError, ValueError):
        return None
    return text


# ---------------------------------------------------------------- throttle

def penalty(failures):
    if failures < 5:
        return 0
    return min(MAX_PENALTY_S, 5 * 2 ** min(failures - 5, 8))


class Throttle:
    """Global consecutive-failure counter in a JSON file, read and written under flock(LOCK_EX).

    State: {"failures": n, "last_failure": t, "next_allowed": t2}
      - last_failure: real wall time of the most recent failure; used only for the 15-minute decay.
      - next_allowed: when the next attempt may be verified; may lie in the future while attempts are
        queued, but is clamped to now + NEXT_CAP_S on every read.
    Owner's worst case while an attacker holds all MAX_CONCURRENT ttyd slots: about 7 minutes, i.e. up to
    NEXT_CAP_S (240 s) at the gate, plus up to 180 s of verify wait if the other 3 slots queue attempts
    while the owner types. Capping the combined wait lower would weaken the throttle (ruling R51).
    Nothing but genuine decay (DECAY_S after last_failure) or a success resets the count. In particular
    a future timestamp (a clock jump, or attempts scheduled ahead) is clamped, never treated as a reset,
    and an unreadable state file fails closed (FAIL_CLOSED_FAILURES) instead of starting from zero.
    """

    def __init__(self, path, now=time.time):
        self.path = path
        self.now = now

    def _open(self):
        d = os.path.dirname(self.path)
        if d and not os.path.isdir(d):
            os.makedirs(d, mode=0o700, exist_ok=True)
            os.chmod(d, 0o700)
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), 0o600)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                raise OSError("state file is not a regular file")
            if stat.S_IMODE(st.st_mode) != 0o600:
                os.fchmod(fd, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX)
        except BaseException:
            os.close(fd)
            raise
        return fd

    @staticmethod
    def _num(v):
        if type(v) in (int, float) and math.isfinite(v):
            return float(v)
        return None

    def _load(self, fd):
        """Return (failures, last_failure, next_allowed, now), normalised and clamped.

        Whenever normalising changed anything (corrupt or torn file, non-finite or future stamps, an
        over-cap next_allowed, decay, round-1 format), the normalised record is written back under the
        lock already held. A record re-anchored to "now" is therefore anchored once and then expires
        normally; without this, every read would re-anchor and the owner would be locked out for good.
        """
        raw = os.pread(fd, 4096, 0)
        state = self._normalise(raw)
        if self._encode(*state[:3]) != raw:
            self._write(fd, *state[:3])
        return state

    def _normalise(self, raw):
        now = self.now()
        if not raw.strip(b" \n\t\r"):
            return 0, now, now, now                      # new (empty) file: a fresh start
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeError):
            data = None
        if not isinstance(data, dict):
            data = {}
        f = data.get("failures")
        last = self._num(data.get("last_failure", data.get("last")))     # "last": round-1 format
        if type(f) is int and f >= 0:
            failures = min(f, _FAILURES_MAX)
        else:
            # Unreadable count: fail closed, not a reset. Its timestamps can't be trusted to decay it
            # either, so the penalty runs from now.
            failures, last = FAIL_CLOSED_FAILURES, None
        last_failure = now if last is None else min(last, now)          # future (clock jump): clamp
        if failures and now - last_failure >= DECAY_S:
            return 0, last_failure, now, now             # genuine decay
        floor = last_failure + penalty(failures)         # never less than the penalty itself
        nxt = self._num(data.get("next_allowed"))
        next_allowed = floor if nxt is None else max(nxt, floor)
        next_allowed = min(next_allowed, now + NEXT_CAP_S)
        return failures, last_failure, next_allowed, now

    @staticmethod
    def _encode(failures, last_failure, next_allowed):
        body = json.dumps({"failures": failures, "last_failure": last_failure,
                           "next_allowed": next_allowed}).encode("ascii")
        return body.ljust(_STATE_SIZE)

    @classmethod
    def _write(cls, fd, failures, last_failure, next_allowed):
        data = cls._encode(failures, last_failure, next_allowed)
        if os.pwrite(fd, data, 0) != len(data):   # one write: valid or untouched
            # A short write (disk filling mid-write) must fail closed, never pad to a lower count.
            raise OSError(errno.EIO, "short write to login state")
        os.ftruncate(fd, _STATE_SIZE)
        os.fsync(fd)

    @staticmethod
    def _remaining(failures, next_allowed, now):
        if failures == 0:
            return 0
        return max(0.0, next_allowed - now)

    def wait_remaining(self):
        fd = self._open()
        try:
            failures, _, next_allowed, now = self._load(fd)
        finally:
            os.close(fd)
        return self._remaining(failures, next_allowed, now)

    def record_failure(self):
        fd = self._open()
        try:
            failures, _, next_allowed, now = self._load(fd)
            failures = min(failures + 1, _FAILURES_MAX)
            if failures == 1:
                next_allowed = now
            next_allowed = min(max(next_allowed, now + penalty(failures)), now + NEXT_CAP_S)
            self._write(fd, failures, now, next_allowed)
            return failures
        finally:
            os.close(fd)

    def record_attempt(self):
        """Count an attempt as failed and return (new count, seconds to wait before verifying it).

        Check and count happen under one lock, so a connection that passed the gate before others failed
        still waits out the current penalty. The next attempt is scheduled a full penalty after this
        one's verify time, so guesses submitted together are spaced apart. record_success() resets.
        """
        fd = self._open()
        try:
            failures, _, next_allowed, now = self._load(fd)
            wait = self._remaining(failures, next_allowed, now)
            failures = min(failures + 1, _FAILURES_MAX)
            next_allowed = min(now + wait + penalty(failures), now + NEXT_CAP_S)
            self._write(fd, failures, now, next_allowed)
            return failures, wait
        finally:
            os.close(fd)

    def record_success(self):
        fd = self._open()
        try:
            now = self.now()
            self._write(fd, 0, now, now)
        finally:
            os.close(fd)


# ---------------------------------------------------------------- terminal I/O

class TtyIO:
    """Login-prompt I/O on the pty.

    Kernel echo stays off for the whole login (start() .. restore()), so nothing typed or pasted is echoed
    by the tty driver before we decide how to show it. The username is read in non-canonical mode and
    echoed by us; the password is read in canonical mode with no echo at all.
    """

    _NOECHO = termios.ECHO | termios.ECHOE | termios.ECHOK | termios.ECHONL

    def __init__(self, fd_in=0, fd_out=1):
        self.fd_in = fd_in
        self.fd_out = fd_out
        self._pending = b""     # bytes read past a newline
        self._orig = None

    def start(self):
        try:
            self._orig = termios.tcgetattr(self.fd_in)
        except termios.error:
            self._orig = None
            return
        quiet = list(self._orig)
        quiet[3] &= ~self._NOECHO
        termios.tcsetattr(self.fd_in, termios.TCSANOW, quiet)

    def restore(self):
        if self._orig is not None:
            termios.tcsetattr(self.fd_in, termios.TCSANOW, self._orig)

    def write(self, s):
        self._write_bytes(s.encode("utf-8"))

    def _write_bytes(self, data):
        while data:
            n = os.write(self.fd_out, data)
            data = data[n:]

    def discard_pending(self):
        self._pending = b""
        try:
            termios.tcflush(self.fd_in, termios.TCIFLUSH)
        except termios.error:
            pass

    def read_line(self, limit, echo, timeout):
        try:
            saved = termios.tcgetattr(self.fd_in)
        except termios.error:
            if os.isatty(self.fd_in):
                raise
            return self._read_canonical(limit, timeout)      # not a tty (pipe): plain lines
        try:
            if echo:
                raw = list(saved)
                raw[3] &= ~(termios.ICANON | self._NOECHO)
                raw[6] = list(saved[6])
                raw[6][termios.VMIN] = 1
                raw[6][termios.VTIME] = 0
                termios.tcsetattr(self.fd_in, termios.TCSANOW, raw)
                return self._read_edited(limit, timeout)
            quiet = list(saved)
            quiet[3] = (quiet[3] | termios.ICANON) & ~self._NOECHO
            # Discard typeahead, as getpass does (its TCSAFLUSH): if "user\npassword\n" is pasted in one go,
            # the pasted password is thrown away (never echoed, never used) and must be typed again.
            # Done as TCSANOW + tcflush(TCIFLUSH) rather than TCSAFLUSH: TCSAFLUSH also waits for pending
            # output to drain, which on a pty blocks for as long as ttyd isn't reading it (no deadline).
            # Echo goes off first, so nothing arriving in between is echoed.
            termios.tcsetattr(self.fd_in, termios.TCSANOW, quiet)
            termios.tcflush(self.fd_in, termios.TCIFLUSH)
            self._pending = b""
            return self._read_canonical(limit, timeout)
        finally:
            termios.tcsetattr(self.fd_in, termios.TCSANOW, saved)

    def _next_chunk(self, deadline):
        if self._pending:
            chunk, self._pending = self._pending, b""
            return chunk
        left = deadline - time.monotonic()
        if left <= 0 or not select.select([self.fd_in], [], [], left)[0]:
            raise TimeoutError
        chunk = os.read(self.fd_in, 1024)
        if not chunk:
            raise EOFError
        return chunk

    def _read_edited(self, limit, timeout):
        """Non-canonical read with our own echo: printable bytes, Backspace/DEL, Ctrl+U, Ctrl+D, Enter.

        Other control bytes and escape sequences (arrow keys) are dropped, not echoed.
        """
        deadline = time.monotonic() + timeout
        buf = bytearray()
        over = False
        esc = 0                     # 1 after ESC, 2 inside a CSI/SS3 sequence
        while True:
            chunk = self._next_chunk(deadline)
            out = bytearray()
            for i, b in enumerate(chunk):
                if esc == 1:
                    esc = 2 if b in (0x5B, 0x4F) else 0
                    continue
                if esc == 2:
                    if 0x40 <= b <= 0x7E:
                        esc = 0
                    continue
                if b in (0x0A, 0x0D):
                    rest = chunk[i + 1:]
                    if b == 0x0D and rest[:1] == b"\n":
                        rest = rest[1:]
                    self._pending = rest
                    self._write_bytes(bytes(out) + b"\n")
                    if over:
                        raise ValueError("line too long")
                    return buf.decode("utf-8", errors="replace")
                if b == 0x1B:
                    esc = 1
                elif b == 0x04:                         # Ctrl+D
                    if not buf and not over:
                        self._write_bytes(bytes(out))
                        raise EOFError
                elif b in (0x7F, 0x08):                 # Backspace: drop one UTF-8 character
                    if buf and not over:
                        j = len(buf) - 1
                        while j > 0 and (buf[j] & 0xC0) == 0x80:
                            j -= 1
                        del buf[j:]
                        out += b"\b \b"
                elif b == 0x15:                         # Ctrl+U
                    if not over:
                        out += b"\b \b" * len(buf.decode("utf-8", errors="replace"))
                        buf.clear()
                elif b < 0x20 or over:
                    pass
                elif len(buf) >= limit:
                    over = True
                    buf.clear()
                else:
                    buf.append(b)
                    out.append(b)
            self._write_bytes(bytes(out))

    def _read_canonical(self, limit, timeout):
        deadline = time.monotonic() + timeout
        buf = b""
        over = False
        while True:
            chunk = self._next_chunk(deadline)
            nl = chunk.find(b"\n")
            if nl >= 0:
                self._pending = chunk[nl + 1:]
                chunk = chunk[:nl]
            if not over:
                buf += chunk
                if len(buf.rstrip(b"\r") if nl >= 0 else buf) > limit:
                    over, buf = True, b""
            if nl >= 0:
                if over:
                    raise ValueError("line too long")
                if buf.endswith(b"\r"):
                    buf = buf[:-1]
                return buf.decode("utf-8", errors="replace")


# ---------------------------------------------------------------- login

def log(priority, message):
    syslog.syslog(priority, message)


def _same(a, b):
    return hmac.compare_digest(a.encode("utf-8", "surrogatepass"), b.encode("utf-8", "surrogatepass"))


def login(io, *, user, host, hash_path, throttle, log, sleep=time.sleep):
    stored = load_hash(hash_path)
    if stored is None:
        io.write(MSG_NOT_SET_UP)
        log(syslog.LOG_ERR, "term.pass missing or unsafe; refusing logins")
        return False
    try:
        io.write(f"\n{host} — web terminal\n\n")
        for _ in range(MAX_TRIES):
            # wait out the global delay; re-check, since another connection may have failed meanwhile
            waited = False
            while True:
                remaining = throttle.wait_remaining()
                if remaining <= 0:
                    break
                io.write(f"Too many failed attempts; wait {math.ceil(remaining)} s\n")
                sleep(remaining)
                waited = True
            if waited:
                io.discard_pending()

            deadline = time.monotonic() + IDLE_S        # one idle budget for username + password
            io.write(f"{host} login: ")
            name_ok = True
            try:
                name = io.read_line(USER_MAX, True, max(0.0, deadline - time.monotonic()))
            except ValueError:
                name, name_ok = "", False
            io.write("Password: ")
            pw_ok = True
            try:
                password = io.read_line(PASS_MAX, False, max(0.0, deadline - time.monotonic()))
            except ValueError:
                password, pw_ok = "", False
            finally:
                io.write("\n")

            # Count the attempt before verifying, and in the same locked step learn whether a penalty became
            # active while this connection sat at its prompt. A Ctrl+C or hang-up during the wait or scrypt
            # then can't leave a guess uncounted, and no guess is verified early. Success resets the counter.
            failures, wait = throttle.record_attempt()
            if wait > 0:
                io.write(f"Too many failed attempts; wait {math.ceil(wait)} s\n")
                sleep(wait)
            ok = verify_password(password, stored)       # always run, so timing doesn't reveal the user
            is_user = name_ok and _same(name, user)
            if ok and is_user and pw_ok:
                throttle.record_success()
                log(syslog.LOG_INFO, f"login ok for {user}")
                return True
            if failures == 5:
                log(syslog.LOG_ERR, f"login delay active ({failures} failures)")
            log(syslog.LOG_WARNING, f"failed login for {user}" if is_user else "failed login (unknown user)")
            sleep(FAIL_DELAY_S)
            io.write(MSG_INCORRECT)
        return False
    except (EOFError, KeyboardInterrupt):
        return False
    except TimeoutError:
        io.write(MSG_TIMEOUT)
        return False


def exec_shell(home, execv=os.execv):
    try:
        os.chdir(home)
    except OSError:
        os.chdir("/")
    name = pwd.getpwuid(os.getuid()).pw_name
    os.environ.update({"HOME": home, "USER": name, "LOGNAME": name, "SHELL": "/bin/bash"})
    # Ignored signals survive exec: give the shell normal SIGQUIT (ignored during login) and SIGPIPE /
    # SIGXFSZ (which Python ignores), and the core limit it had before login.
    for sig in (signal.SIGQUIT, signal.SIGPIPE, signal.SIGXFSZ):
        signal.signal(sig, signal.SIG_DFL)
    if _saved_core is not None:
        try:
            resource.setrlimit(resource.RLIMIT_CORE, _saved_core)
        except (ValueError, OSError):
            pass
    syslog.closelog()
    execv("/bin/bash", ["bash", "--rcfile", RCFILE, "-i"])


# ---------------------------------------------------------------- --write-hash

def _err(msg):
    sys.stderr.write(f"term_login: {msg}\n")
    return 2


def write_hash(path):
    data = sys.stdin.buffer.read(WRITE_HASH_MAX + 1)
    if len(data) > WRITE_HASH_MAX:
        return _err(f"password input longer than {WRITE_HASH_MAX} bytes")
    if data.endswith(b"\n"):
        data = data[:-1]
    try:
        password = data.decode("utf-8")
    except UnicodeError:
        return _err("password is not valid UTF-8")
    if "\n" in password or "\r" in password:
        return _err("password must be a single line")
    if len(password) < WRITE_HASH_MIN_CHARS:
        return _err(f"password must be at least {WRITE_HASH_MIN_CHARS} characters")

    path = os.path.abspath(path)
    d = os.path.dirname(path)
    if os.path.islink(path) or os.path.islink(d):
        return _err("refusing to write through a symlink")
    if os.path.lexists(path) and not os.path.isfile(path):
        return _err("target exists and is not a regular file")
    tmp = None
    try:
        os.makedirs(d, mode=0o700, exist_ok=True)
        if os.path.islink(d):
            return _err("refusing to write through a symlink")
        os.chmod(d, 0o700)
        line = (hash_password(password) + "\n").encode("ascii")
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".term.pass.")
        try:
            os.fchmod(fd, 0o600)
            os.write(fd, line)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path)
        tmp = None
    except OSError as e:
        return _err(f"could not write the hash file ({e.strerror or type(e).__name__})")
    finally:
        if tmp is not None:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    return 0


# ---------------------------------------------------------------- entry point

def _no_core_dumps():
    """Lower the soft core limit to 0 (the hash and typed input must never land in a core file)."""
    global _saved_core
    try:
        soft, hard = resource.getrlimit(resource.RLIMIT_CORE)
        resource.setrlimit(resource.RLIMIT_CORE, (0, hard))
        _saved_core = (soft, hard)
    except (ValueError, OSError):
        _saved_core = None


def _say(io, msg):
    try:
        io.write(msg)
    except Exception:
        pass


def main(argv=None, *, io=None, execv=os.execv):
    argv = sys.argv[1:] if argv is None else list(argv)
    _no_core_dumps()
    syslog.openlog(ident="term-login", logoption=0, facility=syslog.LOG_AUTH)
    if argv:
        if len(argv) == 2 and argv[0] == "--write-hash":
            return write_hash(argv[1])
        sys.stderr.write("usage: term_login.py [--write-hash PATH]\n")
        return 2

    # Every failure below logs a fixed message and returns 1: no traceback (paths, source) reaches the
    # unauthenticated pty, and nothing the client typed reaches the log.
    signal.signal(signal.SIGQUIT, signal.SIG_IGN)       # Ctrl+\ must not dump core during login
    started = None
    try:
        if io is None:
            io = TtyIO()
        if hasattr(io, "start"):
            io.start()
            started = io
        user = pwd.getpwuid(os.getuid()).pw_name
        host = socket.gethostname().split(".")[0]
        ok = login(io, user=user, host=host, hash_path=HASH_PATH,
                   throttle=Throttle(STATE_PATH, now=time.time), log=log, sleep=time.sleep)
    except (KeyboardInterrupt, EOFError):
        return 1
    except Exception:           # fail closed: never a shell on an unexpected error
        try:
            log(syslog.LOG_ERR, "login error")
        except Exception:
            pass
        _say(io, MSG_INTERNAL)
        return 1
    finally:
        if started is not None:
            try:
                started.restore()
            except Exception:
                pass
    if ok is not True:
        return 1
    try:
        exec_shell(pwd.getpwuid(os.getuid()).pw_dir, execv=execv)
    except Exception:
        try:
            syslog.openlog(ident="term-login", logoption=0, facility=syslog.LOG_AUTH)
            log(syslog.LOG_ERR, "exec failed")
        except Exception:
            pass
        _say(io, MSG_INTERNAL)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
