# Deploy CFO AI to Hostinger VPS — Step-by-Step

**Target:** `cfo-ai.finance` (frontend) + `api.cfo-ai.finance` (backend) on a Hostinger KVM VPS running Ubuntu 24.04 LTS.

**VPS:** `srv1626038.hstgr.cloud` · `187.124.0.37` (KVM 2 · 8 GB · Ubuntu 24.04 LTS)

This guide assumes you've already done:
- ✅ Provisioned the VPS
- ✅ Updated DNS records (apex `A @ → 187.124.0.37`, new `A api → 187.124.0.37`, kept `CNAME www → cfo-ai.finance`)

After every step there's a **verify** line. Don't move on until it passes.

---

## Step 0 — Confirm DNS has propagated

From your **local Mac terminal** (not the VPS):

```bash
dig +short cfo-ai.finance www.cfo-ai.finance api.cfo-ai.finance
```

**Expect:** three lines all showing `187.124.0.37` (www may show two lines: the apex IP and the apex hostname — that's normal because it's a CNAME).

If you still see `2.57.91.91`, give Hostinger another 2-5 minutes and retry.

---

## Step 1 — First SSH login + harden

```bash
ssh root@187.124.0.37
```

Hostinger emails you the initial root password; use it. Once in:

```bash
# Update everything
apt update && apt upgrade -y

# Create the non-root user the app runs as
adduser --disabled-password --gecos "" cfoai
usermod -aG sudo cfoai

# Install your SSH key for cfoai (from your local machine; replace path
# if your key isn't ~/.ssh/id_ed25519.pub):
mkdir -p /home/cfoai/.ssh
# Paste your local public key here (run `cat ~/.ssh/id_ed25519.pub` on
# your Mac, then paste into /home/cfoai/.ssh/authorized_keys on the VPS):
nano /home/cfoai/.ssh/authorized_keys
chmod 700 /home/cfoai/.ssh
chmod 600 /home/cfoai/.ssh/authorized_keys
chown -R cfoai:cfoai /home/cfoai/.ssh

# Verify you can SSH as cfoai BEFORE locking down root:
# From your Mac:  ssh cfoai@187.124.0.37   (should not ask for password)

# Then lock SSH (still as root):
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

# Basic firewall — allow SSH, HTTP, HTTPS only
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
ufw status
```

**Verify:** From your Mac, `ssh cfoai@187.124.0.37` works (key-based, no password). `ssh root@187.124.0.37` is now rejected.

---

## Step 2 — Install system packages

SSH in as `cfoai` and:

```bash
# Python 3.12 (Ubuntu 24.04 ships 3.12 by default)
sudo apt install -y \
    python3 python3-venv python3-pip python3-dev build-essential \
    git nginx certbot python3-certbot-nginx \
    curl ca-certificates gnupg lsb-release

# Node.js 20 LTS (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs

# Verify
python3 --version    # → Python 3.12.x
node --version       # → v20.x
npm --version        # → 10.x
nginx -v             # → nginx/1.24.x
certbot --version    # → certbot 2.x
```

---

## Step 3 — Get the code on the VPS

You have two options:

### 3a. Push from your Mac to a Git remote, clone on the VPS (recommended)

On your **Mac**:

```bash
cd "/Users/alex/Desktop/folder claude Scandia copy"
git status            # See uncommitted pricing work
git add -A
git commit -m "feat: pricing V2/V3 + restyle + deploy artifacts"

# Push to your GitHub remote (replace URL with yours):
git push origin master
```

On the **VPS**:

```bash
sudo mkdir -p /var/www/cfo-ai
sudo chown cfoai:cfoai /var/www/cfo-ai
cd /var/www/cfo-ai
git clone https://github.com/<YOUR_USER>/<YOUR_REPO>.git src
# If the repo is private, use a deploy key or HTTPS PAT.

# Layout: /var/www/cfo-ai/src is the full repo. We symlink the API +
# frontend pieces below.
ln -sfn /var/www/cfo-ai/src                                  /var/www/cfo-ai/api
ln -sfn /var/www/cfo-ai/src/scandi-desk-main                 /var/www/cfo-ai/frontend
sudo mkdir -p /var/www/cfo-ai.finance
sudo chown -R cfoai:cfoai /var/www/cfo-ai.finance
```

### 3b. rsync from your Mac (no git remote needed)

If you can't or don't want to push to GitHub, from your **Mac**:

