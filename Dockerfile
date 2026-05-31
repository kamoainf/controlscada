FROM node:20

WORKDIR /app

# ─────────────────────────────────────────────
# 🔧 SYSTEM DEPENDENCIES (WhatsApp + Puppeteer)
# ─────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
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
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    wget \
    -y

# ─────────────────────────────────────────────
# 📦 INSTALL NODE DEPENDENCIES
# ─────────────────────────────────────────────
COPY package*.json ./

RUN npm install 

# ─────────────────────────────────────────────
# 📁 COPY PROJECT FILES
# ─────────────────────────────────────────────
COPY . .

# ─────────────────────────────────────────────
# 🌐 PORT
# ─────────────────────────────────────────────
EXPOSE 3000

# ─────────────────────────────────────────────
# 🚀 START APP
# ─────────────────────────────────────────────
CMD ["npm", "start"]