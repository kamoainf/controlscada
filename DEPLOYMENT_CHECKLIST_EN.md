# KAMOA Control SCADA - Deployment Checklist

## ✅ Pre-deployment

### GitHub
- [x] Repository created: `kamoainf/controlscada`
- [x] All files pushed
- [x] Main branch: `main`

### Essential files
- [x] `package.json` - Node dependencies
- [x] `src/server.js` - Express backend
- [x] `index.html` - Frontend
- [x] `whatsapp-integration.js` - WhatsApp module
- [x] `railway.json` - Railway config
- [x] `wrangler.toml` - Cloudflare config
- [x] `Dockerfile` - Containerization
- [x] `docker-compose.yml` - Local development

---

## 🚀 Step 1: Deploy on Railway

### Actions:
1. Go to [railway.app](https://railway.app)
2. Create new project
3. Connect your GitHub account
4. Select `kamoainf/controlscada`
5. Railway will automatically detect:
   - ✅ `package.json`
   - ✅ `railway.json`
   - ✅ `Dockerfile`

### Add environment variables:

| Variable | Value | Description |
|----------|-------|-------------|
| `WHATSAPP_API_KEY` | `your_evolution_api_key` | Evolution API access key |
| `WHATSAPP_API_BASE_URL` | `https://your-evolution.railway.app/api` | Your Evolution API URL |
| `INSTANCE_NAME` | `kamoa-instance-1` | WhatsApp instance name |
| `NODE_ENV` | `production` | Environment |
| `PORT` | `8080` | Port (Railway will assign) |

### Verify deployment:

Once deployed, you'll see:
- ✅ Domain: `https://controlscada-api.up.railway.app` (or similar)
- ✅ Build logs: Check for errors
- ✅ Real-time logs

Test the API:
```bash
curl https://your-railway-url.up.railway.app/api/health
```

**Response:**
```json
{
  "status": "online",
  "timestamp": "2026-05-29T...",
  "version": "1.0.0",
  "app": "KAMOA Control SCADA"
}
```

---

## 🌐 Step 2: Deploy on Cloudflare Pages

### Actions:
1. Go to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Pages → Create a project → Connect to Git
3. Select `kamoainf/controlscada`
4. Build settings:
   - Build command: *(leave empty)*
   - Build output directory: `/`
   - Root directory: `/`

### Add environment variables:

| Variable | Value |
|----------|-------|
| `VITE_API_URL` | Your Railway URL |

### Verify deployment:

Once deployed, you'll see:
- ✅ Domain: `https://controlscada.pages.dev` (or your domain)
- ✅ Site publicly accessible
- ✅ Automatic deployments on each push

---

## 🔗 Step 3: Connect Frontend ↔ Backend

### Update configuration:

Edit `src/cloudflare-integration.js`:

```javascript
// Line ~8 - Replace:
const API_URL = 'https://your-railway-url.up.railway.app';
// With your actual Railway URL
```

Or update in `index.html` before `</body>`:

```html
<script>
  window.API_BASE_URL = 'https://your-railway-url.up.railway.app/api';
</script>
```

---

## ✨ Step 4: Configure WhatsApp

### Actions in your app:

1. Go to: `https://controlscada.pages.dev`
2. Find "WhatsApp Configuration" button/modal
3. Fill in:
   - API Key
   - API URL (Railway)
   - Instance Name
4. Click "Validate"

### Authenticate WhatsApp:

1. Click "Connect WhatsApp"
2. A QR Code will appear
3. Scan it with your phone
4. Confirm access
5. ✅ Connected!

---

## 🧪 Step 5: Testing

### Manual tests:

```bash
# 1. Health check test
curl https://your-railway.up.railway.app/api/health

# 2. WhatsApp status
curl -H "x-api-key: YOUR_KEY" \
     https://your-railway.up.railway.app/api/whatsapp/qrcode

# 3. Send test message
curl -X POST \
  https://your-railway.up.railway.app/api/whatsapp/send \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+243xxxxxxxxx",
    "message": "Test from KAMOA"
  }'
```

### UI tests:

- [ ] Page loads correctly
- [ ] QR Code appears
- [ ] WhatsApp can connect
- [ ] Messages can be sent
- [ ] Received messages display

---

## 📊 Monitoring

### Railway Dashboard:
- Check logs
- Monitor CPU/Memory usage
- Watch for errors

### Cloudflare Analytics:
- Check page views
- Monitor errors
- Analyze traffic

---

## 🔴 Troubleshooting

### Railway won't start
```bash
# Check logs
railway logs

# Check env variables
railway variables
```

### CORS error
- Verify that `src/server.js` accepts Cloudflare domain
- Update `cors()` configuration

### WhatsApp not responding
- Check API key
- Check Evolution API URL
- Verify QR hasn't expired

### Cloudflare Pages not updating
- Check deployment logs
- Force refresh (Ctrl+F5)
- Clear Cloudflare cache

---

## 📞 Important URLs

| Service | URL |
|---------|-----|
| GitHub | https://github.com/kamoainf/controlscada |
| Railway Dashboard | https://railway.app/dashboard |
| Cloudflare Dashboard | https://dash.cloudflare.com |
| Application Frontend | https://controlscada.pages.dev |
| Backend API | https://your-railway.up.railway.app |

---

## ✅ Final Checklist

- [ ] Railway deployed and working
- [ ] Cloudflare Pages deployed and accessible
- [ ] Frontend ↔ Backend connected
- [ ] WhatsApp authenticated
- [ ] Messages can be sent
- [ ] Received messages display
- [ ] Logs monitored
- [ ] Domain configured (optional)
- [ ] SSL/TLS configured (optional)

---

**Status**: Ready for deployment  
**Date**: 2026-05-29  
**Maintainer**: kamoainf
