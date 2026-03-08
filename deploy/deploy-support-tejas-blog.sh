#!/usr/bin/env bash
set -euo pipefail

# -----------------------------
# Config (override via env vars)
# -----------------------------
DOMAIN="${DOMAIN:-support.tejas.blog}"
REPO_URL="${REPO_URL:-https://github.com/<your-username>/<your-repo>.git}"
APP_DIR="${APP_DIR:-/var/www/remote-desktop}"
APP_NAME="${APP_NAME:-remote-desktop}"
PORT="${PORT:-3010}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-admin@tejas.blog}"
NODE_MAJOR="${NODE_MAJOR:-20}"

DEPLOY_USER="${SUDO_USER:-$USER}"
DEPLOY_HOME="$(eval echo "~${DEPLOY_USER}")"

log() {
  echo "[deploy] $1"
}

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is required to run this script."
  exit 1
fi

log "Updating apt packages..."
sudo apt update
sudo apt upgrade -y

log "Installing base packages..."
sudo apt install -y curl git ufw nginx certbot python3-certbot-nginx

if ! command -v node >/dev/null 2>&1; then
  log "Installing Node.js ${NODE_MAJOR}.x..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt install -y nodejs
else
  log "Node.js already installed: $(node -v)"
fi

if ! command -v pm2 >/dev/null 2>&1; then
  log "Installing PM2 globally..."
  sudo npm install -g pm2
else
  log "PM2 already installed: $(pm2 -v)"
fi

log "Preparing app directory ${APP_DIR}..."
sudo mkdir -p "$(dirname "${APP_DIR}")"
sudo chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "$(dirname "${APP_DIR}")"

if [ ! -d "${APP_DIR}/.git" ]; then
  log "Cloning repository into ${APP_DIR}..."
  sudo -u "${DEPLOY_USER}" -H git clone "${REPO_URL}" "${APP_DIR}"
else
  log "Repository exists. Pulling latest changes..."
  sudo -u "${DEPLOY_USER}" -H bash -lc "cd '${APP_DIR}' && git pull --ff-only"
fi

log "Installing npm dependencies..."
sudo -u "${DEPLOY_USER}" -H bash -lc "cd '${APP_DIR}' && npm install"

log "Ensuring logs directory exists..."
sudo -u "${DEPLOY_USER}" -H mkdir -p "${APP_DIR}/logs"

log "Creating PM2 ecosystem config if missing..."
if [ ! -f "${APP_DIR}/ecosystem.config.js" ]; then
  sudo -u "${DEPLOY_USER}" -H tee "${APP_DIR}/ecosystem.config.js" >/dev/null <<EOF
module.exports = {
  apps: [
    {
      name: "${APP_NAME}",
      script: "./server.js",
      cwd: "${APP_DIR}",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_ENV: "production",
        PORT: ${PORT}
      },
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      merge_logs: true,
      time: true
    }
  ]
};
EOF
fi

log "Starting app with PM2..."
sudo -u "${DEPLOY_USER}" -H bash -lc "cd '${APP_DIR}' && pm2 start ecosystem.config.js --only '${APP_NAME}' --update-env"
sudo -u "${DEPLOY_USER}" -H pm2 save

log "Enabling PM2 startup on boot..."
sudo env "PATH=$PATH" pm2 startup systemd -u "${DEPLOY_USER}" --hp "${DEPLOY_HOME}" >/dev/null || true
sudo systemctl enable "pm2-${DEPLOY_USER}" || true

log "Writing Nginx site configuration..."
sudo tee "/etc/nginx/sites-available/${DOMAIN}" >/dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;

        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }
}
EOF

sudo ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx

log "Configuring firewall..."
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable

log "Requesting/renewing Let's Encrypt certificate..."
sudo certbot --nginx -d "${DOMAIN}" --agree-tos -m "${LETSENCRYPT_EMAIL}" --redirect --non-interactive
sudo certbot renew --dry-run

log "Deployment complete."
echo
printf "URL: https://%s\n" "${DOMAIN}"
printf "App dir: %s\n" "${APP_DIR}"
printf "PM2 app: %s\n" "${APP_NAME}"
printf "Health checks:\n"
printf "  pm2 status\n"
printf "  sudo systemctl status nginx --no-pager\n"
printf "  curl -I https://%s\n" "${DOMAIN}"
