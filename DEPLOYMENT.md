# 🚀 KAMOA Control SCADA - Guide de Déploiement

## 📋 Vue d'ensemble

Application de surveillance avec intégration WhatsApp, déployable sur **Cloudflare** (frontend) et **Railway** (backend).

```
┌─────────────────────────────────────────┐
│  KAMOA CONTROL SCADA                    │
├─────────────────────────────────────────┤
│  Frontend: Cloudflare Pages (HTML/JS)   │
│  Backend:  Railway (Express + Node.js)  │
│  WhatsApp: Evolution API                │
└─────────────────────────────────────────┘
```

---

## 1️⃣ Installation Locale

### Prérequis
- Node.js >= 18.0.0
- npm ou yarn
- Compte Cloudflare
- Compte Railway
- Clé API Evolution (WhatsApp)

### Étapes

```bash
# Clone du repository
git clone https://github.com/kamoainf/controlscada.git
cd controlscada

# Installation des dépendances
npm install

# Configuration des variables d'environnement
cp .env.example .env

# Remplissez .env avec vos valeurs :
# WHATSAPP_API_KEY=votre_clé_api
# WHATSAPP_API_BASE_URL=https://votre-api.railway.app/api
# INSTANCE_NAME=kamoa-instance-1

# Démarrage en développement
npm run dev
```

L'app sera disponible sur `http://localhost:8080`

---

## 2️⃣ Déploiement sur Railway (Backend + API)

### A. Configuration Railway

1. **Créer un projet Railway**
   - Accédez à [railway.app](https://railway.app)
   - Cliquez sur "New Project"
   - Sélectionnez "Deploy from GitHub"
   - Connectez votre repo GitHub

2. **Variables d'environnement Railway**

Dans le Dashboard Railway, configurez :

```
WHATSAPP_API_KEY = <votre_clé_api_evolution>
WHATSAPP_API_BASE_URL = https://your-evolution-api.railway.app/api
INSTANCE_NAME = kamoa-instance-1
NODE_ENV = production
PORT = 8080
```

3. **Déploiement automatique**

Railway détectera automatiquement le `package.json` et déploiera selon la configuration du `railway.json`

### B. Vérifier le déploiement

```bash
# Une fois déployé sur Railway
curl https://your-railway-app.up.railway.app/api/health

# Réponse attendue:
{
  "status": "online",
  "timestamp": "2026-05-29T...",
  "version": "1.0.0",
  "app": "KAMOA Control SCADA"
}
```

---

## 3️⃣ Déploiement sur Cloudflare Pages (Frontend)

### A. Configuration Cloudflare Pages

1. **Connecter le repository**
   - Accédez à [Cloudflare Dashboard](https://dash.cloudflare.com)
   - Pages → Create a project → Connect to Git
   - Sélectionnez `kamoainf/controlscada`

2. **Paramètres de build**

```
Build command: (laisser vide - c'est du HTML statique)
Build output directory: /
Root directory: /
```

3. **Variables d'environnement Pages**

```
VITE_API_URL = https://your-railway-app.up.railway.app
```

### B. Mettre à jour index.html

Dans `index.html`, pointez vers votre API Railway :

```html
<script>
  // Configuration
  const API_URL = 'https://your-railway-app.up.railway.app';
  
  // Initialiser WhatsApp Integration
  const waConfig = {
    apiBaseUrl: API_URL + '/api',
    apiKey: localStorage.getItem('whatsapp_api_key'),
    instanceName: 'kamoa-instance-1'
  };
  
  const whatsappIntegration = new WhatsAppIntegration(waConfig);
  whatsappIntegration.init();
</script>
```

---

## 4️⃣ Intégration WhatsApp avec Evolution API

### A. Déployer Evolution API sur Railway

```bash
# Alternative: Utiliser une instance Evolution existante
# Ou déployer votre propre serveur Evolution

# Variable Railway:
WHATSAPP_API_BASE_URL = https://evolution-api.railway.app/api
```

### B. Authentification WhatsApp

1. Accédez à votre app Cloudflare
2. Cliquez sur le bouton WhatsApp
3. Scannez le QR Code avec votre téléphone
4. Autorisez l'accès

---

## 5️⃣ Architecture API

### Endpoints disponibles

```
GET  /api/health
     ↳ Vérifier l'état du serveur

GET  /api/whatsapp/qrcode
     ↳ Récupérer le QR Code WhatsApp

POST /api/whatsapp/config
     Body: { apiKey, apiBaseUrl, instanceName }
     ↳ Configurer WhatsApp

POST /api/whatsapp/send
     Body: { to, message, mediaUrl?, mediaType? }
     ↳ Envoyer un message WhatsApp

POST /api/webhooks/whatsapp
     ↳ Webhook pour recevoir les messages
```

---

## 6️⃣ Configuration du Webhook WhatsApp

Dans votre Evolution API, configurez le webhook :

```json
{
  "url": "https://your-cloudflare-app.pages.dev/api/webhooks/whatsapp",
  "events": ["messages", "connection"]
}
```

---

## 7️⃣ Troubleshooting

### Problème: CORS Error
```javascript
// Vérifier que le backend accepte votre domaine Cloudflare
// Dans src/server.js:
app.use(cors({
    origin: 'https://your-app.pages.dev',
    credentials: true
}));
```

### Problème: WhatsApp ne répond pas
```bash
# 1. Vérifier les logs Railway
railway logs

# 2. Vérifier la clé API
curl -H "x-api-key: YOUR_KEY" \
     https://your-api.railway.app/api/instances

# 3. Vérifier que le QR n'a pas expiré (35 secondes)
```

### Problème: Pas de webhook
```bash
# 1. Tester le webhook manually
curl -X POST \
  https://your-app.pages.dev/api/webhooks/whatsapp \
  -H "Content-Type: application/json" \
  -d '{"test": true}'

# 2. Vérifier les logs
```

---

## 8️⃣ Optimisations Production

### A. Cache Cloudflare
```
Créer une règle de cache pour:
- index.html: No cache
- *.css, *.js: 1 jour
- /api/*: No cache
```

### B. SSL/TLS
```
Cloudflare → SSL/TLS → Mode: Full (strict)
```

### C. Environment Railway
```
NODE_ENV = production
LOG_LEVEL = info
RATE_LIMIT = 100/minute
```

---

## 9️⃣ Monitoring

### Railway Metrics
- CPU Usage
- Memory Usage
- Request Count
- Error Rate

### Cloudflare Analytics
- Page Views
- Bandwidth
- Requests
- Error Rate

---

## 🔟 Mise à jour de l'application

```bash
# Push des changements
git add .
git commit -m "Update feature"
git push origin main

# Railway redéploiera automatiquement
# Cloudflare mettra à jour le site en quelques secondes
```

---

## 📞 Support

- **Documentation Railway**: https://docs.railway.app
- **Documentation Cloudflare Pages**: https://developers.cloudflare.com/pages
- **Evolution API Docs**: https://www.evolution-api.com

---

**Version**: 1.0.0  
**Last Updated**: 2026-05-29  
**Author**: kamoainf
