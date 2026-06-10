/**
 * KAMOA Control SCADA — server.js  v3.0
 * WhatsApp via Baileys (@whiskeysockets/baileys) — léger, sans navigateur.
 * WebSocket natif (ws) pour les notifications temps réel.
 *
 * Frontend : https://controlscada.pages.dev/
 * Backend  : https://controlscada-production.up.railway.app/
 */

'use strict';

// ── Polyfill crypto (requis par Baileys sur Node < 19) ────────────────────────
const crypto = require('crypto');
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto ?? crypto;

// ── Imports ───────────────────────────────────────────────────────────────────
const express     = require('express');
const cors        = require('cors');
const bodyParser  = require('body-parser');
const compression = require('compression');
const http        = require('http');
const { WebSocketServer } = require('ws');
const path        = require('path');
const fs          = require('fs');
const QRCode      = require('qrcode');
require('dotenv').config();

// ── App & HTTP server ─────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });
const PORT   = process.env.PORT || 8080;

// ── État global WhatsApp ──────────────────────────────────────────────────────
let waSocket      = null;   // instance Baileys active
let waStatus      = 'disconnected';
let waQrBase64    = null;
let waConnNumber  = null;
let waConnected   = false;
let waInitialized = false;

// Cache en mémoire (mis à jour par les événements Baileys)
let cachedChats    = [];   // { id, name, isGroup, unreadCount, lastMessage, timestamp }
let cachedContacts = {};   // jid → { id, name, notify, pushName }
let cachedGroups   = {};   // jid → metadata complète
let cachedMessages = [];   // messages récents normalisés
let mediaMessages  = new Map(); // messageId → message Baileys original pour téléchargement média
let downloadMediaMessageFn = null;

// ── Dossier de session (persisté dans /tmp sur Railway) ───────────────────────
const AUTH_DIR = path.join('/tmp', 'kamoa_auth');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// WEBSOCKET — broadcast à tous les clients connectés
// ─────────────────────────────────────────────────────────────────────────────
function broadcast(obj) {
    const msg = JSON.stringify(obj);
    wss.clients.forEach(ws => {
        if (ws.readyState === 1 /* OPEN */) ws.send(msg);
    });
}

wss.on('connection', (ws) => {
    console.log('🔌 WS client connecté');
    // Envoyer l'état courant au nouveau client
    ws.send(JSON.stringify({ type: 'status', status: waStatus, phone: waConnNumber }));
    if (waQrBase64 && waStatus === 'connecting') {
        ws.send(JSON.stringify({ type: 'qr', qr: waQrBase64 }));
    }
    ws.on('error', () => {});
    ws.on('close', () => console.log('🔌 WS client déconnecté'));
});

