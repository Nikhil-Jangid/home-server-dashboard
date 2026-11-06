#!/usr/bin/env bash
# home-server-dashboard: install or update everything on this server. Safe to run again at any time.
#
#   cd home-server-dashboard && sudo ./setup.sh
#   sudo ./setup.sh --rotate-terminal-password    choose a new web-terminal password
#
# Needs Ubuntu (or Debian) with systemd, and port 80 free. Docker and Tailscale are optional.
# Before changing anything it checks that nothing else uses the ports it needs, and stops if so.
set -euo pipefail

ROTATE_PW=0
for arg in "$@"; do
  case "$arg" in
    --rotate-terminal-password) ROTATE_PW=1 ;;
    *) echo "usage: sudo ./setup.sh [--rotate-terminal-password]" >&2; exit 1 ;;
  esac
done

APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
GLANCES_VERSION="4.5.8"
CADDYFILE="/etc/caddy/Caddyfile"
CADDY_MARKER="# Installed by home-server-dashboard"
UNIT_DIR="/etc/systemd/system"
PROC_ROOT="/proc"
TTYD_BIN="/usr/bin/ttyd"
GLANCES_USER="hsd-glances"
GLANCES_HOME="/opt/home-server-dashboard/glances"
ETC_DIR="/etc/home-server-dashboard"
ROUTE_WAIT_S=15
SAFE_PATH='^/[A-Za-z0-9._/-]+$'
DOCKER_GROUP_LINE=""
TS_HOST=""
TS_IP=""
SERVE_ON=0
ADDRS=""

abort() {
  printf 'STOP: %s\n' "$*" >&2
  exit 1
}

# Everything written under the user's home is written AS that user, so a planted symlink can never
# make root write somewhere else.
as_user() { runuser -u "$SVC_USER" -- env HOME="$SVC_HOME" "$@"; }

has_tty() { [ -t 0 ]; }

no_symlink() {
  local p
  for p in "$@"; do
    [ ! -L "$p" ] || abort "$p is a symlink; remove it and run setup again."
  done
}

require_sudo_user() {
  local u="${SUDO_USER:-}"
  if [ -z "$u" ] || [ "$u" = root ]; then
    abort "run this from your normal account with sudo (sudo ./setup.sh), not as root directly. The web terminal logs into the account that runs it."
  fi
  [ "$(id -u)" -eq 0 ] || abort "run it with sudo: sudo ./setup.sh"
  SVC_USER="$u"
  SVC_HOME="$(getent passwd "$u" | cut -d: -f6)"
  CONFIG_DIR="$SVC_HOME/.config/home-server-dashboard"
}

check_platform() {
  [ -d /run/systemd/system ] || abort "this server does not run systemd; home-server-dashboard needs Ubuntu or Debian with systemd."
  command -v apt-get >/dev/null 2>&1 || abort "apt-get not found; home-server-dashboard needs Ubuntu or Debian."
}

# The folder this script is in becomes the installed app: the services run its files directly.
check_app_dir() {
  [[ "$SVC_HOME" =~ $SAFE_PATH ]] && [[ "$APP_DIR" =~ $SAFE_PATH ]] \
    || abort "the paths '$SVC_HOME' and '$APP_DIR' may only contain letters, digits and . _ / - (the service files are written from them). Move the folder and run setup again."
  no_symlink "$APP_DIR"
  local owner
  owner="$(stat -c %U "$APP_DIR" 2>/dev/null || stat -f %Su "$APP_DIR")"
  [ "$owner" = "$SVC_USER" ] \
    || abort "$APP_DIR is owned by $owner, not by $SVC_USER. Clone or unpack it as $SVC_USER (not with sudo) and run setup again."
  local f
  for f in term/term_login.py dash-events/dash_events.py www/index.html deploy/Caddyfile \
           config/quicklaunch.example config/ignore.example config/mutes.example; do
    [ -f "$APP_DIR/$f" ] || abort "$APP_DIR/$f is missing; download the project again."
  done
}

