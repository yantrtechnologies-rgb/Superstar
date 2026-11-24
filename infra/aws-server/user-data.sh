#!/bin/bash
# First-boot setup for the Superstar server (Amazon Linux 2023, arm64). Logs: /var/log/superstar-bootstrap.log
exec > >(tee -a /var/log/superstar-bootstrap.log) 2>&1
set -euxo pipefail

# 2 GB swap so building the web app fits in 2 GB of memory.
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=2048 && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
fi

dnf install -y nodejs22 nodejs22-npm tar gzip jq
alternatives --set node /usr/bin/node-22 || true
ln -sf /usr/bin/node-22 /usr/local/bin/node || true
ln -sf /usr/bin/npm-22 /usr/local/bin/npm || true
/usr/local/bin/npm install -g pnpm@10.10.0

# Caddy (HTTPS reverse proxy with automatic Let's Encrypt certificates).
CADDY_VERSION=2.9.1
curl -fsSL -o /tmp/caddy.tgz "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_arm64.tar.gz"
tar -xzf /tmp/caddy.tgz -C /usr/local/bin caddy && chmod +x /usr/local/bin/caddy
setcap cap_net_bind_service=+ep /usr/local/bin/caddy

# Temporal CLI (local development server used as the job scheduler, with a SQLite file).
TEMPORAL_VERSION=1.3.0
curl -fsSL -o /tmp/temporal.tgz "https://github.com/temporalio/cli/releases/download/v${TEMPORAL_VERSION}/temporal_cli_${TEMPORAL_VERSION}_linux_arm64.tar.gz"
tar -xzf /tmp/temporal.tgz -C /usr/local/bin temporal && chmod +x /usr/local/bin/temporal

id superstar || useradd --system --create-home --home-dir /opt/superstar --shell /sbin/nologin superstar
mkdir -p /opt/superstar/app /opt/superstar/data /etc/caddy
chown -R superstar:superstar /opt/superstar
touch /opt/superstar/.bootstrap-done
