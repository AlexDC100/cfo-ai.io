# Request body limits — the operator half

> Added 2026-09-06 alongside `BodyLimitMiddleware` in
> `src/engine/api/server.py` and `client_max_body_size` in `nginx.conf`.
> This file is the **one change the coordinator must make on the VPS**;
> everything else in this lane ships with the repo.

## What was measured, and why this exists

Locally, against the real `create_app()`, anonymous, no bearer, nothing in
front of it:

| route | body in | status | body out | amplification | wall |
|---|---|---|---|---|---|
| `POST /api/skus` (18.5 MB of **valid** rows) | 20,205,482 | 200 | 56,989,094 | **2.82×** | 3.45 s |
| `POST /api/skus` (18.5 MB of **invalid** rows) | 19,689,462 | 422 | 42,009,599 | **2.13×** | 3.46 s |
| `POST /api/drill` (18.5 MB invalid) | 19,689,483 | 422 | 42,009,599 | **2.13×** | 3.39 s |
| `POST /api/cfo/today` (18.5 MB invalid) | 19,674,808 | 422 | 39,984,904 | **2.03×** | 3.32 s |

There was **no `client_max_body_size` anywhere** — not in `nginx.conf`
(which serves the SPA only) and not in the app — so the ceiling on an
anonymous request was whatever the front proxy happened to allow. A
caller chose how much work the box did, and how many bytes it sent back.

## The two numbers, and how they were chosen

| limit | bytes | why |
|---|---|---|
| **general — 8 MiB** | 8,388,608 | The largest real SKU dataset in the repo (`files/Trading_analysis_YTDOct'25_LV.xlsx`, 9,604 rows), serialized in the exact shape `frontend/lib/api.ts::rawRowsToBackend` posts, is **1,925,012 bytes (1.84 MB)** at 200.4 bytes/row. 8 MiB is 4.4× that — room for a portfolio four times larger than anything the owner has ever analyzed. |
| **document — 36 MiB** | 37,748,736 | Only two paths legitimately carry a whole document in the request body: `POST /api/financial-statements/parse` (`pdf_b64`, whose own ceiling is a 25 MB decoded PDF → **33.4 MB** of base64) and `POST /api/firm/requests/{token}/upload` (a 25 MB multipart file). 36 MiB clears 33.4 MB plus the JSON envelope, and nothing more. |

The financial pipeline does **not** post documents to the engine at all —
the browser uploads straight to Supabase Storage and the engine downloads
by signed URL (`src/engine/api/pipeline.py:1219`). So the general cap does
not touch the live upload path.

## Where each limit is enforced, and why more than once

| hop | file | enforced |
|---|---|---|
| Caddy (public ingress) | `/opt/scandia/Caddyfile` **on the VPS** | ← **THE OPERATOR DELTA BELOW** |
| nginx (SPA static container) | `nginx.conf` (this repo) | `client_max_body_size 1m` — this hop serves only GETs for assets and `index.html`; API traffic never passes through it |
| the app | `src/engine/api/server.py` (`BodyLimitMiddleware`) | 8 MiB / 36 MiB, before routing and before the validator |

The app-level limit is not redundant with the proxy one. It is what holds
when a request does **not** pass through the front: a direct hit on
`cfo-ai-backend:8000` from inside `scandia_default`, a different ingress,
or a future one. The proxy limit is what keeps the bytes off the box in
the first place.

## OPERATOR DELTA — the exact Caddy change

`scandia-caddy` reverse-proxies `/api/*` **straight to the backend**
(`deploy/cfo-ai-vps/Caddyfile:110-123` mirrors the live file), so the
front today has no body ceiling of its own. Add one line-block inside the
`handle @api` block of the `cfo-ai.io, www.cfo-ai.io` site:

```caddyfile
    @api path /api/* /health
    handle @api {
        request_body {
            max_size 36MB
        }
        reverse_proxy cfo-ai-backend:8000 {
            flush_interval -1
            transport http {
                dial_timeout 10s
                read_timeout 600s
                write_timeout 600s
            }
        }
    }
```

