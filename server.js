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
let waSocket     = null;   // instance Baileys
let waStatus     = 'disconnected';
let waQrBase64   = null;
let waConnNumber = null;
let waConnected  = false;
let waInitialized = false;

// ── Caches chats / messages / médias ──────────────────────────────────────────
let cachedChats    = [];
let cachedMessages = [];
const mediaMessages = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────
function toJid(number) {
    return String(number).replace(/\D/g, '') + '@s.whatsapp.net';
}

function toGroupJid(id) {
    return String(id).includes('@g.us') ? String(id) : String(id) + '@g.us';
}

function withTimeout(promise, ms, label = 'operation') {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms);
        promise.then(
            val => { clearTimeout(timer); resolve(val); },
            err => { clearTimeout(timer); reject(err); }
        );
    });
}

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

// ── Initialiser Baileys ───────────────────────────────────────────────────────
async function initWhatsApp() {
    if (waInitialized) return;
    waInitialized = true;

    try {
        // Import dynamique (Baileys = ESM)
        const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = 
            await import('@whiskeysockets/baileys');
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        console.log('📱 Baileys version:', version.join('.'));

        waSocket = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            browser: ['KAMOA SCADA', 'Chrome', '1.0'],
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
        });

        // ── Événement : QR Code ───────────────────────────────────────────────
        waSocket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                // Convertir QR string en image base64 via qrcode lib
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
                    // Logged out — supprimer la session
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    fs.mkdirSync(AUTH_DIR, { recursive: true });
                    waInitialized = false;
                    setTimeout(initWhatsApp, 2000);
                }
            }
        });

        // ── Sauvegarder credentials ───────────────────────────────────────────
        waSocket.ev.on('creds.update', saveCreds);

        // ── Mise à jour liste des chats ──────────────────────────────────────
        waSocket.ev.on('chats.upsert', (newChats) => {
            newChats.forEach(chat => {
                const idx = cachedChats.findIndex(c => c.id === chat.id);
                const chatObj = { id: chat.id, name: chat.name || chat.id, isGroup: chat.id.endsWith('@g.us'),
                    unreadCount: chat.unreadCount || 0, timestamp: chat.conversationTimestamp || Math.floor(Date.now()/1000), lastMessage: '', picture: null };
                if (idx >= 0) cachedChats[idx] = { ...cachedChats[idx], ...chatObj };
                else cachedChats.push(chatObj);
            });
            cachedChats.sort((a,b) => (b.timestamp||0)-(a.timestamp||0));
        });

        waSocket.ev.on('chats.update', (updates) => {
            updates.forEach(update => {
                const idx = cachedChats.findIndex(c => c.id === update.id);
                if (idx >= 0) {
                    if (update.unreadCount !== undefined) cachedChats[idx].unreadCount = update.unreadCount;
                    if (update.conversationTimestamp) cachedChats[idx].timestamp = update.conversationTimestamp;
                }
            });
        });

        // ── Messages entrants ─────────────────────────────────────────────────
        waSocket.ev.on('messages.upsert', ({ messages, type }) => {
            messages.forEach(msg => {
                if (!msg.message) return;
                const msgType   = Object.keys(msg.message)[0];
                const chatId    = msg.key.remoteJid || '';
                const msgId     = msg.key.id || '';
                const fromMe    = msg.key.fromMe || false;
                const timestamp = Number(msg.messageTimestamp) || Math.floor(Date.now()/1000);
                const pushName  = msg.pushName || '';
                const isGroup   = chatId.endsWith('@g.us');
                const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text
                    || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption
                    || msg.message?.documentMessage?.caption || '';
                const mediaTypes = ['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage','pttMessage'];
                const hasMedia   = mediaTypes.includes(msgType);
                const mediaType  = hasMedia ? msgType.replace('Message','') : null;
                const fileName   = msg.message?.documentMessage?.fileName || null;
                const mimeType   = msg.message?.[msgType]?.mimetype || null;
                if (hasMedia) mediaMessages.set(msgId, msg);
                const msgObj = { id: msgId, chatId, from: fromMe ? 'me' : chatId, fromMe, body,
                    timestamp, pushName, isGroup, hasMedia, mediaType, fileName, mimeType };
                cachedMessages.push(msgObj);
                if (cachedMessages.length > 2000) cachedMessages.shift();
                const chatIdx = cachedChats.findIndex(c => c.id === chatId);
                if (chatIdx >= 0) {
                    cachedChats[chatIdx].lastMessage = body || (hasMedia ? '['+mediaType+']' : '');
                    cachedChats[chatIdx].timestamp   = timestamp;
                    if (!fromMe) cachedChats[chatIdx].unreadCount = (cachedChats[chatIdx].unreadCount||0)+1;
                } else {
                    cachedChats.unshift({ id: chatId, name: pushName || chatId, isGroup,
                        unreadCount: fromMe ? 0 : 1, timestamp,
                        lastMessage: body || (hasMedia ? '['+mediaType+']' : ''), picture: null });
                }
                cachedChats.sort((a,b) => (b.timestamp||0)-(a.timestamp||0));
                broadcast({ type: 'message', data: msgObj });
            });
        });

    } catch (err) {
        console.error('❌ Baileys init error:', err.message);
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

// ── Supprimer une conversation ────────────────────────────────────────────────
app.delete('/api/whatsapp/chat/:chatId', async (req, res) => {
    if (!waConnected || !waSocket) {
        return res.status(503).json({ success: false, error: 'WhatsApp non connecté', status: waStatus });
    }
    try {
        const chatId = decodeURIComponent(req.params.chatId);

        // Trouver le dernier message de ce chat pour Baileys
        const msgs = cachedMessages
            .filter(m => m.chatId === chatId)
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        const lastMessages = msgs.slice(0, 1).map(m => ({
            key: { id: m.id, remoteJid: chatId, fromMe: m.fromMe ?? false },
            messageTimestamp: m.timestamp || Math.floor(Date.now() / 1000),
        }));

        // Suppression via Baileys chatModify
        await withTimeout(
            waSocket.chatModify({ delete: true, lastMessages }, chatId),
            15_000, 'deleteChat'
        );

        // Mettre à jour les caches locaux
        cachedChats    = cachedChats.filter(c => c.id !== chatId);
        cachedMessages = cachedMessages.filter(m => m.chatId !== chatId);

        // Supprimer les médias associés
        for (const [msgId, msg] of mediaMessages.entries()) {
            if ((msg.key?.remoteJid ?? '') === chatId) mediaMessages.delete(msgId);
        }

        broadcast({ type: 'chat_deleted', chatId });
        console.log(`🗑️  Chat supprimé : ${chatId}`);
        res.json({ success: true, chatId, message: 'Conversation supprimée' });
    } catch (err) {
        console.error('❌ Erreur suppression chat:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Envoyer un média depuis le navigateur (base64) ────────────────────────────
// Utilisé quand l'utilisateur sélectionne un fichier local dans l'interface
app.post('/api/whatsapp/send-media-base64', async (req, res) => {
    const { to, base64, mimetype, caption = '', filename = 'fichier' } = req.body;

    if (!to || !base64 || !mimetype) {
        return res.status(400).json({ error: 'Champs requis : to, base64, mimetype' });
    }
    if (!waConnected || !waSocket) {
        return res.status(503).json({ error: 'WhatsApp non connecté', status: waStatus });
    }

    try {
        const jid    = String(to).includes('@g.us') ? toGroupJid(to) : toJid(to);
        const buffer = Buffer.from(base64, 'base64');

        let msgContent;
        if (mimetype.startsWith('image/')) {
            msgContent = { image: buffer, caption, mimetype };
        } else if (mimetype.startsWith('video/')) {
            msgContent = { video: buffer, caption, mimetype };
        } else if (mimetype.startsWith('audio/')) {
            msgContent = { audio: buffer, mimetype, ptt: false };
        } else {
            msgContent = { document: buffer, mimetype, fileName: filename, caption };
        }

        const result    = await withTimeout(waSocket.sendMessage(jid, msgContent), 45_000, 'sendMediaBase64');
        const messageId = result?.key?.id ?? 'sent';
        console.log(`✅ Média base64 (${mimetype}) envoyé à ${to} — id: ${messageId}`);
        res.json({ success: true, messageId, status: 'sent', mimetype });
    } catch (err) {
        console.error(`❌ Erreur envoi média base64 à ${to}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Récupérer les messages d'un chat ─────────────────────────────────────────
app.get('/api/whatsapp/messages', async (req, res) => {
    if (!waConnected || !waSocket)
        return res.status(503).json({ error: 'WhatsApp non connecté', status: waStatus });
    const chatId = req.query.chatId;
    const limit  = parseInt(req.query.limit) || 50;
    if (!chatId) return res.status(400).json({ error: 'chatId requis' });
    try {
        let msgs = cachedMessages.filter(m => m.chatId === chatId).slice(-limit);
        // Marquer comme lu
        const ci = cachedChats.findIndex(c => c.id === chatId);
        if (ci >= 0) cachedChats[ci].unreadCount = 0;
        res.json({ success: true, messages: msgs, count: msgs.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Récupérer un média par messageId ──────────────────────────────────────────
app.get('/api/whatsapp/media/:msgId', async (req, res) => {
    if (!waConnected || !waSocket)
        return res.status(503).json({ error: 'WhatsApp non connecté' });
    const msgId = decodeURIComponent(req.params.msgId);
    try {
        const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
        const rawMsg = mediaMessages.get(msgId);
        if (!rawMsg)
            return res.status(404).json({ success: false, error: 'Message média introuvable (peut être expiré)' });
        const buffer   = await withTimeout(downloadMediaMessage(rawMsg, 'buffer', {}), 30_000, 'downloadMedia');
        const msgType  = Object.keys(rawMsg.message)[0];
        const mimetype = rawMsg.message?.[msgType]?.mimetype || 'application/octet-stream';
        const fileName = rawMsg.message?.documentMessage?.fileName || null;
        res.json({ success: true, data: buffer.toString('base64'), mimetype, fileName });
    } catch (err) {
        console.error('❌ Erreur média:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Envoyer à un groupe ───────────────────────────────────────────────────────
app.post('/api/whatsapp/send-group', async (req, res) => {
    const { groupId, message } = req.body;
    if (!groupId || !message) return res.status(400).json({ error: 'Champs requis: groupId, message' });
    if (!waConnected || !waSocket) return res.status(503).json({ error: 'WhatsApp non connecté' });
    try {
        const result = await waSocket.sendMessage(toGroupJid(groupId), { text: message });
        res.json({ success: true, messageId: result?.key?.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Photo de profil ───────────────────────────────────────────────────────────
app.get('/api/whatsapp/profile-picture', async (req, res) => {
    if (!waConnected || !waSocket) return res.status(503).json({ error: 'Non connecté' });
    try {
        const url = await waSocket.profilePictureUrl(req.query.jid, 'image');
        res.json({ success: true, url });
    } catch(e) { res.json({ success: false, url: null }); }
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
    // Démarrer WhatsApp automatiquement
    setTimeout(initWhatsApp, 2000);
});

module.exports = app;
