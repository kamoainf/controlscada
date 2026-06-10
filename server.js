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
            syncFullHistory:               false,
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

                const body = msg.message?.conversation
                    ?? msg.message?.extendedTextMessage?.text
                    ?? msg.message?.imageMessage?.caption
                    ?? msg.message?.videoMessage?.caption
                    ?? msg.message?.documentMessage?.title
                    ?? '[media]';

                const from      = msg.key.remoteJid ?? '';
                const fromMe    = msg.key.fromMe ?? false;
                const messageId = msg.key.id ?? '';
                const timestamp = Number(msg.messageTimestamp ?? 0);
                const pushName  = msg.pushName ?? '';
                const isGroup   = isJidGroup(from);

                const payload = {
                    type: 'message',
                    data: {
                        messageId,
                        from,
                        fromMe,
                        body,
                        timestamp,
                        pushName,
                        isGroup,
                    },
                };

                broadcast(payload);

                if (!fromMe) {
                    console.log(`📩 Message reçu de ${pushName || from}: ${body.substring(0, 80)}`);
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
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('./'));

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Normalise un numéro de téléphone en JID WhatsApp individuel */
function toJid(number) {
    const digits = String(number).replace(/\D/g, '');
    return digits.endsWith('@s.whatsapp.net') ? digits : `${digits}@s.whatsapp.net`;
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

// ── Envoyer un média (image / document via URL) ───────────────────────────────
app.post('/api/whatsapp/send-media', async (req, res) => {
    const { to, mediaUrl, mediaType = 'image', caption = '', filename } = req.body;
    if (!to || !mediaUrl) {
        return res.status(400).json({ error: 'Champs requis: to, mediaUrl' });
    }
    if (!waConnected || !waSocket) {
        return res.status(503).json({ error: 'WhatsApp non connecté', status: waStatus });
    }
    try {
        const jid = String(to).includes('@g.us') ? toGroupJid(to) : toJid(to);

        let msgContent;
        if (mediaType === 'document') {
            msgContent = {
                document: { url: mediaUrl },
                mimetype: 'application/octet-stream',
                fileName: filename ?? 'document',
                caption,
            };
        } else if (mediaType === 'video') {
            msgContent = { video: { url: mediaUrl }, caption };
        } else {
            // image par défaut
            msgContent = { image: { url: mediaUrl }, caption };
        }

        const result = await withTimeout(
            waSocket.sendMessage(jid, msgContent),
            30_000, 'sendMedia'
        );
        const messageId = result?.key?.id ?? 'sent';
        console.log(`✅ Média (${mediaType}) envoyé à ${to} — id: ${messageId}`);
        res.json({ success: true, messageId, status: 'sent', mediaType });
    } catch (err) {
        console.error(`❌ Erreur envoi média à ${to}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Récupérer tous les chats (groupes + contacts) ─────────────────────────────
app.get('/api/whatsapp/chats', async (_req, res) => {
    if (!waConnected || !waSocket) {
        return res.status(503).json({ error: 'WhatsApp non connecté', status: waStatus });
    }
    try {
        // Enrichir avec les métadonnées des groupes si disponibles
        const chats = cachedChats.map(chat => ({
            ...chat,
            name: chat.isGroup
                ? (cachedGroups[chat.id]?.subject ?? chat.name)
                : (cachedContacts[chat.id]?.name ?? chat.name),
            participants: chat.isGroup
                ? (cachedGroups[chat.id]?.participants?.length ?? null)
                : null,
        }));

        // Trier par timestamp décroissant
        chats.sort((a, b) => b.timestamp - a.timestamp);

        res.json({ success: true, chats, total: chats.length });
    } catch (err) {
        console.error('❌ Erreur récupération chats:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Récupérer uniquement les groupes ─────────────────────────────────────────
app.get('/api/whatsapp/groups', async (_req, res) => {
    if (!waConnected || !waSocket) {
        return res.status(503).json({ error: 'WhatsApp non connecté', status: waStatus });
    }
    try {
        const rawGroups = await withTimeout(
            waSocket.groupFetchAllParticipating(),
            20_000, 'groupFetchAllParticipating'
        );

        // Mettre à jour le cache
        cachedGroups = rawGroups;

        const groups = Object.entries(rawGroups).map(([id, g]) => ({
            id,
            name:         g.subject ?? id,
            isGroup:      true,
            participants: g.participants?.map(p => ({
                id:     p.id,
                admin:  p.admin ?? null,
            })) ?? [],
            participantCount: g.participants?.length ?? 0,
            creation:     g.creation ?? null,
            owner:        g.owner ?? null,
            desc:         g.desc ?? '',
        }));

        console.log(`👥 ${groups.length} groupes récupérés`);
        res.json({ success: true, groups, total: groups.length });
    } catch (err) {
        console.error('❌ Erreur récupération groupes:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Récupérer les contacts ────────────────────────────────────────────────────
app.get('/api/whatsapp/contacts', (_req, res) => {
    if (!waConnected || !waSocket) {
        return res.status(503).json({ error: 'WhatsApp non connecté', status: waStatus });
    }
    try {
        const contacts = Object.values(cachedContacts).filter(c => !c.id.endsWith('@g.us'));
        console.log(`👤 ${contacts.length} contacts retournés`);
        res.json({ success: true, contacts, total: contacts.length });
    } catch (err) {
        console.error('❌ Erreur récupération contacts:', err.message);
        res.status(500).json({ error: err.message });
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
