/**
 * KAMOA Control SCADA — WhatsApp via UltraMsg API
 * Replaces whatsapp-web.js / Puppeteer with simple HTTP calls.
 * Inbound messages arrive via webhook → pushed to clients over Socket.IO.
 */

const express     = require('express');
const cors        = require('cors');
const bodyParser  = require('body-parser');
const compression = require('compression');
const http        = require('http');
const { Server }  = require('socket.io');
const path        = require('path');
require('dotenv').config();

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// ULTRAMSG CONFIG  (set these in your .env or Northflank environment variables)
//   ULTRAMSG_INSTANCE  = your instance ID, e.g. "instance12345"
//   ULTRAMSG_TOKEN     = your token from app.ultramsg.com
// ─────────────────────────────────────────────────────────────────────────────
const UM_INSTANCE = process.env.ULTRAMSG_INSTANCE || '';
const UM_TOKEN    = process.env.ULTRAMSG_TOKEN    || '';
const UM_BASE     = `https://api.ultramsg.com/${UM_INSTANCE}`;

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────
app.use(compression());
app.use(cors({ origin: '*' }));
app.use(bodyParser.json({ limit: '20mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('./'));

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS — thin wrappers around the UltraMsg REST API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generic GET request to UltraMsg.
 * @param {string} endpoint  e.g. "/instance/status"
 */
async function umGet(endpoint) {
    const url = `${UM_BASE}${endpoint}?token=${encodeURIComponent(UM_TOKEN)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`UltraMsg ${endpoint} → HTTP ${res.status}`);
    return res.json();
}

/**
 * Generic POST request to UltraMsg.
 * @param {string} endpoint  e.g. "/messages/chat"
 * @param {object} body
 */
async function umPost(endpoint, body = {}) {
    const url = `${UM_BASE}${endpoint}`;
    const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({ token: UM_TOKEN, ...body }).toString()
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`UltraMsg ${endpoint} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// BASE ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/status', async (_req, res) => {
    const waStatus = await getWaStatus().catch(() => 'unknown');
    res.json({ status: 'online', whatsapp: waStatus });
});

// Alias kept for backwards-compat with the frontend's whatsapp-integration.js
app.get('/api/health', async (_req, res) => {
    const waStatus = await getWaStatus().catch(() => 'unknown');
    res.json({ status: 'online', whatsapp: waStatus });
});

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPER — maps UltraMsg accountStatus to the legacy status strings
// the frontend already understands ("connected", "disconnected", "qr")
// ─────────────────────────────────────────────────────────────────────────────
async function getWaStatus() {
    if (!UM_INSTANCE || !UM_TOKEN) return 'disconnected';
    try {
        const data = await umGet('/instance/status');
        // UltraMsg returns { status: { accountStatus: { status: "authenticated" | "qr" | ... } } }
        const s = data?.status?.accountStatus?.status || data?.instanceStatus || '';
        if (s === 'authenticated' || s === 'connected') return 'connected';
        if (s === 'qr')                                  return 'qr';
        if (s === 'disconnected' || s === 'logout')      return 'disconnected';
        return s || 'unknown';
    } catch {
        return 'disconnected';
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/whatsapp/init
 * Re-connects (or restarts) the UltraMsg instance.
 */
app.post('/api/whatsapp/init', async (_req, res) => {
    if (!UM_INSTANCE || !UM_TOKEN) {
        return res.status(503).json({ success: false, error: 'ULTRAMSG_INSTANCE / ULTRAMSG_TOKEN not set' });
    }
    try {
        await umGet('/instance/restart');          // soft-restart
        const status = await getWaStatus();
        io.emit('whatsapp_status', { status });
        res.json({ success: true, status, message: 'Instance restarted' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/whatsapp/status
 * Returns the current connection status + phone info.
 */
app.get('/api/whatsapp/status', async (_req, res) => {
    if (!UM_INSTANCE || !UM_TOKEN) {
        return res.json({ status: 'disconnected', connected: false, info: null });
    }
    try {
        const data   = await umGet('/instance/status');
        const status = await getWaStatus();
        res.json({
            status,
            connected: status === 'connected',
            info:      data?.status || null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/whatsapp/qrcode
 * Returns the QR code image as a base-64 data-URL.
 * UltraMsg exposes GET /instance/qr  →  { qrCode: "data:image/png;base64,..." }
 */
app.get('/api/whatsapp/qrcode', async (_req, res) => {
    if (!UM_INSTANCE || !UM_TOKEN) {
        return res.json({ qr: null, status: 'disconnected' });
    }
    try {
        const data   = await umGet('/instance/qr');
        const status = await getWaStatus();
        // UltraMsg may return qrCode or qr_code depending on version
        const qr = data?.qrCode || data?.qr_code || null;
        if (qr) io.emit('whatsapp_qr', { qr });
        res.json({ qr, status });
    } catch (err) {
        res.json({ qr: null, status: 'error', error: err.message });
    }
});

/**
 * POST /api/whatsapp/send
 * Body: { to: "+243XXXXXXXXX", message: "Text..." }
 * or    { to: "2432XXXXXXXXX@c.us", message: "Text..." }
 */
app.post('/api/whatsapp/send', async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) {
        return res.status(400).json({ error: '"to" and "message" are required' });
    }
    if (!UM_INSTANCE || !UM_TOKEN) {
        return res.status(503).json({ error: 'UltraMsg not configured', status: 'disconnected' });
    }
    try {
        // UltraMsg accepts "+243..." or "243...@c.us" or group JIDs
        const toClean = to.replace(/@c\.us$/, '');   // strip WA suffix if present
        const data = await umPost('/messages/chat', { to: toClean, body: message });
        res.json({ success: true, messageId: data?.id || data?.message || 'sent' });
    } catch (err) {
        console.error('❌ Send error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/whatsapp/disconnect
 * Logs out the UltraMsg instance.
 */
app.post('/api/whatsapp/disconnect', async (_req, res) => {
    try {
        if (UM_INSTANCE && UM_TOKEN) await umGet('/instance/logout').catch(() => {});
        io.emit('whatsapp_status', { status: 'disconnected' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/whatsapp/chats
 * Returns recent chats (contacts + groups) from UltraMsg.
 */
app.get('/api/whatsapp/chats', async (_req, res) => {
    if (!UM_INSTANCE || !UM_TOKEN) {
        return res.json({ success: false, groups: [], contacts: [] });
    }
    try {
        // Fetch groups and contacts in parallel
        const [groupsData, contactsData] = await Promise.allSettled([
            umGet('/groups/all'),
            umGet('/contacts')
        ]);

        const groups   = groupsData.status   === 'fulfilled' ? (groupsData.value?.groups   || groupsData.value || []) : [];
        const contacts = contactsData.status === 'fulfilled' ? (contactsData.value?.contacts || contactsData.value || []) : [];

        res.json({ success: true, groups, contacts });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/whatsapp/messages
 * Returns recent messages (inbox summary) from UltraMsg.
 * UltraMsg: GET /messages?token=...&status=all&page=1&limit=50
 */
app.get('/api/whatsapp/messages', async (req, res) => {
    if (!UM_INSTANCE || !UM_TOKEN) {
        return res.json({ success: false, chats: {} });
    }
    try {
        const page  = req.query.page  || 1;
        const limit = req.query.limit || 50;
        const url   = `${UM_BASE}/messages?token=${encodeURIComponent(UM_TOKEN)}&status=all&page=${page}&limit=${limit}`;
        const resp  = await fetch(url);
        const data  = await resp.json();

        const messages = data?.messages || data || [];
        // Group by chatId for the frontend's inbox format
        const chatMap = {};
        messages.forEach(m => {
            const chatId = m.chatId || m.from || m.to || '';
            if (!chatId) return;
            if (!chatMap[chatId] || (m.timestamp || 0) > (chatMap[chatId].ts || 0)) {
                chatMap[chatId] = {
                    id:       m.id,
                    body:     m.body || m.message || '',
                    ts:       m.timestamp || 0,
                    time:     m.timestamp ? new Date(m.timestamp * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '',
                    date:     m.timestamp ? new Date(m.timestamp * 1000).toLocaleDateString('fr-FR') : '',
                    fromMe:   !!m.fromMe,
                    pushName: m.pushName || m.author || ''
                };
            }
        });

        res.json({ success: true, chats: chatMap });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK — UltraMsg posts inbound messages here.
//
// Set your webhook URL in the UltraMsg dashboard to:
//   https://<your-domain>/api/whatsapp/webhook
//
// Payload (example):
//  { data: { id, from, body, type, pushName, timestamp, chatId, isGroup }, event_type: "message_received" }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/whatsapp/webhook', (req, res) => {
    // Acknowledge immediately so UltraMsg doesn't retry
    res.sendStatus(200);

    try {
        const payload = req.body;

        // UltraMsg wraps everything in a `data` key; handle both shapes
        const msg   = payload?.data || payload;
        const event = payload?.event_type || 'message_received';

        if (!msg || !msg.from) return;

        const chatId      = msg.chatId || msg.from;
        const isGroup     = !!msg.isGroup || chatId.endsWith('@g.us');
        const pushName    = msg.pushName || msg.author || msg.from || '';
        const ts          = msg.timestamp || Math.floor(Date.now() / 1000);
        const timeStr     = new Date(ts * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        const dateStr     = new Date(ts * 1000).toLocaleDateString('fr-FR');

        console.log(`📩 Webhook [${event}] from ${pushName} (${chatId}): ${(msg.body || '').substring(0, 60)}`);

        // Push to all connected browser clients via Socket.IO
        io.emit('whatsapp_message', {
            id:        msg.id || String(ts) + chatId,
            chatId,
            from:      pushName,
            body:      msg.body    || msg.message || '',
            fromMe:    !!msg.fromMe,
            isGroup,
            timestamp: ts,
            time:      timeStr,
            date:      dateStr,
            pushName,
            hasMedia:  !!msg.hasMedia,
            mediaType: msg.type !== 'chat' ? msg.type : null
        });

        // Also broadcast a status ping so the sidebar badge updates
        io.emit('whatsapp_status', { status: 'connected' });

    } catch (err) {
        console.error('⚠️ Webhook parse error:', err.message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// SOCKET.IO — send current state to each new browser tab
// ─────────────────────────────────────────────────────────────────────────────
io.on('connection', async (socket) => {
    console.log('🔌 Client connected:', socket.id);
    const status = await getWaStatus().catch(() => 'unknown');
    socket.emit('whatsapp_status', { status });

    // If we're in QR mode, also send the current QR so late-joiners see it
    if (status === 'qr') {
        try {
            const data = await umGet('/instance/qr');
            const qr   = data?.qrCode || data?.qr_code || null;
            if (qr) socket.emit('whatsapp_qr', { qr });
        } catch { /* ignore */ }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// OPTIONAL: poll UltraMsg every 30 s and broadcast status changes to clients
// (covers the case where someone scans the QR while no client is watching)
// ─────────────────────────────────────────────────────────────────────────────
let _lastStatus = '';
setInterval(async () => {
    if (!UM_INSTANCE || !UM_TOKEN) return;
    try {
        const status = await getWaStatus();
        if (status !== _lastStatus) {
            _lastStatus = status;
            io.emit('whatsapp_status', { status });
            console.log('📶 WhatsApp status changed →', status);

            if (status === 'qr') {
                const data = await umGet('/instance/qr').catch(() => ({}));
                const qr   = data?.qrCode || data?.qr_code || null;
                if (qr) io.emit('whatsapp_qr', { qr });
            }
        }
    } catch { /* ignore */ }
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════╗
║  🚀 KAMOA SCADA ONLINE                       ║
║  🌐 PORT: ${PORT}                               ║
║  📡 WhatsApp: UltraMsg API (no Puppeteer)    ║
║  🔗 Webhook: POST /api/whatsapp/webhook      ║
╚══════════════════════════════════════════════╝

UltraMsg instance : ${UM_INSTANCE || '⚠️  NOT SET — add ULTRAMSG_INSTANCE env var'}
UltraMsg token    : ${UM_TOKEN    ? '✅ set' : '⚠️  NOT SET — add ULTRAMSG_TOKEN env var'}
    `);
});

module.exports = app;