```bash
cd "/Users/alex/Desktop/folder claude Scandia copy"
rsync -avz --exclude node_modules --exclude .venv --exclude dist \
    --exclude .git --exclude '*.pyc' --exclude __pycache__ \
    ./ cfoai@187.124.0.37:/var/www/cfo-ai/src/
```

(Then continue the symlinks + frontend dir setup as in 3a.)

**Verify (on VPS):** `ls /var/www/cfo-ai/src/scandi-desk-main/package.json` exists.

---

## Step 4 — Build the Python venv + backend secrets

On the **VPS** as `cfoai`:

```bash
cd /var/www/cfo-ai/api
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -e .          # installs the engine package from pyproject.toml
pip install uvicorn[standard]

# Sanity:
.venv/bin/python -m engine --help
```

Set up the secrets file:

```bash
sudo mkdir -p /etc/cfo-ai
sudo cp /var/www/cfo-ai/src/deploy/env.backend.example /etc/cfo-ai/api.env
sudo chown cfoai:cfoai /etc/cfo-ai/api.env
sudo chmod 600 /etc/cfo-ai/api.env

# Edit and fill every <REPLACE_*> placeholder:
sudo nano /etc/cfo-ai/api.env
```

Required for first boot (you can leave Stripe blank for now per the choice you made):
- `VITE_SUPABASE_URL` (already filled)
- `VITE_SUPABASE_ANON_KEY` ← copy from your local `.env`
- `SUPABASE_SERVICE_ROLE_KEY` ← copy from your local `.env`
- `ANTHROPIC_API_KEY` ← copy from your local `.env`
- `STRIPE_SECRET_KEY` ← can be a Stripe test key for now (`sk_test_…`); leave blank if you want checkout to 501

**Verify:**

```bash
cat /etc/cfo-ai/api.env | grep -v '^#' | head -5     # See your values
ls -la /etc/cfo-ai/api.env                            # mode 600, owned by cfoai
```

---

## Step 5 — Install the systemd unit + start the backend

```bash
sudo cp /var/www/cfo-ai/src/deploy/cfo-ai-api.service /etc/systemd/system/
sudo mkdir -p /var/log/cfo-ai
sudo chown cfoai:cfoai /var/log/cfo-ai

# Place config.yaml where the unit expects it
ln -sfn /var/www/cfo-ai/src/config.yaml /var/www/cfo-ai/api/config.yaml

sudo systemctl daemon-reload
sudo systemctl enable --now cfo-ai-api
sudo systemctl status cfo-ai-api      # should be `active (running)`

# Tail logs in another terminal if anything looks off:
journalctl -u cfo-ai-api -f
```

**Verify:** From the VPS,

```bash
curl -fsS http://127.0.0.1:8000/api/pricing/config | head -c 400
```

You should see JSON starting with `{"billing_scope":"user","cogs_estimate_per_doc_eur":1.62,"plans":[...`. If you get HTML or a connection error, check `journalctl -u cfo-ai-api -n 100` for the traceback.

---

## Step 6 — Build the frontend

On the **VPS** as `cfoai`:

```bash
cd /var/www/cfo-ai/frontend
npm ci                                          # clean install from package-lock.json

# Production env (filled before build — Vite inlines these)
cp /var/www/cfo-ai/src/deploy/env.frontend.example .env.production
nano .env.production       # fill <REPLACE_WITH_SUPABASE_ANON_KEY>

npm run build              # outputs to dist/

# Copy the built bundle to the nginx-served directory
sudo rm -rf /var/www/cfo-ai.finance/dist
sudo cp -r dist /var/www/cfo-ai.finance/dist
sudo chown -R www-data:www-data /var/www/cfo-ai.finance
```

**Verify:**

```bash
ls /var/www/cfo-ai.finance/dist/index.html
ls /var/www/cfo-ai.finance/dist/assets/ | head
```

---

## Step 7 — nginx site configs

