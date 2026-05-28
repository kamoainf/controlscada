/**
 * WhatsApp Integration Module
 * Uses Evolution API (Railway/VPS)
 * Handles QR Code authentication and messaging
 */

class WhatsAppIntegration {
    constructor(config = {}) {
        this.apiBaseUrl = config.apiBaseUrl || 'https://your-railway-app.railway.app/api';
        this.apiKey = config.apiKey || localStorage.getItem('whatsapp_api_key');
        this.instanceName = config.instanceName || 'kamoa-instance-1';
        this.sessionActive = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 3000;
        this.listeners = {};
        this.messageQueue = [];
        this.lastQRRefresh = 0;
        this.qrRefreshInterval = 35000; // 35 seconds
    }

    /**
     * Initialize WhatsApp connection with QR Code
     */
    async init() {
        console.log('🔄 Initializing WhatsApp Integration...');
        
        try {
            // Check if instance exists
            const instanceExists = await this.checkInstance();
            
            if (!instanceExists) {
                await this.createInstance();
            }
            
            // Fetch QR Code
            await this.fetchQRCode();
            
            // Start connection monitoring
            this.startConnectionMonitoring();
            
            this.emit('init-success', {
                timestamp: new Date(),
                instanceName: this.instanceName
            });
            
            return true;
        } catch (error) {
            console.error('❌ WhatsApp initialization failed:', error);
            this.emit('init-error', error);
            return false;
        }
    }

    /**
     * Check if instance already exists
     */
    async checkInstance() {
        try {
            const response = await this.apiCall('GET', `/instances/${this.instanceName}`);
            return response.status === 'open' || response.status === 'connecting';
        } catch (error) {
            if (error.status === 404) return false;
            throw error;
        }
    }

    /**
     * Create new Evolution API instance
     */
    async createInstance() {
        try {
            console.log('📱 Creating new WhatsApp instance...');
            
            const response = await this.apiCall('POST', '/instances/create', {
                instanceName: this.instanceName,
                number: '', // Will be populated after QR scan
                integration: 'WHATSAPP-BAILEYS'
            });
            
            console.log('✅ Instance created successfully:', response);
            return response;
        } catch (error) {
            console.error('❌ Failed to create instance:', error);
            throw error;
        }
    }

    /**
     * Fetch QR Code for authentication
     */
    async fetchQRCode() {
        try {
            // Avoid excessive API calls
            const now = Date.now();
            if (now - this.lastQRRefresh < 5000) {
                return;
            }
            this.lastQRRefresh = now;

            const response = await this.apiCall('GET', `/instances/${this.instanceName}/qrcode/image`);
            
            if (response) {
                this.emit('qr-code', {
                    qrCode: response.base64 || response,
                    timestamp: new Date(),
                    expiresIn: 35
                });
                
                console.log('📲 QR Code fetched');
                return response;
            }
        } catch (error) {
            console.warn('⚠️ QR Code fetch failed:', error);
            // Retry after delay
            setTimeout(() => this.fetchQRCode(), this.reconnectDelay);
        }
    }

    /**
     * Monitor connection status and auto-refresh QR when needed
     */
    startConnectionMonitoring() {
        this.connectionCheckInterval = setInterval(async () => {
            try {
                const status = await this.getConnectionStatus();
                
                if (status === 'open') {
                    this.sessionActive = true;
                    this.reconnectAttempts = 0;
                    this.emit('connected', { status });
                    
                    // Process queued messages
                    this.processMessageQueue();
                } else if (status === 'connecting') {
                    this.emit('connecting', { status });
                    // Auto-refresh QR code
                    if (Date.now() - this.lastQRRefresh > this.qrRefreshInterval) {
                        await this.fetchQRCode();
                    }
                } else {
                    this.sessionActive = false;
                    this.emit('disconnected', { status });
                }
            } catch (error) {
                console.error('Connection check failed:', error);
            }
        }, 5000); // Check every 5 seconds
    }

    /**
     * Get current connection status
     */
    async getConnectionStatus() {
        try {
            const response = await this.apiCall('GET', `/instances/${this.instanceName}/connection/status`);
            return response.instance?.state || 'disconnected';
        } catch (error) {
            console.error('Failed to get connection status:', error);
            return 'error';
        }
    }

    /**
     * Send WhatsApp message
     */
    async sendMessage(to, text, options = {}) {
        const message = {
            to: this.formatPhoneNumber(to),
            text,
            ...options
        };

        if (!this.sessionActive) {
            console.warn('⏳ Session not active, queueing message...');
            this.messageQueue.push(message);
            return { queued: true };
        }

        try {
            const response = await this.apiCall('POST', `/instances/${this.instanceName}/send/text`, message);
            console.log('✉️ Message sent:', response);
            this.emit('message-sent', { ...message, response });
            return response;
        } catch (error) {
            console.error('❌ Failed to send message:', error);
            this.messageQueue.push(message); // Queue for retry
            this.emit('message-error', { message, error });
            throw error;
        }
    }

