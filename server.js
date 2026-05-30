/**
 * KAMOA Control SCADA — server.js
 * WhatsApp BAILEYS intégré directement (pas besoin d'Evolution API)
 * Frontend : https://controlscada.pages.dev/
 * Backend  : https://controlscada-production.up.railway.app/
 */

// ── Polyfill crypto global (requis par Baileys sur Node.js < 19) ───────────────
const crypto = require('crypto');
if (!globalThis.crypto) {
    globalThis.crypto = crypto.webcrypto || crypto;
}

const { createRequire } = require('node:module');
const req = createRequire(__filename);

const express     = require('express');
const cors        = require('cors');
const bodyParser  = require('body-parser');
const compression = require('compression');
const http        = require('http');
const { WebSocketServer } = require('ws');
const path        = require('path');
const fs          = require('fs');
require('dotenv').config();

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });
const PORT   = process.env.PORT || 8080;

// ── État global WhatsApp ───────────────────────────────────────────────────────
let waSocket     = null;
let waStatus     = 'disconnected';
let waQrBase64   = null;
let waConnNumber = null;
let waConnected  = false;
let waInitialized = false;

// ── Broadcast WebSocket ────────────────────────────────────────────────────────
function broadcast(obj) {
    const msg = JSON.stringify(obj);
    wss.clients.forEach(ws => {
        if (ws.readyState === 1) ws.send(msg);
    });
}

// ── Dossier auth (persist session entre redémarrages) ─────────────────────────
const AUTH_DIR = path.join('/tmp', 'kamoa_auth');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// ── Initialiser Baileys (version robuste avec createRequire) ───────────────────
async function initWhatsApp() {
    if (waInitialized) return;
    waInitialized = true;

    try {
        const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = 
            req('@whiskeysockets/baileys');

        let version;
        if (fetchLatestBaileysVersion) {
            const v = await fetchLatestBaileysVersion();
            version = v.version;
        } else {
            version = [2, 3000, 1035194821];
        }

        console.log('📱 Baileys version:', version.join('.'));

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        // Options de connexion renforcées
        waSocket = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            browser: ['KAMOA SCADA', 'Chrome', '1.0'],
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 5000,
            defaultQueryTimeoutMs: 60000,
            patchMessageBeforeSending: (msg) => msg,
            shouldSyncHistoryMessage: () => false,
            markOnlineOnConnect: false,
            fireInitQueries: false,
            getMessage: async () => undefined,
        });

        // ── Événements avec logs détaillés ─────────────────────────────────────
        waSocket.ev.on('connection.update', async (update) => {
            console.log('📡 connection.update reçu:', Object.keys(update));
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('📲 QR Code string reçu (longueur:', qr.length, ')');
                try {
                    const QRCode = require('qrcode');
                    const qrBase64 = await QRCode.toDataURL(qr, {
                        width: 300,
                        margin: 2,
                        color: { dark: '#000000', light: '#ffffff' }
                    });
                    waQrBase64 = qrBase64;
                    waStatus = 'connecting';
                    broadcast({ type: 'qr', qr: qrBase64 });
                    broadcast({ type: 'status', status: 'connecting' });
                    console.log('📲 QR Code généré et diffusé');
                } catch (e) {
                    console.error('QR gen error:', e.message);
                }
            }

            if (connection === 'open') {
                waStatus = 'open';
                waConnected = true;
                waQrBase64 = null;
                waConnNumber = waSocket.user?.id?.split(':')[0] || waSocket.user?.id || '';
                broadcast({ type: 'status', status: 'open', phone: waConnNumber });
                console.log('✅ WhatsApp connecté:', waConnNumber);
            }

            if (connection === 'close') {
                waConnected = false;
                waStatus = 'disconnected';
                broadcast({ type: 'status', status: 'disconnected' });
                const code = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = code !== DisconnectReason.loggedOut;
                console.log('🔴 Connexion fermée, code:', code, '— reconnect:', shouldReconnect);
                if (shouldReconnect) {
                    waInitialized = false;
                    setTimeout(initWhatsApp, 5000);
                } else {
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    fs.mkdirSync(AUTH_DIR, { recursive: true });
                    waInitialized = false;
                    setTimeout(initWhatsApp, 2000);
                }
            }
        });

        waSocket.ev.on('creds.update', saveCreds);

        waSocket.ev.on('messages.upsert', ({ messages }) => {
            messages.forEach(msg => {
                if (!msg.message) return;
                const body = msg.message?.conversation
                    || msg.message?.extendedTextMessage?.text
                    || '';
                const from = msg.key.remoteJid || '';
                broadcast({
                    type: 'message',
                    data: { from, body, fromMe: msg.key.fromMe, ts: msg.messageTimestamp }
                });
            });
        });

        waSocket.ev.on('connection.error', (err) => {
            console.error('❌ connection.error Baileys:', err);
        });

    } catch (err) {
        console.error('❌ Baileys init error:', err.message, err.stack);
        waInitialized = false;
        setTimeout(initWhatsApp, 8000);
    }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(compression());
