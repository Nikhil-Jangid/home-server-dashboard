#!/usr/bin/env bash
# Runs every automated check. Usage: bash scripts/check.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== banned DOM APIs in www/"
[ -d www ] || { echo "FAIL: www/ missing" >&2; exit 1; }
rc=0
grep -rnE 'innerHTML|outerHTML|insertAdjacentHTML|document\.write' www/ || rc=$?
case "$rc" in
  0) echo "FAIL: banned API found (use textContent / h())" >&2; exit 1 ;;
  1) ;;  # no match
  *) echo "FAIL: grep could not scan www/ (exit $rc); refusing to treat that as clean" >&2; exit 1 ;;
esac

echo "== ttyd runs the login program, never a credential"
unit=deploy/units/ttyd-dash.service
exec_line=$(grep -E '^ExecStart=' "$unit")
expected='ExecStart=/usr/bin/ttyd -d 3 -m 4 -i lo -p 7681 -b /term -W -O -- /usr/bin/python3 -I @APP_DIR@/term/term_login.py'
[[ "$exec_line" == "$expected" ]] || { echo "FAIL: ttyd ExecStart must be exactly: $expected" >&2; echo "  got: $exec_line" >&2; exit 1; }
if grep -q '^EnvironmentFile=' "$unit"; then echo "FAIL: ttyd unit must not load an EnvironmentFile" >&2; exit 1; fi

echo "== setup scripts"
for f in setup.sh scripts/*.sh; do bash -n "$f"; done
if command -v shellcheck >/dev/null; then
  shellcheck -S warning setup.sh scripts/*.sh
else
  echo "(shellcheck not installed; syntax check only)"
fi
python3 -I -m unittest discover -s scripts -p 'test_*.py' -v

echo "== JS tests"
node --test 'tests/**/*.test.js'

echo "== Python tests"
if compgen -G 'dash-events/test_*.py' >/dev/null; then
  python3 -I -m unittest discover -s dash-events -p 'test_*.py' -v
fi

echo "== term tests"
bash -n term/dashboard.bashrc
python3 -I -m unittest discover -s term -p 'test_*.py' -v
echo "ALL CHECKS PASSED"
