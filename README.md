# home-server-dashboard

One page that shows your home server at a glance: CPU, memory, temperatures, every drive, network
traffic, a GPU if there is one, every Docker container, the errors your server has logged, Quick Launch
tiles that open the web apps you run, and a web terminal into your own account. Install it with a single
`sudo ./setup.sh`. It finds your drives, network adapters and containers by itself. Nothing to edit unless you want to.

> **Read this first**
>
> - **It needs port 80.** The dashboard is served on port 80. If anything already uses port 80 (another web
>   server, a NAS or home-server panel, Pi-hole ...), move that service to another port, **reboot**, and then
>   run setup. Setup checks this first and stops without changing anything if port 80 is taken.
> - **Plain http on your home network.** On the local addresses (`http://your-server/`) the page, and the
>   web terminal's password and everything you type into it, cross your Wi-Fi **unencrypted**. Anyone on the
>   same network who listens could read them. If your server is on [Tailscale](https://tailscale.com), its
>   tailnet address is encrypted end to end; use that one when you can. Never forward port 80 to the internet.
> - **The page itself has no login.** Anyone who can reach it on your home network or tailnet sees what it
>   shows (stats, container names, journal warnings, your Quick Launch tiles). Only the web terminal has a
>   password. Requests from public internet addresses are refused.

## Requirements

- Ubuntu 24.04 or newer, or Debian 12 or newer, with systemd (a normal server install).
- A normal user account with sudo. The web terminal logs into this account.
- Port 80 free (see above).
- Optional: Docker (containers and Quick Launch tiles), Tailscale (encrypted access from anywhere).

Setup installs what it needs from your distribution (Caddy, ttyd, pipx), plus Glances 4.5.8 with pipx.
Nothing is downloaded at runtime and nothing phones home.

## Install

As your normal user (not root):

```sh
git clone https://github.com/Nikhil-Jangid/home-server-dashboard.git
cd home-server-dashboard
sudo ./setup.sh
```

No git? Download the ZIP from GitHub (Code > Download ZIP), unpack it in your home folder, `cd` into it and
run `sudo bash setup.sh`.

Setup asks once for a **terminal password** (12+ characters). It is stored only as a scrypt hash, and later
runs never ask again. To change it: `sudo ./setup.sh --rotate-terminal-password`.

When it finishes, it prints every address that works, for example:

```
The dashboard opens at:
  http://my-server/
  http://my-server.local/
  http://192.168.1.20/
  http://my-server.tailnet-name.ts.net/   (your tailnet)
SETUP COMPLETE
```

## Addresses

- **On your home network:** `http://<server name>/`, `http://<server name>.local/` (when avahi is running),
  or `http://<server IP>/`.
- **On Tailscale:** if the server is on a tailnet, `http://<tailnet name>/` works with no extra setup, and the
  connection is encrypted by Tailscale. If Tailscale Serve is not in use on the server yet, setup offers to
  also serve the dashboard at `https://<tailnet name>/`. If Serve already serves something else, setup leaves
  it alone. Tailscale problems never stop setup; if the tailnet address does not answer, setup prints what it
  found (Tailscale status, the address, the error, firewall hints) and finishes the local install.
- The page answers only to this server's own names and addresses, and only to devices on private networks
  (home LAN ranges, link-local, Tailscale). Anything else is refused. This also blocks DNS-rebinding attacks
  from websites you visit.

## Make it yours

Setup creates three plain-text files in `~/.config/home-server-dashboard/` from commented templates. Edit them
with any editor, no sudo needed. The dashboard picks up changes within a minute. Setup and updates never
overwrite them. If a file has a mistake, the dashboard names it above the Quick Launch tiles.

### `~/.config/home-server-dashboard/quicklaunch`: extra tiles

Every running container that publishes a port already gets a tile with an **Open** button. Use this file to
rename one, change its port, or add tiles for things that are not containers:

```ini
# a service on this server, by port
[Router admin]
port = 8443
desc = the box under the desk

# a container (by name or the first 4+ characters of its ID), with a custom name and port
[Photos]
container = immich_server
port = 2283
desc = family photos
```

**Open** goes to `http://<the address you opened the dashboard on>:<port>`. A port-only tile shows whether
the port answers; a container tile shows the container's status.

### `~/.config/home-server-dashboard/ignore`: hide containers

One container per line: its name, its compose service name (`web` in `myapp-web-1`), or the first 4+
characters of its ID. Hidden containers leave the Containers table and get no Quick Launch tile.

```
watchtower
a1b2c3d4
```

### `~/.config/home-server-dashboard/mutes`: quiet journal noise

The Errors panel shows warnings and errors from your server's journal. Each `[section]` here hides matching
lines by `source` (the program) and/or `pattern` (a regular expression). Real errors are never hidden. It
ships with a few common Ubuntu noise rules; delete them to see those lines again.

```ini
[my-noisy-app]
source = my-app
pattern = retrying in \d+s
```

Theme, error filters and the Quick Launch order (drag the tiles) are set in the page itself. The order is
remembered per browser.

## Updating

```sh
cd home-server-dashboard && git pull && sudo ./setup.sh
```

ZIP users: unpack the new ZIP over the old folder and run `sudo ./setup.sh` again. Your files in
`~/.config/home-server-dashboard/` and your terminal password are kept. The version is shown at the bottom
of the page.

Installed Docker or Tailscale after the dashboard? Run `sudo ./setup.sh` again.

## Custom domain or your own reverse proxy

Not automated. The dashboard is plain http on port 80 of this server. To put it behind your own domain:

1. Point your proxy (or a site block in `deploy/Caddyfile`) at `http://127.0.0.1:7682` for the page and
   `http://127.0.0.1:7681` for `/term/ws` and `/term/token`. Keep the `forward_auth` check from `deploy/Caddyfile`
   in front of the terminal paths.
2. Allow the new name: in `deploy/units/dash-events.service`, add `--allowed-host your.domain` to the end of the
   `ExecStart` line.
3. Run `sudo ./setup.sh` again. These are local edits to the project folder, so `git pull` will ask you to
   commit or stash them.

Only do this behind HTTPS and some form of access control. The page includes a shell into your account.

## Uninstall

```sh
sudo systemctl disable --now ttyd-dash.service dash-events.service glances-web.service
sudo rm /etc/systemd/system/ttyd-dash.service /etc/systemd/system/dash-events.service /etc/systemd/system/glances-web.service
sudo systemctl daemon-reload
sudo cp /etc/caddy/Caddyfile.orig /etc/caddy/Caddyfile && sudo systemctl restart caddy   # or: sudo apt remove caddy
sudo rm -rf /opt/home-server-dashboard /etc/home-server-dashboard
sudo userdel hsd-glances
rm -rf ~/.config/home-server-dashboard ~/.local/state/home-server-dashboard
```

If you enabled HTTPS on Tailscale through setup, turn it off with `sudo tailscale serve reset` (this clears all
Serve settings on the server). Setup masks the ttyd package's own `ttyd.service` (it runs a root login);
`sudo systemctl unmask ttyd.service` undoes that.

## How it works

- **Caddy** on port 80 serves everything and checks the Host name before it lets anything reach the terminal.
- **dash-events** (Python, standard library only, 127.0.0.1:7682) serves the page, reads your three files,
  streams the journal's warnings and errors, and passes system stats through from Glances.
- **Glances** (127.0.0.1:61208) collects CPU, memory, drives, network, sensors, GPU and Docker stats. It runs
  as its own system user (`hsd-glances`) from a root-owned install in `/opt/home-server-dashboard`, because it is
  the only part that may read Docker.
- **ttyd** (127.0.0.1:7681) runs the web terminal behind its own scrypt login with a retry throttle.

The backends listen only on 127.0.0.1. dash-events and Glances run under systemd sandboxing; the terminal is
deliberately not sandboxed, because after its login it is your normal shell. Developers: run all tests
with `bash scripts/check.sh` (needs Node 20+ and Python 3.10+).

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE): free for personal and other non-commercial use; not for
commercial use. The software is provided as-is, without warranty of any kind, and the author is not liable
for anything that happens from using it. Back up what matters and read what a script does before you run it
with sudo.
