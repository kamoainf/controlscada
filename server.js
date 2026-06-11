/**
 * ══════════════════════════════════════════════════════════
 *  KAMOA — server.js  — NOUVELLES ROUTES À AJOUTER
 *  Insérer ces deux blocs AVANT la ligne :
 *    app.get('/', (_req, res) => { ...  (fallback HTML)
 * ══════════════════════════════════════════════════════════
 */

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
    const { to, base64, mimetype, caption = '', filename = 'fichier' } = req.body;

    if (!to || !base64 || !mimetype) {
        return res.status(400).json({ error: 'Champs requis : to, base64, mimetype' });
    }
    if (!waConnected || !waSocket) {
        return res.status(503).json({ error: 'WhatsApp non connecté', status: waStatus });
    }

    try {
        const jid    = String(to).includes('@g.us') ? toGroupJid(to) : toJid(to);
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

        const result    = await withTimeout(waSocket.sendMessage(jid, msgContent), 45_000, 'sendMediaBase64');
        const messageId = result?.key?.id ?? 'sent';
        console.log(`✅ Média base64 (${mimetype}) envoyé à ${to} — id: ${messageId}`);
        res.json({ success: true, messageId, status: 'sent', mimetype });
    } catch (err) {
        console.error(`❌ Erreur envoi média base64 à ${to}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});
