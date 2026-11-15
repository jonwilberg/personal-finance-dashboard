#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server for the app. Run as root from the cloned repo:
#
#   sudo deploy/scripts/setup-server.sh <your-login-user>
#
# Installs Docker, automatic security updates, a firewall that only lets SSH in, and the tools the backups use;
# prepares deploy/data and deploy/secrets; and installs the daily refresh and backup jobs. Safe to run again.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi
LOGIN_USER="${1:?Usage: setup-server.sh <your-login-user>}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_DIR="$REPO_DIR/deploy"
APP_UID=10001 # the app container's user (see Dockerfile)

echo "==> System updates and base tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y upgrade
apt-get install -y ca-certificates curl git sqlite3 rclone unattended-upgrades ufw

echo "==> Swap (2 GB), so building the image fits on a small server"
if ! swapon --show | grep -q /swapfile; then
  [[ -f /swapfile ]] || { fallocate -l 2G /swapfile && chmod 0600 /swapfile && mkswap /swapfile >/dev/null; }
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
echo 'vm.swappiness=10' >/etc/sysctl.d/90-finance-swap.conf
sysctl -q -p /etc/sysctl.d/90-finance-swap.conf

echo "==> Automatic security updates (with reboots at 04:00 when needed)"
cat >/etc/apt/apt.conf.d/52finance-unattended <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
EOF
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Time zone: Europe/Oslo (the cron times below are local)"
timedatectl set-timezone Europe/Oslo

echo "==> Docker"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
usermod -aG docker "$LOGIN_USER"

echo "==> Firewall: SSH in, nothing else (the app is reached through the Cloudflare tunnel, which connects out)"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

echo "==> SSH: keys only"
cat >/etc/ssh/sshd_config.d/50finance.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t
# Ubuntu 24.04 starts sshd per connection (ssh.socket), which reads the new settings anyway; reload it if it runs.
systemctl try-reload-or-restart ssh.service

echo "==> App folders"
install -d -m 0700 -o "$APP_UID" -g "$APP_UID" "$DEPLOY_DIR/data"
install -d -m 0750 -o root -g "$APP_UID" "$DEPLOY_DIR/secrets"
for example in app.env .env backup.env; do
  if [[ ! -f "$DEPLOY_DIR/$example" ]]; then
    cp "$DEPLOY_DIR/$example.example" "$DEPLOY_DIR/$example"
    chmod 0600 "$DEPLOY_DIR/$example"
    chown "$LOGIN_USER" "$DEPLOY_DIR/$example"
  fi
done

echo "==> Daily refresh and nightly backup"
sed "s#@REPO_DIR@#$REPO_DIR#g" "$DEPLOY_DIR/cron/finance" >/etc/cron.d/finance
chmod 0644 /etc/cron.d/finance

cat <<EOF

Done. Next (see docs/hosting.md):
  1. Fill in $DEPLOY_DIR/app.env, $DEPLOY_DIR/.env and $DEPLOY_DIR/backup.env
  2. Put the Enable Banking key at $DEPLOY_DIR/secrets/enablebanking.pem, then:
       chown root:$APP_UID $DEPLOY_DIR/secrets/enablebanking.pem && chmod 0640 $DEPLOY_DIR/secrets/enablebanking.pem
  3. Copy the database in (deploy/scripts/restore.sh or a direct copy), then: deploy/scripts/deploy.sh
  Log out and back in so $LOGIN_USER can use docker without sudo.
EOF
