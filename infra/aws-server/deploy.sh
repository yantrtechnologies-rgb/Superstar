#!/bin/bash
# Deploys the latest release on the Superstar server. Runs as root through Session Manager.
set -euo pipefail
REGION=ap-southeast-2
BUCKET=superstar-media-569659729378
APP=/opt/superstar/app
ENVFILE=/opt/superstar/superstar.env
export HOME=/root PATH=/usr/local/bin:$PATH

# Settings from the encrypted parameter (readable only by the superstar user).
aws ssm get-parameter --region $REGION --name /superstar/env --with-decryption --query Parameter.Value --output text > $ENVFILE.new
install -m 600 -o superstar -g superstar $ENVFILE.new $ENVFILE && rm -f $ENVFILE.new
# Server-side defaults the stored settings may not carry (a stored value always wins).
for setting in 'REDIS_URL=redis://127.0.0.1:6379' 'API_PUBLIC_URL=https://superstar.xolnet.in/api' 'RSS_ALLOWED_FEEDS=*'; do
  key=${setting%%=*}
  if ! grep -q "^$key=." $ENVFILE; then sed -i "/^$key=/d" $ENVFILE; printf '\n%s\n' "$setting" >> $ENVFILE; fi
done

# Redis for the public API's per-key rate limit. Listens on this machine only.
if ! systemctl is-active --quiet redis6 && ! systemctl is-active --quiet valkey; then
  if dnf install -y -q redis6; then systemctl enable --now redis6; else dnf install -y -q valkey && systemctl enable --now valkey; fi
fi

# Fresh copy of the code (keeps the previous build until the new one succeeds).
aws s3 cp --region $REGION s3://$BUCKET/deploy/superstar-release.tgz /tmp/superstar-release.tgz --only-show-errors
rm -rf $APP.next && mkdir -p $APP.next && tar -xzf /tmp/superstar-release.tgz -C $APP.next
chown -R superstar:superstar $APP.next
cd $APP.next
sudo -u superstar -H bash -lc "cd $APP.next && export PATH=/usr/local/bin:\$PATH && pnpm install --frozen-lockfile --config.confirmModulesPurge=false"
# Only DATABASE_URL is needed to build and migrate; the full settings file is not shell-safe (it contains <, >, spaces).
DBURL=$(grep '^DATABASE_URL=' $ENVFILE | cut -d= -f2- | sed 's/^"//; s/"$//')
sudo -u superstar -H env DATABASE_URL="$DBURL" bash -lc "cd $APP.next && export PATH=/usr/local/bin:\$PATH NODE_OPTIONS=--max-old-space-size=1536 && pnpm db:generate && pnpm -r build"
sudo -u superstar -H env DATABASE_URL="$DBURL" bash -lc "cd $APP.next/packages/data && export PATH=/usr/local/bin:\$PATH && npx prisma migrate deploy"

# Swap in the new build.
systemctl stop superstar-web superstar-api superstar-worker 2>/dev/null || true
rm -rf $APP.old; [ -d $APP ] && mv $APP $APP.old; mv $APP.next $APP

# Services.
cat > /etc/systemd/system/superstar-temporal.service <<'UNIT'
[Unit]
Description=Superstar scheduler (Temporal dev server)
After=network-online.target
[Service]
User=superstar
ExecStart=/usr/local/bin/temporal server start-dev --ip 127.0.0.1 --port 7233 --ui-port 8233 --db-filename /opt/superstar/data/temporal.db --log-level warn
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
for svc in worker api web; do
  case $svc in
    worker) DIR=$APP/apps/worker; CMD="/usr/local/bin/node dist/main.js"; AFTER=superstar-temporal.service;;
    api)    DIR=$APP/apps/api;    CMD="/usr/local/bin/node dist/main.js"; AFTER=network-online.target;;
    web)    DIR=$APP/apps/web;    CMD="/usr/local/bin/node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3000"; AFTER=network-online.target;;
  esac
  cat > /etc/systemd/system/superstar-$svc.service <<UNIT
[Unit]
Description=Superstar $svc
After=$AFTER
Wants=$AFTER
[Service]
User=superstar
WorkingDirectory=$DIR
EnvironmentFile=$ENVFILE
Environment=NODE_ENV=production API_LISTEN_HOST=127.0.0.1 PORT=$( [ $svc = api ] && echo 3001 || ([ $svc = web ] && echo 3000) || echo 3002 )
ExecStart=$CMD
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
done

# HTTPS front door. Caddy gets and renews the certificate once DNS points here.
cat > /etc/caddy/Caddyfile <<'CADDY'
superstar.xolnet.in {
  encode zstd gzip
  # Public workspace API (base URL https://superstar.xolnet.in/api). Its routes are /v1/... on the API server.
  handle /api/docs* {
    reverse_proxy 127.0.0.1:3001
  }
  handle /api/v1/* {
    uri strip_prefix /api
    reverse_proxy 127.0.0.1:3001
  }
  handle {
    reverse_proxy 127.0.0.1:3000
  }
  header {
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options nosniff
    Referrer-Policy strict-origin-when-cross-origin
  }
}
CADDY
cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy HTTPS
After=network-online.target
[Service]
User=superstar
Environment=XDG_DATA_HOME=/opt/superstar/data XDG_CONFIG_HOME=/opt/superstar/data
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile
Restart=always
[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now superstar-temporal superstar-worker superstar-api superstar-web caddy
systemctl restart superstar-worker superstar-api superstar-web
systemctl reload caddy || systemctl restart caddy
sleep 8
for s in superstar-temporal superstar-worker superstar-api superstar-web caddy; do echo "$s: $(systemctl is-active $s)"; done
curl -s -o /dev/null -w 'web local: %{http_code}\n' http://127.0.0.1:3000/login || true
