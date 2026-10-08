#!/usr/bin/env bash
# One-shot setup for the SupaConsole test VPS (Ubuntu 24.04, run as root).
# Override the cloned SupaConsole branch with BRANCH=... (default: main).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APP_DIR=/opt/supaconsole
BRANCH="${BRANCH:-main}"
DB_URL="file:${APP_DIR}/prisma/supaconsole.db"
SVC_USER=supaconsole
DEV_USER=dev
DOCKER_USER_LOCKDOWN=/usr/local/sbin/docker-user-lockdown.sh

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
# Every `\$` below is the heredoc escape for a literal `$` in the embedded
# script — those are runtime substitutions inside the lockdown script, not
# expansions at heredoc-write time. (Escape `$ipt` too: it is not set in this
# shell under `set -u`, so an unescaped reference would abort setup.)
cat > "${DOCKER_USER_LOCKDOWN}" <<SCRIPT
#!/bin/sh
WAN_IF=\$(ip route show default | awk '{print \$5; exit}')
[ -n "\$WAN_IF" ] || exit 1
GUARD_COMMENT=docker-user-lockdown-guard
for ipt in iptables ip6tables; do
  \$ipt -n -L DOCKER-USER >/dev/null 2>&1 || continue
  # Guard-first swap: a plain delete-then-insert would leave the WAN interface
  # briefly without a DROP. Insert a temporary guard at position 1 marked with
  # a comment, swap the rules around it, then remove the guard by its marker
  # so the comment is the only thing distinguishing it from the real DROP.
  # Unrelated rules lower in the chain are left untouched.
  \$ipt -I DOCKER-USER 1 -i "\$WAN_IF" -j DROP -m comment --comment "\$GUARD_COMMENT"
  while \$ipt -D DOCKER-USER -i "\$WAN_IF" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN 2>/dev/null; do :; done
  while \$ipt -D DOCKER-USER -i "\$WAN_IF" -j DROP 2>/dev/null; do :; done
  \$ipt -I DOCKER-USER 1 -i "\$WAN_IF" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  \$ipt -I DOCKER-USER 2 -i "\$WAN_IF" -j DROP
  while \$ipt -D DOCKER-USER -i "\$WAN_IF" -j DROP -m comment --comment "\$GUARD_COMMENT" 2>/dev/null; do :; done
done
SCRIPT
chmod 755 "${DOCKER_USER_LOCKDOWN}"
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
systemctl enable docker-user-lockdown >/dev/null 2>&1 || true
# Re-runs must pick up the rewritten ExecStart even if the unit was already
# active from a previous run. `enable --now` skips restart; do it explicitly.
systemctl restart docker-user-lockdown
# Fail the setup if the rules didn't land: a silent miss leaves Postgres public.
iptables -C DOCKER-USER -i "$WAN_IF" -j DROP
iptables -S DOCKER-USER

step "node 22"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
apt-get install -y -qq nodejs >/dev/null
node --version; npm --version

step "service user: ${SVC_USER} (docker group, no shell, no sudo)"
# A system user with no login shell, in the docker group so the Next process
# can drive docker via the unix socket. /opt/supaconsole is owned by this
# user so the service can write prisma/supaconsole.db, the project tree, and
# clone supabase-core without a system-wide privileged path.
if ! id -u "${SVC_USER}" >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "${SVC_USER}"
fi
# Membership in docker is what gives docker access; the primary group is set
# for clear ownership of files created by the service.
usermod -aG docker "${SVC_USER}"

step "dev user: ${DEV_USER} (docker group, users group, linger on, npm prefix)"
# The non-root user that owns Traycer agents and dev work. Same docker
# membership as the service user; no sudo, since the only thing this account
# is allowed to do on the host is run agents and develop.
if ! id -u "${DEV_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --user-group "${DEV_USER}"
  passwd -l "${DEV_USER}" >/dev/null
fi
usermod -aG docker "${DEV_USER}"
usermod -aG users "${DEV_USER}"
# SSH access for agents: copy root's authorized_keys into ~dev/.ssh with
# correct ownership and modes. Idempotent — overwrites with whatever root
# currently trusts.
DEV_HOME=$(getent passwd "${DEV_USER}" | cut -d: -f6)
install -d -m 0700 -o "${DEV_USER}" -g "${DEV_USER}" "${DEV_HOME}/.ssh"
if [ -s /root/.ssh/authorized_keys ]; then
  install -m 0600 -o "${DEV_USER}" -g "${DEV_USER}" /root/.ssh/authorized_keys "${DEV_HOME}/.ssh/authorized_keys"
