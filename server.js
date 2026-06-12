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
let waReconnectTimer = null;
let waStarting = false;

// ── Caches chats / messages / médias ──────────────────────────────────────────
let cachedChats    = [];
let cachedMessages = [];
let cachedContacts = [];
const groupNames = new Map();
const rawMessages = new Map();
const mediaMessages = new Map();
const sentMediaCache = new Map();
let participatingGroupsCache = { data: null, ts: 0, inflight: null };
const MEDIA_CACHE_DIR = process.env.WA_MEDIA_CACHE_DIR || path.join('/tmp', 'kamoa_wa_media');
try { fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true }); } catch (_) {}

// ── Helpers ───────────────────────────────────────────────────────────────────
function toJid(number) {
    if (String(number).includes('@s.whatsapp.net')) return String(number);
    return String(number).replace(/\D/g, '') + '@s.whatsapp.net';
}

function toGroupJid(id) {
    return String(id).includes('@g.us') ? String(id) : String(id) + '@g.us';
}

function normalizeChatJid(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.includes('@g.us')) return toGroupJid(raw);
    if (raw.includes('@s.whatsapp.net')) return raw;
    if (raw.includes('@lid')) return raw;
    return toJid(raw);
}

function resolveOutgoingJid(value, quotedMsg = null) {
    const raw = String(value || '').trim();
    const quotedJid = quotedMsg?.key?.remoteJid || quotedMsg?.chatId || '';
    if (isLidJid(raw)) return raw;
    const jid = normalizeChatJid(raw || quotedJid);
    if (!jid) throw new Error('Destinataire WhatsApp non résolu. Rechargez les contacts/groupes puis réessayez.');
    return jid;
}

function jidToNumber(jid) {
    const id = String(jid || '');
    if (id.includes('@lid')) return '';
    return id.replace('@s.whatsapp.net', '').replace('@g.us', '').split(':')[0];
}

function isNumericContactName(value) {
    return /^\+?\d{8,16}$/.test(String(value || '').replace(/\s/g, ''));
}

function isLidJid(value) {
    return String(value || '').includes('@lid');
}

function bestNameFromContact(contact = {}) {
    return [contact.name, contact.notify, contact.verifiedName, contact.pushName, contact.shortName]
        .find(v => v && !String(v).includes('@') && !isNumericContactName(v)) || '';
}

function getBestContactName(jid, fallback = '') {
    const id = String(jid || '');
    const num = jidToNumber(id);
    const contact = cachedContacts.find(c => c.id === id || c.jid === id || jidToNumber(c.id || c.jid) === num);
    const name = contact && bestNameFromContact(contact);
    const cleanFallback = fallback && !isNumericContactName(fallback) && !String(fallback).includes('@') ? fallback : '';
    return name || cleanFallback || (num ? '+' + num : 'Utilisateur WhatsApp');
}

function getDisplayName(jid, fallback = '') {
    const name = getBestContactName(jid, fallback);
    const num = jidToNumber(jid);
    if (!name || name === jid || name === num) return num ? '+' + num : (fallback || 'Utilisateur WhatsApp');
    return name;
}

async function getProfilePictureSafe(jid) {
    if (!waSocket || !jid) return null;
    try {
        return await waSocket.profilePictureUrl(jid, 'image');
    } catch (_) {
        return null;
    }
}

async function hydrateChat(chat) {
    const id = chat.id;
    const isGroup = !!chat.isGroup || String(id).endsWith('@g.us');
    let name = chat.name || chat.subject || chat.pushName || chat.notify || '';
    let participants = chat.participants;

    if (isGroup) {
        name = groupNames.get(id) || name;
        if (!groupNames.has(id)) try {
            const meta = await waSocket.groupMetadata(id);
            name = meta.subject || name || id;
            participants = meta.participants?.length || participants;
            if (meta.subject) groupNames.set(id, meta.subject);
        } catch (_) {}
        name = groupNames.get(id) || name || id;
    } else {
        name = getBestContactName(id, name);
    }

    const picture = chat.picture || await getProfilePictureSafe(id);
    return {
        id,
        name: name || id,
        isGroup,
        participants,
        unreadCount: chat.unreadCount || 0,
        timestamp: chat.timestamp || 0,
        lastMessage: chat.lastMessage || '',
        picture,
        phone: isGroup ? id : jidToNumber(id),
    };
}

