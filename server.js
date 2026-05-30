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
let waSocket      = null;
let waSocketId    = 0;          // incrémenté à chaque nouvelle instance, détecte les sockets périmés
let waStatus      = 'disconnected';
let waQrBase64    = null;
let waConnNumber  = null;
let waConnected   = false;
let waInitialized = false;
let waReadyForAPI = false;
let waReadyTimer  = null;
let waCleanupInProgress = false;
let waLoggedOutAt = 0;          // timestamp du dernier 440, empêche les re-sauvegardes post-nettoyage

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

// ── Helpers session ────────────────────────────────────────────────────────────
function isSessionValid() {
    try {
        const credsFile = path.join(AUTH_DIR, 'creds.json');
        if (!fs.existsSync(credsFile)) return false;
        const raw = fs.readFileSync(credsFile, 'utf8');
        if (!raw || raw.trim().length < 10) return false;
        const parsed = JSON.parse(raw);
        if (!parsed.me && !parsed.noiseKey && !parsed.signedIdentityKey) return false;
        console.log('✅ Session: creds.json valide, compte:', parsed.me?.id || 'inconnu');
        return true;
    } catch (e) {
        console.log('⚠️ Session: erreur lecture creds.json —', e.message);
        return false;
    }
}

function cleanSession(reason = '') {
    if (waCleanupInProgress) return;
    waCleanupInProgress = true;
    console.log(`🧹 Nettoyage session${reason ? ' — ' + reason : ''}...`);
    try {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        console.log('✅ Session nettoyée, dossier recréé');
    } catch (e) {
        console.error('❌ Erreur nettoyage session:', e.message);
    } finally {
        setTimeout(() => { waCleanupInProgress = false; }, 3000);
    }
}

