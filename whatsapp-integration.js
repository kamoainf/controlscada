/**
 * KAMOA SCADA - WhatsApp Frontend Integration
 * Compatible server.js whatsapp-web.js (Northflank)
 */

class WhatsAppIntegration {
    constructor(config = {}) {
        this.baseUrl = config.baseUrl || window.location.origin;
        this.status = 'disconnected';
        this.qr = null;
        this.listeners = {};
        this.polling = null;
    }

    // ─────────────────────────────
    // INIT
    // ─────────────────────────────
    async init() {
        console.log("🔄 WhatsApp init...");

        this.startPolling();

        this.emit("init", {
            status: "starting"
        });

        return true;
    }

    // ─────────────────────────────
    // POLLING SERVER
    // ─────────────────────────────
    startPolling() {
        if (this.polling) clearInterval(this.polling);

        this.polling = setInterval(async () => {
            await this.fetchStatus();
            await this.fetchQR();
        }, 3000);
    }

    // ─────────────────────────────
    // STATUS
    // ─────────────────────────────
    async fetchStatus() {
        try {
            const res = await fetch(`${this.baseUrl}/api/health`);
            const data = await res.json();

            if (data?.whatsapp) {
                this.status = data.whatsapp;
                this.emit("status", this.status);
            }

        } catch (err) {
            console.error("Status error:", err);
        }
    }

    // ─────────────────────────────
    // QR CODE
    // ─────────────────────────────
    async fetchQR() {
        try {
            const res = await fetch(`${this.baseUrl}/api/qrcode`);
            const data = await res.json();

            if (data?.qr) {
                this.qr = data.qr;
                this.emit("qr", this.qr);
            }

        } catch (err) {
            // ignore
        }
    }

    // ─────────────────────────────
    // SEND MESSAGE
    // ─────────────────────────────
    async sendMessage(number, message) {
        try {
            const res = await fetch(`${this.baseUrl}/api/send`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    to: number,
                    message
                })
            });

            return await res.json();

        } catch (err) {
            console.error("Send error:", err);
            return { error: err.message };
        }
    }

    // ─────────────────────────────
    // EVENT SYSTEM
    // ─────────────────────────────
    on(event, callback) {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event].push(callback);
    }

    emit(event, data) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(cb => cb(data));
        }
    }

    // ─────────────────────────────
    // STOP
    // ─────────────────────────────
    stop() {
        if (this.polling) clearInterval(this.polling);
        this.polling = null;
    }
}

// ─────────────────────────────
// EXPORT GLOBAL
// ─────────────────────────────
window.WhatsAppIntegration = WhatsAppIntegration;