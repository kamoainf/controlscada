FROM node:20-slim

WORKDIR /app

# ─────────────────────────────────────────────
# 🔧 CHROMIUM SYSTÈME + dépendances complètes
# ─────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxkbcommon0 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    wget \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# ─────────────────────────────────────────────
# 🚫 EMPÊCHER Puppeteer de télécharger Chrome
#    → utiliser Chromium système
# ─────────────────────────────────────────────
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# ─────────────────────────────────────────────
# 📦 INSTALL NODE DEPENDENCIES
# ─────────────────────────────────────────────
COPY package*.json ./
RUN npm install --omit=dev

# ─────────────────────────────────────────────
# 📁 COPY PROJECT FILES
# ─────────────────────────────────────────────
COPY . .

# ─────────────────────────────────────────────
# 🌐 PORT + USER SÉCURISÉ
# ─────────────────────────────────────────────
EXPOSE 3000

# Northflank tourne souvent en root — pas besoin d'un user séparé
# mais on s'assure que /tmp est accessible pour LocalAuth
RUN mkdir -p /tmp/kamoa_auth && chmod 777 /tmp/kamoa_auth

# ─────────────────────────────────────────────
# 🚀 START
# ─────────────────────────────────────────────
CMD ["npm", "start"]
