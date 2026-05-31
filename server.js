/**
 * KAMOA Control SCADA — server.js
 * WhatsApp via whatsapp-web.js + Puppeteer/Chrome
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
    cors: {
        origin: ['https://controlscada.pages.dev', 'http://localhost:3000', 'http://localhost:8080', '*'],
        methods: ['GET', 'POST']
    }
});
const PORT = process.env.PORT || 8080;

app.use(compression());
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.options('*', cors());
app.use(bodyParser.json({ limit: '20mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('./'));

// ── Chrome path ───────────────────────────────────────────────────────────────
function findChrome() {
    const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        process.env.CHROME_PATH,
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
    ].filter(Boolean);
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

// ── État global ───────────────────────────────────────────────────────────────
let waClient  = null;
let waStatus  = 'disconnected';
let waQr      = null;
let waInfo    = null;
let waIniting = false;
const nameCache = new Map();
const msgBuffer = {};

function storeMsgInBuffer(chatId, msg) {
    if (!msgBuffer[chatId]) msgBuffer[chatId] = [];
    if (!msgBuffer[chatId].find(m => m.id === msg.id)) {
        msgBuffer[chatId].push(msg);
        if (msgBuffer[chatId].length > 100) msgBuffer[chatId].shift();
    }
}

// ── Init WhatsApp ─────────────────────────────────────────────────────────────
async function initWhatsApp() {
    if (waIniting) return;
    waIniting = true;
    waStatus = 'initializing';
    io.emit('whatsapp_status', { status: 'initializing' });

    const chromePath = findChrome();
    if (!chromePath) {
        console.error('Chrome introuvable');
        waStatus = 'error'; waIniting = false;
        io.emit('whatsapp_status', { status: 'error', error: 'Chrome non trouvé' });
        return;
    }
    console.log('Chrome:', chromePath);

    const { Client, LocalAuth } = require('whatsapp-web.js');
    const QRCode = require('qrcode');

    try {
        waClient = new Client({
            authStrategy: new LocalAuth({ dataPath: '/tmp/kamoa_wwebjs_auth' }),
            puppeteer: {
                headless: true,
                executablePath: chromePath,
                args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--disable-extensions']
            }
        });

        waClient.on('qr', async (qr) => {
            console.log('QR généré');
            waQr = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
            waStatus = 'qr';
            io.emit('whatsapp_qr', { qr: waQr, status: 'qr' });
            io.emit('whatsapp_status', { status: 'qr' });
        });

        waClient.on('authenticated', () => {
            waStatus = 'authenticated';
            io.emit('whatsapp_status', { status: 'authenticated' });
        });

        waClient.on('ready', () => {
            waInfo = waClient.info;
            waStatus = 'connected'; waQr = null;
            console.log('WhatsApp connecté:', waInfo?.pushname, waInfo?.wid?.user);
            io.emit('whatsapp_status', { status: 'connected', phone: waInfo?.wid?.user, name: waInfo?.pushname });
        });

        waClient.on('disconnected', (reason) => {
            console.warn('WhatsApp déconnecté:', reason);
            waStatus = 'disconnected'; waQr = null; waInfo = null; waIniting = false;
            io.emit('whatsapp_status', { status: 'disconnected', reason });
        });

        waClient.on('auth_failure', (msg) => {
            console.error('Auth failure:', msg);
            waStatus = 'auth_failure'; waIniting = false;
            try { const d='/tmp/kamoa_wwebjs_auth'; if(fs.existsSync(d)) fs.rmSync(d,{recursive:true,force:true}); } catch(_){}
            io.emit('whatsapp_status', { status: 'auth_failure', error: String(msg) });
        });

        waClient.on('message', (msg) => {
            try {
                const chatId  = msg.from;
                const isGroup = chatId.endsWith('@g.us');
                const notify  = msg._data?.notifyName || '';
                const sender  = notify || msg.author || msg.from;
                const msgId   = msg.id._serialized;
                let mediaType = null;
                if (msg.hasMedia) {
                    const t = (msg.type||'').toLowerCase();
                    if (t==='image'||t==='sticker') mediaType='image';
                    else if (t==='video'||t==='gif') mediaType='video';
                    else if (t==='audio'||t==='ptt') mediaType='audio';
                    else if (t==='document') mediaType='document';
                    else mediaType=t;
                }
                const entry = { id:msgId, chatId, chatName:nameCache.get(chatId)||(isGroup?chatId:(notify||chatId)), isGroup, sender, body:msg.body, timestamp:msg.timestamp, fromMe:msg.fromMe, hasMedia:msg.hasMedia, mediaType, pushName:notify };
                storeMsgInBuffer(chatId, entry);
                io.emit('whatsapp_message', entry);
                if (!nameCache.has(chatId)) msg.getChat().then(c=>nameCache.set(chatId,c.name||notify||chatId)).catch(()=>{});
                if (msg.hasMedia) msg.downloadMedia().then(media=>{ if(media) io.emit('whatsapp_media_ready',{msgId,chatId,mimetype:media.mimetype,mediaType,data:media.data,filename:media.filename||null}); }).catch(()=>{});
            } catch(e) { console.error('message handler:', e.message); }
        });

        waClient.on('message_ack', (msg, ack) => {
            io.emit('whatsapp_msg_ack', { msgId: msg.id._serialized, chatId: msg.from||msg.to, ack });
        });

        await waClient.initialize();
        console.log('WhatsApp client démarré');
    } catch(err) {
        console.error('init error:', err.message);
        waStatus = 'error'; waIniting = false;
        io.emit('whatsapp_status', { status: 'error', error: err.message });
        setTimeout(initWhatsApp, 15000);
    }
}

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log('WS client connecté:', socket.id);
    socket.emit('whatsapp_status', { status: waStatus, phone: waInfo?.wid?.user||null, name: waInfo?.pushname||null });
    if (waQr && waStatus === 'qr') socket.emit('whatsapp_qr', { qr: waQr, status: 'qr' });
});

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status:'online', whatsapp:{ status:waStatus, phone:waInfo?.wid?.user } }));

app.get('/api/whatsapp/status', (req, res) => res.json({ success:true, status:waStatus, phone:waInfo?.wid?.user||null, name:waInfo?.pushname||null, connected:waStatus==='connected' }));

app.get('/api/whatsapp/qrcode', (req, res) => {
    if (waStatus==='connected') return res.json({ success:true, status:'connected', phone:waInfo?.wid?.user });
    if (!waQr) return res.status(404).json({ error:'QR pas encore prêt' });
    res.json({ success:true, qrCode:waQr });
});

app.get('/api/whatsapp/chats', async (req, res) => {
    if (waStatus!=='connected'||!waClient) return res.status(503).json({ error:'WhatsApp non connecté', status:waStatus });
    try {
        const chats = await waClient.getChats();
        const groups=[], contacts=[];
        for (const c of chats) {
            const id = c.id._serialized;
            nameCache.set(id, c.name||c.id.user);
            const item = { id, name:c.name||c.id.user||id, unreadCount:c.unreadCount||0, timestamp:c.timestamp, lastMessage:c.lastMessage?{body:(c.lastMessage.body||'').substring(0,100),timestamp:c.lastMessage.timestamp,fromMe:c.lastMessage.fromMe}:null };
            if (c.isGroup) { item.participants=c.groupMetadata?.participants?.length||0; groups.push(item); }
            else { item.phone=c.id.user; contacts.push(item); }
        }
        res.json({ success:true, groups, contacts });
    } catch(err) { res.status(500).json({ error:err.message }); }
});

app.get('/api/whatsapp/messages', async (req, res) => {
    const { chatId, limit=50 } = req.query;
    if (!chatId) {
        const summary={};
        Object.entries(msgBuffer).forEach(([cid,msgs])=>{ if(msgs.length) summary[cid]=msgs[msgs.length-1]; });
        return res.json({ success:true, chats:summary });
    }
    if (waStatus!=='connected'||!waClient) return res.json({ success:true, chatId, messages:msgBuffer[chatId]||[] });
    try {
        const chat = await waClient.getChatById(chatId);
        const messages = await chat.fetchMessages({ limit:parseInt(limit) });
        const result = messages.map(m=>({ id:m.id._serialized, sender:nameCache.get(m.author||m.from)||m._data?.notifyName||(m.author||m.from)||'?', body:m.body, timestamp:m.timestamp, fromMe:m.fromMe, hasMedia:m.hasMedia, mediaType:m.hasMedia?m.type:null }));
        res.json({ success:true, chatId, messages:result });
    } catch(_) { res.json({ success:true, chatId, messages:msgBuffer[chatId]||[] }); }
});

app.post('/api/whatsapp/send', async (req, res) => {
    const { to, message } = req.body;
    if (!to||!message) return res.status(400).json({ error:'to + message requis' });
    if (waStatus!=='connected'||!waClient) return res.status(503).json({ error:'WhatsApp non connecté' });
    try {
        const jid  = to.includes('@') ? to : to.replace(/\D/g,'')+' @s.whatsapp.net';
        const chat = await waClient.getChatById(jid);
        const sent = await chat.sendMessage(message);
        const ts   = sent.timestamp||Math.floor(Date.now()/1000);
        storeMsgInBuffer(jid, { id:sent.id._serialized, chatId:jid, body:message, fromMe:true, timestamp:ts, sender:waInfo?.pushname||'Moi' });
        res.json({ success:true, id:sent.id._serialized });
    } catch(err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/whatsapp/logout', async (req, res) => {
    try {
        if (waClient) { await waClient.destroy().catch(()=>{}); waClient=null; }
        waStatus='disconnected'; waQr=null; waInfo=null; waIniting=false; nameCache.clear();
        try { const d='/tmp/kamoa_wwebjs_auth'; if(fs.existsSync(d)) fs.rmSync(d,{recursive:true,force:true}); } catch(_){}
        io.emit('whatsapp_status',{status:'disconnected'});
        setTimeout(initWhatsApp,2000);
        res.json({ success:true, message:'Session réinitialisée, QR en cours...' });
    } catch(err) { res.status(500).json({ error:err.message }); }
});

app.post('/api/whatsapp/reconnect', async (req, res) => {
    res.json({ success:true, message:'Reconnexion en cours...' });
    if (waClient) { await waClient.destroy().catch(()=>{}); waClient=null; }
    waIniting=false;
    setTimeout(initWhatsApp,1000);
});

app.get('/', (req, res) => {
    const f=path.join(__dirname,'index.html');
    if (fs.existsSync(f)) return res.sendFile(f);
    res.json({ status:'KAMOA SCADA API online', whatsapp:waStatus });
});
app.use((req,res)=>res.status(404).json({error:'Route introuvable'}));

// ── Démarrage ─────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║  🚀 KAMOA Control SCADA                          ║
║  📱 WhatsApp via whatsapp-web.js + Chrome        ║
║  🌐 Port: ${PORT}                                   ║
╚══════════════════════════════════════════════════╝`);
    setTimeout(initWhatsApp, 3000);
});

module.exports = app;
