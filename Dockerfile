# ─────────────────────────────────────────────────────────────────────────────
# KAMOA SCADA v3 — Dockerfile
# WhatsApp via Baileys (@whiskeysockets/baileys) — aucun navigateur requis
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# ── Dépendances système (Baileys build + SSL certs) ───────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ── Installer les dépendances Node ───────────────────────────────────────────
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ── Copier les fichiers de l'application ─────────────────────────────────────
COPY . .

# ── Port exposé ───────────────────────────────────────────────────────────────
EXPOSE 8080

# ── Démarrage ─────────────────────────────────────────────────────────────────
CMD ["node", "server.js"]
