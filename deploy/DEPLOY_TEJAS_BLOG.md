# Deploy Guide for tejas.blog

This guide brings your remote support platform online at:
- Website + download: https://tejas.blog/download
- TURN server: turn.tejas.blog

## Local development
Run the signaling server locally:

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

Host and viewer pages:

```text
http://localhost:3000/host.html
http://localhost:3000/viewer.html
```

## Ubuntu VPS quick setup (Hostinger)

```bash
sudo apt update
sudo apt install -y nodejs npm
npm install -g pm2
```

From project directory:

```bash
npm install
pm2 start server.js --name remote-desktop
pm2 startup
pm2 save
```

Nginx reverse proxy file (`/etc/nginx/sites-available/support.tejas.blog`):

```nginx
server {
  listen 80;
  server_name support.tejas.blog;

  location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
  }
}
```

Enable Nginx site and restart:

```bash
sudo apt install -y nginx
sudo ln -sf /etc/nginx/sites-available/support.tejas.blog /etc/nginx/sites-enabled/support.tejas.blog
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable nginx
sudo systemctl restart nginx
```

Enable SSL (Certbot):

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d support.tejas.blog
sudo systemctl enable certbot.timer
```

## Quick Deploy for support.tejas.blog (Nginx + PM2)
If you want to deploy the signaling server to `https://support.tejas.blog`, use:

```bash
cd /tmp
git clone <YOUR_REPO_URL> remote-desktop
cd remote-desktop
bash deploy/deploy-support-tejas-blog.sh
```

Optional overrides:

```bash
DOMAIN=support.tejas.blog \
REPO_URL=https://github.com/<your-username>/<your-repo>.git \
APP_DIR=/var/www/remote-desktop \
APP_NAME=remote-desktop \
PORT=3010 \
LETSENCRYPT_EMAIL=admin@tejas.blog \
bash deploy/deploy-support-tejas-blog.sh
```

Nginx template file: `deploy/nginx.support.tejas.blog.conf`
PM2 ecosystem file: `ecosystem.config.js`

## 1. DNS setup
Create these DNS records:
- `A` record: `@` -> `<YOUR_SERVER_PUBLIC_IP>`
- `A` record: `turn` -> `<YOUR_SERVER_PUBLIC_IP>` (or separate TURN server IP)

## 2. Server prerequisites (Ubuntu)
```bash
sudo apt update
sudo apt install -y curl ufw
```

Install Node LTS:
```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
```

Install PM2:
```bash
sudo npm i -g pm2
```

## 3. Run signaling server with PM2
From your project folder:
```bash
npm install
pm2 start server.js --name remote-support
pm2 save
pm2 startup
```

## 4. Configure HTTPS reverse proxy (Caddy)
Install Caddy:
```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile`, then:
```bash
sudo systemctl restart caddy
sudo systemctl status caddy
```

## 5. Install and configure coturn
```bash
sudo apt install -y coturn certbot
sudo systemctl stop coturn
```

Get TLS certificate for TURN:
```bash
sudo certbot certonly --standalone -d turn.tejas.blog
```

Copy `deploy/turnserver.conf` to `/etc/turnserver.conf` and replace:
- `replace-with-turn-username`
- `replace-with-turn-password`

Enable and start coturn:
```bash
sudo sed -i 's/^#TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo systemctl enable coturn
sudo systemctl restart coturn
sudo systemctl status coturn
```

## 6. Firewall rules
```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 49160:49200/udp
sudo ufw --force enable
sudo ufw status
```

## 7. Update app defaults before build
In `app-config.json` set:
```json
{
  "signalingUrl": "https://tejas.blog",
  "turn": {
    "server": "turn.tejas.blog",
    "port": 3478,
    "username": "<TURN_USERNAME>",
    "credential": "<TURN_PASSWORD>"
  }
}
```

## 8. Build and distribute installer
```bash
npm run build
```
Installer output:
- `dist/RemoteDesktop Setup 1.0.0.exe`

Public download URLs:
- `https://tejas.blog/download`
- `https://tejas.blog/download/latest`

## 9. Quick verification
```bash
curl -I https://tejas.blog/download
curl -I https://tejas.blog/download/latest
curl -s https://tejas.blog/download/meta
```
