# Deploy CFO AI to the existing Hostinger VPS — Run Sheet

Lives alongside the existing **scandiafood-sku.online** Docker stack on the same VPS (`187.124.0.37`, Hostinger KVM 2). Adds 2 new containers + 1 new Caddy site block. The scandia, vitalis, and longivity sites are untouched.

## Architecture decision

The VPS already has a `scandia-caddy` container that owns ports 80/443 and routes by hostname. We:

- Create a **second compose stack** at `/opt/cfo-ai/` with `cfo-ai-backend` and `cfo-ai-frontend` containers.
- Attach both new containers to the existing `scandia_default` Docker network so `scandia-caddy` can reach them by service name.
- Add a **`cfo-ai.finance` block** to the existing `/opt/scandia/Caddyfile`.
- Reload Caddy (zero-downtime).

No changes to the scandia containers, no port conflicts, no second TLS terminator.

---

## Step 1 — Upload code from your Mac

Run this **on your Mac terminal** (not the VPS):

```bash
cd "/Users/alex/Desktop/folder claude Scandia copy"

# Create /opt/cfo-ai on the VPS first
ssh root@187.124.0.37 'mkdir -p /opt/cfo-ai && chown root:root /opt/cfo-ai'

# Rsync the source tree. Excludes: node_modules, .venv, dist, .git,
# the local pricing diagnostic, and macOS resource forks.
rsync -avz --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.venv' \
  --exclude 'dist' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude '.DS_Store' \
  --exclude '._*' \
  --exclude 'files/' \
  --exclude 'DIAGNOSTIC_DEPLOYED_BLANK_PRICES.md' \
  --exclude 'scandi-desk-main/.env' \
  --exclude 'scandi-desk-main/.env.local' \
  --exclude '/.env' \
  ./ root@187.124.0.37:/opt/cfo-ai/
```

`--delete` means the VPS copy stays in sync with what you have locally. `.env` files are NOT synced (we put production secrets directly on the VPS).

---

## Step 2 — Drop the CFO-AI-specific config into place (on the VPS)

SSH in:

```bash
ssh root@187.124.0.37
```

Then:

```bash
cd /opt/cfo-ai

# Move CFO-AI-specific files into place (these come from deploy/cfo-ai-vps/
# that we just rsync'd up).
cp deploy/cfo-ai-vps/docker-compose.yml /opt/cfo-ai/docker-compose.yml
cp deploy/cfo-ai-vps/.env.example       /opt/cfo-ai/.env

# Fill in the secrets — open the file and replace every <REPLACE_*>:
nano /opt/cfo-ai/.env
# Required to fill: VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
#                   ANTHROPIC_API_KEY, STRIPE_SECRET_KEY (can be a test
#                   key sk_test_… for now).
# Leave Stripe price IDs commented out — you said they're not ready yet.

chmod 600 /opt/cfo-ai/.env
```

---

## Step 3 — Update the Caddyfile (on the VPS, additive)

```bash
# Backup the current Caddyfile (Caddy convention you've already used)
cp /opt/scandia/Caddyfile \
   /opt/scandia/Caddyfile.bak-$(date +%Y-%m-%d)-pre-cfo-ai

# Replace it with the new one (existing 4 blocks + 2 new CFO AI blocks)
cp /opt/cfo-ai/deploy/cfo-ai-vps/Caddyfile /opt/scandia/Caddyfile

# Sanity-diff so you can see what changed
diff /opt/scandia/Caddyfile.bak-$(date +%Y-%m-%d)-pre-cfo-ai \
     /opt/scandia/Caddyfile | head -80
```

You should see only **new** lines at the bottom (CFO AI blocks), no edits to existing scandia/vitalis/longivity blocks.

---

## Step 4 — Build + start the CFO AI containers

