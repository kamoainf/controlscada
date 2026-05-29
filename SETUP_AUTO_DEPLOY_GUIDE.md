# 🚀 CONFIGURATION AUTOMATIQUE - DÉPLOIEMENT

## ✅ Fichiers GitHub Actions créés

Deux workflows ont été créés automatiquement:

1. **`.github/workflows/deploy-railway.yml`** → Déploie sur Railway
2. **`.github/workflows/deploy-cloudflare.yml`** → Déploie sur Cloudflare Pages

---

## 🔑 ÉTAPE 1: Créer les Secrets GitHub

### Allez sur: https://github.com/kamoainf/controlscada/settings/secrets/actions

Cliquez **"New repository secret"** et ajoutez ces 3 secrets:

### **Secret 1: RAILWAY_TOKEN**
```
Nom: RAILWAY_TOKEN
Valeur: [Votre Railway API Token]
```

**Comment obtenir le token:**
1. Allez sur https://railway.app/dashboard
2. Settings → API Tokens
3. Create Token
4. Copier-coller la valeur

### **Secret 2: CLOUDFLARE_API_TOKEN**
```
Nom: CLOUDFLARE_API_TOKEN
Valeur: [Votre Cloudflare API Token]
```

**Comment obtenir le token:**
1. Allez sur https://dash.cloudflare.com
2. My Profile → API Tokens
3. Create Token → "Edit Cloudflare Workers"
4. Copier-coller la valeur

### **Secret 3: CLOUDFLARE_ACCOUNT_ID**
```
Nom: CLOUDFLARE_ACCOUNT_ID
Valeur: [Votre Cloudflare Account ID]
```

**Comment obtenir l'ID:**
1. Allez sur https://dash.cloudflare.com
2. Sélectionnez votre domaine/site
3. L'ID est affiché en bas à droite

---

## ⚙️ ÉTAPE 2: Configurer Railway

1. Allez sur https://railway.app/dashboard
2. Créez un nouveau projet
3. Connect GitHub → Sélectionnez `kamoainf/controlscada`
4. Allez à **Variables**
5. Ajoutez ces variables d'environnement:

```
WHATSAPP_API_KEY = [votre clé API Evolution]
WHATSAPP_API_BASE_URL = https://your-evolution-api.railway.app/api
INSTANCE_NAME = kamoa-instance-1
NODE_ENV = production
```

6. Sauvegardez et attendez le déploiement initial

---

## 🌐 ÉTAPE 3: Configurer Cloudflare Pages

1. Allez sur https://dash.cloudflare.com
2. Pages → Create a project → Connect to Git
3. Sélectionnez `kamoainf/controlscada`
4. Build settings:
   - Build command: *(laisser vide)*
   - Build output directory: `/`
   - Root directory: `/`
5. Save and Deploy

---

## 📤 ÉTAPE 4: Déclencher le déploiement automatique

Une fois tous les secrets configurés, déclenchez le déploiement:

```bash
# Récupérez les changements
git pull origin setup/auto-deploy

# Fusionnez la branche (optionnel)
git checkout main
git merge setup/auto-deploy

# Ou, poussez directement sur main
git push origin setup/auto-deploy:main
```

Allez sur: https://github.com/kamoainf/controlscada/actions

Vous verrez les 2 workflows se déclencher automatiquement:
- 🟡 **Deploy to Railway** - En cours...
- 🟡 **Deploy to Cloudflare Pages** - En cours...

Attendez ~5-10 minutes.

---

## ✨ C'EST FAIT!

À partir de maintenant:
- 📤 Chaque `git push` sur `main` déclenche les déploiements
- 🚀 Railway redéploie le backend automatiquement
- 🌐 Cloudflare redéploie le frontend automatiquement
- ⚡ Déploiement complet en ~5-10 minutes

**Vous n'avez plus rien à faire!** 🎉

---

## 🔗 Vérifier le déploiement

### Vérifier Railway:
```bash
curl https://controlscada-api.up.railway.app/api/health
```

Réponse attendue:
```json
{
  "status": "online",
  "version": "1.0.0",
  "app": "KAMOA Control SCADA"
}
```

### Vérifier Cloudflare:
Ouvrez: `https://controlscada.pages.dev`

---

## ❓ Dépannage

### Les workflows ne se déclenchent pas?
- Vérifiez que les Secrets sont bien configurés
- Attendez ~5 minutes après avoir créé les secrets
- Relancez manuellement depuis l'onglet Actions

### Erreur "Permission denied"?
- Vérifiez que le repo est **public**
- Vérifiez vos tokens (valides et non expirés)

### Le déploiement échoue?
- Allez sur: https://github.com/kamoainf/controlscada/actions
- Cliquez sur le workflow qui a échoué
- Consultez les logs pour l'erreur

---

**Status**: ✅ Déploiement automatique prêt!  
**Prochaines étapes**: Configurer les Secrets GitHub + Variables Railway/Cloudflare