    /**
     * Send WhatsApp message with media (image, document, etc)
     */
    async sendMedia(to, mediaUrl, mediaType = 'image', caption = '') {
        if (!this.sessionActive) {
            console.warn('⏳ Session not active, queueing media message...');
            return { queued: true };
        }

        try {
            const endpoint = `/instances/${this.instanceName}/send/${mediaType}`;
            const response = await this.apiCall('POST', endpoint, {
                to: this.formatPhoneNumber(to),
                media: mediaUrl,
                caption
            });

            console.log('🖼️ Media sent:', response);
            this.emit('media-sent', { to, mediaUrl, response });
            return response;
        } catch (error) {
            console.error('❌ Failed to send media:', error);
            this.emit('media-error', { to, mediaUrl, error });
            throw error;
        }
    }

    /**
     * Send WhatsApp button message
     */
    async sendButtons(to, text, buttons) {
        if (!this.sessionActive) {
            return { queued: true };
        }

        try {
            const response = await this.apiCall('POST', `/instances/${this.instanceName}/send/buttons`, {
                to: this.formatPhoneNumber(to),
                title: text,
                buttons: buttons.map(btn => ({
                    displayText: btn.text,
                    id: btn.id
                }))
            });

            this.emit('buttons-sent', { to, buttons, response });
            return response;
        } catch (error) {
            console.error('❌ Failed to send buttons:', error);
            throw error;
        }
    }

    /**
     * Handle incoming messages webhook
     */
    handleIncomingMessage(data) {
        const message = {
            from: data.sender,
            text: data.message,
            timestamp: data.timestamp,
            messageId: data.key?.id,
            type: data.messageType || 'text'
        };

        console.log('📨 Incoming message:', message);
        this.emit('message-received', message);

        // Auto-reply for testing
        if (message.text?.toLowerCase().includes('ping')) {
            this.sendMessage(message.from, '🏓 Pong! I received your message.');
        }
    }

    /**
     * Process queued messages when connection is restored
     */
    async processMessageQueue() {
        if (this.messageQueue.length === 0) return;

        console.log(`📤 Processing ${this.messageQueue.length} queued messages...`);
        const queue = [...this.messageQueue];
        this.messageQueue = [];

        for (const message of queue) {
            try {
                await this.sendMessage(message.to, message.text, message);
            } catch (error) {
                console.error('Failed to send queued message:', error);
            }
        }
    }

    /**
     * Format phone number to WhatsApp format
     */
    formatPhoneNumber(number) {
        // Remove non-numeric characters
        const cleaned = number.replace(/\D/g, '');
        
        // Add country code if missing (example: +1 for US, +33 for France, +243 for DRC)
        if (cleaned.length === 9) {
            return `243${cleaned}@s.whatsapp.net`; // DRC example
        }
        
        return `${cleaned}@s.whatsapp.net`;
    }

    /**
     * Generic API call handler
     */
    async apiCall(method, endpoint, data = null) {
        try {
            const options = {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'x-api-key': this.apiKey
                }
            };

            if (data && (method === 'POST' || method === 'PUT')) {
                options.body = JSON.stringify(data);
            }

            const url = `${this.apiBaseUrl}${endpoint}`;
            const response = await fetch(url, options);

            if (!response.ok) {
                throw {
                    status: response.status,
                    message: `API Error: ${response.statusText}`
                };
            }

            return await response.json();
        } catch (error) {
            console.error(`API Call Error [${method} ${endpoint}]:`, error);
            throw error;
        }
    }

    /**
     * Disconnect WhatsApp session
     */
    async disconnect() {
        try {
            clearInterval(this.connectionCheckInterval);
            await this.apiCall('DELETE', `/instances/${this.instanceName}`);
            this.sessionActive = false;
            this.emit('disconnected', { manual: true });
            console.log('✅ WhatsApp session disconnected');
        } catch (error) {
            console.error('Failed to disconnect:', error);
        }
    }

    /**
     * Event listener registration
     */
    on(event, callback) {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event].push(callback);
    }

    /**
     * Event emitter
     */
    emit(event, data) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(callback => callback(data));
        }
    }

    /**
     * Get instance info
     */
    async getInstanceInfo() {
        try {
            return await this.apiCall('GET', `/instances/${this.instanceName}`);
        } catch (error) {
            console.error('Failed to get instance info:', error);
            return null;
        }
    }

    /**
     * Set API configuration
     */
    setConfig(config) {
        this.apiBaseUrl = config.apiBaseUrl || this.apiBaseUrl;
        this.apiKey = config.apiKey || this.apiKey;
        this.instanceName = config.instanceName || this.instanceName;
        localStorage.setItem('whatsapp_api_key', this.apiKey);
    }
}

// Export for use in HTML
window.WhatsAppIntegration = WhatsAppIntegration;
