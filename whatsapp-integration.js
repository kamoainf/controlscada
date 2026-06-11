/**
 * KAMOA SCADA — WhatsApp Frontend Integration  v3.1
 *
 * Utilise WebSocket natif (/ws) pour les notifications temps réel.
 * Fallback REST polling si le WebSocket n'est pas disponible.
 *
 * Nouveautés v3.1 :
 *   - deleteChat(chatId)              — supprime une conversation
 *   - sendMediaBase64(to, file, opt)  — envoie un fichier local (File/Blob)
 *
 * Événements émis :
 *   'status'          — { status: 'open'|'connecting'|'disconnected', phone? }
 *   'qr'              — { qr: 'data:image/png;base64,...' }
 *   'message'         — { messageId, from, fromMe, body, timestamp, pushName, isGroup }
 *   'message_status'  — { messageId, to, status }
 *   'chats_update'    — { count }
 *   'contacts_update' — { count }
 *   'chat_deleted'    — { chatId }
 *   'error'           — { message }
 */

class WhatsAppIntegration {
    constructor(config = {}) {
        this.baseUrl   = config.baseUrl || window.location.origin;
        this.wsUrl     = config.wsUrl   || this._buildWsUrl();
        this.status    = 'disconnected';
        this.phone     = null;
        this.qr        = null;
        this.listeners = {};

        // Internals
        this._ws          = null;
        this._wsReady     = false;
        this._reconnectMs = 3_000;
        this._reconnectTimer = null;
        this._pollTimer   = null;
        this._useFallback = false;
    }

