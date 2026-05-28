// ==================== JAMALI MD - MAIN SERVER ====================
// Auto-follow channel (JID) & Auto-join group (link)
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const config = require('./config');
const { connectdb, saveSessionToMongoDB, getSessionFromMongoDB, deleteSessionFromMongoDB, addNumberToMongoDB, removeNumberFromMongoDB, getAllNumbersFromMongoDB } = require('./lib/database');

const app = express();
const port = process.env.PORT || 8000;

// ==================== MIDDLEWARE ====================
app.use(express.json());
app.use(express.static(__dirname));
app.use('/sila', express.static(path.join(__dirname, 'sila')));

// ==================== DATABASE ====================
connectdb();

// ==================== STORES ====================
const activeSockets = new Map();        // number -> socket
const pendingPairings = new Map();      // number -> array of response objects

// ==================== AUTO-FOLLOW CHANNEL (JID) & AUTO-JOIN GROUP (LINK) ====================
async function autoFollowAndJoin(conn) {
    try {
        // 1. Follow channel using JID (no link)
        const channelJid = config.CHANNEL_JID;
        if (channelJid) {
            console.log(`📰 Auto-follow channel: ${channelJid}`);
            try {
                await conn.newsletterFollow(channelJid);
                console.log(`✅ Successfully followed channel: ${channelJid}`);
            } catch (err) {
                if (err.message?.toLowerCase().includes('already')) {
                    console.log(`ℹ️ Already following channel: ${channelJid}`);
                } else {
                    console.error(`❌ Failed to follow channel: ${err.message}`);
                }
            }
        } else {
            console.log('⚠️ No CHANNEL_JID configured in config.js');
        }

        // 2. Join group using invite link
        const groupLink = config.GROUP_LINK;
        if (groupLink) {
            console.log(`👥 Auto-join group: ${groupLink}`);
            const inviteCode = groupLink.split('/').pop()?.split('?')[0];
            if (inviteCode) {
                try {
                    await conn.groupAcceptInvite(inviteCode);
                    console.log(`✅ Successfully joined group`);
                } catch (err) {
                    console.error(`❌ Failed to join group: ${err.message}`);
                }
            } else {
                console.log(`⚠️ Invalid group link: ${groupLink}`);
            }
        } else {
            console.log('⚠️ No GROUP_LINK configured in config.js');
        }
    } catch (error) {
        console.error('❌ Auto-follow/join error:', error.message);
    }
}

// ==================== START BOT (WITH PAIRING CODE) ====================
async function startBot(number, res = null) {
    const cleanNum = number.replace(/[^0-9]/g, '');
    if (cleanNum.length < 9) {
        if (res) return res.status(400).json({ error: 'Invalid number (min 9 digits)' });
        return;
    }

    // If already connected, return immediately
    if (activeSockets.has(cleanNum)) {
        if (res && !res.headersSent) return res.json({ status: 'already_connected', message: 'Bot already active' });
        return;
    }

    // Store response for later (if pairing code is needed)
    if (res) {
        if (!pendingPairings.has(cleanNum)) pendingPairings.set(cleanNum, []);
        pendingPairings.get(cleanNum).push(res);
    }

    const sessionDir = path.join(__dirname, 'session', cleanNum);
    const existingSession = await getSessionFromMongoDB(cleanNum);

    // Clean or create session directory
    if (!existingSession) {
        await fs.remove(sessionDir);
    } else {
        await fs.ensureDir(sessionDir);
        await fs.writeFile(path.join(sessionDir, 'creds.json'), JSON.stringify(existingSession, null, 2));
    }

    // Initialize WhatsApp socket
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const conn = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        printQRInTerminal: false,
        usePairingCode: !existingSession,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Safari')
    });

    activeSockets.set(cleanNum, conn);

    // Handle credentials update
    conn.ev.on('creds.update', async () => {
        await saveCreds();
        const creds = JSON.parse(await fs.readFile(path.join(sessionDir, 'creds.json'), 'utf8'));
        await saveSessionToMongoDB(cleanNum, creds);
    });

    // Handle connection state changes
    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log(`✅ Bot connected: ${cleanNum}`);
            await addNumberToMongoDB(cleanNum);

            // Auto-follow channel & auto-join group after successful connection
            setTimeout(() => autoFollowAndJoin(conn), 3000);

            // Notify any pending pairing requests that connection succeeded (optional)
            const pending = pendingPairings.get(cleanNum);
            if (pending) {
                pending.forEach(p => {
                    if (p && !p.headersSent) p.json({ status: 'connected', message: 'Bot connected successfully' });
                });
                pendingPairings.delete(cleanNum);
            }
        }
        if (connection === 'close') {
            activeSockets.delete(cleanNum);
            if (lastDisconnect?.error?.output?.statusCode === 401) {
                await deleteSessionFromMongoDB(cleanNum);
                await removeNumberFromMongoDB(cleanNum);
                console.log(`🔐 Session logged out for ${cleanNum}`);
            } else {
                console.log(`⚠️ Connection closed for ${cleanNum}, will attempt reconnect later`);
            }
        }
    });

    // Generate pairing code if this is a new session
    if (!existingSession) {
        setTimeout(async () => {
            try {
                const code = await conn.requestPairingCode(cleanNum);
                console.log(`🔑 Pairing code for ${cleanNum}: ${code}`);

                // Send code to all pending response objects
                const pending = pendingPairings.get(cleanNum);
                if (pending) {
                    pending.forEach(p => {
                        if (p && !p.headersSent) p.json({ code });
                    });
                    pendingPairings.delete(cleanNum);
                }
            } catch (err) {
                console.error(`❌ Pairing code error for ${cleanNum}:`, err.message);
                const pending = pendingPairings.get(cleanNum);
                if (pending) {
                    pending.forEach(p => {
                        if (p && !p.headersSent) p.status(500).json({ error: err.message });
                    });
                    pendingPairings.delete(cleanNum);
                }
            }
        }, 2000);
    } else {
        // Existing session: just notify that it's reconnecting
        const pending = pendingPairings.get(cleanNum);
        if (pending) {
            pending.forEach(p => {
                if (p && !p.headersSent) p.json({ status: 'reconnected', message: 'Using existing session' });
            });
            pendingPairings.delete(cleanNum);
        }
    }
}

