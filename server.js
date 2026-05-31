/**
 * KAMOA Control SCADA — Northflank FIXED VERSION
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

// ✅ FIX IMPORTANT NORTHFLANK
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
let waClient = null;
let waStatus = 'disconnected';
let waQr = null;
let waInfo = null;
let waIniting = false;

// ─────────────────────────────
// INIT WHATSAPP
// ─────────────────────────────
async function initWhatsApp() {
    if (waIniting) return;
    waIniting = true;

    try {
        const { Client, LocalAuth } = require('whatsapp-web.js');
        const QRCode = require('qrcode');

        waClient = new Client({
            authStrategy: new LocalAuth({ dataPath: '/tmp/kamoa_auth' }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage'
                ]
            }
        });

        waClient.on('qr', async (qr) => {
            waQr = await QRCode.toDataURL(qr);
            waStatus = 'qr';
            io.emit('whatsapp_qr', { qr: waQr });
        });

        waClient.on('ready', () => {
            waStatus = 'connected';
            waInfo = waClient.info;
            console.log("WhatsApp CONNECTED 🚀");
            io.emit('whatsapp_status', { status: 'connected' });
        });

        waClient.on('disconnected', () => {
            waStatus = 'disconnected';
            waIniting = false;
        });

        await waClient.initialize();

    } catch (err) {
        console.error("WhatsApp error:", err.message);
        waStatus = 'error';
        waIniting = false;
        setTimeout(initWhatsApp, 10000);
    }
}

// ─────────────────────────────
// ROUTES
// ─────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'KAMOA SCADA RUNNING 🚀', whatsapp: waStatus });
});

app.get('/api/status', (req, res) => {
    res.json({ status: 'online', whatsapp: waStatus });
});

// ─────────────────────────────
// SOCKET.IO
// ─────────────────────────────
io.on('connection', (socket) => {
    socket.emit('whatsapp_status', { status: waStatus });
});

// ─────────────────────────────
// START SERVER (CRITICAL FIX)
// ─────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
    console.log(`
╔══════════════════════════════════════╗
║  🚀 KAMOA SCADA ONLINE               ║
║  🌐 PORT: ${PORT}                   ║
╚══════════════════════════════════════╝
    `);

    setTimeout(initWhatsApp, 5000);
});

module.exports = app;