    // ── URL WebSocket ─────────────────────────────────────────────────────────
    _buildWsUrl() {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${window.location.host}/ws`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INIT
    // ─────────────────────────────────────────────────────────────────────────
    async init() {
        console.log('🔄 WhatsApp init (Baileys/WebSocket)...');
        this._connectWs();
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // WEBSOCKET
    // ─────────────────────────────────────────────────────────────────────────
    _connectWs() {
        if (this._ws && this._ws.readyState <= 1) return;

        try {
            this._ws = new WebSocket(this.wsUrl);

            this._ws.onopen = () => {
                console.log('🔌 WS connecté');
                this._wsReady    = true;
                this._useFallback = false;
                this._reconnectMs = 3_000;
                if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
            };

            this._ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    this._handleServerMessage(msg);
                } catch (e) {
                    console.warn('WS parse error:', e);
                }
            };

            this._ws.onerror = () => {
                console.warn('⚠️ WS erreur — bascule sur polling REST');
                this._wsReady    = false;
                this._useFallback = true;
                this._startFallbackPolling();
            };

            this._ws.onclose = () => {
                console.log('🔌 WS fermé — reconnexion dans', this._reconnectMs, 'ms');
                this._wsReady = false;
                if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
                this._reconnectTimer = setTimeout(() => {
                    this._reconnectMs = Math.min(this._reconnectMs * 1.5, 30_000);
                    this._connectWs();
                }, this._reconnectMs);
            };

        } catch (e) {
            console.warn('WS non disponible — polling REST activé');
            this._useFallback = true;
            this._startFallbackPolling();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GESTION DES MESSAGES SERVEUR
    // ─────────────────────────────────────────────────────────────────────────
    _handleServerMessage(msg) {
        switch (msg.type) {
            case 'status':
                this.status = msg.status;
                this.phone  = msg.phone || null;
                this.emit('status', { status: msg.status, phone: msg.phone });
                break;

            case 'qr':
                this.qr = msg.qr;
                this.emit('qr', { qr: msg.qr });
                break;

            case 'message':
            case 'whatsapp_message':
                this.emit('message', msg.data);
                break;

            case 'message_status':
                this.emit('message_status', msg.data);
                break;

            case 'chats_update':
                this.emit('chats_update', { count: msg.count });
                break;

            case 'contacts_update':
                this.emit('contacts_update', { count: msg.count });
                break;

            case 'chat_deleted':
                this.emit('chat_deleted', { chatId: msg.chatId });
                break;

            default:
                break;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FALLBACK POLLING REST
    // ─────────────────────────────────────────────────────────────────────────
    _startFallbackPolling() {
        if (this._pollTimer) return;
        this._pollTimer = setInterval(async () => {
            await this._pollStatus();
            if (this.status !== 'open') await this._pollQR();
        }, 3_000);
    }

    async _pollStatus() {
        try {
            const res  = await fetch(`${this.baseUrl}/api/whatsapp/status`);
            const data = await res.json();
            if (data?.status && data.status !== this.status) {
                this.status = data.status;
                this.phone  = data.phone || null;
                this.emit('status', { status: data.status, phone: data.phone });
            }
        } catch (e) { /* ignore */ }
    }

    async _pollQR() {
        try {
            const res  = await fetch(`${this.baseUrl}/api/whatsapp/qrcode`);
            const data = await res.json();
            if (data?.qrCode && data.qrCode !== this.qr) {
                this.qr = data.qrCode;
                this.emit('qr', { qr: data.qrCode });
            }
        } catch (e) { /* ignore */ }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // API — ENVOYER UN MESSAGE TEXTE
    // ─────────────────────────────────────────────────────────────────────────
    async sendMessage(to, message) {
        try {
            const res = await fetch(`${this.baseUrl}/api/whatsapp/send`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ to, message }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            return data;
        } catch (err) {
            console.error('❌ sendMessage error:', err.message);
            this.emit('error', { message: err.message });
            return { success: false, error: err.message };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // API — ENVOYER UN MESSAGE À UN GROUPE
    // ─────────────────────────────────────────────────────────────────────────
    async sendGroupMessage(groupId, message) {
        try {
            const res = await fetch(`${this.baseUrl}/api/whatsapp/send-group`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ groupId, message }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            return data;
        } catch (err) {
            console.error('❌ sendGroupMessage error:', err.message);
            this.emit('error', { message: err.message });
            return { success: false, error: err.message };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // API — ENVOYER UN MÉDIA (URL externe)
    // ─────────────────────────────────────────────────────────────────────────
    async sendMedia(to, mediaUrl, options = {}) {
        try {
            const res = await fetch(`${this.baseUrl}/api/whatsapp/send-media`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    to,
                    mediaUrl,
                    mediaType: options.mediaType || 'image',
                    caption:   options.caption   || '',
                    filename:  options.filename  || '',
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            return data;
        } catch (err) {
            console.error('❌ sendMedia error:', err.message);
            this.emit('error', { message: err.message });
            return { success: false, error: err.message };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // API — ENVOYER UN FICHIER LOCAL (File/Blob → base64)          ★ NOUVEAU ★
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * @param {string}  to       — JID ou numéro
     * @param {File}    file     — objet File du <input type="file">
     * @param {object}  options  — { caption }
     */
    async sendMediaBase64(to, file, options = {}) {
        try {
            // Lire le fichier en base64
            const base64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload  = () => resolve(reader.result.split(',')[1]);
                reader.onerror = () => reject(new Error('Lecture fichier échouée'));
                reader.readAsDataURL(file);
            });

            const res = await fetch(`${this.baseUrl}/api/whatsapp/send-media-base64`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    to,
                    base64,
                    mimetype: file.type || 'application/octet-stream',
                    filename: file.name || 'fichier',
                    caption:  options.caption || '',
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            return data;
        } catch (err) {
            console.error('❌ sendMediaBase64 error:', err.message);
            this.emit('error', { message: err.message });
            return { success: false, error: err.message };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // API — RÉCUPÉRER LES CHATS
    // ─────────────────────────────────────────────────────────────────────────
    async getChats() {
        try {
            const res  = await fetch(`${this.baseUrl}/api/whatsapp/chats`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            return data;
        } catch (err) {
            console.error('❌ getChats error:', err.message);
            return { success: false, chats: [], error: err.message };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // API — RÉCUPÉRER LES GROUPES
    // ─────────────────────────────────────────────────────────────────────────
    async getGroups() {
        try {
            const res  = await fetch(`${this.baseUrl}/api/whatsapp/groups`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            return data;
        } catch (err) {
            console.error('❌ getGroups error:', err.message);
            return { success: false, groups: [], error: err.message };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // API — RÉCUPÉRER LES MESSAGES
    // ─────────────────────────────────────────────────────────────────────────
    async getMessages(chatId = '') {
        try {
            const qs   = chatId ? `?chatId=${encodeURIComponent(chatId)}` : '';
            const res  = await fetch(`${this.baseUrl}/api/whatsapp/messages${qs}`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            return data;
        } catch (err) {
            console.error('❌ getMessages error:', err.message);
            return { success: false, messages: [], error: err.message };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // API — PHOTO DE PROFIL
    // ─────────────────────────────────────────────────────────────────────────
    async getProfilePicture(jid) {
        try {
            const res  = await fetch(`${this.baseUrl}/api/whatsapp/profile-picture/${encodeURIComponent(jid)}`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            return data;
        } catch (err) {
            console.warn('⚠️ profile picture indisponible:', err.message);
            return { success: false, url: '', error: err.message };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // API — TÉLÉCHARGER UN MÉDIA REÇU
    // ─────────────────────────────────────────────────────────────────────────
    async getMedia(messageId) {
        try {
            const res  = await fetch(`${this.baseUrl}/api/whatsapp/media/${encodeURIComponent(messageId)}`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            return data;
        } catch (err) {
            console.error('❌ getMedia error:', err.message);
            return { success: false, error: err.message };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // API — RÉCUPÉRER LES CONTACTS
    // ─────────────────────────────────────────────────────────────────────────
    async getContacts() {
        try {
            const res  = await fetch(`${this.baseUrl}/api/whatsapp/contacts`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            return data;
        } catch (err) {
            console.error('❌ getContacts error:', err.message);
            return { success: false, contacts: [], error: err.message };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // API — SUPPRIMER UNE CONVERSATION                              ★ NOUVEAU ★
    // ─────────────────────────────────────────────────────────────────────────
    async deleteChat(chatId) {
        try {
            const res  = await fetch(`${this.baseUrl}/api/whatsapp/chat/${encodeURIComponent(chatId)}`, {
                method: 'DELETE',
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            return data;
        } catch (err) {
            console.error('❌ deleteChat error:', err.message);
            this.emit('error', { message: err.message });
            return { success: false, error: err.message };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // API — DÉCONNECTER / RÉINITIALISER
    // ─────────────────────────────────────────────────────────────────────────
    async logout() {
        try {
            const res  = await fetch(`${this.baseUrl}/api/whatsapp/logout`, { method: 'POST' });
            const data = await res.json();
            return data;
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SYSTÈME D'ÉVÉNEMENTS
    // ─────────────────────────────────────────────────────────────────────────
    on(event, callback) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(callback);
        return this;
    }

    off(event, callback) {
        if (!this.listeners[event]) return this;
        this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
        return this;
    }

    emit(event, data) {
        (this.listeners[event] || []).forEach(cb => {
            try { cb(data); } catch (e) { console.error(`Listener error [${event}]:`, e); }
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ARRÊT PROPRE
    // ─────────────────────────────────────────────────────────────────────────
    stop() {
        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
        if (this._pollTimer)      clearInterval(this._pollTimer);
        if (this._ws)             this._ws.close();
        this._ws      = null;
        this._wsReady = false;
        console.log('🛑 WhatsAppIntegration arrêtée');
    }
}

// ── Export global (browser) ───────────────────────────────────────────────────
if (typeof window !== 'undefined') {
    window.WhatsAppIntegration = WhatsAppIntegration;
}

// ── Export CommonJS (Node.js / tests) ────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
    module.exports = WhatsAppIntegration;
}
