#!/usr/bin/env bash
set -e

echo "=== Intimex Bridge – Installer ==="
echo "This script assumes Ubuntu 22.04+ and root privileges."

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo bash install.sh"
  exit 1
fi

# Move to script directory
cd "$(dirname "$0")"

# 1) Install deps
apt-get update
apt-get install -y curl ca-certificates gnupg ufw

# 2) Install Node.js LTS via NodeSource
if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js LTS..."
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
  apt-get install -y nodejs
fi

# 3) PM2 for process manager
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi

# 4) Install server deps
echo "Installing project dependencies..."
npm install

# 5) Ask for OPENAI_API_KEY and create .env
if [ ! -f ".env" ]; then
  echo ""
  echo "Enter your OPENAI_API_KEY:"
  read -r OPENAI_API_KEY
  echo "OPENAI_API_KEY=${OPENAI_API_KEY}" > .env
  echo "PORT=3000" >> .env
fi

# 6) Nginx + Certbot
if ! command -v nginx >/dev/null 2>&1; then
  apt-get install -y nginx
fi
if ! command -v certbot >/dev/null 2>&1; then
  apt-get install -y certbot python3-certbot-nginx
fi

mkdir -p /var/www/certbot
cp nginx/site.conf /etc/nginx/sites-available/intimex_bridge
ln -sf /etc/nginx/sites-available/intimex_bridge /etc/nginx/sites-enabled/intimex_bridge
nginx -t && systemctl reload nginx

# 7) Obtain/renew SSL (Let's Encrypt)
echo "Issuing/renewing SSL for intimexdakmil.com ..."
certbot --nginx -d intimexdakmil.com --non-interactive --agree-tos -m admin@intimexdakmil.com || true
nginx -t && systemctl reload nginx

# 8) Start with PM2 & enable on boot
pm2 start server.js --name intimex-bridge
pm2 save
pm2 startup systemd -u $SUDO_USER --hp "$(eval echo ~$SUDO_USER)" >/tmp/pm2setup.sh
bash /tmp/pm2setup.sh || true

# 9) Firewall (optional – allow 80/443 only)
ufw allow OpenSSH || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
yes | ufw enable || true

echo "=== Done! ==="
echo "Health check: https://intimexdakmil.com/health"
