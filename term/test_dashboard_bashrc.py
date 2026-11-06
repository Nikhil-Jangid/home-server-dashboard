"""Tests for dashboard.bashrc (the one-line, zsh-style prompt for the web terminal).

Functions are tested by sourcing the file with DASH_RC_FUNCS_ONLY=1 in a clean bash, so nothing from the
machine's profile or the owner's ~/.bashrc is involved.
"""
import os
import re
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
RC = HERE / "dashboard.bashrc"
SUBSET_SCRIPT = HERE.parent / "scripts" / "make-font-subset.sh"
TIME_RE = r"\d\d:\d\d:\d\d [AP]M"


def visible(ps1):
    """What bash counts as the prompt's width: everything outside \\[ \\]."""
    return re.sub(r"\\\[.*?\\\]", "", ps1)


def bash(script, cwd=None, env_extra=None):
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": "/home/u", "DASH_RC_FUNCS_ONLY": "1",
           "LC_ALL": "en_US.UTF-8", "GIT_CONFIG_NOSYSTEM": "1"}
    env.update(env_extra or {})
    r = subprocess.run(["bash", "--noprofile", "--norc", "-c", f'. "{RC}"; {script}'],
                       cwd=cwd, env=env, capture_output=True, timeout=30)
    if r.returncode != 0:
        raise AssertionError(f"bash failed rc={r.returncode}: {r.stderr.decode(errors='replace')}")
    return r.stdout.decode("utf-8")