// ── Initialiser Baileys (version robuste avec pairing code) ───────────────────
async function initWhatsApp() {
    if (waInitialized) return;
    waInitialized = true;

    // Si un logout vient de se produire, attendre que le nettoyage soit terminé
    const timeSinceLogout = Date.now() - waLoggedOutAt;
    if (waLoggedOutAt > 0 && timeSinceLogout < 3000) {
        await new Promise(r => setTimeout(r, 3000 - timeSinceLogout));
    }

    console.log('🔍 Vérification de la session stockée dans', AUTH_DIR, '...');
    const sessionOk = isSessionValid();
    if (!sessionOk && fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
        console.log('🧹 Session corrompue détectée au démarrage — nettoyage préventif');
        cleanSession('session corrompue au démarrage');
        await new Promise(r => setTimeout(r, 1000));
    }

    // Identifiant unique pour cette instance de socket
    const mySocketId = ++waSocketId;

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

        const { state, saveCreds: _saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        // Wrapper : n'écrit les creds que si ce socket est encore le socket courant
        // et qu'aucun logout n'a été déclenché depuis. Empêche la boucle 440.
        const saveCreds = () => {
            if (mySocketId !== waSocketId) {
                console.log('⚠️ saveCreds ignoré — socket périmé (id mismatch)');
                return;
            }
            if (Date.now() - waLoggedOutAt < 30000) {
                console.log('⚠️ saveCreds ignoré — logout récent, creds périmés');
                return;
            }
            return _saveCreds();
        };

        // Options de connexion renforcées
        waSocket = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            browser: ['Ubuntu', 'Chrome', '120.0.0.0'], // plus crédible
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
            retrieveFullMessageHistoryOnReconnect: false,
            ignoreUnencryptedMessages: true,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 5000,
            defaultQueryTimeoutMs: 60000,
            patchMessageBeforeSending: (msg) => msg,
            shouldSyncHistoryMessage: () => false,
            markOnlineOnConnect: false,
            fireInitQueries: false,
            getMessage: async () => undefined,
            shouldIgnoreJid: (jid) => jid.includes('status') || jid === '0@broadcast',
        });

        let pairingRequested = false;

        // Fonction utilitaire pour envoyer le QR
        const sendQRCode = async (qrString) => {
            try {
                const QRCode = require('qrcode');
                const qrBase64 = await QRCode.toDataURL(qrString, { width: 300, margin: 2 });
                waQrBase64 = qrBase64;
                waStatus = 'connecting';
                broadcast({ type: 'qr', qr: qrBase64 });
                broadcast({ type: 'status', status: 'connecting' });
                console.log('📲 QR Code généré et diffusé');
            } catch (e) {
                console.error('QR gen error:', e.message);
            }
        };

        // ── Événement connection.update ───────────────────────────────────────
        waSocket.ev.on('connection.update', async (update) => {
            console.log('📡 connection.update reçu:', Object.keys(update));
            const { connection, lastDisconnect, qr } = update;

            // Gestion du QR ou du pairing code
            if (qr && !pairingRequested) {
                pairingRequested = true;
                const phoneNumber = process.env.WA_PHONE_NUMBER;
                if (phoneNumber && phoneNumber.trim() !== '') {
                    try {
                        const code = await waSocket.requestPairingCode(phoneNumber);
                        console.log(`📱 Code d'appairage (entrez-le dans WhatsApp) : ${code}`);
                        broadcast({ type: 'pairing_code', code });
                    } catch (e) {
                        console.error('Erreur lors de la demande de code d\'appairage:', e);
                        await sendQRCode(qr);
                    }
                } else {
                    console.log('📲 Aucun WA_PHONE_NUMBER défini, utilisation du QR code');
                    await sendQRCode(qr);
                }
            }

            if (connection === 'open') {
                waStatus = 'open';
                waConnected = true;
                waQrBase64 = null;
                waReadyForAPI = false;
                if (waReadyTimer) clearTimeout(waReadyTimer);
                waConnNumber = waSocket.user?.id?.split(':')[0] || waSocket.user?.id || '';
                broadcast({ type: 'status', status: 'open', phone: waConnNumber });
                console.log('✅ WhatsApp connecté:', waConnNumber);

                const STABILIZATION_DELAY = 5000;
                console.log(`⏳ Stabilisation en cours — API disponible dans ${STABILIZATION_DELAY/1000}s...`);
                waReadyTimer = setTimeout(() => {
                    if (waConnected) {
                        waReadyForAPI = true;
                        console.log('🟢 WhatsApp prêt pour les appels API (groupFetchAllParticipating, etc.)');
                        broadcast({ type: 'ready', phone: waConnNumber });
                    }
                    waReadyTimer = null;
                }, STABILIZATION_DELAY);
            }

            if (connection === 'close') {
                waConnected = false;
                waReadyForAPI = false;
                waStatus = 'disconnected';
                if (waReadyTimer) clearTimeout(waReadyTimer);
                broadcast({ type: 'status', status: 'disconnected' });

                const code = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = code === DisconnectReason.loggedOut || code === 440;
                const shouldReconnect = !isLoggedOut;

                console.log('🔴 Connexion fermée, code:', code, '— reconnect:', shouldReconnect,
                    isLoggedOut ? '(session révoquée par WhatsApp)' : '');

                if (isLoggedOut) {
                    console.log('🚨 Code 440 / loggedOut détecté — nettoyage complet de la session');
                    broadcast({ type: 'status', status: 'logged_out', message: 'Session révoquée — nouveau QR requis' });
                    waLoggedOutAt = Date.now();  // bloque saveCreds sur tous les sockets existants
                    waSocketId++;               // invalide le socket courant immédiatement
                    cleanSession('code 440 / loggedOut');
                    waInitialized = false;
                    console.log('⏳ Attente 60s avant de relancer (anti-blocage WhatsApp)...');
                    setTimeout(initWhatsApp, 60000);
                } else {
                    waInitialized = false;
                    console.log('🔄 Reconnexion dans 5s...');
                    setTimeout(initWhatsApp, 5000);
                }
            }
        });

        waSocket.ev.on('creds.update', saveCreds);

        waSocket.ev.on('messages.upsert', ({ messages }) => {
            for (const msg of messages) {
                if (!msg.message || msg.message?.protocolMessage) continue;
                const body = msg.message?.conversation
                          || msg.message?.extendedTextMessage?.text
                          || '';
                if (!body) continue;
                const from = msg.key.remoteJid || '';
                broadcast({ type: 'message', data: { from, body, fromMe: msg.key.fromMe, ts: msg.messageTimestamp } });
            }
        });

        waSocket.ev.on('connection.error', (err) => {
            console.error('❌ connection.error Baileys:', err?.message || err);
        });

        // Gestion des erreurs de décryptage
        let decryptionErrorCount = 0;
        let decryptionErrorTimer = null;
        waSocket.ev.on('message.retry', (msg) => {
            if (msg.type === 'decryption-error') {
                decryptionErrorCount++;
                console.warn(`⚠️ Échec de décryptage #${decryptionErrorCount}`);
                if (decryptionErrorTimer) clearTimeout(decryptionErrorTimer);
                decryptionErrorTimer = setTimeout(() => {
                    if (decryptionErrorCount >= 5) {
                        console.error('❌ Trop d’erreurs de décryptage — réinitialisation de la session');
                        cleanSession('trop d’erreurs de décryptage');
                        waInitialized = false;
                        waConnected = false;
                        waReadyForAPI = false;
                        if (waSocket) waSocket.end();
                        setTimeout(initWhatsApp, 5000);
                    }
                    decryptionErrorCount = 0;
                }, 10000);
            }
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

app.get('/api/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date(),
        app: 'KAMOA SCADA',
        whatsapp: { status: waStatus, phone: waConnNumber, connected: waConnected, readyForAPI: waReadyForAPI }
    });
});

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