# term_login.py hashes with scrypt; a python3 without it would lock the owner out of the terminal.
check_scrypt() {
  /usr/bin/python3 -I -c 'import hashlib; hashlib.scrypt(b"x", salt=b"s", n=2, r=1, p=1)' 2>/dev/null \
    || abort "/usr/bin/python3 has no working hashlib.scrypt (needs OpenSSL 1.1 or newer)."
}

# Listeners on a TCP port that were NOT started by the given systemd unit, one "name (pid N)" per line.
# A process name proves nothing; the cgroup says which unit started it.
foreign_listeners() {
  local port="$1" unit="$2" line pid name out=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    pid="$(printf '%s' "$line" | sed -n 's/.*pid=\([0-9]*\).*/\1/p')"
    name="$(printf '%s' "$line" | sed -n 's/.*(("\([^"]*\)".*/\1/p')"
    if [ -n "$pid" ] && grep -q "/$unit\$" "$PROC_ROOT/$pid/cgroup" 2>/dev/null; then
      continue
    fi
    out+="${name:-unknown program} (pid ${pid:-?})"$'\n'
  done < <(ss -ltnpH "sport = :$port" 2>/dev/null || true)
  printf '%s' "$out"
}

# missing | ours | package (the file the caddy package shipped, unedited) | foreign
caddyfile_state() {
  [ -e "$CADDYFILE" ] || { echo missing; return 0; }
  if [ "$(head -n 1 "$CADDYFILE")" = "$CADDY_MARKER setup.sh" ]; then echo ours; return 0; fi
  local shipped
  shipped="$(dpkg-query -W -f='${Conffiles}\n' caddy 2>/dev/null | awk '$1 == "/etc/caddy/Caddyfile" { print $2 }')" || shipped=""
  if [ -n "$shipped" ] && [ "$(md5sum < "$CADDYFILE" | cut -d' ' -f1)" = "$shipped" ]; then echo package; return 0; fi
  echo foreign
}

# Every reason to stop is checked here, before anything on the server is changed.
preflight() {
  echo "== checking this server (nothing is changed yet)"
  local held
  held="$(foreign_listeners 80 caddy.service)"
  if [ -n "$held" ]; then
    printf 'STOP: port 80 is in use by:\n%s' "$held" >&2
    printf '%s\n' \
      "The dashboard needs port 80. Move that service to another port (or uninstall it), reboot," \
      "and run sudo ./setup.sh again. Nothing was changed." >&2
    exit 1
  fi
  if [ "$(caddyfile_state)" = foreign ]; then
    abort "$CADDYFILE was written by someone else (Caddy is already set up for another site). Setup would replace it, so it stopped. Nothing was changed."
  fi
  local port unit
  for port in 7681:ttyd-dash.service 7682:dash-events.service 61208:glances-web.service; do
    unit="${port#*:}"; port="${port%%:*}"
    held="$(foreign_listeners "$port" "$unit")"
    if [ -n "$held" ]; then
      printf 'STOP: port %s (on this server only) is in use by:\n%s' "$port" "$held" >&2
      echo "The dashboard needs ports 7681, 7682 and 61208 on 127.0.0.1. Move that service and run setup again. Nothing was changed." >&2
      exit 1
    fi
  done
  if [ ! -e "$UNIT_DIR/ttyd-dash.service" ] && systemctl is-active --quiet ttyd.service; then
    abort "ttyd.service (another web terminal) is running. Setup would stop and disable it. Stop it yourself (sudo systemctl disable --now ttyd.service) if you do not need it, then run setup again. Nothing was changed."
  fi
  if { [ ! -s "$CONFIG_DIR/term.pass" ] || [ "$ROTATE_PW" -eq 1 ]; } && ! has_tty; then
    abort "setup needs to ask for the web-terminal password; run sudo ./setup.sh interactively (in a terminal)."
  fi
  echo "ok"
}

install_packages() {
  echo "== packages"
  local missing=()
  command -v caddy >/dev/null 2>&1 || missing+=(caddy)
  if ! command -v ttyd >/dev/null 2>&1; then
    # The ttyd package starts its own root `login` terminal at once; mask it before it can.
    systemctl mask ttyd.service >/dev/null
    missing+=(ttyd)
  fi
  command -v pipx >/dev/null 2>&1 || missing+=(pipx)
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  if [ "${#missing[@]}" -gt 0 ]; then
    apt-get update -qq </dev/null || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}" </dev/null \
      || abort "could not install ${missing[*]}. On Ubuntu they come from the 'universe' repository: sudo add-apt-repository universe, then run setup again."
  fi
  [ -x "$TTYD_BIN" ] || abort "$TTYD_BIN not found after installing ttyd."
  local ver
  ver="$("$TTYD_BIN" --version 2>&1 || true)"
  case "$ver" in
    *" 1.7."*) ;;
    *) echo "WARNING: expected ttyd 1.7.x, got: ${ver:-no version output}" >&2 ;;
  esac
}

