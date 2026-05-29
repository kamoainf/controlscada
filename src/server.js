const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const compression = require('compression');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(compression());
app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Serve static files (HTML, CSS, JS)
app.use(express.static('./'));

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date(),
        version: '1.0.0',
        app: 'KAMOA Control SCADA'
    });
});

// WhatsApp webhook for receiving messages
app.post('/api/webhooks/whatsapp', (req, res) => {
    try {
        const data = req.body;
        console.log('📨 WhatsApp Webhook received:', data);
        
        // Emit event to frontend via WebSocket or store in database
        res.json({ 
            success: true, 
            message: 'Webhook processed',
            receivedAt: new Date()
        });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: error.message });
    }
});

// API Configuration endpoint
app.post('/api/whatsapp/config', (req, res) => {
    try {
        const { apiKey, apiBaseUrl, instanceName } = req.body;
        
        // Store configuration (in production, use secure storage)
        process.env.WHATSAPP_API_KEY = apiKey;
        process.env.WHATSAPP_API_BASE_URL = apiBaseUrl;
        process.env.INSTANCE_NAME = instanceName;
        
        res.json({
            success: true,
            message: 'WhatsApp configuration updated',
            config: {
                apiBaseUrl,
                instanceName
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Send message via WhatsApp
app.post('/api/whatsapp/send', async (req, res) => {
    try {
        const { to, message, mediaUrl, mediaType } = req.body;
        
        // Validate input
        if (!to || !message) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        console.log(`📤 Sending WhatsApp message to ${to}`);
        
        // Forward to Evolution API
        const apiKey = process.env.WHATSAPP_API_KEY;
        const apiBaseUrl = process.env.WHATSAPP_API_BASE_URL;
        const instanceName = process.env.INSTANCE_NAME;
        
        if (!apiKey || !apiBaseUrl) {
            return res.status(400).json({ error: 'WhatsApp not configured' });
        }
        
        // Make request to Evolution API
        const axios = require('axios');
        const evolutionResponse = await axios.post(
            `${apiBaseUrl}/instances/${instanceName}/send/text`,
            {
                to: to.replace(/\D/g, '') + '@s.whatsapp.net',
                text: message
            },
            {
                headers: {
                    'x-api-key': apiKey,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        res.json({
            success: true,
            message: 'Message sent',
            response: evolutionResponse.data
        });
    } catch (error) {
        console.error('Send message error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Get WhatsApp QR Code
app.get('/api/whatsapp/qrcode', async (req, res) => {
    try {
        const axios = require('axios');
        const apiKey = process.env.WHATSAPP_API_KEY;
        const apiBaseUrl = process.env.WHATSAPP_API_BASE_URL;
        const instanceName = process.env.INSTANCE_NAME;
        
        if (!apiKey || !apiBaseUrl) {
            return res.status(400).json({ error: 'WhatsApp not configured' });
        }
        
        const qrResponse = await axios.get(
            `${apiBaseUrl}/instances/${instanceName}/qrcode/image`,
            {
                headers: {
                    'x-api-key': apiKey
                }
            }
        );
        
        res.json({
            success: true,
            qrCode: qrResponse.data
        });
    } catch (error) {
        console.error('QR Code error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Default route - serve index.html
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║  🚀 KAMOA Control SCADA                ║
║  📱 WhatsApp Integration Active        ║
║  🌐 Server running on port ${PORT}      ║
╚════════════════════════════════════════╝
    `);
});

module.exports = app;
