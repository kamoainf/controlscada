/**
 * KAMOA Control SCADA — Backend Railway
 * WhatsApp via Evolution API + QR Code WebSocket push
 * Frontend: https://controlscada.pages.dev/
 */

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const compression = require('compression');
const http       = require('http');
const { WebSocketServer } = require('ws');
require('dotenv').config();

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });
const PORT   = process.env.PORT || 8080;

// ── Variables d'état globales ─────────────────────────────────────────────────
let waStatus      = 'disconnected';  // disconnected | connecting | open
let waQrBase64    = null;
let waQrInterval  = null;
let waConnNumber  = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function getEvolutionConfig() {
    return {
        apiKey:       process.env.EVOLUTION_API_KEY  || process.env.WHATSAPP_API_KEY,
        apiBaseUrl:   process.env.EVOLUTION_BASE_URL || process.env.WHATSAPP_API_BASE_URL,
        instanceName: process.env.INSTANCE_NAME      || 'kamoa-instance-1'
    };
}

function evolutionHeaders(apiKey) {
    return { 'Content-Type': 'application/json', 'apikey': apiKey };
}

// Broadcast un objet JSON à tous les clients WebSocket connectés
function broadcast(obj) {
    const msg = JSON.stringify(obj);
    wss.clients.forEach(ws => {
        if (ws.readyState === 1) ws.send(msg);
    });
}

// Appel fetch vers Evolution API (Node 18+ built-in fetch)
async function evolutionFetch(method, path, body = null) {
    const { apiKey, apiBaseUrl } = getEvolutionConfig();
    if (!apiKey || !apiBaseUrl) throw new Error('Evolution API non configurée (variables .env manquantes)');

    const opts = {
        method,
        headers: evolutionHeaders(apiKey)
    };
    if (body) opts.body = JSON.stringify(body);

    const res  = await fetch(`${apiBaseUrl}${path}`, opts);
    const json = await res.json().catch(() => ({}));

    if (!res.ok) throw Object.assign(new Error(json.message || res.statusText), { status: res.status, body: json });
    return json;
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(compression());
app.use(cors({
    origin: [
        'https://controlscada.pages.dev',
        'http://localhost:3000',
        'http://localhost:8080'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'apikey']
}));
app.options('*', cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('./'));

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
    console.log('🔌 WS client connecté');
    // Envoyer l'état courant immédiatement
    ws.send(JSON.stringify({ type: 'status', status: waStatus, phone: waConnNumber }));
    if (waQrBase64 && waStatus !== 'open') {
        ws.send(JSON.stringify({ type: 'qr', qr: waQrBase64 }));
    }
});

// ── Polling QR / Statut ───────────────────────────────────────────────────────
async function pollConnectionStatus() {
    const { instanceName } = getEvolutionConfig();
    try {
        const data = await evolutionFetch('GET', `/instance/connectionState/${instanceName}`);
        const state = data?.instance?.state || data?.state || 'disconnected';

        if (state !== waStatus) {
            waStatus = state;
            broadcast({ type: 'status', status: waStatus, phone: waConnNumber });
            console.log(`📡 WA State → ${waStatus}`);
        }

        if (state === 'open') {
            // Connecté : arrêter le polling QR
            waQrBase64 = null;
            stopQrPolling();
        } else if (state === 'connecting' || state === 'disconnected') {
            await fetchAndBroadcastQR();
        }
    } catch (err) {
        console.warn('⚠️ pollConnectionStatus:', err.message);
    }
}

async function fetchAndBroadcastQR() {
    const { instanceName } = getEvolutionConfig();
    try {
        const data = await evolutionFetch('GET', `/instance/connect/${instanceName}`);
        const qr = data?.base64 || data?.qrcode?.base64 || data?.qr;
        if (qr && qr !== waQrBase64) {
            waQrBase64 = qr;
            broadcast({ type: 'qr', qr });
            console.log('📲 Nouveau QR Code diffusé');
        }
    } catch (err) {
        console.warn('⚠️ fetchAndBroadcastQR:', err.message);
    }
}

function startQrPolling() {
    if (waQrInterval) return;
    waQrInterval = setInterval(pollConnectionStatus, 8000);
    pollConnectionStatus(); // Appel immédiat
    console.log('🔄 QR Polling démarré');
}

function stopQrPolling() {
    if (waQrInterval) { clearInterval(waQrInterval); waQrInterval = null; }
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({ status: 'online', timestamp: new Date(), app: 'KAMOA SCADA', waStatus });
});