# The user's own files, from the templates, only when missing: setup never overwrites them.
setup_user_files() {
  echo "== your settings files ($CONFIG_DIR)"
  no_symlink "$CONFIG_DIR"
  as_user install -d -m 700 "$CONFIG_DIR"
  local f
  for f in quicklaunch ignore mutes; do
    no_symlink "$CONFIG_DIR/$f"
    if [ -e "$CONFIG_DIR/$f" ]; then
      echo "kept $CONFIG_DIR/$f"
    else
      as_user install -m 644 "$APP_DIR/config/$f.example" "$CONFIG_DIR/$f"
      echo "created $CONFIG_DIR/$f"
    fi
  done
}

setup_docker_access() {
  echo "== Docker"
  if getent group docker >/dev/null 2>&1; then
    # Only the Glances service gets the docker group (it reads container stats). The account itself is
    # not added: docker group = root without a password, and the web terminal logs into this account.
    DOCKER_GROUP_LINE="SupplementaryGroups=docker"
    echo "found: container stats are read by the Glances service only"
  else
    DOCKER_GROUP_LINE=""
    echo "Docker not found: the dashboard says so in its Containers section. Installed Docker later? Run sudo ./setup.sh again."
  fi
}

# Write a unit template from deploy/units into $UNIT_DIR with this server's values.
render_unit() {
  local src="$APP_DIR/deploy/units/$1" allowed=""
  no_symlink "$src"
  if [ -n "$TS_HOST" ]; then allowed="--allowed-host $TS_HOST"; fi
  sed -e "s|@USER@|$SVC_USER|g" -e "s|@HOME@|$SVC_HOME|g" -e "s|@APP_DIR@|$APP_DIR|g" \
      -e "s|@CONFIG_DIR@|$CONFIG_DIR|g" -e "s|@ALLOWED_HOST_ARGS@|$allowed|g" \
      -e "s|@DOCKER_GROUP@|$DOCKER_GROUP_LINE|g" -e "s|@GLANCES_HOME@|$GLANCES_HOME|g" \
      -e "s|@ETC_DIR@|$ETC_DIR|g" "$src" > "$UNIT_DIR/$1"
  chmod 644 "$UNIT_DIR/$1"
}

start_unit() {
  render_unit "$1"
  systemctl daemon-reload
  systemctl enable "$1" >/dev/null 2>&1
  systemctl restart "$1"
}

