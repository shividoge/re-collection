#!/usr/bin/env bash
# Run ONCE on a fresh Ubuntu 24.04 Vultr server, as root:
#   ssh root@<server ip> 'bash -s' < deploy/setup-server.sh
#   (optional) DOMAIN=braindance.example.com ssh ... to use your own domain
#
# Installs Node 22 and Caddy, makes a locked-down service for the guide, and
# gets a free HTTPS certificate. With no domain it uses <ip>.sslip.io, which
# points at the server's IP, so the URL is stable for as long as the server is.
#
# This server is a read-only mirror: it gets no Anthropic key, and its team
# key is random and never shared, so visitors can look but cannot upload,
# approve, or start a Claude session.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Run as root." >&2; exit 1; fi

APP=/opt/braindance
IP="$(curl -fsS https://ifconfig.me || hostname -I | awk '{print $1}')"
HOST="${DOMAIN:-${IP//./-}.sslip.io}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg rsync ufw debian-keyring debian-archive-keyring apt-transport-https

# Node 22 (the guide needs 21.7 or newer)
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Caddy (automatic HTTPS)
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# The service runs as its own user and can only write the data folder.
id braindance >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin braindance
mkdir -p "$APP/guide/data" "$APP/web"
chown -R braindance:braindance "$APP"

ENV_FILE="$APP/guide/.env"
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  printf 'PORT=8787\nBRAINDANCE_KEY=%s\n' "$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n')" > "$ENV_FILE"
  chown braindance:braindance "$ENV_FILE"
fi

cat > /etc/systemd/system/braindance.service <<UNIT
[Unit]
Description=Braindance guide (read-only public mirror)
After=network.target

[Service]
User=braindance
WorkingDirectory=$APP/guide
ExecStart=/usr/bin/node src/server.mjs
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$APP/guide/data

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
$HOST {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8787
}
CADDY

# Only SSH and the web. The guide's own port stays closed.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

systemctl daemon-reload
systemctl enable braindance >/dev/null
systemctl restart caddy

echo
echo "Server is ready. Your site will be at: https://$HOST"
echo "Now, from your Mac:  ./deploy/deploy.sh root@$IP"
