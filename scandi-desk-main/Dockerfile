# Frontend image — Vite build → static files behind tiny nginx.
# Caddy reverse-proxies to nginx for / and to the backend for /api etc.

# ─── Build stage ───
FROM node:20-alpine AS build
WORKDIR /app

# VITE_API_URL is empty → frontend calls relative paths (`/api/skus`,
# `/health`) which Caddy routes to the backend. Same-origin = no CORS.
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL

COPY package.json package-lock.json ./
# `npm install` (not `npm ci`) — the lockfile in this repo lags some deps
# in package.json. Install resolves the gap by updating the lockfile in place
# inside the image. For stricter reproducibility, regenerate the lockfile
# locally with `npm install` and switch this back to `npm ci`.
RUN npm install --no-audit --no-fund --legacy-peer-deps

COPY . .
RUN npm run build

# ─── Runtime stage ───
FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