# Glances may hold the docker group (root-equivalent), so it runs as its own system user from a
# root-owned install and a root-owned copy of its config: the login account can change neither.
setup_glances() {
  echo "== Glances $GLANCES_VERSION (system stats, this server only)"
  if ! getent passwd "$GLANCES_USER" >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$GLANCES_USER"
  fi
  local installed src="$APP_DIR/deploy/glances.conf"
  installed="$(PIPX_HOME="$GLANCES_HOME" PIPX_BIN_DIR="$GLANCES_HOME/bin" pipx list --short 2>/dev/null || true)"
  if ! grep -qx "glances $GLANCES_VERSION" <<<"$installed"; then
    (umask 022 && PIPX_HOME="$GLANCES_HOME" PIPX_BIN_DIR="$GLANCES_HOME/bin" pipx install --force "glances[web,containers,gpu]==$GLANCES_VERSION" </dev/null)
  fi
  no_symlink "$src"
  install -d -m 755 "$ETC_DIR"
  install -m 644 -o root -g root "$src" "$ETC_DIR/glances.conf"
  start_unit glances-web.service
}

# Sets TS_HOST / TS_IP when this server is on a tailnet. Never stops setup.
detect_tailscale() {
  TS_HOST=""; TS_IP=""
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "== Tailscale: not installed (local addresses only)"
    return 0
  fi
  local st out
  st="$(timeout 10 tailscale status --json 2>/dev/null)" || st=""
  out="$(printf '%s' "$st" | /usr/bin/python3 -I -c '
import json, re, sys
try:
    d = json.load(sys.stdin)
except ValueError:
    sys.exit(1)
if not isinstance(d, dict) or d.get("BackendState") != "Running":
    sys.exit(1)
me = d.get("Self") or {}
name = str(me.get("DNSName") or "").rstrip(".").lower()
ip = next((str(a) for a in me.get("TailscaleIPs") or [] if "." in str(a)), "")
if not re.fullmatch(r"[a-z0-9.-]+", name) or not re.fullmatch(r"[0-9.]+", ip):
    sys.exit(1)
print(name, ip)' 2>/dev/null)" || out=""
  if [ -z "$out" ]; then
    echo "== Tailscale: installed but not connected (local addresses only)"
    return 0
  fi
  read -r TS_HOST TS_IP <<<"$out" || true
  echo "== Tailscale: $TS_HOST ($TS_IP)"
}

setup_dash_events() {
  echo "== dashboard service"
  start_unit dash-events.service
}

# Only the scrypt hash is stored (term_login.py). The password never reaches an argv or environment.
write_terminal_hash() {
  { set +x; } 2>/dev/null  # bash -x must never trace the password
  local file="$1" pw pw2
  echo "The web terminal in the dashboard opens a shell as $SVC_USER. It has its own password."
  # IFS= keeps leading/trailing spaces: term_login.py does not trim at login, so neither may we.
  IFS= read -rsp "Choose a terminal password (12+ chars): " pw; echo
  IFS= read -rsp "Repeat it: " pw2; echo
  [ "$pw" = "$pw2" ] || abort "the passwords differ; run setup again."
  [ "${#pw}" -ge 12 ] || abort "the password is shorter than 12 characters; run setup again."
  as_user install -d -m 700 "$(dirname "$file")"
  printf '%s\n' "$pw" | as_user /usr/bin/python3 -I "$APP_DIR/term/term_login.py" --write-hash "$file"
  unset pw pw2
}

# The stock unit runs `login` as root; keep it stopped and masked.
mask_stock_ttyd() {
  case "$(systemctl show -p LoadState --value ttyd.service 2>/dev/null || true)" in
    not-found|"") ;;
    masked) systemctl stop ttyd.service 2>/dev/null || true ;;
    *) systemctl disable --now ttyd.service 2>/dev/null || true
       systemctl mask ttyd.service ;;
  esac
}

# Asked before anything is installed, so the rest of setup runs without you.
setup_terminal_password() {
  local hashfile="$CONFIG_DIR/term.pass"
  no_symlink "$CONFIG_DIR" "$hashfile"
  if [ ! -s "$hashfile" ] || [ "$ROTATE_PW" -eq 1 ]; then
    echo "== web terminal password"
    write_terminal_hash "$hashfile"
    echo "Thanks. The rest of setup needs no input (except one optional Tailscale question)."
  else
    echo "== web terminal password unchanged (sudo ./setup.sh --rotate-terminal-password changes it)"
  fi
}