app.get('/api/whatsapp/status', (req, res) => {
    res.json({ success: true, status: waStatus, phone: waConnNumber, connected: waConnected, readyForAPI: waReadyForAPI });
});

app.get('/api/whatsapp/qrcode', (req, res) => {
    if (waConnected) return res.json({ success: true, status: 'open', phone: waConnNumber });
    if (!waQrBase64) return res.status(404).json({ error: 'QR pas encore prêt — réessayez dans 3s' });
    res.json({ success: true, qrCode: waQrBase64 });
});

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

app.post('/api/whatsapp/logout', async (req, res) => {
    try {
        console.log('🔄 Logout manuel demandé — réinitialisation complète...');
        if (waReadyTimer) clearTimeout(waReadyTimer);
        if (waSocket) await waSocket.logout().catch(() => {});
        waSocket = null;
        waConnected = false;
        waReadyForAPI = false;
        waStatus = 'disconnected';
        waQrBase64 = null;
        waConnNumber = null;
        waInitialized = false;
        waCleanupInProgress = false;
        cleanSession('logout manuel');
        broadcast({ type: 'status', status: 'disconnected' });
        setTimeout(initWhatsApp, 2000);
        res.json({ success: true, message: 'Session réinitialisée, nouveau QR en cours...' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/whatsapp/chats', async (req, res) => {
    if (!waConnected || !waSocket) {
        return res.status(503).json({ error: 'WhatsApp non connecté', status: waStatus });
    }
    if (!waReadyForAPI) {
        return res.status(503).json({ error: 'WhatsApp connecté mais pas encore prêt — stabilisation en cours', readyForAPI: false });
    }
    try {
        console.log('📋 Récupération des groupes via groupFetchAllParticipating()...');
        const groupsPromise = waSocket.groupFetchAllParticipating();
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout > 20s')), 20000));
        const groups = await Promise.race([groupsPromise, timeoutPromise]);
        const groupList = Object.entries(groups).map(([id, g]) => ({
            id, name: g.subject || id, isGroup: true, participants: g.participants?.length || 0
        }));
        let contacts = [];
        try {
            if (waSocket.store && waSocket.store.chats) {
                contacts = Array.from(waSocket.store.chats.values())
                    .filter(c => !c.id.endsWith('@g.us'))
                    .map(c => ({ id: c.id, name: c.name || c.id.split('@')[0], isGroup: false, unread: c.unreadCount || 0 }));
            }
        } catch (e) { console.warn('⚠️ Impossible de récupérer les contacts individuels:', e.message); }
        console.log(`✅ ${groupList.length} groupe(s) et ${contacts.length} contact(s) récupéré(s)`);
        res.json({ success: true, groups: groupList, contacts });
    } catch (err) {
        console.error('❌ groupFetchAllParticipating() erreur:', err.message);
        if (err.message?.includes('Connection Closed') || err.message?.includes('stream errored')) {
            waConnected = false;
            waReadyForAPI = false;
            waStatus = 'disconnected';
            broadcast({ type: 'status', status: 'disconnected' });
        }
        res.status(500).json({ error: err.message, hint: 'Utilisez POST /api/whatsapp/logout pour réinitialiser' });
    }
});

app.get('/api/whatsapp/debug', (req, res) => {
    if (!waSocket) return res.json({ error: 'socket null', connected: false });
    res.json({
        user: waSocket.user,
        connected: waConnected,
        readyForAPI: waReadyForAPI,
        wsReadyState: waSocket.ws?.readyState,
        registered: waSocket.registered,
        storeKeys: waSocket.store ? Object.keys(waSocket.store) : [],
    });
});

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