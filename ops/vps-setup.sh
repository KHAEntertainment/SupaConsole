#!/usr/bin/env bash
# One-shot setup for the SupaConsole test VPS (Ubuntu 24.04, run as root).
# Override the cloned SupaConsole branch with BRANCH=... (default: main).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APP_DIR=/opt/supaconsole
BRANCH="${BRANCH:-main}"
DB_URL="file:${APP_DIR}/prisma/supaconsole.db"

step() { echo; echo "=== [$(date +%H:%M:%S)] $* ==="; }

step "base packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git ufw jq >/dev/null

step "docker (official repo)"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null

step "docker: default-bridge ports on localhost"
# Only affects `docker run -p` on the default bridge. Compose creates its own
# networks and ignores this, which is why the DOCKER-USER lockdown below exists.
mkdir -p /etc/docker
echo '{ "ip": "127.0.0.1" }' > /etc/docker/daemon.json
systemctl restart docker
docker version --format 'docker {{.Server.Version}}'
docker compose version

step "ufw: deny inbound except ssh"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
ufw status | head -5

step "docker-user lockdown: block internet access to Docker-published ports"
# Docker's NAT rules bypass ufw, and Supabase's compose file publishes the
# gateway and pooler on 0.0.0.0. Drop new inbound connections from the public
# interface in DOCKER-USER; replies to container-initiated traffic stay allowed.
WAN_IF=$(ip route show default | awk '{print $5; exit}')
[ -n "$WAN_IF" ] || { echo "no default route interface"; exit 1; }
cat > /usr/local/sbin/docker-user-lockdown.sh <<SCRIPT
#!/bin/sh
for ipt in iptables ip6tables; do
  \$ipt -n -L DOCKER-USER >/dev/null 2>&1 || continue
  \$ipt -C DOCKER-USER -i ${WAN_IF} -j DROP 2>/dev/null || \$ipt -I DOCKER-USER -i ${WAN_IF} -j DROP
  \$ipt -C DOCKER-USER -i ${WAN_IF} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN 2>/dev/null || \$ipt -I DOCKER-USER -i ${WAN_IF} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
done
SCRIPT
chmod 755 /usr/local/sbin/docker-user-lockdown.sh
cat > /etc/systemd/system/docker-user-lockdown.service <<'UNIT'
[Unit]
Description=Block internet access to Docker-published ports
After=docker.service
PartOf=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/docker-user-lockdown.sh
RemainAfterExit=yes

[Install]
WantedBy=docker.service
UNIT
systemctl daemon-reload
systemctl enable --now docker-user-lockdown >/dev/null 2>&1
# Fail the setup if the rules didn't land: a silent miss leaves Postgres public.
iptables -C DOCKER-USER -i "$WAN_IF" -j DROP
iptables -S DOCKER-USER

step "node 22"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
apt-get install -y -qq nodejs >/dev/null
node --version; npm --version

step "supaconsole: clone ${BRANCH}"
rm -rf "$APP_DIR"
git clone -q --branch "$BRANCH" https://github.com/KHAEntertainment/SupaConsole.git "$APP_DIR"
cd "$APP_DIR"
git log --oneline -1

step "supaconsole: install, prisma, build"
npm ci --no-audit --no-fund --loglevel=error
DATABASE_URL="$DB_URL" npx prisma generate >/dev/null
DATABASE_URL="$DB_URL" node scripts/db-migrate.mjs
DATABASE_URL="$DB_URL" NODE_ENV=production npm run build 2>&1 | tail -15

step "supaconsole: systemd service on 127.0.0.1:3000"
cat > /etc/systemd/system/supaconsole.service <<UNIT
[Unit]
Description=SupaConsole
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=DATABASE_URL=${DB_URL}
Environment=APP_NAME=SupaConsole
Environment=APP_URL=http://localhost:3000
ExecStart=${APP_DIR}/node_modules/.bin/next start -H 127.0.0.1 -p 3000
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now supaconsole >/dev/null 2>&1
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ || true)
  [ "$code" != "000" ] && break; sleep 2
done
echo "supaconsole HTTP: $code"
ss -ltnp | grep -E ':3000\b'

step "DONE"