setup_ttyd() {
  echo "== web terminal"
  mask_stock_ttyd
  render_unit ttyd-dash.service
  systemctl daemon-reload
  systemctl enable ttyd-dash.service >/dev/null 2>&1
  # start (a no-op when it already runs, so a web-terminal session running setup is never cut off here);
  # changes to a running terminal are applied by restart_ttyd, the very last step
  systemctl start ttyd-dash.service
  warn_if_in_ttyd_session
}

in_ttyd_session() {
  grep -q 'ttyd-dash\.service' "${SELF_CGROUP:-/proc/self/cgroup}" 2>/dev/null
}

warn_if_in_ttyd_session() {
  if in_ttyd_session; then
    echo "WARNING: running inside the dashboard's web terminal. It restarts as the very last step," >&2
    echo "         so this session disconnects right after SETUP COMPLETE. Reconnect to continue." >&2
  fi
}

# Caddy (the Ubuntu package, runs as user caddy) on port 80 with deploy/Caddyfile.
setup_caddy() {
  echo "== Caddy (port 80)"
  local src="$APP_DIR/deploy/Caddyfile" changed=0
  [ -f "$src" ] && [ ! -L "$src" ] || abort "$src is missing or a symlink."
  caddy validate --config "$src" --adapter caddyfile >/dev/null 2>&1 \
    || abort "$src is not a valid Caddyfile; the live $CADDYFILE was left unchanged."
  if [ -e "$CADDYFILE" ] && [ ! -e "$CADDYFILE.orig" ] && ! cmp -s "$src" "$CADDYFILE" \
     && [ "$(caddyfile_state)" = package ]; then
    cp -p "$CADDYFILE" "$CADDYFILE.orig"
  fi
  if ! cmp -s "$src" "$CADDYFILE"; then
    install -m 0644 -o root -g root "$src" "$CADDYFILE"
    changed=1
  fi
  systemctl enable caddy.service >/dev/null 2>&1 || true
  if [ "$changed" -eq 1 ] || ! systemctl is-active --quiet caddy.service; then
    systemctl restart caddy.service || abort "Caddy failed to start on port 80; see: journalctl -u caddy -n 50"
  fi
}

# none | ours | ours-funnel | other | unknown
serve_state() {
  local st
  st="$(timeout 10 tailscale serve status --json 2>/dev/null)" || { echo unknown; return 0; }
  printf '%s' "$st" | /usr/bin/python3 -I -c '
import json, sys
text = sys.stdin.read()
if not text.strip():
    print("none"); sys.exit()
try:
    d = json.loads(text)
except ValueError:
    print("unknown"); sys.exit()
if not d:
    print("none"); sys.exit()

def funnel_on(node):
    if isinstance(node, dict):
        return any((k == "AllowFunnel" and (v is True or (isinstance(v, dict) and any(v.values())))) or funnel_on(v)
                   for k, v in node.items())
    if isinstance(node, list):
        return any(funnel_on(v) for v in node)
    return False

web = d.get("Web") if isinstance(d, dict) else None
ours = any(isinstance(site, dict) and isinstance(site.get("Handlers"), dict)
           and (site["Handlers"].get("/") or {}).get("Proxy") == "http://127.0.0.1:7682"
           for site in (web.values() if isinstance(web, dict) else []))
print(("ours-funnel" if funnel_on(d) else "ours") if ours else "other")' 2>/dev/null || echo unknown
}

# Remove only the three paths setup mounts; anything else in Serve stays as it is.
remove_our_serve() {
  local p
  for p in / /term/token /term/ws; do
    timeout 30 tailscale serve --https=443 --set-path "$p" off >/dev/null 2>&1 || true
  done
}