function rememberRawMessage(msg) {
    const id = msg?.key?.id;
    if (id) rawMessages.set(id, msg);
}

function rememberCachedMessage(msgObj) {
    if (!msgObj?.id) return;
    const idx = cachedMessages.findIndex(m => m.id === msgObj.id);
    if (idx >= 0) cachedMessages[idx] = { ...cachedMessages[idx], ...msgObj };
    else cachedMessages.push(msgObj);
    if (cachedMessages.length > 2000) cachedMessages.shift();
}

function getMessageById(messageId) {
    return cachedMessages.find(m => m.id === messageId) || null;
}

function buildMessageKey(messageId, chatId, fallbackFromMe = false) {
    const cached = getMessageById(messageId);
    if (!cached && !chatId) return null;
    const key = {
        remoteJid: chatId || cached.chatId,
        id: messageId,
        fromMe: cached?.fromMe ?? fallbackFromMe,
    };
    if (cached?.participant) key.participant = cached.participant;
    return key;
}

function unwrapMessage(message = {}) {
    if (message.ephemeralMessage?.message) return unwrapMessage(message.ephemeralMessage.message);
    if (message.viewOnceMessage?.message) return unwrapMessage(message.viewOnceMessage.message);
    if (message.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message);
    if (message.documentWithCaptionMessage?.message) return unwrapMessage(message.documentWithCaptionMessage.message);
    return message;
}

function getTextFromMessage(message = {}) {
    return message.conversation
        || message.extendedTextMessage?.text
        || message.imageMessage?.caption
        || message.videoMessage?.caption
        || message.documentMessage?.caption
        || message.buttonsResponseMessage?.selectedDisplayText
        || message.listResponseMessage?.title
        || '';
}

function getQuotedInfo(message = {}) {
    const ctx = getContextInfo(message);
    const quoted = ctx.quotedMessage ? unwrapMessage(ctx.quotedMessage) : null;
    return {
        quotedMessageId: ctx.stanzaId || '',
        quotedParticipant: ctx.participant || '',
        quotedText: quoted ? getTextFromMessage(quoted) : '',
        mentionedJid: ctx.mentionedJid || [],
    };
}

function getContextInfo(message = {}) {
    return message.extendedTextMessage?.contextInfo
        || message.imageMessage?.contextInfo
        || message.videoMessage?.contextInfo
        || message.documentMessage?.contextInfo
        || message.audioMessage?.contextInfo
        || {};
}

function isIgnorableChatId(jid) {
    const id = String(jid || '');
    return !id || id === 'status@broadcast' || id.endsWith('@broadcast') || id.includes('newsletter');
}

