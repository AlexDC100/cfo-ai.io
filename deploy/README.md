# Deploying to the Hostinger VPS

Target host: **scandiafood-sku.online** → 187.124.0.37 (Hostinger KVM 2, Ubuntu 24.04)

The stack runs as three Docker containers (backend, frontend, Caddy reverse-proxy with auto-HTTPS) defined in `docker-compose.yml` at the project root.

**You can deploy *now* and fix DNS / API key later** — Caddy serves the stack on `http://187.124.0.37` immediately, and the AI panel falls back to deterministic prose when no key is set. Once you point DNS at the VPS and add the rotated key, both auto-activate without redeploying.

## Quick path (deploy first, polish after)

### 1. Ship the project to the VPS

From your **laptop** (the project folder you've been working in):

```bash
cd ~/Desktop
tar --exclude='folder claude Scandia/.venv' \
    --exclude='folder claude Scandia/.git' \
    --exclude='folder claude Scandia/.pytest_cache' \
    --exclude='folder claude Scandia/build' \
    --exclude='folder claude Scandia/output' \
    --exclude='folder claude Scandia/scandi-desk-main/node_modules' \
    --exclude='folder claude Scandia/scandi-desk-main/dist' \
    --exclude='folder claude Scandia/.DS_Store' \
    --exclude='folder claude Scandia/files.zip' \
    -czf /tmp/scandia.tar.gz \
    'folder claude Scandia'

scp /tmp/scandia.tar.gz root@187.124.0.37:/opt/
```

(SSH password is on the Hostinger VPS overview page until you set up keys.)

### 2. Bootstrap the VPS

SSH in and unpack:

```bash
ssh root@187.124.0.37

mkdir -p /opt/scandia
tar -xzf /opt/scandia.tar.gz -C /opt/scandia --strip-components=1
cd /opt/scandia
./deploy/bootstrap.sh
```

The first run installs Docker (Ubuntu 24.04 native), then exits after creating `.env`. You can either edit it now and add the Anthropic key, or skip it and add later — the engine doesn't need the key to start.

```bash
docker compose up -d --build
```

First build takes 3–5 minutes (Python deps + `npm ci` + nginx + Caddy).

### 3. Verify (works without DNS)

```bash
# From the VPS itself, or from your laptop
curl -fsS http://187.124.0.37/health
# → {"status":"ok","version":"0.1.0"}
```

Open `http://187.124.0.37` in a browser — the dashboard loads. Browser will warn there's no HTTPS; that's fine for now. Share the IP with the team only if you trust your network; otherwise wait until step 4.

### 4. Add HTTPS (do this when you can)

In Hostinger DNS Zone Editor for `scandiafood-sku.online`:

| Type | Name | Value             | TTL |
|------|------|-------------------|-----|
| A    | @    | 187.124.0.37      | 300 |
| A    | www  | 187.124.0.37      | 300 |

Delete any existing A records pointing at parking pages. Verify from your laptop:

```bash
dig +short scandiafood-sku.online   # should print 187.124.0.37
```

Within ~30 seconds of DNS resolving, Caddy negotiates a Let's Encrypt cert in the background. You don't have to redeploy. Then `https://scandiafood-sku.online` is live — share *that* URL with the team.

### 5. Add the Anthropic key (when you have it)

The compromised keys you pasted in chat must stay revoked. Mint a third at <https://console.anthropic.com/settings/keys>, name it `scandia-prod`, copy to your password manager. Then on the VPS:

```bash
nano /opt/scandia/.env
# set: ANTHROPIC_API_KEY=sk-ant-...
docker compose restart backend
docker compose logs backend | grep anthropic
# → [anthropic] Key sk-ant-api03-… authenticated — AI panel ready.
```

The boot probe shows the first 12 characters of the key as a fingerprint so you can confirm you pasted the right one — never enough characters to use the key.

## Updates (subsequent deploys)

When you change code locally, redo step 1 (re-tar + scp) then on the VPS:

```bash
cd /opt/scandia
tar -xzf /opt/scandia.tar.gz -C /opt/scandia --strip-components=1
docker compose up -d --build
```

Caddy and the named SQLite volume keep state across rebuilds.

## Operational commands

```bash
# Tail logs across all containers
docker compose logs -f

# Just the backend
docker compose logs -f backend

# Restart the backend (no rebuild)
docker compose restart backend

# Check container health
docker compose ps

# Stop everything (data persists in named volumes)
docker compose down

# Stop AND wipe data (decisions, run history, AI cache)
docker compose down -v
```

## Troubleshooting

**Caddy keeps retrying the cert** — your DNS hasn't propagated yet. `dig +short scandiafood-sku.online` from your laptop should return `187.124.0.37`. If it doesn't, fix the DNS records and wait.

**Backend health check fails** — `docker compose logs backend`. Most likely the canonical Excel path or `pyproject.toml install -e` failed during build. Check the build log.

**Frontend loads but API calls 502** — the `backend` container is restarting. `docker compose ps` will show `unhealthy` or `restarting`.

**HTTPS works but API calls fail with CORS** — shouldn't happen because Caddy serves both on the same origin, but if you split them later, set `CORS_ORIGINS` in `.env`.

## What's where

```
/opt/scandia/
  Dockerfile                       backend image
  scandi-desk-main/Dockerfile      frontend image (Vite build → nginx)
  scandi-desk-main/nginx.conf      SPA fallback config
  Caddyfile                        reverse proxy + auto-HTTPS rules
  docker-compose.yml               orchestration
  .env                             SECRETS (gitignored, never commit)
  .env.example                     template
  deploy/bootstrap.sh              one-shot installer
  deploy/README.md                 this file
```

Backend SQLite DB lives in the named volume `scandia_backend_data` — survives rebuilds and `docker compose down`. Caddy's TLS state lives in `scandia_caddy_data`.