**36MB, not 8MB, at this hop on purpose.** Caddy matches on path prefix,
so a single ceiling here has to clear the largest legitimate path
(`/api/financial-statements/parse`). The exact per-path split — 8 MiB for
everything else — is the app's job, and the app does it. The front's job
is to stop the multi-gigabyte body before it reaches a Python process.

`/opt/scandia/Caddyfile` fronts the **whole VPS**, including the scandia
stack. Per CLAUDE.md §21: **`caddy validate` before reloading, always.**

```
docker exec scandia-caddy caddy validate --config /etc/caddy/Caddyfile
docker exec scandia-caddy caddy reload  --config /etc/caddy/Caddyfile
```

Verify after the reload (read-only, unauthenticated):

```
# 40 MB of zeros at a general path -> 413 from Caddy
head -c 40000000 /dev/zero | curl -s -o /dev/null -w '%{http_code}\n' \
     -X POST https://cfo-ai.io/api/skus \
     -H 'content-type: application/json' --data-binary @-
```

## The stated worst case, after the change

Measured at the cap boundary (8,388,608 − 1,024 bytes in), anonymous:

| route | bytes in | status | bytes out (decoded) | bytes out (wire, gzip) | secs |
|---|---|---|---|---|---|
| `/api/skus` | 8,357,801 | 200 | **23,578,467** | **730,551** | 1.70 |
| `/api/drill` | 8,357,822 | 200 | 322,203 | 9,517 | 0.57 |
| `/api/classify-rows` | 8,357,823 | 200 | 9,313 | 1,046 | 0.53 |
| `/api/alerts` | 8,357,801 | 200 | 75,558 | 3,994 | 0.48 |
| `/api/cfo/today` | 8,366,708 | 200 | 579 | 579 | 0.58 |
| any of them, **invalid** rows | ~8,370,000 | 422 | 3,541 | 391 | ≤ 0.39 |
| any of them, **over** the cap | any | 413 | 229 | 229 | ~0.00 |

**So: at most 8 MiB in, 24 MiB out (730 KB on the wire), 1.7 s.**
`/api/skus` is the ceiling because it returns one enriched record per
input row — its response is proportional to its input by design. That is
the shape of the endpoint, not a defect; the defect was that nothing
bounded the input.

## What is NOT closed by this change

`POST /api/cfo/*` still has **no rate limiter**, and a cap cannot give it
one. Measured 2026-09-06 against a real uvicorn on 127.0.0.1, anonymous:

| burst | result |
|---|---|
| 30 × 4.87 MiB (**under** the cap) | 30 × 200, **12.37 s** of wall time, slowest request 12.32 s |
| 50 × 18.5 MiB (**over** the cap) | 50 × 413, **0.73 s** of wall time |

The cap makes over-size traffic essentially free — that half is closed.
Bodies **under** the cap are admitted, as they must be, and N of them in
parallel still cost N× the CPU. That is a limiter's job. Backlogged as
**LB-RL-1: rate-limit `/api/cfo/*` for anonymous callers** (the RO
storefront's `engine.public_ro.ratelimit` is the existing pattern).

Two smaller residuals, both one-line tickets:

* **LB-413-COPY** — `frontend/lib/api.ts::call` reads `body.detail`, and
  the 413 answers in the `{"error": {...}}` envelope the surface walls
  use, so a browser would surface the terse `413 Payload Too Large`
  rather than the designed message. No live caller can reach it today
  (the largest legitimate body is 1.84 MB), which is why it is a ticket
  and not a change.
* **LB-CHUNK-MEM** — a chunked request with no `content-length` is
  buffered here, bounded at `limit + 1` bytes. Bounded *per request*: N
  concurrent chunked requests still hold N × 8 MiB. Same fix as LB-RL-1.
