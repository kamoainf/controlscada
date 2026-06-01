# ─────────────────────────────────────────────────────────────────────────────
# KAMOA SCADA — Dockerfile (UltraMsg, no Puppeteer / Chromium)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# ── Node dependencies only — no browser needed ───────────────────────────────
COPY package*.json ./

# Remove whatsapp-web.js and puppeteer from the install if still in package.json
# (safe to run even if they're already gone)
RUN npm uninstall --save whatsapp-web.js puppeteer puppeteer-core 2>/dev/null || true

RUN npm install --omit=dev

# ── Application files ─────────────────────────────────────────────────────────
COPY . .

# ── Port ──────────────────────────────────────────────────────────────────────
EXPOSE 3000

# ── Start ─────────────────────────────────────────────────────────────────────
CMD ["node", "server.js"]