```bash
# Frontend site (cfo-ai.finance + www)
sudo cp /var/www/cfo-ai/src/deploy/nginx-cfo-ai.finance.conf \
    /etc/nginx/sites-available/cfo-ai.finance
sudo ln -sf /etc/nginx/sites-available/cfo-ai.finance \
    /etc/nginx/sites-enabled/cfo-ai.finance

# Backend site (api.cfo-ai.finance)
sudo cp /var/www/cfo-ai/src/deploy/nginx-api.cfo-ai.finance.conf \
    /etc/nginx/sites-available/api.cfo-ai.finance
sudo ln -sf /etc/nginx/sites-available/api.cfo-ai.finance \
    /etc/nginx/sites-enabled/api.cfo-ai.finance

# Disable the default site if present
sudo rm -f /etc/nginx/sites-enabled/default

# ACME challenge dir for certbot
sudo mkdir -p /var/www/letsencrypt

# Test config + reload
sudo nginx -t
sudo systemctl reload nginx
```

**Verify (HTTP only at this point, before SSL):**

```bash
# Frontend over plain HTTP — will redirect to https in the config but
# you can use -L to follow:
curl -sI http://cfo-ai.finance/ | head -3      # should see 301 redirect
curl -sI http://api.cfo-ai.finance/ | head -3  # should see 301 redirect
```

---

## Step 8 — SSL certificates with certbot

```bash
sudo certbot --nginx \
    -d cfo-ai.finance -d www.cfo-ai.finance \
    -d api.cfo-ai.finance \
    --redirect --hsts --staple-ocsp \
    --email <YOUR_EMAIL> --agree-tos --no-eff-email
```

certbot will:
- Place an ACME challenge under `/var/www/letsencrypt/`
- Request certs for all three hostnames
- Rewrite the nginx server blocks with `ssl_certificate` lines
- Set up automatic renewal via the `certbot.timer` systemd timer

**Verify:**

```bash
sudo certbot certificates       # list installed certs (3 SANs)
sudo systemctl list-timers | grep certbot

# From your Mac:
curl -fsS https://cfo-ai.finance/ | head -c 200
curl -fsS https://api.cfo-ai.finance/api/pricing/config | head -c 200
```

The second curl should return JSON with `"plans":[...]"`.

---

## Step 9 — End-to-end browser check

Open https://cfo-ai.finance in your browser:

- Hero "Simple, honest pricing." should render
- Plan cards for Starter (€14.99) and Pro (€39.99) should populate
- Intro Unlock callout should show €0.99 one-time
- FAQ accordion should expand

Open DevTools → Network → reload. You should see:
- `GET https://api.cfo-ai.finance/api/pricing/config` → 200 JSON

If you see a CORS error in the console, double-check `CORS_ORIGINS` in `/etc/cfo-ai/api.env` includes both `https://cfo-ai.finance` and `https://www.cfo-ai.finance`, then:

```bash
sudo systemctl restart cfo-ai-api
```

---

## Step 10 — Re-deploys after this

When you push new code, on the VPS:

```bash
cd /var/www/cfo-ai/src
git pull

# Backend changes? — restart the API
sudo systemctl restart cfo-ai-api
journalctl -u cfo-ai-api -n 50

# Frontend changes? — rebuild + recopy
cd /var/www/cfo-ai/frontend
npm ci                              # only if package-lock.json changed
npm run build
sudo rm -rf /var/www/cfo-ai.finance/dist
sudo cp -r dist /var/www/cfo-ai.finance/dist
sudo chown -R www-data:www-data /var/www/cfo-ai.finance
```

No nginx reload needed for content-only updates; nginx serves the new `dist` directly.

---

## What to come back to once Stripe price IDs are ready

1. Publish trial/intro/starter/pro prices in your Stripe dashboard.
2. Add `STRIPE_PRICE_*` env vars to `/etc/cfo-ai/api.env`.
3. `sudo systemctl restart cfo-ai-api`.
4. Set up the Stripe webhook in dashboard pointing at `https://api.cfo-ai.finance/api/billing/webhook` and copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

Until then, the free trial signup path and the pricing display work; only checkout for paid tiers is gated.

---

## Rollback (in case something goes wrong)

```bash
# Stop the new API service
sudo systemctl stop cfo-ai-api

# Revert to a known-good git commit
cd /var/www/cfo-ai/src
git log --oneline -5
git checkout <known-good-sha>

# Rebuild + restart
cd /var/www/cfo-ai/api && source .venv/bin/activate && pip install -e .
sudo systemctl start cfo-ai-api
cd /var/www/cfo-ai/frontend && npm run build
sudo rm -rf /var/www/cfo-ai.finance/dist && sudo cp -r dist /var/www/cfo-ai.finance/
```

Or just point DNS back at `2.57.91.91` for an emergency cut-over to the parking page while you diagnose.