app.use(cors({
    origin: [
        'https://controlscada.pages.dev',
        'https://controlscada-production.up.railway.app',
        'http://localhost:3000',
        'http://localhost:8080',
        '*'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));
app.options('*', cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('./'));

// ── WebSocket : envoyer état courant aux nouveaux clients ──────────────────────
wss.on('connection', (ws) => {
    console.log('🔌 WS client connecté');
    ws.send(JSON.stringify({ type: 'status', status: waStatus, phone: waConnNumber }));
    if (waQrBase64 && waStatus === 'connecting') {
        ws.send(JSON.stringify({ type: 'qr', qr: waQrBase64 }));
    }
    ws.on('error', () => {});
});

// ── API Routes ────────────────────────────────────────────────────────────────

// Health
app.get('/api/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date(),
        app: 'KAMOA SCADA',
        whatsapp: { status: waStatus, phone: waConnNumber, connected: waConnected }
    });
});

// Init / démarrer QR
app.post('/api/whatsapp/init', async (req, res) => {
    try {
        if (waConnected) {
            return res.json({ success: true, status: 'open', phone: waConnNumber, message: 'Déjà connecté' });
        }
        waInitialized = false;
        initWhatsApp();
        res.json({ success: true, message: 'Initialisation Baileys démarrée', status: waStatus });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Statut
app.get('/api/whatsapp/status', (req, res) => {
    res.json({ success: true, status: waStatus, phone: waConnNumber, connected: waConnected });
});

// QR Code (fallback REST)
app.get('/api/whatsapp/qrcode', (req, res) => {
    if (waConnected) return res.json({ success: true, status: 'open', phone: waConnNumber });
    if (!waQrBase64) return res.status(404).json({ error: 'QR pas encore prêt — réessayez dans 3s' });
    res.json({ success: true, qrCode: waQrBase64 });
});

// Envoyer message
app.post('/api/whatsapp/send', async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'Champs requis: to, message' });
    if (!waConnected || !waSocket) return res.status(503).json({ error: 'WhatsApp non connecté' });

    try {
        const jid = to.replace(/\D/g, '') + '@s.whatsapp.net';
        await waSocket.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Logout / Reset session
app.post('/api/whatsapp/logout', async (req, res) => {
    try {
        if (waSocket) await waSocket.logout().catch(() => {});
        waSocket = null; waConnected = false; waStatus = 'disconnected';
        waQrBase64 = null; waConnNumber = null; waInitialized = false;
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        broadcast({ type: 'status', status: 'disconnected' });
        setTimeout(initWhatsApp, 1000);
        res.json({ success: true, message: 'Session réinitialisée, nouveau QR en cours...' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Récupérer groupes/contacts
app.get('/api/whatsapp/chats', async (req, res) => {
    if (!waConnected || !waSocket) return res.status(503).json({ error: 'WhatsApp non connecté' });
    try {
        const groups = await waSocket.groupFetchAllParticipating();
        const chats = Object.entries(groups).map(([id, g]) => ({
            id, name: g.subject || id, isGroup: true, participants: g.participants?.length || 0
        }));
        res.json({ success: true, chats });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Fallback
app.get('/', (req, res) => {
    const f = path.join(__dirname, 'index.html');
    if (fs.existsSync(f)) return res.sendFile(f);
    res.json({ status: 'KAMOA SCADA API online', whatsapp: waStatus });
});
app.use((req, res) => res.status(404).json({ error: 'Route introuvable' }));

// ── Démarrage ─────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║  🚀 KAMOA Control SCADA — Railway                ║
║  📱 WhatsApp Baileys intégré (QR natif)          ║
║  🌐 https://controlscada-production.up.railway.app ║
║  🌐 Port: ${PORT}                                   ║
╚══════════════════════════════════════════════════╝`);
    setTimeout(initWhatsApp, 2000);
});

module.exports = app;