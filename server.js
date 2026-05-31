/**
 * KAMOA Control SCADA — Railway FIXED VERSION
 */

const express     = require('express');
const cors        = require('cors');
const bodyParser  = require('body-parser');
const compression = require('compression');
const http        = require('http');
const { Server }  = require('socket.io');
const path        = require('path');
const fs          = require('fs');
require('dotenv').config();

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: '*', methods: ['GET','POST'] }
});

const PORT = process.env.PORT || 3000;

// ─────────────────────────────
// MIDDLEWARE
// ─────────────────────────────
app.use(compression());
app.use(cors({ origin: '*' }));
app.use(bodyParser.json({ limit: '20mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('./'));

// ─────────────────────────────
// WHATSAPP STATE
// ─────────────────────────────
let waClient  = null;
let waStatus  = 'disconnected';
let waQr      = null;
let waInfo    = null;
let waIniting = false;

// ─────────────────────────────
// INIT WHATSAPP
// ─────────────────────────────
async function initWhatsApp() {
    if (waIniting) return;
    waIniting = true;
    waStatus  = 'initializing';
    io.emit('whatsapp_status', { status: waStatus });

    try {
        const { Client, LocalAuth } = require('whatsapp-web.js');
        const QRCode = require('qrcode');

        // Utiliser Chromium système (défini dans Dockerfile via PUPPETEER_EXECUTABLE_PATH)
        const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

        waClient = new Client({
            authStrategy: new LocalAuth({ dataPath: '/tmp/kamoa_auth' }),
            puppeteer: {
                headless: true,
                executablePath,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--disable-extensions',
                    '--no-first-run',
                    '--single-process',
                    '--no-zygote'
                ]
            }
        });

        let qrCount = 0;
        waClient.on('qr', async (qr) => {
            qrCount++;
            waQr    = await QRCode.toDataURL(qr);
            waStatus = 'qr';
            io.emit('whatsapp_qr',     { qr: waQr });
            io.emit('whatsapp_status', { status: waStatus });
            console.log(`📱 QR #${qrCount} généré — scannez MAINTENANT (expire dans ~20s)`);
            if (qrCount >= 5) console.warn('⚠️  5 QR générés sans scan — vérifiez que vous scannez le QR affiché dans la page');
        });

        waClient.on('ready', () => {
            waStatus = 'connected';
            waQr     = null;
            waInfo   = waClient.info;
            const phone = waInfo?.wid?.user || '';
            const name  = waInfo?.pushname  || '';
            console.log(`✅ WhatsApp CONNECTÉ — ${phone} (${name})`);
            io.emit('whatsapp_status', {
                status: 'connected',
                phone,
                name,
                info: waInfo
            });
        });

        waClient.on('authenticated', () => {
            waStatus = 'authenticated';
            io.emit('whatsapp_status', { status: waStatus });
        });

        waClient.on('auth_failure', (msg) => {
            console.error('❌ Auth failure:', msg);
            waStatus  = 'auth_failure';
            waIniting = false;
            io.emit('whatsapp_status', { status: waStatus });
        });

        waClient.on('disconnected', (reason) => {
            console.log('🔌 WhatsApp déconnecté:', reason);
            waStatus  = 'disconnected';
            waIniting = false;
            io.emit('whatsapp_status', { status: waStatus });
            // Reconnexion automatique après 15s
            setTimeout(initWhatsApp, 15000);
        });

        await waClient.initialize();

    } catch (err) {
        console.error('❌ WhatsApp error:', err.message);
        waStatus  = 'error';
        waIniting = false;
        io.emit('whatsapp_status', { status: waStatus, error: err.message });
        setTimeout(initWhatsApp, 10000);
    }
}

// ─────────────────────────────
// ROUTES DE BASE
// ─────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/status', (req, res) => {
    res.json({ status: 'online', whatsapp: waStatus });
});

// Alias /api/health → même réponse (compatibilité whatsapp-integration.js)
app.get('/api/health', (req, res) => {
    res.json({ status: 'online', whatsapp: waStatus });
});

// ─────────────────────────────
// ROUTES WHATSAPP  ← MANQUAIENT
// ─────────────────────────────

/**
 * POST /api/whatsapp/init
 * Lance l'initialisation WhatsApp (appelé par le frontend au clic "Refresh")
 */
app.post('/api/whatsapp/init', async (req, res) => {
    if (waStatus === 'connected') {
        return res.json({ success: true, status: waStatus, message: 'Déjà connecté' });
    }
    // Lance init en arrière-plan (non-bloquant)
    initWhatsApp().catch(console.error);
    res.json({ success: true, status: waStatus, message: 'Initialisation démarrée' });
});

/**
 * GET /api/whatsapp/status
 * Retourne le statut courant du client WhatsApp
 */
app.get('/api/whatsapp/status', (req, res) => {
    res.json({
        status:    waStatus,
        connected: waStatus === 'connected',
        info:      waInfo || null
    });
});

/**
 * GET /api/whatsapp/qrcode
 * Retourne le QR code base64 (si disponible)
 */
app.get('/api/whatsapp/qrcode', (req, res) => {
    if (waQr) {
        res.json({ qr: waQr, status: waStatus });
    } else {
        res.json({ qr: null, status: waStatus });
    }
});

/**
 * POST /api/whatsapp/send
 * Envoie un message WhatsApp
 * Body: { to: "243XXXXXXXXX", message: "Texte..." }
 */
app.post('/api/whatsapp/send', async (req, res) => {
    const { to, message } = req.body;

    if (!to || !message) {
        return res.status(400).json({ error: 'Champs "to" et "message" requis' });
    }

    if (waStatus !== 'connected' || !waClient) {
        return res.status(503).json({ error: 'WhatsApp non connecté', status: waStatus });
    }

    try {
        // Formater le numéro : retirer le + et ajouter @c.us
        const number = to.replace(/\D/g, '') + '@c.us';
        const result = await waClient.sendMessage(number, message);
        res.json({ success: true, messageId: result.id._serialized });
    } catch (err) {
        console.error('Erreur envoi:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/whatsapp/disconnect
 * Déconnecte le client WhatsApp
 */
app.post('/api/whatsapp/disconnect', async (req, res) => {
    try {
        if (waClient) await waClient.destroy();
        waStatus  = 'disconnected';
        waIniting = false;
        waQr      = null;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────
// SOCKET.IO
// ─────────────────────────────
io.on('connection', (socket) => {
    console.log('🔌 Client connecté:', socket.id);
    // Envoyer l'état courant au nouveau client
    socket.emit('whatsapp_status', { status: waStatus });
    if (waQr) socket.emit('whatsapp_qr', { qr: waQr });
});

// ─────────────────────────────
// START SERVER
// ─────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════╗
║  🚀 KAMOA SCADA ONLINE               ║
║  🌐 PORT: ${PORT}                       ║
║  📡 Routes WhatsApp: ✅              ║
╚══════════════════════════════════════╝
    `);

    // Lancer WhatsApp après démarrage du serveur
    setTimeout(initWhatsApp, 5000);
});

module.exports = app;