// ─────────────────────────────────────────────────────────────────────────────
// BAILEYS — initialisation et gestion des événements
// ─────────────────────────────────────────────────────────────────────────────
async function initWhatsApp() {
    if (waInitialized) return;
    waInitialized = true;

    console.log('📱 Démarrage Baileys...');

    try {
        // Baileys est un module ESM — import dynamique depuis un projet CommonJS
        const {
            default: makeWASocket,
            useMultiFileAuthState,
            DisconnectReason,
            fetchLatestBaileysVersion,
            isJidGroup,
            jidNormalizedUser,
            downloadMediaMessage,
        } = await import('@whiskeysockets/baileys');
        downloadMediaMessageFn = downloadMediaMessage;

        // Logger silencieux (pino) pour éviter le bruit en production
        const pino = require('pino');
        const logger = pino({ level: 'silent' });

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`📱 Baileys WA v${version.join('.')} — latest: ${isLatest}`);

        waSocket = makeWASocket({
            version,
            auth:                          state,
            logger,
            printQRInTerminal:             true,
            browser:                       ['KAMOA SCADA', 'Chrome', '120.0'],
            generateHighQualityLinkPreview: false,
            syncFullHistory:               true,
            markOnlineOnConnect:           false,
            connectTimeoutMs:              60_000,
            defaultQueryTimeoutMs:         30_000,
            keepAliveIntervalMs:           25_000,
        });

        // ── Événement : connexion / QR / déconnexion ──────────────────────────
        waSocket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // ── QR Code ───────────────────────────────────────────────────────
            if (qr) {
                try {
                    waQrBase64 = await QRCode.toDataURL(qr, {
                        width: 300, margin: 2,
                        color: { dark: '#000000', light: '#ffffff' },
                    });
                    waStatus = 'connecting';
                    broadcast({ type: 'qr',     qr:     waQrBase64 });
                    broadcast({ type: 'status', status: 'connecting' });
                    console.log('📲 QR Code généré et diffusé aux clients WS');
                } catch (e) {
                    console.error('❌ Erreur génération QR:', e.message);
                }
            }

            // ── Connecté ──────────────────────────────────────────────────────
            if (connection === 'open') {
                waStatus      = 'open';
                waConnected   = true;
                waQrBase64    = null;
                waConnNumber  = waSocket.user?.id?.split(':')[0] ?? waSocket.user?.id ?? '';
                broadcast({ type: 'status', status: 'open', phone: waConnNumber });
                console.log(`✅ WhatsApp connecté — numéro: ${waConnNumber}`);
                refreshGroupsCache().then(() => broadcast({ type: 'chats_update', count: cachedChats.length })).catch(() => {});
            }

            // ── Déconnecté ────────────────────────────────────────────────────
            if (connection === 'close') {
                waConnected = false;
                waStatus    = 'disconnected';
                broadcast({ type: 'status', status: 'disconnected' });

                const code           = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = code !== DisconnectReason.loggedOut;
                console.log(`🔴 Connexion fermée — code: ${code} — reconnect: ${shouldReconnect}`);

                if (shouldReconnect) {
                    waInitialized = false;
                    console.log('🔄 Reconnexion dans 5 s...');
                    setTimeout(initWhatsApp, 5_000);
                } else {
                    // Logged out → effacer la session et redemander un QR
                    console.log('🚪 Déconnexion volontaire — session effacée');
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    fs.mkdirSync(AUTH_DIR, { recursive: true });
                    waInitialized = false;
                    setTimeout(initWhatsApp, 2_000);
                }
            }
        });

        // ── Sauvegarder les credentials à chaque mise à jour ─────────────────
        waSocket.ev.on('creds.update', saveCreds);

        // ── Messages entrants ─────────────────────────────────────────────────
        waSocket.ev.on('messages.upsert', ({ messages, type }) => {
            if (type !== 'notify') return;

            messages.forEach(msg => {
                if (!msg.message) return;

                const from      = msg.key.remoteJid ?? '';
                const fromMe    = msg.key.fromMe ?? false;
                const messageId = msg.key.id ?? '';
                const timestamp = Number(msg.messageTimestamp ?? 0);
                const pushName  = msg.pushName ?? '';
                const isGroup   = isJidGroup(from);
                const meta      = extractTextAndMedia(msg);
                const groupName = isGroup ? (cachedGroups[from]?.subject || '') : '';
                const displayName = groupName || pushName || from;

                if (meta.hasMedia && messageId) mediaMessages.set(messageId, msg);

                const normalized = {
                    id: messageId,
                    messageId,
                    chatId: from,
                    from,
                    fromMe,
                    body: meta.body,
                    message: meta.body,
                    timestamp,
                    ts: timestamp,
                    pushName,
                    name: displayName,
                    chatName: displayName,
                    isGroup,
                    hasMedia: meta.hasMedia,
                    mediaType: meta.mediaType,
                    mimetype: meta.mimetype,
                    fileName: meta.fileName,
                    caption: meta.caption,
                };

                cachedMessages.push(normalized);
                if (cachedMessages.length > 1000) cachedMessages = cachedMessages.slice(-1000);

                const idx = cachedChats.findIndex(c => c.id === from);
                const chatEntry = {
                    id: from,
                    name: displayName,
                    isGroup,
                    unreadCount: 0,
                    lastMessage: meta.body,
                    timestamp,
                };
                if (idx >= 0) cachedChats[idx] = { ...cachedChats[idx], ...chatEntry };
                else cachedChats.push(chatEntry);

                broadcast({ type: 'message', data: normalized });
                broadcast({ type: 'whatsapp_message', data: normalized });

                if (!fromMe) {
                    console.log(`📩 Message reçu de ${displayName}: ${meta.body.substring(0, 80)}`);
                }
            });
        });

        // ── Mise à jour du statut d'un message (envoyé, lu, etc.) ─────────────
        waSocket.ev.on('messages.update', (updates) => {
            updates.forEach(({ key, update }) => {
                if (update.status !== undefined) {
                    broadcast({
                        type: 'message_status',
                        data: {
                            messageId: key.id,
                            to:        key.remoteJid,
                            status:    update.status,
                        },
                    });
                }
            });
        });

        // ── Chats (nouveaux ou mis à jour) ────────────────────────────────────
        waSocket.ev.on('chats.upsert', (chats) => {
            chats.forEach(chat => {
                const idx = cachedChats.findIndex(c => c.id === chat.id);
                const entry = {
                    id:          chat.id,
                    name:        chat.name ?? chat.id,
                    isGroup:     isJidGroup(chat.id),
                    unreadCount: chat.unreadCount ?? 0,
                    lastMessage: chat.lastMessage?.message?.conversation ?? '',
                    timestamp:   Number(chat.conversationTimestamp ?? 0),
                };
                if (idx >= 0) cachedChats[idx] = entry;
                else cachedChats.push(entry);
            });
            broadcast({ type: 'chats_update', count: cachedChats.length });
            console.log(`💬 Chats mis à jour — total: ${cachedChats.length}`);
        });

        // ── Contacts (nouveaux ou mis à jour) ─────────────────────────────────
        waSocket.ev.on('contacts.upsert', (contacts) => {
            contacts.forEach(c => {
                cachedContacts[c.id] = {
                    id:       c.id,
                    name:     c.name ?? c.notify ?? c.id,
                    notify:   c.notify ?? '',
                    pushName: c.pushName ?? '',
                };
            });
            broadcast({ type: 'contacts_update', count: Object.keys(cachedContacts).length });
            console.log(`👤 Contacts mis à jour — total: ${Object.keys(cachedContacts).length}`);
        });

    } catch (err) {
        console.error('❌ Erreur initialisation Baileys:', err.message);
        waInitialized = false;
        console.log('🔄 Nouvelle tentative dans 8 s...');
        setTimeout(initWhatsApp, 8_000);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE EXPRESS
// ─────────────────────────────────────────────────────────────────────────────
app.use(compression());
app.use(cors({
    origin: [
        'https://controlscada.pages.dev',
        'https://controlscada-production.up.railway.app',
        'http://localhost:3000',
        'http://localhost:8080',
        '*',
    ],
    credentials:    true,
    methods:        ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
}));
app.options('*', cors());
app.use(bodyParser.json({ limit: '75mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('./'));

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Normalise un numéro de téléphone en JID WhatsApp individuel */
function toJid(number) {
    const value = String(number || '').trim();
    if (value.endsWith('@s.whatsapp.net') || value.endsWith('@g.us')) return value;
    const digits = value.replace(/\D/g, '');
    return `${digits}@s.whatsapp.net`;
}

/** Normalise un ID de groupe en JID WhatsApp groupe */
function toGroupJid(id) {
    if (String(id).includes('@g.us')) return id;
    return `${id}@g.us`;
}

/** Wrapper avec timeout sur les appels Baileys */
function withTimeout(promise, ms = 15_000, label = 'opération') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout: ${label} > ${ms}ms`)), ms)
        ),
    ]);
}


function getMessageType(message = {}) {
    const k = Object.keys(message || {}).find(x => x !== 'messageContextInfo');
    return k || null;
}

function extractTextAndMedia(msg) {
    const m = msg.message || {};
    const type = getMessageType(m);
    let body = m.conversation
        ?? m.extendedTextMessage?.text
        ?? m.imageMessage?.caption
        ?? m.videoMessage?.caption
        ?? m.documentMessage?.title
        ?? m.documentMessage?.fileName
        ?? null;
    if (!body && m.audioMessage) body = '[audio]';
    if (!body) body = '[media]';
    const mediaNode = type ? m[type] : null;
    return {
        type,
        body: typeof body === 'string' ? body : '[media]',
        hasMedia: !!(type && ['imageMessage','videoMessage','documentMessage','audioMessage','stickerMessage'].includes(type)),
        mediaType: type ? type.replace('Message','') : null,
        mimetype: mediaNode?.mimetype || null,
        fileName: mediaNode?.fileName || mediaNode?.title || null,
        caption: mediaNode?.caption || null,
    };
}

function safeName(v) {
    return String(v || '').trim();
}

async function getProfilePicture(jid) {
    try {
        if (!waSocket || !jid) return '';
        return await withTimeout(waSocket.profilePictureUrl(jid, 'image'), 7_000, 'profilePictureUrl');
    } catch (_) {
        return '';
    }
}

async function refreshGroupsCache() {
    if (!waConnected || !waSocket) return cachedGroups;
    try {
        const rawGroups = await withTimeout(waSocket.groupFetchAllParticipating(), 20_000, 'groupFetchAllParticipating');
        cachedGroups = rawGroups || {};
        Object.entries(cachedGroups).forEach(([id, g]) => {
            if (!cachedChats.find(c => c.id === id)) {
                cachedChats.push({
                    id,
                    name: g.subject || id,
                    isGroup: true,
                    unreadCount: 0,
                    lastMessage: '',
                    timestamp: Number(g.creation || 0),
                });
            }
        });
        return cachedGroups;
    } catch (e) {
        console.warn('⚠️ Impossible de rafraîchir les groupes:', e.message);
        return cachedGroups;
    }
}

async function buildChatEntry(chat) {
    const id = chat.id;
    const isGroup = String(id).endsWith('@g.us');
    let name = chat.name || id;
    let participants = null;
    let picture = '';
    if (isGroup) {
        const meta = cachedGroups[id];
        name = safeName(meta?.subject) || safeName(chat.name) || id;
        participants = meta?.participants?.length ?? null;
    } else {
        const c = cachedContacts[id] || {};
        name = safeName(c.name) || safeName(c.notify) || safeName(c.pushName) || safeName(chat.name) || id.replace('@s.whatsapp.net','');
    }
    picture = await getProfilePicture(id);
    return { ...chat, id, jid: id, name, isGroup, participants, picture, profilePicUrl: picture };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES API
// ─────────────────────────────────────────────────────────────────────────────

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
    res.json({
        status:    'online',
        timestamp: new Date().toISOString(),
        app:       'KAMOA SCADA v3',
        whatsapp:  { status: waStatus, phone: waConnNumber, connected: waConnected },
    });
});

// ── Init / démarrer QR ────────────────────────────────────────────────────────
app.post('/api/whatsapp/init', async (_req, res) => {
    try {
        if (waConnected) {
            return res.json({ success: true, status: 'open', phone: waConnNumber, message: 'Déjà connecté' });
        }
        waInitialized = false;
        initWhatsApp();
        res.json({ success: true, message: 'Initialisation Baileys démarrée', status: waStatus });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Statut ────────────────────────────────────────────────────────────────────
app.get('/api/whatsapp/status', (_req, res) => {
    res.json({ success: true, status: waStatus, phone: waConnNumber, connected: waConnected });
});

// ── QR Code (fallback REST pour les clients sans WebSocket) ───────────────────
app.get('/api/whatsapp/qrcode', (_req, res) => {
    if (waConnected) return res.json({ success: true, status: 'open', phone: waConnNumber });
    if (!waQrBase64) return res.status(404).json({ error: 'QR pas encore prêt — réessayez dans 3 s' });
    res.json({ success: true, qrCode: waQrBase64 });
});

// ── Envoyer un message texte ──────────────────────────────────────────────────
app.post('/api/whatsapp/send', async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) {
        return res.status(400).json({ error: 'Champs requis: to, message' });
    }
    if (!waConnected || !waSocket) {
        return res.status(503).json({ error: 'WhatsApp non connecté', status: waStatus });
    }
    try {
        const jid    = toJid(to);
        const result = await withTimeout(
            waSocket.sendMessage(jid, { text: message }),
            15_000, 'sendMessage'
        );
        const messageId = result?.key?.id ?? 'sent';
        console.log(`✅ Message envoyé à ${to} — id: ${messageId}`);
        res.json({ success: true, messageId, status: 'sent' });
    } catch (err) {
        console.error(`❌ Erreur envoi à ${to}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Envoyer un message à un groupe ───────────────────────────────────────────
app.post('/api/whatsapp/send-group', async (req, res) => {
    const { groupId, message } = req.body;
    if (!groupId || !message) {
        return res.status(400).json({ error: 'Champs requis: groupId, message' });
    }
    if (!waConnected || !waSocket) {
        return res.status(503).json({ error: 'WhatsApp non connecté', status: waStatus });
    }
    try {
        const jid    = toGroupJid(groupId);
        const result = await withTimeout(
            waSocket.sendMessage(jid, { text: message }),
            15_000, 'sendGroupMessage'
        );
        const messageId = result?.key?.id ?? 'sent';
        console.log(`✅ Message groupe envoyé à ${groupId} — id: ${messageId}`);
        res.json({ success: true, messageId, status: 'sent' });
    } catch (err) {
        console.error(`❌ Erreur envoi groupe ${groupId}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Envoyer un média (image / vidéo / document via URL ou base64) ─────────────
app.post('/api/whatsapp/send-media', async (req, res) => {
    const { to, mediaUrl, dataUrl, base64, mimetype = '', mediaType = 'image', caption = '', filename } = req.body || {};
    const source = mediaUrl || dataUrl || base64;
    if (!to || !source) {
        return res.status(400).json({ success:false, error: 'Champs requis: to + mediaUrl/dataUrl/base64' });
    }
    if (!waConnected || !waSocket) {
        return res.status(503).json({ success:false, error: 'WhatsApp non connecté', status: waStatus, needQr: waStatus !== 'open' });
    }
    try {
        const jid = String(to).includes('@g.us') ? toGroupJid(to) : toJid(to);
        let buffer = null;
        let finalMime = mimetype || 'image/jpeg';

        if (String(source).startsWith('data:')) {
            const match = String(source).match(/^data:([^;]+);base64,(.+)$/);
            if (!match) throw new Error('Format dataUrl invalide');
            finalMime = match[1] || finalMime;
            buffer = Buffer.from(match[2], 'base64');
        } else if (base64 && !String(base64).startsWith('http')) {
            buffer = Buffer.from(String(base64).replace(/^data:[^,]+,/, ''), 'base64');
        }

        let msgContent;
        const type = String(mediaType || '').toLowerCase();
        const input = buffer ? buffer : { url: source };
        if (type === 'document' || finalMime === 'application/pdf' || filename) {
            msgContent = { document: input, mimetype: finalMime || 'application/octet-stream', fileName: filename || 'document', caption };
        } else if (type === 'video' || finalMime.startsWith('video/')) {
            msgContent = { video: input, mimetype: finalMime || undefined, caption };
        } else {
            msgContent = { image: input, mimetype: finalMime || undefined, caption };
        }

        const result = await withTimeout(waSocket.sendMessage(jid, msgContent), 60_000, 'sendMedia');
        const messageId = result?.key?.id ?? 'sent';
        console.log(`✅ Média envoyé à ${jid} — id: ${messageId}`);
        res.json({ success: true, messageId, id: messageId, status: 'sent', mediaType: type || 'image' });
    } catch (err) {
        console.error(`❌ Erreur envoi média:`, err);
        res.status(500).json({ success:false, error: err.message });
    }
});

// Compatibilité frontend: endpoint base64 dédié
app.post('/api/whatsapp/send-media-base64', async (req, res) => {
    const body = req.body || {};
    const { to, caption = '', filename = '' } = body;
    const dataUrl = body.dataUrl || body.mediaData || body.base64;
    const mimetype = body.mimetype || body.mime || (String(dataUrl).match(/^data:([^;]+);base64,/)||[])[1] || 'image/jpeg';
    const mediaType = body.mediaType || (mimetype.startsWith('video/') ? 'video' : mimetype.startsWith('application/') ? 'document' : 'image');
    if (!to || !dataUrl) return res.status(400).json({ success:false, error:'Champs requis: to + dataUrl/base64' });
    if (!waConnected || !waSocket) return res.status(503).json({ success:false, error:'WhatsApp non connecté', status:waStatus, needQr:waStatus !== 'open' });
    try {
        const jid = String(to).includes('@g.us') ? toGroupJid(to) : toJid(to);
        const raw = String(dataUrl).replace(/^data:[^,]+,/, '');
        const buffer = Buffer.from(raw, 'base64');
        let content;
        if (mediaType === 'document') content = { document: buffer, mimetype, fileName: filename || 'document', caption };
        else if (mediaType === 'video') content = { video: buffer, mimetype, caption };
        else content = { image: buffer, mimetype, caption };
        const result = await withTimeout(waSocket.sendMessage(jid, content), 60_000, 'sendMediaBase64');
        const messageId = result?.key?.id || 'sent';
        res.json({ success:true, messageId, id:messageId, status:'sent', mediaType });
    } catch(err) {
        console.error('❌ send-media-base64:', err);
        res.status(500).json({ success:false, error:err.message });
    }
});

// ── Récupérer tous les chats (groupes + contacts) ─────────────────────────────
app.get('/api/whatsapp/chats', async (_req, res) => {
    if (!waInitialized) initWhatsApp().catch(() => {});
    if (!waConnected || !waSocket) {
        // Ne pas retourner 503: le frontend doit rester propre pendant le scan QR / reconnexion.
        return res.json({
            success: false,
            error: 'WhatsApp non connecté',
            status: waStatus,
            chats: cachedChats || [],
            total: (cachedChats || []).length,
            needQr: waStatus !== 'open'
        });
    }
    try {
        await refreshGroupsCache();
        const byId = new Map();
        cachedChats.forEach(c => byId.set(c.id, c));
        Object.entries(cachedGroups).forEach(([id, g]) => {
            const old = byId.get(id) || {};
            byId.set(id, {
                id,
                name: g.subject || old.name || id,
                isGroup: true,
                unreadCount: old.unreadCount || 0,
                lastMessage: old.lastMessage || '',
                timestamp: old.timestamp || Number(g.creation || 0),
            });
        });
        Object.values(cachedContacts).forEach(c => {
            if (!c.id || String(c.id).endsWith('@g.us')) return;
            const old = byId.get(c.id) || {};
            byId.set(c.id, {
                id: c.id,
                name: c.name || c.notify || c.pushName || old.name || c.id,
                isGroup: false,
                unreadCount: old.unreadCount || 0,
                lastMessage: old.lastMessage || '',
                timestamp: old.timestamp || 0,
            });
        });

        const chats = await Promise.all(Array.from(byId.values()).map(buildChatEntry));
        chats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        res.json({ success: true, chats, total: chats.length });
    } catch (err) {
        console.error('❌ Erreur récupération chats:', err.message);
        res.status(500).json({ success: false, error: err.message, chats: [] });
    }
});

// ── Récupérer les messages récents ou ceux d'une conversation ────────────────
app.get('/api/whatsapp/messages', async (req, res) => {
    if (!waInitialized) initWhatsApp().catch(() => {});
    if (!waConnected || !waSocket) {
        // 200 volontaire: évite les erreurs rouges côté navigateur pendant la reconnexion.
        return res.json({ success: false, error: 'WhatsApp non connecté', status: waStatus, messages: [], needQr: waStatus !== 'open' });
    }
    try {
        const chatId = req.query.chatId ? String(req.query.chatId) : '';
        let messages = cachedMessages;
        if (chatId) messages = messages.filter(m => m.chatId === chatId || m.from === chatId);
        res.json({ success: true, messages, total: messages.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message, messages: [] });
    }
});

// ── Télécharger un média reçu ────────────────────────────────────────────────
app.get('/api/whatsapp/media/:messageId', async (req, res) => {
    if (!waConnected || !waSocket) {
        return res.json({ success: false, error: 'WhatsApp non connecté', status: waStatus });
    }
    if (!downloadMediaMessageFn) {
        return res.json({ success: false, error: 'Téléchargement média non prêt' });
    }
    try {
        const requestedId = decodeURIComponent(req.params.messageId || '');
        // Les JID @g.us / @s.whatsapp.net / @lid ne sont pas des IDs média.
        if (!requestedId || requestedId.includes('@')) {
            return res.json({ success: false, error: 'ID média invalide: ouvrir un vrai message média, pas un contact/groupe', id: requestedId });
        }
        const msg = mediaMessages.get(requestedId);
        if (!msg) return res.json({ success: false, error: 'Média non trouvé ou trop ancien', id: requestedId });
        const meta = extractTextAndMedia(msg);
        const buffer = await withTimeout(
            downloadMediaMessageFn(msg, 'buffer', {}, { reuploadRequest: waSocket.updateMediaMessage }),
            30_000,
            'downloadMediaMessage'
        );
        const mimetype = meta.mimetype || 'application/octet-stream';
        res.json({
            success: true,
            messageId: requestedId,
            mimetype,
            mime: mimetype,
            data: Buffer.from(buffer).toString('base64'),
            base64: Buffer.from(buffer).toString('base64'),
            fileName: meta.fileName,
            mediaType: meta.mediaType,
        });
    } catch (err) {
        console.error('❌ Erreur média:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Photo de profil / groupe ────────────────────────────────────────────────
app.get('/api/whatsapp/profile-picture/:jid', async (req, res) => {
    if (!waConnected || !waSocket) {
        return res.json({ success: false, error: 'WhatsApp non connecté', status: waStatus, url: '' });
    }
    try {
        const jid = decodeURIComponent(req.params.jid);
        const url = await getProfilePicture(jid);
        if (!url) return res.status(404).json({ success: false, error: 'Photo non disponible', jid });
        res.json({ success: true, jid, url, picture: url, profilePicUrl: url });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Récupérer uniquement les groupes ─────────────────────────────────────────
app.get('/api/whatsapp/groups', async (_req, res) => {
    if (!waInitialized) initWhatsApp().catch(() => {});
    if (!waConnected || !waSocket) {
        return res.json({ success: false, error: 'WhatsApp non connecté', status: waStatus, groups: [], total: 0, needQr: waStatus !== 'open' });
    }
    try {
        const rawGroups = await withTimeout(
            waSocket.groupFetchAllParticipating(),
            20_000, 'groupFetchAllParticipating'
        );

        // Mettre à jour le cache
        cachedGroups = rawGroups;

        const groups = await Promise.all(Object.entries(rawGroups).map(async ([id, g]) => ({
            id,
            jid:          id,
            name:         g.subject ?? id,
            subject:      g.subject ?? id,
            isGroup:      true,
            picture:      await getProfilePicture(id),
            profilePicUrl: '',
            participants: g.participants?.map(p => ({
                id:     p.id,
                admin:  p.admin ?? null,
            })) ?? [],
            participantCount: g.participants?.length ?? 0,
            creation:     g.creation ?? null,
            owner:        g.owner ?? null,
            desc:         g.desc ?? '',
        })));

        console.log(`👥 ${groups.length} groupes récupérés`);
        groups.forEach(g => { if (!g.profilePicUrl) g.profilePicUrl = g.picture || ''; });
        res.json({ success: true, connected: waConnected, status: waStatus, groups, total: groups.length });
    } catch (err) {
        console.error('❌ Erreur récupération groupes:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Récupérer les contacts ────────────────────────────────────────────────────
app.get('/api/whatsapp/contacts', async (_req, res) => {
    if (!waInitialized) initWhatsApp().catch(() => {});
    try {
        const map = new Map();
        Object.values(cachedContacts || {}).forEach(c => {
            if (!c?.id || String(c.id).endsWith('@g.us')) return;
            const id = c.id;
            const name = safeName(c.name) || safeName(c.notify) || safeName(c.pushName) || id.replace('@s.whatsapp.net','').replace('@lid','');
            map.set(id, { id, jid:id, name, notify:c.notify || '', pushName:c.pushName || '', isGroup:false });
        });
        (cachedChats || []).forEach(c => {
            if (!c?.id || String(c.id).endsWith('@g.us')) return;
            const id = c.id;
            const name = safeName(c.name) || id.replace('@s.whatsapp.net','').replace('@lid','');
            if (!map.has(id)) map.set(id, { id, jid:id, name, isGroup:false, lastMessage:c.lastMessage || '', timestamp:c.timestamp || 0 });
        });
        (cachedMessages || []).forEach(m => {
            const id = m.chatId || m.from;
            if (!id || String(id).endsWith('@g.us')) return;
            const name = safeName(m.pushName) || safeName(m.name) || id.replace('@s.whatsapp.net','').replace('@lid','');
            if (!map.has(id)) map.set(id, { id, jid:id, name, isGroup:false, lastMessage:m.body || '', timestamp:m.timestamp || 0 });
        });
        const contacts = await Promise.all(Array.from(map.values()).map(async c => {
            const picture = await getProfilePicture(c.id);
            return { ...c, picture, profilePicUrl: picture };
        }));
        contacts.sort((a,b) => String(a.name).localeCompare(String(b.name)));
        res.json({ success:true, connected:waConnected, status:waStatus, contacts, total:contacts.length, needQr:waStatus !== 'open' });
    } catch (err) {
        console.error('❌ Erreur récupération contacts:', err.message);
        res.status(500).json({ success:false, error: err.message, contacts: [] });
    }
});

// ── Logout / Réinitialiser la session ─────────────────────────────────────────
app.post('/api/whatsapp/logout', async (_req, res) => {
    try {
        if (waSocket) {
            await waSocket.logout().catch(() => {});
            waSocket = null;
        }
        waConnected   = false;
        waStatus      = 'disconnected';
        waQrBase64    = null;
        waConnNumber  = null;
        waInitialized = false;
        cachedChats    = [];
        cachedContacts = {};
        cachedGroups   = {};
        cachedMessages = [];
        mediaMessages  = new Map();

        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });

        broadcast({ type: 'status', status: 'disconnected' });
        console.log('🚪 Session WhatsApp réinitialisée — nouveau QR en cours...');

        setTimeout(initWhatsApp, 1_000);
        res.json({ success: true, message: 'Session réinitialisée, nouveau QR en cours...' });
    } catch (err) {
        console.error('❌ Erreur logout:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Fallback HTML ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
    const f = path.join(__dirname, 'index.html');
    if (fs.existsSync(f)) return res.sendFile(f);
    res.json({ status: 'KAMOA SCADA API online', whatsapp: waStatus });
});

app.use((_req, res) => res.status(404).json({ error: 'Route introuvable' }));

// ─────────────────────────────────────────────────────────────────────────────
// DÉMARRAGE
// ─────────────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║  🚀 KAMOA Control SCADA v3 — Railway                 ║
║  📱 WhatsApp Baileys (léger, sans navigateur)        ║
║  🌐 https://controlscada-production.up.railway.app   ║
║  🔌 WebSocket: ws://…/ws                             ║
║  🌐 Port: ${PORT}                                       ║
╚══════════════════════════════════════════════════════╝`);

    // Démarrer WhatsApp automatiquement après 2 s
    setTimeout(initWhatsApp, 2_000);
});

module.exports = app;