enable_serve() {
  if timeout 60 tailscale serve --bg --https=443 --set-path / http://127.0.0.1:7682 \
     && timeout 60 tailscale serve --bg --https=443 --set-path /term/token http://127.0.0.1:7681/term/token \
     && timeout 60 tailscale serve --bg --https=443 --set-path /term/ws http://127.0.0.1:7681/term/ws; then
    SERVE_ON=1
    if [ "$(serve_state)" = ours-funnel ]; then
      remove_our_serve
      SERVE_ON=0
      echo "Tailscale Funnel is on for this server, which would put the dashboard and its terminal on the"
      echo "public internet, so the dashboard was removed from Serve again. Use http://$TS_HOST/ on your tailnet."
      return 0
    fi
    echo "https://$TS_HOST/ now serves the dashboard on your tailnet."
  else
    echo "WARNING: Tailscale Serve could not be set up. HTTPS certificates may be off for your tailnet"
    echo "         (Tailscale admin console > DNS: enable MagicDNS and HTTPS Certificates), then run setup again."
    timeout 30 tailscale serve reset >/dev/null 2>&1 || true
    echo "         The partial Serve setup was removed. http://$TS_HOST/ still works on your tailnet."
  fi
}

# Optional https on the tailnet. Never changes an existing Serve setup and never stops setup.
offer_serve() {
  [ -n "$TS_HOST" ] || return 0
  echo "== Tailscale HTTPS"
  case "$(serve_state)" in
    none)
      if [ -e "$CONFIG_DIR/tailscale-https-declined" ]; then
        echo "not asked again (you said no before; delete $CONFIG_DIR/tailscale-https-declined to be asked)."
        echo "Use http://$TS_HOST/ on your tailnet."
        return 0
      fi
      if ! has_tty; then
        echo "not asked (no terminal). Use http://$TS_HOST/ on your tailnet."
        return 0
      fi
      local ans=""
      printf 'Also serve the dashboard over HTTPS on your tailnet (https://%s/)? [y/N] ' "$TS_HOST"
      IFS= read -r ans || ans=""
      case "$ans" in
        y|Y|yes|Yes|YES) enable_serve ;;
        *) as_user touch "$CONFIG_DIR/tailscale-https-declined" 2>/dev/null || true
           echo "skipped (setup will not ask again). Use http://$TS_HOST/ on your tailnet." ;;
      esac ;;
    ours)
      SERVE_ON=1
      echo "Tailscale Serve already serves the dashboard at https://$TS_HOST/ (left as it is)." ;;
    ours-funnel)
      # Funnel would publish the dashboard and its shell to the internet: never leave that in place.
      remove_our_serve
      SERVE_ON=0
      echo "Tailscale Funnel is on for this server, which put the dashboard and its terminal on the public"
      echo "internet. Setup removed the dashboard from Tailscale Serve. Use http://$TS_HOST/ on your tailnet."
      echo "To check what else Funnel publishes: tailscale funnel status" ;;
    other)
      echo "Tailscale Serve is already set up on this server for something else; it was left untouched."
      echo "Use http://$TS_HOST/ on your tailnet." ;;
    *)
      echo "Could not read the Tailscale Serve settings; they were left untouched. Use http://$TS_HOST/ on your tailnet." ;;
  esac
}

# GET http://127.0.0.1$2 with Host: $1, retried while services start; prints the status code.
route_code() {
  local code i=0
  while :; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H "Host: $1" "http://127.0.0.1$2")" || true
    { [ "$code" != 000 ] || [ "$i" -ge "$ROUTE_WAIT_S" ]; } && break
    i=$((i + 1)); sleep 1
  done
  printf '%s' "$code"
}