class BashrcTest(unittest.TestCase):
    def test_syntax(self):
        r = subprocess.run(["bash", "-n", str(RC)], capture_output=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_short_cwd(self):
        # every parent is cut to 2 characters (3 for a dot-directory); the current folder is kept whole
        cases = {
            "/home/u": "~",
            "/home/u/projects": "~/projects",
            "/home/u/Projects/home-server-dashboard": "~/Pr/home-server-dashboard",
            "/home/u/projects/media/server/term/www": "~/pr/me/se/te/www",
            "/home/u/.config/a/b/c": "~/.co/a/b/c",
            "/etc/systemd/system/multi-user.target.wants": "/et/sy/sy/multi-user.target.wants",
            "/": "/",
            "/home/user2/x": "/ho/us/x",      # a sibling of $HOME is not under it
            "/a/b/c": "/a/b/c",
        }
        for path, want in cases.items():
            with self.subTest(path=path):
                self.assertEqual(bash(f'__dash_short_cwd "{path}"').rstrip("\n"), want)

    def test_prompt_success_failure_duration(self):
        with tempfile.TemporaryDirectory() as d:
            d = os.path.realpath(d)
            sub = os.path.join(d, "Projects", "home-server-dashboard")
            os.makedirs(sub)
            env = {"HOME": d, "COLUMNS": "80"}
            ok = bash("__dash_build_ps1 0 0", cwd=sub, env_extra=env)
            bad = bash("__dash_build_ps1 3 5", cwd=sub, env_extra=env)
            two = bash("__dash_build_ps1 0 2", cwd=sub, env_extra=env)
        # one line, plain text like the login screen: path, then the prompt character
        self.assertEqual(visible(ok), "~/Pr/home-server-dashboard > ")
        self.assertEqual(visible(bad), "~/Pr/home-server-dashboard > ")
        self.assertIn("\\[\\e[38;5;103m\\]~/Pr/", ok)                       # parents dim lavender
        self.assertIn("\\[\\e[1;38;5;39m\\]home-server-dashboard", ok)     # current folder bold blue
        self.assertTrue(ok.endswith("\\[\\e[38;5;76m\\]>\\[\\e[0m\\] "), repr(ok[-40:]))   # green >
        self.assertTrue(bad.endswith("\\[\\e[38;5;196m\\]>\\[\\e[0m\\] "), repr(bad[-40:]))  # red >
        # the time is right-aligned in dim teal, inside \\[ \\] so it never counts toward the width
        m = re.search(r"\\\[\\e\[(\d+)G\\e\[38;5;66m(.*?)\\e\[0m\\r\\\]", ok)
        self.assertIsNotNone(m, repr(ok))
        self.assertRegex(m.group(2), "^" + TIME_RE + "$")
        self.assertEqual(int(m.group(1)), 80 - len(m.group(2)) + 1)
        mb = re.search(r"\\e\[(\d+)G\\e\[38;5;66m(.*?)\\e\[0m", bad)
        self.assertRegex(mb.group(2), "^5s " + TIME_RE + "$")                  # duration over 2 s
        self.assertEqual(int(mb.group(1)), 80 - len(mb.group(2)) + 1)
        self.assertNotRegex(two, r"\ds " + TIME_RE)                           # 2 s is not "> 2 s"
        for ps1 in (ok, bad, two):
            self.assertEqual(ps1.count("\\["), ps1.count("\\]"))
            outside = visible(ps1)
            self.assertNotIn("\\e", outside)
            self.assertNotIn("\x1b", outside)
            self.assertNotIn("\\n", ps1)                                       # one line
            self.assertNotIn("\\u@\\h", ps1)                                  # the panel header shows user@host

    def test_time_is_dropped_when_the_line_is_too_narrow(self):
        with tempfile.TemporaryDirectory() as d:
            d = os.path.realpath(d)
            sub = os.path.join(d, "a-rather-long-folder-name")
            os.mkdir(sub)
            narrow = bash("__dash_build_ps1 0 0", cwd=sub, env_extra={"HOME": d, "COLUMNS": "30"})
            unset = bash("__dash_build_ps1 0 0", cwd=sub, env_extra={"HOME": d, "COLUMNS": "x"})
        self.assertNotRegex(narrow, TIME_RE)
        self.assertEqual(visible(narrow), "~/a-rather-long-folder-name > ")
        self.assertRegex(unset, r"\\e\[70G")                                  # non-numeric COLUMNS → 80

    def test_home_and_root_paths(self):
        with tempfile.TemporaryDirectory() as d:
            d = os.path.realpath(d)
            at_home = bash("__dash_build_ps1 0 0", cwd=d, env_extra={"HOME": d})
        root = bash("__dash_build_ps1 0 0", cwd="/", env_extra={"HOME": "/nonexistent-home"})
        self.assertEqual(visible(at_home), "~ > ")
        self.assertIn("\\[\\e[1;38;5;39m\\]~", at_home)
        self.assertEqual(visible(root), "/ > ")

    def test_cwd_and_branch_are_not_expanded_or_escaped(self):
        # a directory name must not inject prompt escapes or command substitution
        with tempfile.TemporaryDirectory() as d:
            evil = os.path.join(d, "a\\[b$(touch pwned)`id`")
            os.mkdir(evil)
            ps1 = bash("__dash_build_ps1 0 0", cwd=evil)
            self.assertIn("a\\\\[b", ps1)                  # backslash doubled: no stray \[
            # render the prompt the way interactive bash would, then check nothing ran
            out = bash('__dash_prompt; printf "%s" "${PS1@P}"'
                       if self._bash_has_at_p() else 'true', cwd=evil)
            self.assertFalse(os.path.exists(os.path.join(evil, "pwned")))
            if out:
                self.assertIn("$(touch pwned)", out)

    @staticmethod
    def _bash_has_at_p():
        r = subprocess.run(["bash", "-c", 'x=1; echo "${x@P}"'], capture_output=True)
        return r.returncode == 0

    @unittest.skipUnless(shutil.which("git"), "git not installed")
    def test_git_segment_branch_and_dirty(self):
        with tempfile.TemporaryDirectory() as d:
            genv = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid", "GIT_COMMITTER_NAME": "t",
                    "GIT_COMMITTER_EMAIL": "t@example.invalid", "HOME": d}
            env = dict(os.environ, **genv)

            def git(*a):
                subprocess.run(["git", *a], cwd=d, env=env, check=True, capture_output=True)

            git("-c", "init.defaultBranch=main", "init")
            Path(d, "f.txt").write_text("one\n")
            git("add", "f.txt")
            git("commit", "-m", "init")
            Path(d, "f.txt").write_text("two\n")
            self.assertEqual(bash("__dash_git", cwd=d, env_extra=genv).rstrip("\n"), "main *")
            dirty = bash("__dash_build_ps1 0 0", cwd=d, env_extra=genv)
            self.assertIn("main *", dirty)
            self.assertIn("\\[\\e[38;5;178m\\]main *", dirty)   # yellow when dirty
            self.assertTrue(visible(dirty).endswith(" main * > "), repr(visible(dirty)))
            git("checkout", "--", "f.txt")
            Path(d, "untracked.txt").write_text("x\n")        # untracked files do not count (-uno)
            self.assertEqual(bash("__dash_git", cwd=d, env_extra=genv).rstrip("\n"), "main")
            clean = bash("__dash_build_ps1 0 0", cwd=d, env_extra=genv)
            self.assertIn("main", clean)
            self.assertNotIn("main *", clean)
            self.assertIn("\\[\\e[38;5;76m\\]main", clean)      # green when clean
            self.assertTrue(visible(clean).endswith(" main > "), repr(visible(clean)))

    @unittest.skipUnless(shutil.which("git"), "git not installed")
    def test_git_segment_in_fresh_repo(self):
        with tempfile.TemporaryDirectory() as d:
            subprocess.run(["git", "-c", "init.defaultBranch=main", "init"], cwd=d, check=True, capture_output=True)
            self.assertEqual(bash("__dash_git", cwd=d, env_extra={"HOME": d}).rstrip("\n"), "main")

    def test_prompt_command_timer_and_status(self):
        # drive the init block's prompt hook the way interactive bash does, without sourcing any profile
        with tempfile.TemporaryDirectory() as d:
            out = bash('__dash_t0=$((SECONDS - 7)); (exit 4); __dash_prompt; printf "%s|%s" "$PS1" "${__dash_t0-unset}"',
                       cwd=d)
        ps1, t0 = out.rsplit("|", 1)
        self.assertIn("\\[\\e[38;5;196m\\]>", ps1)      # red after exit 4
        self.assertRegex(ps1, "7s " + TIME_RE)
        self.assertEqual(t0, "unset")

    def test_init_block_sources_profiles_and_sets_prompt(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, ".profile").write_text('PROFILE_RAN=1\n[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n')
            Path(d, ".bashrc").write_text("BASHRC_RAN=$((${BASHRC_RAN:-0} + 1))\nalias ll='ls -l'\n")
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": d, "TERM": "dumb"}
            r = subprocess.run(
                ["bash", "--noprofile", "--norc", "-c",
                 f'. "{RC}"; printf "%s %s %s|" "$PROFILE_RAN" "$BASHRC_RAN" "$(alias ll)";'
                 ' printf "%s|" "$PROMPT_COMMAND"; trap -p DEBUG; shopt promptvars; true'],
                cwd=d, env=env, capture_output=True, timeout=30)
            out = r.stdout.decode()
            bashrc_after = Path(d, ".bashrc").read_text()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(out.startswith("1 1 alias ll='ls -l'|"), out)   # ~/.bashrc sourced exactly once
        self.assertIn("__dash_prompt", out)
        self.assertIn("__dash_t0", out)
        self.assertIn("DEBUG", out)
        self.assertRegex(out, r"promptvars\s+off")
        # the owner's ~/.bashrc is never written
        self.assertEqual(bashrc_after, "BASHRC_RAN=$((${BASHRC_RAN:-0} + 1))\nalias ll='ls -l'\n")

    def _git_repo(self, d):
        genv = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid", "GIT_COMMITTER_NAME": "t",
                "GIT_COMMITTER_EMAIL": "t@example.invalid", "HOME": d, "GIT_CONFIG_NOSYSTEM": "1"}
        env = dict(os.environ, **genv)

        def git(*a):
            return subprocess.run(["git", *a], cwd=os.path.join(d, "repo"), env=env, check=True,
                                  capture_output=True)

        os.mkdir(os.path.join(d, "repo"))
        git("-c", "init.defaultBranch=main", "init")
        return git, genv

    @unittest.skipUnless(shutil.which("git"), "git not installed")
    def test_malicious_fsmonitor_does_not_run(self):                    # I1
        with tempfile.TemporaryDirectory() as d:
            git, genv = self._git_repo(d)
            repo, marker = os.path.join(d, "repo"), os.path.join(d, "PWNED-fsmonitor")
            hook = os.path.join(d, "hook.sh")
            Path(hook).write_text(f"#!/bin/sh\ntouch '{marker}'\nexit 1\n")
            os.chmod(hook, 0o755)
            Path(repo, "f.txt").write_text("one\n")
            git("add", "f.txt")
            git("commit", "-m", "init")
            git("config", "core.fsmonitor", hook)
            ps1 = bash("__dash_build_ps1 0 0", cwd=repo, env_extra=genv)
            self.assertIn("main", ps1)
            self.assertFalse(os.path.exists(marker), "the prompt ran the repo's core.fsmonitor")
            git("status")                                   # control: plain git status does run it
            self.assertTrue(os.path.exists(marker))

    @unittest.skipUnless(shutil.which("git"), "git not installed")
    def test_malicious_clean_filter_does_not_run(self):                 # I1 (same class: config-run commands)
        with tempfile.TemporaryDirectory() as d:
            git, genv = self._git_repo(d)
            repo, marker = os.path.join(d, "repo"), os.path.join(d, "PWNED-filter")
            Path(repo, ".gitattributes").write_text("*.txt filter=evil\n")
            Path(repo, "f.txt").write_text("one\n")
            git("add", ".")
            git("commit", "-m", "init")
            git("config", "filter.evil.clean", f"touch '{marker}'; cat")
            time.sleep(1.1)
            Path(repo, "f.txt").write_text("one\n")         # same size, new mtime: status must re-hash it
            ps1 = bash("__dash_build_ps1 0 0", cwd=repo, env_extra=genv)
            self.assertFalse(os.path.exists(marker), "the prompt ran the repo's clean filter")
            self.assertIn("main ?", ps1)                     # branch shown, dirty state unknown
            git("status")                                   # control: plain git status does run it
            self.assertTrue(os.path.exists(marker))

    @unittest.skipUnless(shutil.which("git"), "git not installed")
    def test_partial_clone_lazy_fetch_does_not_run(self):              # N1
        for variant in ("sshCommand", "uploadpack", "ssh-allowed-locally"):
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as d:
                git, genv = self._git_repo(d)
                repo, marker = os.path.join(d, "repo"), os.path.join(d, "PWNED-lazyfetch")
                evil = os.path.join(d, "evil.sh")
                Path(evil).write_text(f"#!/bin/sh\ntouch '{marker}'\nexit 1\n")
                os.chmod(evil, 0o755)
                Path(repo, "f.txt").write_text("one\n")
                git("add", "f.txt")
                git("commit", "-m", "init")
                git("config", "core.repositoryformatversion", "1")
                git("config", "extensions.partialClone", "origin")
                git("config", "remote.origin.promisor", "true")
                if variant == "uploadpack":
                    git("config", "remote.origin.url", os.path.join(d, "nonexistent"))
                    git("config", "remote.origin.uploadpack", evil)
                else:
                    git("config", "remote.origin.url", "ssh://example.invalid/r")
                    git("config", "core.sshCommand", evil)
                    if variant == "ssh-allowed-locally":
                        git("config", "protocol.ssh.allow", "always")
                tree = git("rev-parse", "HEAD^{tree}").stdout.decode().strip()
                os.unlink(os.path.join(repo, ".git", "objects", tree[:2], tree[2:]))   # missing HEAD tree
                ps1 = bash("__dash_build_ps1 0 0", cwd=repo, env_extra=genv)
                self.assertFalse(os.path.exists(marker), "the prompt lazy-fetched through repo config")
                self.assertIn("main ?", ps1)
                subprocess.run(["git", "status"], cwd=repo, env=dict(os.environ, **genv), capture_output=True)
                self.assertTrue(os.path.exists(marker))     # control: plain git status does run it

    @unittest.skipUnless(shutil.which("git"), "git not installed")
    def test_slow_git_is_cut_off(self):                                  # N2
        with tempfile.TemporaryDirectory() as d:
            git, genv = self._git_repo(d)
            repo = os.path.join(d, "repo")
            Path(repo, "f.txt").write_text("one\n")
            git("add", "f.txt")
            git("commit", "-m", "init")
            shims = os.path.join(d, "bin")
            os.mkdir(shims)
            real_git = shutil.which("git")
            # a git whose `status` hangs, and a stand-in for coreutils timeout (macOS has none)
            Path(shims, "git").write_text(
                f'#!/bin/sh\nfor a in "$@"; do [ "$a" = status ] && exec sleep 30; done\nexec "{real_git}" "$@"\n')
            Path(shims, "timeout").write_text(
                "#!/usr/bin/env python3\nimport subprocess, sys\n"
                "try:\n    sys.exit(subprocess.run(sys.argv[2:], timeout=float(sys.argv[1])).returncode)\n"
                "except subprocess.TimeoutExpired:\n    sys.exit(124)\n")
            for f in ("git", "timeout"):
                os.chmod(os.path.join(shims, f), 0o755)
            env = dict(genv, PATH=shims + os.pathsep + os.environ.get("PATH", "/usr/bin:/bin"))
            t0 = time.monotonic()
            out = bash("__dash_git", cwd=repo, env_extra=env)
            self.assertLess(time.monotonic() - t0, 10)
            self.assertEqual(out.rstrip("\n"), "main ?")

    def test_control_characters_in_cwd_are_replaced(self):              # M1
        with tempfile.TemporaryDirectory() as d:
            name = "evil\x1b]0;PWNED\x07\x1b[2J\r\x7f\u009b\x01x"
            evil = os.path.join(d, name)
            os.mkdir(evil)
            ps1 = bash("__dash_build_ps1 0 0", cwd=evil)
            for bad in ("\x1b", "\x07", "\r", "\x7f", "\u009b", "\x01"):
                self.assertNotIn(bad, ps1, repr(bad))
            self.assertIn("evil?]0;PWNED??[2J????x", ps1)     # ESC BEL ESC; CR DEL C1 SOH
            nl = os.path.join(d, "a\nb")
            os.mkdir(nl)
            self.assertIn("a?b", bash("__dash_build_ps1 0 0", cwd=nl))
            ok = os.path.join(d, "caf\u00e9\u2014\u00a0ok")       # legitimate UTF-8 survives
            os.mkdir(ok)
            self.assertIn("caf\u00e9\u2014\u00a0ok", bash("__dash_build_ps1 0 0", cwd=ok))

    def _init(self, home, script, bashrc):
        Path(home, ".bashrc").write_text(bashrc)
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": home, "TERM": "dumb",
               "LC_ALL": "en_US.UTF-8"}
        return subprocess.run(["bash", "--noprofile", "--norc", "-c", f'. "{RC}"; {script}'],
                              cwd=home, env=env, capture_output=True, timeout=30)

    def test_owner_prompt_command_with_trailing_semicolon(self):        # I2
        for owner in ("OWNER_RAN=1; ", "OWNER_RAN=1 # a comment", "OWNER_RAN=1"):
            with self.subTest(owner=owner), tempfile.TemporaryDirectory() as d:
                # the DEBUG trap is removed first: in `bash -c` every later command would restart the timer
                r = self._init(d, 'trap - DEBUG; __dash_t0=$SECONDS; eval "$PROMPT_COMMAND";'
                                  ' printf "%s|%s|%s" "$OWNER_RAN" "${__dash_t0-unset}" "$PS1"',
                               f'PROMPT_COMMAND="{owner}"\n')
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(r.stderr, b"")
                ran, t0, ps1 = r.stdout.decode().split("|", 2)
                self.assertEqual((ran, t0), ("1", "unset"))
                self.assertTrue(ps1.endswith(">\\[\\e[0m\\] "), repr(ps1[-30:]))

    def test_debug_trap_safe_under_extdebug(self):                     # M2
        with tempfile.TemporaryDirectory() as d:
            r = self._init(d, "echo one; echo two; echo three", "shopt -s extdebug\n")
            self.assertEqual(r.stdout.decode(), "one\ntwo\nthree\n", r.stderr)

    def test_owner_debug_trap_is_kept(self):                           # M2
        with tempfile.TemporaryDirectory() as d:
            r = self._init(d, "trap -p DEBUG", "trap 'OWNER_DEBUG=1' DEBUG\n")
            out = r.stdout.decode()
            self.assertIn("OWNER_DEBUG=1", out)
            self.assertNotIn("__dash_t0", out)

    def test_bashrc_glyphs_are_in_font_subset(self):
        m = re.search(r'^UNICODES="([^"]+)"', SUBSET_SCRIPT.read_text(), re.M)
        self.assertIsNotNone(m, "UNICODES= line not found in make-font-subset.sh")
        spec = m.group(1)
        ranges = []
        for part in spec.split(","):
            part = part.strip().upper().removeprefix("U+")
            lo, _, hi = part.partition("-")
            ranges.append((int(lo, 16), int(hi or lo, 16)))
        text = RC.read_text(encoding="utf-8")
        used = sorted({ord(c) for c in text if ord(c) > 0x7E})
        # the prompt is plain ASCII now; any glyph that is added later must be in the subset
        missing = [f"U+{cp:04X}" for cp in used if not any(lo <= cp <= hi for lo, hi in ranges)]
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