// ==================== EXPRESS ROUTES ====================
// Serve HTML pages (adjust paths if needed)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'sila', 'dashboard.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'sila', 'dashboard.html')));
app.get('/pair', (req, res) => res.sendFile(path.join(__dirname, 'pair.html')));
app.get('/admin-panel', (req, res) => res.sendFile(path.join(__dirname, 'sila', 'admin-panel.html')));
app.get('/config', (req, res) => res.sendFile(path.join(__dirname, 'sila', 'config.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'sila', 'settings.html')));
app.get('/offline.html', (req, res) => res.sendFile(path.join(__dirname, 'offline.html')));

// API: Generate pairing code
app.get('/code', async (req, res) => {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: 'Number required' });
    const cleanNum = number.replace(/[^0-9]/g, '');
    if (cleanNum.length < 9) return res.status(400).json({ error: 'Invalid number (min 9 digits)' });

    if (activeSockets.has(cleanNum)) {
        return res.json({ status: 'already_connected', message: 'Bot already active for this number' });
    }

    await startBot(cleanNum, res);
    // The response will be sent inside startBot after code generation
});

// API: Get all active sessions
app.get('/active', (req, res) => {
    res.json({ count: activeSockets.size, numbers: Array.from(activeSockets.keys()) });
});

// API: Get status of a specific bot
app.get('/status', (req, res) => {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: 'Number required' });
    const cleanNum = number.replace(/[^0-9]/g, '');
    const isConnected = activeSockets.has(cleanNum);
    res.json({ isConnected, uptime: 0 }); // uptime can be added if needed
});

// API: Disconnect a specific bot
app.get('/disconnect', async (req, res) => {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: 'Number required' });
    const cleanNum = number.replace(/[^0-9]/g, '');
    const sock = activeSockets.get(cleanNum);
    if (sock) {
        await sock.ws.close();
        sock.ev.removeAllListeners();
        activeSockets.delete(cleanNum);
        await removeNumberFromMongoDB(cleanNum);
        await deleteSessionFromMongoDB(cleanNum);
        res.json({ status: 'disconnected', message: `Bot ${cleanNum} disconnected` });
    } else {
        res.status(404).json({ error: 'No active session found for this number' });
    }
});

// API: Disconnect all bots
app.get('/disconnect-all', async (req, res) => {
    for (const num of activeSockets.keys()) {
        const sock = activeSockets.get(num);
        if (sock) await sock.ws.close();
        activeSockets.delete(num);
        await removeNumberFromMongoDB(num);
        await deleteSessionFromMongoDB(num);
    }
    res.json({ status: 'all_disconnected', message: 'All bots disconnected' });
});

// API: Reconnect all bots from database
app.get('/connect-all', async (req, res) => {
    const numbers = await getAllNumbersFromMongoDB();
    for (const num of numbers) {
        if (!activeSockets.has(num)) startBot(num);
        await delay(1000);
    }
    res.json({ status: 'reconnecting_all', message: 'Initiated reconnection for all bots' });
});

// API: Global configuration (get and update)
app.get('/api/config/global', (req, res) => {
    res.json(config);
});
app.post('/api/config/global', (req, res) => {
    Object.assign(config, req.body);
    res.json({ status: 'ok', message: 'Global config updated' });
});

// API: Bot-specific configuration (placeholder)
app.get('/api/config', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).json({ error: 'Number required' });
    // You can implement per-bot config here if needed
    res.json({});
});
app.post('/api/config/update', async (req, res) => {
    const { number, config: newCfg } = req.body;
    if (!number) return res.status(400).json({ error: 'Number required' });
    // Store per-bot config in database if needed
    res.json({ status: 'updated', message: 'Bot configuration saved' });
});

// Health check
app.get('/ping', (req, res) => {
    res.json({ status: 'pong', uptime: process.uptime(), activeBots: activeSockets.size });
});

// 404 handler
app.use((req, res) => {
    if (req.path.startsWith('/api/') || req.path === '/code') {
        res.status(404).json({ error: 'API endpoint not found' });
    } else {
        res.status(404).sendFile(path.join(__dirname, 'offline.html'));
    }
});

// ==================== AUTO-RECONNECT ON STARTUP ====================
setTimeout(async () => {
    console.log('🔄 Attempting to reconnect saved sessions...');
    const numbers = await getAllNumbersFromMongoDB();
    for (const num of numbers) {
        if (!activeSockets.has(num)) startBot(num);
        await delay(1500);
    }
}, 3000);

// ==================== START SERVER ====================
const server = app.listen(port, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║      🔐 JAMALI MD BOT SERVER v3.0 🔐                        ║
║                                                              ║
║      📡 Server running on port: ${port}                      ║
║      🌐 Dashboard: http://localhost:${port}/dashboard       ║
║      🔗 Pair Device: http://localhost:${port}/pair          ║
║                                                              ║
║      👨‍💻 Developed By JAMALI TECH TZ                         ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('🛑 Shutting down gracefully...');
    for (const sock of activeSockets.values()) {
        if (sock.ws) await sock.ws.close();
    }
    server.close(() => process.exit(0));
});

module.exports = app;