fi
# Linger so user services (e.g. the Traycer host) survive the dev user's
# logout. `enable-linger` is idempotent.
loginctl enable-linger "${DEV_USER}"
# npm global prefix and PATH lines in ~/.profile and ~/.bashrc. Both files
# are kept narrow: ~/.profile carries the PATH for login shells, ~/.bashrc
# carries it for interactive shells (placed at the head, before the
# non-interactive early-return).
PROFILE_PATH_LINE='export PATH="$HOME/.npm-global/bin:$PATH"'
BASHRC_PATH_LINE='export PATH="$HOME/.npm-global/bin:$PATH"'
if ! grep -Fq '.npm-global/bin' "${DEV_HOME}/.profile" 2>/dev/null; then
  printf '\n%s\n' "${PROFILE_PATH_LINE}" >> "${DEV_HOME}/.profile"
fi
if [ -f "${DEV_HOME}/.bashrc" ] && ! grep -Fq '.npm-global/bin' "${DEV_HOME}/.bashrc"; then
  tmp=$(mktemp)
  {
    printf '%s\n' "${BASHRC_PATH_LINE}"
    cat "${DEV_HOME}/.bashrc"
  } > "${tmp}"
  install -m 0644 -o "${DEV_USER}" -g "${DEV_USER}" "${tmp}" "${DEV_HOME}/.bashrc"
  rm -f "${tmp}"
fi
chown -R "${DEV_USER}:${DEV_USER}" "${DEV_HOME}"

step "supaconsole: clone ${BRANCH} (running as root)"
# Stop any running service so the clone/build below is not racing with a
# live process holding open files in the tree (especially .next/).
if systemctl is-active --quiet supaconsole 2>/dev/null; then
  systemctl stop supaconsole
fi
mkdir -p "${APP_DIR}"
# Remove the things a build produces so a rebuild from a clean slate is
# deterministic; keep .git so a re-run can fast-forward instead of cloning
# from scratch.
rm -rf "${APP_DIR}/supabase-projects" "${APP_DIR}/supabase-core" "${APP_DIR}/.supabase-core-incoming"
if [ ! -d "${APP_DIR}/.git" ]; then
  git clone -q --branch "${BRANCH}" https://github.com/KHAEntertainment/SupaConsole.git "${APP_DIR}"
fi
cd "${APP_DIR}"
git fetch -q origin "${BRANCH}"
git checkout -q -B "${BRANCH}" "origin/${BRANCH}"
git log --oneline -1

step "supaconsole: install, prisma, build (running as root)"
# Root can write /opt/supaconsole here because the chown to ${SVC_USER} has
# not happened yet. The ownership transfer happens after the build is done.
npm ci --no-audit --no-fund --loglevel=error
DATABASE_URL="${DB_URL}" npx prisma generate >/dev/null
DATABASE_URL="${DB_URL}" NODE_ENV=production npm run build 2>&1 | tail -15

step "supaconsole: transfer ownership to ${SVC_USER}"
chown -R "${SVC_USER}:${SVC_USER}" "${APP_DIR}"

step "supaconsole: systemd service on 127.0.0.1:3000 (User=${SVC_USER})"
cat > /etc/systemd/system/supaconsole.service <<UNIT
[Unit]
Description=SupaConsole
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
User=${SVC_USER}
Group=${SVC_USER}
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
# Drop any ALLOW_REGISTRATION override left from a previous run; the unit file
# is the source of truth and starts in bootstrap mode.
rm -f /etc/systemd/system/supaconsole.service.d/allow-registration.conf
systemctl daemon-reload
systemctl enable supaconsole >/dev/null 2>&1 || true
# `enable --now` does not pick up a rewritten unit on a re-run, and the old
# root-owned process from a previous setup must be replaced. Restart explicitly.
systemctl restart supaconsole
# Readiness loop: only HTTP 200 on the root probe counts as up. Anything
# else (502, 503, ECONNREFUSED-as-000, etc.) is a setup failure.
last_code=000
for i in $(seq 1 30); do
  last_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/ || true)
  if [ "${last_code}" = "200" ]; then break; fi
  sleep 2
done
if [ "${last_code}" != "200" ]; then
  echo "FATAL: SupaConsole did not respond with HTTP 200 on http://127.0.0.1:3000/ (last response: ${last_code})"
  echo "--- service status ---"; systemctl --no-pager status supaconsole || true
  echo "--- last 30 journal lines ---"; journalctl --no-pager -n 30 -u supaconsole || true
  exit 1
fi
echo "supaconsole HTTP: ${last_code}"
ss -ltnp | grep -E ':3000\b'

step "DONE"