```bash
cd /opt/cfo-ai
docker compose build              # ~2-4 min the first time
docker compose up -d              # starts cfo-ai-backend + cfo-ai-frontend

# Watch logs until "Application startup complete." appears
docker compose logs -f cfo-ai-backend &
sleep 8 && kill %1 2>/dev/null    # detach the log tail after 8s

# Confirm both are healthy
docker ps --filter name=cfo-ai --format 'table {{.Names}}\t{{.Status}}'
```

Both should show `Up`. Backend should reach `(healthy)` within ~30s thanks to the healthcheck.

---

## Step 5 — Reload Caddy (zero-downtime)

```bash
# Validate the new Caddyfile inside the running Caddy container first
docker compose -f /opt/scandia/docker-compose.yml exec caddy \
    caddy validate --config /etc/caddy/Caddyfile

# Reload — picks up the new cfo-ai.finance blocks WITHOUT dropping any
# existing connections. scandia, vitalis, longivity stay up the whole
# time.
docker compose -f /opt/scandia/docker-compose.yml exec caddy \
    caddy reload --config /etc/caddy/Caddyfile

# Tail Caddy logs briefly to confirm the new sites + cert provisioning
docker compose -f /opt/scandia/docker-compose.yml logs --tail=80 caddy
```

You'll see lines like:

```
... msg: "obtained certificate" identifiers: ["cfo-ai.finance"]
... msg: "obtained certificate" identifiers: ["www.cfo-ai.finance"]
... msg: "obtained certificate" identifiers: ["api.cfo-ai.finance"]
```

Cert issuance takes 10–60 seconds. If it fails, it'll keep retrying — the rest of the stack stays up.

---

## Step 6 — Verify from the public internet

From your **Mac** (or any non-VPS machine):

```bash
# Frontend
curl -fsS https://cfo-ai.finance/ | grep -oE '<title>[^<]+</title>'
# Expect: <title>CFO AI — …</title>  (NOT "Scandia AI · SKU Decision Engine")

# Backend pricing config
curl -fsS https://cfo-ai.finance/api/pricing/config | head -c 200
# Expect JSON starting with {"billing_scope":"user","cogs_estimate_per_doc_eur":1.62,...

# API subdomain works too
curl -fsS https://api.cfo-ai.finance/api/pricing/config | head -c 200
# Expect the same JSON.

# scandia site still works (sanity check)
curl -fsS https://scandiafood-sku.online/ | grep -oE '<title>[^<]+</title>'
# Expect: <title>Scandia AI · SKU Decision Engine</title>  (unchanged)
```

Open `https://cfo-ai.finance/pricing` in your browser. You should see:

- "Simple, honest pricing." hero
- Starter (€14.99) + Pro (€39.99) tier cards with brand-gradient accent on Pro
- Intro Unlock callout (€0.99 one-time)
- FAQ accordion

---

## Re-deploy after code changes

```bash
# On your Mac (in the repo root)
cd "/Users/alex/Desktop/folder claude Scandia copy"
rsync -avz --delete --exclude '.git' --exclude 'node_modules' \
  --exclude '.venv' --exclude 'dist' --exclude '*.pyc' --exclude '.DS_Store' \
  --exclude '._*' --exclude 'files/' --exclude '/.env' \
  ./ root@187.124.0.37:/opt/cfo-ai/

# On the VPS
ssh root@187.124.0.37
cd /opt/cfo-ai
docker compose build         # ~30-90s incremental
docker compose up -d         # restarts the changed containers
```

No Caddy reload needed for code-only changes.

---

## Rollback (if anything breaks)

```bash
# Restore the previous Caddyfile (replace <DATE> with today)
cp /opt/scandia/Caddyfile.bak-<DATE>-pre-cfo-ai /opt/scandia/Caddyfile
docker compose -f /opt/scandia/docker-compose.yml exec caddy \
    caddy reload --config /etc/caddy/Caddyfile

# Stop the CFO AI containers (scandia/vitalis/longivity unaffected)
cd /opt/cfo-ai
docker compose down

# DNS: if needed, point cfo-ai.finance back to 2.57.91.91 (parking)
# at hpanel.hostinger.com → DNS.
```