# The tailnet route never stops setup; when it fails, print what is needed to find out why.
check_tailnet_route() {
  local out code
  out="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$TS_HOST:80:$TS_IP" "http://$TS_HOST/" 2>&1)" || true
  code="${out: -3}"
  if [ "$code" = 200 ]; then
    ADDRS+="  http://$TS_HOST/   (your tailnet)"$'\n'
    return 0
  fi
  echo
  echo "NOTE: the tailnet address did not answer. Setup carries on; the local addresses work."
  echo "  address:      http://$TS_HOST/"
  echo "  tailnet name: $TS_HOST"
  echo "  tailnet IP:   $TS_IP"
  echo "  result:       $out   (000 = no connection; anything else is the HTTP status)"
  echo "  tailscale status:"
  timeout 10 tailscale status 2>&1 | head -n 5 | sed 's/^/    /' || true
  if command -v ufw >/dev/null 2>&1; then
    echo "  firewall:     $(ufw status 2>/dev/null | head -n 1)"
    echo "    if it says active, allow the dashboard on the tailnet:"
    echo "    sudo ufw allow in on tailscale0 to any port 80 proto tcp"
  else
    echo "  firewall:     ufw not installed; check any other firewall for port 80 on tailscale0"
  fi
  echo "  Tailscale access rules (ACLs) must also allow your devices to reach this server on port 80."
  echo
}

verify_routes() {
  echo "== checking the addresses"
  local h p code lan name short
  name="$(hostname)"
  short="${name%%.*}"
  # the LAN address is the source of the default route (hostname -I may list Docker's bridge first)
  lan="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')" || lan=""
  [ -n "$lan" ] || lan="$(hostname -I | awk '{print $1}')"
  for h in "$name" "$short.local" $lan; do
    code="$(route_code "$h" /)"
    [ "$code" = 200 ] || abort "http://$h/ answered $code, expected the dashboard (200). See: journalctl -u caddy -u dash-events -n 50"
  done
  code="$(route_code "$name" /term/token)"
  [ "$code" = 200 ] || abort "http://$name/term/token answered $code, expected the terminal (200). See: journalctl -u caddy -u ttyd-dash -n 50"
  for p in / /term/token; do
    code="$(route_code evil.example "$p")"
    [ "$code" != 200 ] || abort "an unknown Host (evil.example) was answered on $p; the DNS-rebinding guard is not working."
  done
  ADDRS="  http://$name/"$'\n'
  if systemctl is-active --quiet avahi-daemon 2>/dev/null; then ADDRS+="  http://$short.local/"$'\n'; fi
  [ -z "$lan" ] || ADDRS+="  http://$lan/"$'\n'
  if [ -n "$TS_HOST" ]; then check_tailnet_route; fi
  if [ "$SERVE_ON" -eq 1 ]; then ADDRS+="  https://$TS_HOST/   (your tailnet, https)"$'\n'; fi
  echo "The dashboard opens at:"
  printf '%s' "$ADDRS"
}

print_summary() {
  echo
  echo "Your settings files (edit them any time; the page picks up changes within a minute):"
  echo "  $CONFIG_DIR/quicklaunch   extra Quick Launch tiles"
  echo "  $CONFIG_DIR/ignore        containers to hide"
  echo "  $CONFIG_DIR/mutes         journal lines the Errors panel keeps quiet"
  if [ -d "$APP_DIR/.git" ]; then
    echo "Update later with: cd $APP_DIR && git pull && sudo ./setup.sh"
  else
    echo "Update later: unpack the new ZIP over $APP_DIR, then run sudo ./setup.sh in it again."
  fi
  echo
}

# Must be the last step: restarting the terminal ends a web-terminal shell that is running setup.
restart_ttyd() {
  echo "Restarting ttyd-dash.service now; the web terminal (if you are in it) will disconnect."
  systemctl restart ttyd-dash.service
}

main() {
  require_sudo_user
  check_platform
  check_app_dir
  preflight
  check_scrypt
  setup_terminal_password
  install_packages
  setup_user_files
  setup_docker_access
  setup_glances
  detect_tailscale
  setup_dash_events
  setup_ttyd
  setup_caddy
  offer_serve
  verify_routes
  print_summary
  echo "SETUP COMPLETE"
  restart_ttyd
}

main
