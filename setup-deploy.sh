#!/bin/bash

# 🚀 Script de configuration automatique pour déploiement

echo "================================================"
echo "   KAMOA Control SCADA - Setup Auto-Deploy"
echo "================================================"
echo ""

# Couleurs
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}📋 Vérification de l'environnement...${NC}"

if ! command -v git &> /dev/null; then
    echo -e "${RED}❌ Git n'est pas installé${NC}"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ Node.js n'est pas installé${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Git et Node.js détectés${NC}"
echo ""

echo -e "${BLUE}📦 Installation des dépendances...${NC}"
npm install
echo -e "${GREEN}✅ Dépendances installées${NC}"
echo ""

echo -e "${YELLOW}⚠️  ÉTAPES SUIVANTES:${NC}"
echo ""
echo "1️⃣  Configurez les Secrets GitHub:"
echo "   https://github.com/kamoainf/controlscada/settings/secrets/actions"
echo ""
echo "   Secrets à ajouter:"
echo "   - RAILWAY_TOKEN"
echo "   - CLOUDFLARE_API_TOKEN"
echo "   - CLOUDFLARE_ACCOUNT_ID"
echo ""
echo "2️⃣  Lisez le guide complet:"
echo "   cat SETUP_AUTO_DEPLOY_GUIDE.md"
echo ""
echo "3️⃣  Poussez vos changements:"
echo "   git push origin setup/auto-deploy"
echo ""
echo -e "${GREEN}================================================"
echo "   ✅ Configuration prête!"
echo "================================================${NC}"