// ── WhatsApp : Initialiser l'instance + démarrer QR polling ──────────────────
app.post('/api/whatsapp/init', async (req, res) => {
    const { instanceName } = getEvolutionConfig();
    try {
        // Vérifier si l'instance existe déjà
        let instanceReady = false;
        try {
            const info = await evolutionFetch('GET', `/instance/fetchInstances`);
            const instances = Array.isArray(info) ? info : info?.instances || [];
            instanceReady = instances.some(i => i.instance?.instanceName === instanceName || i.instanceName === instanceName);
        } catch (_) {}

        if (!instanceReady) {
            console.log('📱 Création instance Evolution...');
            await evolutionFetch('POST', '/instance/create', {
                instanceName,
                integration: 'WHATSAPP-BAILEYS',
                qrcode: true
            });
        }

        startQrPolling();
        res.json({ success: true, message: 'Instance initialisée, QR polling actif', instanceName });
    } catch (err) {
        console.error('❌ Init error:', err.message);
        res.status(500).json({ error: err.message, detail: err.body });
    }
});

// ── WhatsApp : Obtenir QR Code (REST fallback si pas de WS) ──────────────────
app.get('/api/whatsapp/qrcode', async (req, res) => {
    const { instanceName } = getEvolutionConfig();
    try {
        const data = await evolutionFetch('GET', `/instance/connect/${instanceName}`);
        const qr   = data?.base64 || data?.qrcode?.base64 || data?.qr;
        if (!qr) return res.status(404).json({ error: 'Pas de QR code disponible', detail: data });
        res.json({ success: true, qrCode: qr });
    } catch (err) {
        res.status(500).json({ error: err.message, detail: err.body });
    }
});

// ── WhatsApp : Statut connexion ───────────────────────────────────────────────
app.get('/api/whatsapp/status', async (req, res) => {
    const { instanceName } = getEvolutionConfig();
    try {
        const data  = await evolutionFetch('GET', `/instance/connectionState/${instanceName}`);
        const state = data?.instance?.state || data?.state || 'disconnected';
        waStatus    = state;
        res.json({ success: true, status: state, phone: waConnNumber });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── WhatsApp : Envoyer message texte ─────────────────────────────────────────
app.post('/api/whatsapp/send', async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'Champs manquants: to, message' });

    const { instanceName } = getEvolutionConfig();
    const number = to.replace(/\D/g, '');

    try {
        const data = await evolutionFetch('POST', `/message/sendText/${instanceName}`, {
            number,
            text: message
        });
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ error: err.message, detail: err.body });
    }
});

// ── WhatsApp : Déconnecter / Logout ──────────────────────────────────────────
app.post('/api/whatsapp/logout', async (req, res) => {
    const { instanceName } = getEvolutionConfig();
    stopQrPolling();
    waStatus = 'disconnected'; waQrBase64 = null; waConnNumber = null;
    try {
        await evolutionFetch('DELETE', `/instance/logout/${instanceName}`);
        broadcast({ type: 'status', status: 'disconnected' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── WhatsApp : Webhook Evolution API ─────────────────────────────────────────
app.post('/api/webhooks/whatsapp', (req, res) => {
    const data  = req.body;
    const event = data?.event || data?.type;
    console.log(`📨 Webhook [${event}]`);

    if (event === 'connection.update') {
        const state = data?.data?.state || data?.state;
        if (state) {
            waStatus = state;
            if (state === 'open') waConnNumber = data?.data?.wuid || null;
            broadcast({ type: 'status', status: waStatus, phone: waConnNumber });
            if (state === 'open') stopQrPolling();
        }
        // QR dans le webhook
        const qr = data?.data?.qrcode?.base64 || data?.qr;
        if (qr) {
            waQrBase64 = qr;
            broadcast({ type: 'qr', qr });
        }
    } else if (event === 'messages.upsert' || event === 'messages.set') {
        broadcast({ type: 'message', data });
    }

    res.json({ received: true });
});

// ── Config runtime (optionnel, pour mise à jour sans redéploiement) ───────────
app.post('/api/whatsapp/config', (req, res) => {
    const { apiKey, apiBaseUrl, instanceName } = req.body;
    if (apiKey)       process.env.EVOLUTION_API_KEY  = apiKey;
    if (apiBaseUrl)   process.env.EVOLUTION_BASE_URL = apiBaseUrl;
    if (instanceName) process.env.INSTANCE_NAME      = instanceName;
    res.json({ success: true });
});

// ── Fallback HTML ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});
app.use((req, res) => res.status(404).json({ error: 'Route introuvable' }));

// ── Démarrage ─────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════╗
║  🚀 KAMOA Control SCADA — Railway          ║
║  📱 Evolution API + WebSocket QR Push      ║
║  🌐 Port ${PORT}                              ║
╚════════════════════════════════════════════╝
Variables requises dans Railway:
  EVOLUTION_API_KEY   = votre clé Evolution API
  EVOLUTION_BASE_URL  = https://votre-evolution.railway.app
  INSTANCE_NAME       = kamoa-instance-1 (ou votre nom)
    `);

    // Démarrer le polling automatiquement si les variables sont présentes
    const { apiKey, apiBaseUrl } = getEvolutionConfig();
    if (apiKey && apiBaseUrl) {
        setTimeout(startQrPolling, 3000);
    } else {
        console.warn('⚠️  EVOLUTION_API_KEY / EVOLUTION_BASE_URL non définis — polling désactivé');
    }
});

module.exports = app;