function applyReactionToCache(chatId, reaction, senderName, timestamp) {
    const targetId = reaction?.key?.id || '';
    if (!targetId) return false;
    const target = cachedMessages.find(m => m.id === targetId);
    if (!target) return false;
    if (!target.reactions) target.reactions = [];
    const from = reaction.key?.participant || reaction.key?.remoteJid || senderName || '';
    target.reactions = target.reactions.filter(r => r.from !== from);
    if (reaction.text) target.reactions.push({ emoji: reaction.text, from, ts: timestamp });
    return true;
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

function mediaCachePath(messageId, suffix) {
    const safe = String(messageId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(MEDIA_CACHE_DIR, `${safe}.${suffix}`);
}

function saveJsonSafe(file, data) {
    try { fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { console.warn('⚠️ Cache média:', e.message); }
}

function readJsonSafe(file) {
    try {
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
        return null;
    }
}

function rememberMediaMessageOnDisk(messageId, msg) {
    if (!messageId || !msg) return;
    saveJsonSafe(mediaCachePath(messageId, 'raw.json'), msg);
}

function rememberSentMediaOnDisk(messageId, media) {
    if (!messageId || !media?.data) return;
    saveJsonSafe(mediaCachePath(messageId, 'sent.json'), media);
}

function loadSentMediaFromDisk(messageId) {
    return readJsonSafe(mediaCachePath(messageId, 'sent.json'));
}

function loadRawMediaFromDisk(messageId) {
    return readJsonSafe(mediaCachePath(messageId, 'raw.json'));
}

async function getParticipatingGroupsCached(force = false) {
    if (!waSocket) return participatingGroupsCache.data || {};
    const ttl = 5 * 60 * 1000;
    const fresh = participatingGroupsCache.data && (Date.now() - participatingGroupsCache.ts < ttl);
    if (!force && fresh) return participatingGroupsCache.data;
    if (participatingGroupsCache.inflight) return participatingGroupsCache.inflight;

    participatingGroupsCache.inflight = waSocket.groupFetchAllParticipating()
        .then(groups => {
            participatingGroupsCache = { data: groups || {}, ts: Date.now(), inflight: null };
            Object.entries(groups || {}).forEach(([id, g]) => {
                if (g?.subject) groupNames.set(id, g.subject);
            });
            return participatingGroupsCache.data;
        })
        .catch(err => {
            participatingGroupsCache.inflight = null;
            console.warn('⚠️ groupFetchAllParticipating:', err.message);
            return participatingGroupsCache.data || {};
        });

    return participatingGroupsCache.inflight;
}

function learnContactsFromGroups(groups = {}) {
    Object.values(groups || {}).forEach(g => {
        (g.participants || []).forEach(p => {
            const jid = p.id || p.jid;
            if (!jid || String(jid).endsWith('@g.us')) return;
            const known = cachedContacts.find(c => (c.id || c.jid) === jid);
            if (!known && !isLidJid(jid)) cachedContacts.push({ id: jid, jid, name: jidToNumber(jid), phone: jidToNumber(jid), isGroup: false });
        });
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
const AUTH_DIR = process.env.WA_AUTH_DIR || path.join('/tmp', 'kamoa_auth');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// ── Initialiser Baileys ───────────────────────────────────────────────────────
async function initWhatsApp() {
    // Protection contre plusieurs instances Baileys en même temps
    if (waStarting || waInitialized || waSocket) {
        console.log('ℹ️ Baileys déjà actif ou en démarrage — init ignoré');
        return;
    }
    waStarting = true;
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
            browser: ['KAMOA SCADA', 'Chrome', '1.0'],
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
        });
        waStarting = false;

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

                try { waSocket?.end?.(); } catch (_) {}
                waSocket = null;
                waInitialized = false;
                waStarting = false;

                if (waReconnectTimer) clearTimeout(waReconnectTimer);

                if (shouldReconnect) {
                    // Un seul timer de reconnexion pour éviter la boucle code 440
                    waReconnectTimer = setTimeout(() => {
                        waReconnectTimer = null;
                        if (!waSocket && !waInitialized && !waStarting) initWhatsApp();
                    }, 8000);
                } else {
                    // Logged out — supprimer la session
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    fs.mkdirSync(AUTH_DIR, { recursive: true });
                    waReconnectTimer = setTimeout(() => {
                        waReconnectTimer = null;
                        if (!waSocket && !waInitialized && !waStarting) initWhatsApp();
                    }, 2000);
                }
            }
        });

        // ── Sauvegarder credentials ───────────────────────────────────────────
        waSocket.ev.on('creds.update', saveCreds);

        // ── Mise à jour liste des chats ──────────────────────────────────────
        waSocket.ev.on('chats.upsert', (newChats) => {
            newChats.forEach(chat => {
                const idx = cachedChats.findIndex(c => c.id === chat.id);
                const isGroup = chat.id.endsWith('@g.us');
                if (isGroup && chat.name) groupNames.set(chat.id, chat.name);
                const old = idx >= 0 ? cachedChats[idx] : {};
                const chatObj = { id: chat.id, name: isGroup ? (chat.name || old.name || chat.id) : (chat.name || old.name || chat.id), isGroup,
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

        // ── Contacts : noms réels synchronisés par Baileys ───────────────────
        function upsertContacts(list = []) {
            list.forEach(contact => {
                const id = contact.id || contact.jid;
                if (!id || isIgnorableChatId(id)) return;
                const idx = cachedContacts.findIndex(c => (c.id || c.jid) === id);
                const existing = idx >= 0 ? cachedContacts[idx] : {};
                const incomingName = bestNameFromContact(contact);
                const existingName = bestNameFromContact(existing);
                const normalized = {
                    id,
                    jid: id,
                    name: incomingName || existingName || existing.name || (jidToNumber(id) ? ('+' + jidToNumber(id)) : 'Utilisateur WhatsApp'),
                    notify: contact.notify || '',
                    verifiedName: contact.verifiedName || '',
                    pushName: contact.pushName || '',
                    shortName: contact.shortName || '',
                    isGroup: String(id).endsWith('@g.us'),
                    phone: jidToNumber(id),
                };
                if (idx >= 0) cachedContacts[idx] = { ...cachedContacts[idx], ...normalized };
                else cachedContacts.push(normalized);
            });
            broadcast({ type: 'contacts_update', count: cachedContacts.length });
        }
        waSocket.ev.on('contacts.upsert', upsertContacts);
        waSocket.ev.on('contacts.update', upsertContacts);

        // ── Messages entrants ─────────────────────────────────────────────────
        waSocket.ev.on('messages.upsert', ({ messages, type }) => {
            messages.forEach(msg => {
                if (!msg.message) return;
                const cleanMessage = unwrapMessage(msg.message);
                const msgType   = Object.keys(cleanMessage)[0];
                const chatId    = msg.key.remoteJid || '';
                if (isIgnorableChatId(chatId)) return;
                rememberRawMessage(msg);
                const msgId     = msg.key.id || '';
                const fromMe    = msg.key.fromMe || false;
                const participant = msg.key.participant || '';
                const timestamp = Number(msg.messageTimestamp) || Math.floor(Date.now()/1000);
                const pushName  = msg.pushName || '';
                const isGroup   = chatId.endsWith('@g.us');
                if (isGroup && groupNames.has(chatId) === false) {
                    const existingGroup = cachedChats.find(c => c.id === chatId && c.name && c.name !== pushName);
                    if (existingGroup?.name) groupNames.set(chatId, existingGroup.name);
                }
                const body = getTextFromMessage(cleanMessage);
                const mediaTypes = ['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage','pttMessage'];
                const hasMedia   = mediaTypes.includes(msgType);
                const mediaType  = hasMedia ? msgType.replace('Message','') : null;
                const fileName   = cleanMessage?.documentMessage?.fileName || null;
                const mimeType   = cleanMessage?.[msgType]?.mimetype || null;
                const quoted = getQuotedInfo(cleanMessage);
                const reaction = cleanMessage.reactionMessage || null;
                if (!body && !hasMedia && !reaction) return;
                if (!isGroup && pushName) {
                    upsertContacts([{ id: chatId, name: pushName, pushName }]);
                }
                if (isGroup && participant && pushName) {
                    upsertContacts([{ id: participant, name: pushName, pushName }]);
                }
                if (hasMedia) {
                    mediaMessages.set(msgId, msg);
                    rememberMediaMessageOnDisk(msgId, msg);
                }
                const chatName = isGroup ? '' : getBestContactName(chatId, pushName);
                const senderName = fromMe ? 'me' : (isGroup ? (pushName || getBestContactName(participant, participant || chatId)) : (chatName || pushName || chatId));
                if (reaction) {
                    applyReactionToCache(chatId, reaction, senderName, timestamp);
                    const reactionObj = {
                        id: msgId,
                        chatId,
                        from: senderName,
                        fromMe,
                        timestamp,
                        pushName: pushName || chatName,
                        isGroup,
                        participant,
                        isReaction: true,
                        reactionTo: reaction.key?.id || '',
                        reactionText: reaction.text || '',
                    };
                    const chatIdx = cachedChats.findIndex(c => c.id === chatId);
                    if (chatIdx >= 0) {
                        cachedChats[chatIdx].lastMessage = senderName + ' a réagi ' + (reaction.text || '');
                        cachedChats[chatIdx].timestamp = timestamp;
                    }
                    broadcast({ type: 'message', data: reactionObj });
                    return;
                }
                const msgObj = { id: msgId, chatId, from: senderName, fromMe, body,
                    timestamp, pushName: pushName || chatName, chatName, isGroup, participant, hasMedia, mediaType, fileName, mimeType,
                    quotedMessageId: quoted.quotedMessageId, quotedParticipant: quoted.quotedParticipant, quotedText: quoted.quotedText,
                    mentionedJid: getContextInfo(cleanMessage).mentionedJid || [] };
                rememberCachedMessage(msgObj);
                const chatIdx = cachedChats.findIndex(c => c.id === chatId);
                if (chatIdx >= 0) {
                    cachedChats[chatIdx].lastMessage = reaction ? (senderName + ' a réagi ' + reaction.text) : (body || (hasMedia ? '['+mediaType+']' : ''));
                    cachedChats[chatIdx].timestamp   = timestamp;
                    if (isGroup) cachedChats[chatIdx].name = groupNames.get(chatId) || cachedChats[chatIdx].name || chatId;
                    if (!fromMe) cachedChats[chatIdx].unreadCount = (cachedChats[chatIdx].unreadCount||0)+1;
                } else {
                    cachedChats.unshift({ id: chatId, name: isGroup ? (groupNames.get(chatId) || chatId) : (chatName || pushName || chatId), isGroup,
                        unreadCount: fromMe ? 0 : 1, timestamp,
                        lastMessage: body || (hasMedia ? '['+mediaType+']' : ''), picture: null });
                }
                cachedChats.sort((a,b) => (b.timestamp||0)-(a.timestamp||0));
                broadcast({ type: 'message', data: msgObj });
            });
        });

        waSocket.ev.on('messages.update', (updates = []) => {
            updates.forEach(update => {
                const chatId = update.key?.remoteJid || '';
                if (isIgnorableChatId(chatId)) return;
                const cleanMessage = unwrapMessage(update.update?.message || update.message || {});
                const reaction = cleanMessage.reactionMessage;
                if (!reaction) return;
                const timestamp = Math.floor(Date.now() / 1000);
                const participant = update.key?.participant || reaction.key?.participant || '';
                const senderName = update.key?.fromMe ? 'me' : getBestContactName(participant || chatId, participant || chatId);
                applyReactionToCache(chatId, reaction, senderName, timestamp);
                broadcast({
                    type: 'message',
                    data: {
                        id: update.key?.id || ('reaction-' + Date.now()),
                        chatId,
                        from: senderName,
                        fromMe: !!update.key?.fromMe,
                        timestamp,
                        participant,
                        isReaction: true,
                        reactionTo: reaction.key?.id || '',
                        reactionText: reaction.text || '',
                    }
                });
            });
        });

    } catch (err) {
        console.error('❌ Baileys init error:', err.message);
        waSocket = null;
        waInitialized = false;
        waStarting = false;
        if (!waReconnectTimer) {
            waReconnectTimer = setTimeout(() => {
                waReconnectTimer = null;
                if (!waSocket && !waInitialized && !waStarting) initWhatsApp();
            }, 8000);
        }
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
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
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
        if (waConnected && waSocket) {
            return res.json({ success: true, status: 'open', phone: waConnNumber, message: 'Déjà connecté' });
        }
        if (!waSocket && !waInitialized && !waStarting) initWhatsApp();
        res.json({ success: true, message: 'Initialisation Baileys demandée', status: waStatus, starting: waStarting });
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
    const { to, message, quotedMessageId } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'Champs requis: to, message' });
    if (!waConnected || !waSocket) return res.status(503).json({ error: 'WhatsApp non connecté' });

    try {
        const options = {};
        if (quotedMessageId && rawMessages.has(quotedMessageId)) options.quoted = rawMessages.get(quotedMessageId);
        const jid = resolveOutgoingJid(to, options.quoted);
        const result = await waSocket.sendMessage(jid, { text: message }, options);
        const messageId = result?.key?.id;
        if (messageId) rememberCachedMessage({
            id: messageId,
            chatId: jid,
            from: 'me',
            fromMe: true,
            body: message,
            timestamp: Math.floor(Date.now() / 1000),
            isGroup: jid.endsWith('@g.us'),
            participant: result?.key?.participant || '',
        });
        res.json({ success: true, messageId: result?.key?.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Répondre à un message précis
app.post('/api/whatsapp/reply', async (req, res) => {
    const { chatId, messageId, message } = req.body;
    if (!chatId || !messageId || !message) return res.status(400).json({ error: 'Champs requis: chatId, messageId, message' });
    if (!waConnected || !waSocket) return res.status(503).json({ error: 'WhatsApp non connecté' });
    try {
        const quoted = rawMessages.get(messageId);
        const jid = resolveOutgoingJid(chatId, quoted || getMessageById(messageId));
        const options = quoted ? { quoted } : {};
        const result = await waSocket.sendMessage(jid, { text: message }, options);
        const sentId = result?.key?.id;
        if (sentId) rememberCachedMessage({
            id: sentId,
            chatId: jid,
            from: 'me',
            fromMe: true,
            body: message,
            timestamp: Math.floor(Date.now() / 1000),
            isGroup: jid.endsWith('@g.us'),
            quotedMessageId: quoted ? messageId : '',
        });
        res.json({ success: true, messageId: sentId, quoted: !!quoted });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Éditer un message envoyé par vous
app.post('/api/whatsapp/edit-message', async (req, res) => {
    const { chatId, messageId, message } = req.body;
    if (!chatId || !messageId || !message) return res.status(400).json({ error: 'Champs requis: chatId, messageId, message' });
    if (!waConnected || !waSocket) return res.status(503).json({ error: 'WhatsApp non connecté' });
    try {
        const jid = normalizeChatJid(chatId);
        const key = buildMessageKey(messageId, jid, true);
        if (!key) return res.status(404).json({ error: 'Message introuvable' });
        await waSocket.sendMessage(jid, { text: message, edit: key });
        const cached = getMessageById(messageId);
        if (cached) {
            cached.body = message;
            cached.edited = true;
        }
        res.json({ success: true, messageId, edited: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Supprimer un message
app.delete('/api/whatsapp/message/:messageId', async (req, res) => {
    const { chatId, fromMe } = req.query;
    const messageId = decodeURIComponent(req.params.messageId);
    if (!messageId) return res.status(400).json({ error: 'messageId requis' });
    if (!waConnected || !waSocket) return res.status(503).json({ error: 'WhatsApp non connecté' });
    try {
        const jid = normalizeChatJid(chatId || getMessageById(messageId)?.chatId || '');
        const key = buildMessageKey(messageId, jid, String(fromMe) === 'true');
        if (!key) return res.status(404).json({ error: 'Message introuvable' });
        await waSocket.sendMessage(jid, { delete: key });
        cachedMessages = cachedMessages.filter(m => m.id !== messageId);
        rawMessages.delete(messageId);
        mediaMessages.delete(messageId);
        broadcast({ type: 'message_deleted', chatId: jid, messageId });
        res.json({ success: true, messageId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Transférer un message
app.post('/api/whatsapp/forward-message', async (req, res) => {
    const { to, messageId } = req.body;
    if (!to || !messageId) return res.status(400).json({ error: 'Champs requis: to, messageId' });
    if (!waConnected || !waSocket) return res.status(503).json({ error: 'WhatsApp non connecté' });
    try {
        const jid = normalizeChatJid(to);
        const raw = rawMessages.get(messageId);
        const cached = getMessageById(messageId);
        if (raw) {
            const result = await waSocket.sendMessage(jid, { forward: raw });
            return res.json({ success: true, messageId: result?.key?.id });
        }
        if (cached?.body) {
            const result = await waSocket.sendMessage(jid, { text: cached.body });
            return res.json({ success: true, messageId: result?.key?.id, fallback: 'text' });
        }
        res.status(404).json({ error: 'Message original introuvable dans le cache' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Logout / Reset session
app.post('/api/whatsapp/logout', async (req, res) => {
    try {
        if (waReconnectTimer) { clearTimeout(waReconnectTimer); waReconnectTimer = null; }
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

// Récupérer groupes + contacts connus par Baileys
app.get('/api/whatsapp/chats', async (req, res) => {
    if (!waConnected || !waSocket) return res.status(503).json({ error: 'WhatsApp non connecté', status: waStatus });
    try {
        const byId = new Map();
        cachedChats.forEach(c => {
            if (c && c.id && !isIgnorableChatId(c.id)) byId.set(c.id, {
                id: c.id,
                name: c.name || getBestContactName(c.id, c.pushName || c.id),
                isGroup: !!c.isGroup || String(c.id).endsWith('@g.us'),
                participants: c.participants || undefined,
                unreadCount: c.unreadCount || 0,
                timestamp: c.timestamp || 0,
                lastMessage: c.lastMessage || '',
                picture: c.picture || null,
            });
        });

        cachedContacts.forEach(c => {
            const id = c.id || c.jid;
            if (!id || isIgnorableChatId(id)) return;
            if (isLidJid(id) && !bestNameFromContact(c)) return;
            const old = byId.get(id) || {};
            byId.set(id, {
                ...old,
                id,
                name: old.name && old.name !== id ? old.name : getBestContactName(id, c.name),
                isGroup: String(id).endsWith('@g.us'),
                participants: old.participants,
                unreadCount: old.unreadCount || 0,
                timestamp: old.timestamp || 0,
                lastMessage: old.lastMessage || '',
                picture: old.picture || c.picture || null,
                phone: jidToNumber(id),
            });
        });

        // Compléter avec les groupes participatifs, sans écraser les messages du cache
        try {
            const groups = await getParticipatingGroupsCached(req.query.refresh === '1');
            Object.entries(groups || {}).forEach(([id, g]) => {
                if (g.subject) groupNames.set(id, g.subject);
                const old = byId.get(id) || {};
                byId.set(id, {
                    ...old,
                    id,
                    name: old.name && old.name !== id ? old.name : (g.subject || id),
                    isGroup: true,
                    participants: g.participants?.length || old.participants || 0,
                    unreadCount: old.unreadCount || 0,
                    timestamp: old.timestamp || Math.floor(Date.now()/1000),
                    lastMessage: old.lastMessage || '',
                    picture: old.picture || null,
                });
            });
        } catch (e) {
            console.warn('⚠️ groupFetchAllParticipating:', e.message);
        }

        const hydrated = [];
        for (const chat of byId.values()) hydrated.push(await hydrateChat(chat));
        const chats = hydrated.sort((a,b) => (b.timestamp||0) - (a.timestamp||0));
        res.json({ success: true, chats, count: chats.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Récupérer contacts connus avec noms et photos ────────────────────────────
app.get('/api/whatsapp/contacts', async (req, res) => {
    if (!waConnected || !waSocket) return res.status(503).json({ error: 'WhatsApp non connecté', status: waStatus });
    try {
        try {
            const groups = await getParticipatingGroupsCached(req.query.refresh === '1');
            learnContactsFromGroups(groups);
        } catch (_) {}
        const contacts = [];
        for (const contact of cachedContacts) {
            const id = contact.id || contact.jid;
            if (!id || String(id).endsWith('@broadcast') || String(id).endsWith('@g.us')) continue;
            if (isLidJid(id) && !bestNameFromContact(contact)) continue;
            const picture = contact.picture || await getProfilePictureSafe(id);
            contacts.push({
                id,
                jid: id,
                name: getBestContactName(id, contact.name),
                phone: jidToNumber(id),
                picture,
                profilePicUrl: picture,
                isGroup: false,
            });
        }
        res.json({ success: true, contacts, count: contacts.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/whatsapp/groups', async (req, res) => {
    if (!waConnected || !waSocket) return res.status(503).json({ error: 'WhatsApp non connecté', status: waStatus });
    try {
        const groups = await getParticipatingGroupsCached(req.query.refresh === '1');
        learnContactsFromGroups(groups);
        const out = [];
        for (const [id, g] of Object.entries(groups || {})) {
            if (g.subject) groupNames.set(id, g.subject);
            const picture = await getProfilePictureSafe(id);
            out.push({
                id,
                name: g.subject || id,
                subject: g.subject || id,
                isGroup: true,
                participants: g.participants?.length || 0,
                picture,
                profilePicUrl: picture,
            });
        }
        res.json({ success: true, groups: out, count: out.length });
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
        for (const [msgId] of sentMediaCache.entries()) {
            const m = cachedMessages.find(x => x.id === msgId);
            if (m?.chatId === chatId) sentMediaCache.delete(msgId);
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
    const { to, base64, mimetype, caption = '', filename = 'fichier', quotedMessageId } = req.body;

    if (!to || !base64 || !mimetype) {
        return res.status(400).json({ error: 'Champs requis : to, base64, mimetype' });
    }
    if (!waConnected || !waSocket) {
        return res.status(503).json({ error: 'WhatsApp non connecté', status: waStatus });
    }

    try {
        const jid    = resolveOutgoingJid(to, quotedMessageId ? rawMessages.get(quotedMessageId) : null);
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

        const options = {};
        if (quotedMessageId && rawMessages.has(quotedMessageId)) options.quoted = rawMessages.get(quotedMessageId);
        const result    = await withTimeout(waSocket.sendMessage(jid, msgContent, options), 45_000, 'sendMediaBase64');
        const messageId = result?.key?.id ?? 'sent';
        if (messageId && messageId !== 'sent') {
            sentMediaCache.set(messageId, {
                data: base64,
                mimetype,
                fileName: filename,
                createdAt: Date.now(),
            });
            rememberSentMediaOnDisk(messageId, {
                data: base64,
                mimetype,
                fileName: filename,
                createdAt: Date.now(),
            });
            if (sentMediaCache.size > 300) {
                const oldest = Array.from(sentMediaCache.entries()).sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0)).slice(0, 50);
                oldest.forEach(([id]) => sentMediaCache.delete(id));
            }
        }
        rememberCachedMessage({
            id: messageId,
            chatId: jid,
            from: 'me',
            fromMe: true,
            body: caption || '',
            timestamp: Math.floor(Date.now() / 1000),
            hasMedia: true,
            mediaType: mimetype.split('/')[0] || 'document',
            fileName: filename,
            mimeType: mimetype,
            isGroup: jid.endsWith('@g.us'),
        });
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
        const sent = sentMediaCache.get(msgId) || loadSentMediaFromDisk(msgId);
        if (sent) {
            return res.json({ success: true, data: sent.data, mimetype: sent.mimetype, fileName: sent.fileName, sent: true });
        }
        const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
        const rawMsg = mediaMessages.get(msgId) || loadRawMediaFromDisk(msgId);
        if (!rawMsg)
            return res.status(404).json({ success: false, expired: true, error: 'Média non disponible dans le cache serveur' });
        const buffer   = await withTimeout(downloadMediaMessage(rawMsg, 'buffer', {}), 30_000, 'downloadMedia');
        const cleanMessage = unwrapMessage(rawMsg.message || {});
        const msgType  = Object.keys(cleanMessage)[0];
        const mimetype = cleanMessage?.[msgType]?.mimetype || 'application/octet-stream';
        const fileName = cleanMessage?.documentMessage?.fileName || null;
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
        const result = await waSocket.sendMessage(normalizeChatJid(groupId), { text: message });
        res.json({ success: true, messageId: result?.key?.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Photo de profil ───────────────────────────────────────────────────────────
app.get('/api/whatsapp/profile-picture', async (req, res) => {
    if (!waConnected || !waSocket) return res.status(503).json({ error: 'Non connecté' });
    try {
        const jid = normalizeChatJid(req.query.jid);
        const url = await waSocket.profilePictureUrl(jid, 'image');
        res.json({ success: true, url });
    } catch(e) { res.json({ success: false, url: null }); }
});
app.get('/api/whatsapp/profile-picture/:jid', async (req, res) => {
    if (!waConnected || !waSocket) return res.status(503).json({ error: 'Non connecté' });
    try {
        const jid = normalizeChatJid(decodeURIComponent(req.params.jid));
        const url = await waSocket.profilePictureUrl(jid, 'image');
        res.json({ success: true, url, picture: url, profilePicUrl: url });
    } catch(e) { res.json({ success: false, url: null, picture: null }); }
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
    // Démarrer WhatsApp automatiquement une seule fois
    setTimeout(() => {
        if (!waSocket && !waInitialized && !waStarting) initWhatsApp();
    }, 2000);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM reçu — fermeture serveur');
    try { waSocket?.end?.(); } catch (_) {}
    server.close(() => process.exit(0));
});

module.exports = app;
