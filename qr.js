import express from 'express';
import fs from 'fs';
import { makeWASocket, useMultiFileAuthState, delay, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { uploadSession } from './mega.js';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

router.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

const TEMP_DIR = path.join(__dirname, 'temp_sessions');

if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const MAX_SESSIONS = 100;
const CLEANUP_AGE = 3600000;

let cachedVersion = null;
let versionCacheTime = 0;
const VERSION_CACHE_TTL = 3600000;

let encryptionWarningLogged = false;
const rateLimits = new Map();
const BASE_URL = process.env.BASE_URL || 'https://gle-session-2.onrender.com';

function makeid() {
    return crypto.randomBytes(8).toString('hex');
}

function removeFile(filePath) {
    try { if (fs.existsSync(filePath)) fs.rmSync(filePath, { recursive: true, force: true }); } catch (e) {}
}

function collectSessionFiles(sessionDir) {
    try {
        const sessionData = {};
        const files = fs.readdirSync(sessionDir);
        for (const file of files) {
            const filePath = path.join(sessionDir, file);
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
                const content = fs.readFileSync(filePath);
                sessionData[file] = content.toString('base64');
            }
        }
        return sessionData;
    } catch (err) {
        return {};
    }
}

function encryptSession(sessionData, sessionId) {
    const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
    if (!ENCRYPTION_KEY) {
        if (!encryptionWarningLogged) {
            console.warn(`⚠️ Encryption disabled - plain text!`);
            encryptionWarningLogged = true;
        }
        return JSON.stringify(sessionData);
    }
    
    const key = crypto.createHash('sha256').update(ENCRYPTION_KEY + sessionId).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(JSON.stringify(sessionData), 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');
    
    const package_ = { iv: iv.toString('base64'), data: encrypted, authTag, sessionId };
    return Buffer.from(JSON.stringify(package_)).toString('base64');
}

async function getCachedVersion() {
    try {
        const now = Date.now();
        if (cachedVersion && (now - versionCacheTime) < VERSION_CACHE_TTL) {
            return cachedVersion;
        }
        const { version } = await fetchLatestBaileysVersion();
        cachedVersion = version;
        versionCacheTime = now;
        return version;
    } catch (err) {
        return cachedVersion || [2, 3000, 1035194821];
    }
}

function checkRateLimit(ip) {
    const now = Date.now();
    const limit = rateLimits.get(ip) || [];
    const recent = limit.filter(t => now - t < 60000);
    if (recent.length >= 3) return false;
    recent.push(now);
    rateLimits.set(ip, recent);
    return true;
}

// Cleanup intervals
setInterval(() => {
    try {
        if (!fs.existsSync(TEMP_DIR)) return;
        const files = fs.readdirSync(TEMP_DIR);
        const now = Date.now();
        for (const file of files) {
            const filePath = path.join(TEMP_DIR, file);
            try {
                const stat = fs.statSync(filePath);
                if (now - stat.mtimeMs > CLEANUP_AGE) removeFile(filePath);
            } catch (e) {}
        }
        const sessions = fs.readdirSync(TEMP_DIR);
        if (sessions.length > MAX_SESSIONS) {
            sessions.sort((a, b) => {
                try {
                    const statA = fs.statSync(path.join(TEMP_DIR, a));
                    const statB = fs.statSync(path.join(TEMP_DIR, b));
                    return statA.mtimeMs - statB.mtimeMs;
                } catch (e) { return 0; }
            });
            const toDelete = sessions.slice(0, sessions.length - MAX_SESSIONS);
            for (const session of toDelete) removeFile(path.join(TEMP_DIR, session));
        }
    } catch (e) {}
}, 600000);

setInterval(() => {
    try {
        const now = Date.now();
        for (const [ip, times] of rateLimits.entries()) {
            const recent = times.filter(t => now - t < 60000);
            if (recent.length === 0) rateLimits.delete(ip);
            else rateLimits.set(ip, recent);
        }
    } catch (e) {}
}, 60000);

// ==================== QR ENDPOINT ====================
router.get('/', async (req, res) => {
    const sessionId = makeid();
    const sessionDir = path.join(TEMP_DIR, sessionId);
    
    const clientIp = req.headers['x-forwarded-for'] || req.ip;
    if (!checkRateLimit(clientIp)) {
        return res.status(429).json({ success: false, error: 'Rate limited. Please wait a minute.', sessionId });
    }
    
    console.log(`\n🔷 [${sessionId}] QR session started`);
    
    let sock = null;
    let qrSent = false;
    let sessionExported = false;
    let userConnected = false;
    let cleaned = false;
    let reconnectTimer = null;
    let authState = null;
    let saveCredsFn = null;
    let version = null;
    
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        console.log(`🧹 [${sessionId}] Cleanup...`);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (sock) {
            sock.ev.removeAllListeners();
            try { sock.end(); } catch (e) {}
        }
        setTimeout(() => removeFile(sessionDir), 5000);
    };
    
    // ✅ Function to attach event handlers to a socket
    const attachEvents = (socket) => {
        socket.ev.on('creds.update', () => {
            console.log(`💾 [${sessionId}] creds.update`);
            if (saveCredsFn) saveCredsFn();
        });
        
        socket.ev.on('connection.update', async (update) => {
            if (sessionExported || cleaned) return;
            
            const { connection, qr, lastDisconnect } = update;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            console.log(`[${sessionId}] State:`, connection || 'waiting', statusCode ? `(code: ${statusCode})` : '');
            
            // Send QR
            if (qr && !qrSent && !res.headersSent && !cleaned) {
                qrSent = true;
                try {
                    const qrImage = await QRCode.toDataURL(qr);
                    res.json({ 
                        success: true, 
                        qr: qrImage, 
                        sessionId,
                        message: 'Scan QR with WhatsApp',
                        instructions: [
                            '1. Open WhatsApp on your phone',
                            '2. Tap Menu > Linked Devices',
                            '3. Tap "Link a Device"',
                            '4. Scan this QR code',
                            '',
                            `Session ID: ${sessionId}`,
                            `Manual retrieval: ${BASE_URL}/qr/session/${sessionId}`
                        ]
                    });
                    console.log(`✅ [${sessionId}] QR sent`);
                } catch (err) {
                    if (!res.headersSent) {
                        res.status(500).json({ success: false, error: 'QR generation failed', sessionId });
                    }
                    cleanup();
                }
            }
            
            // ✅ Detect 515 restart - RECREATE SOCKET
            if (connection === 'close' && statusCode === 515 && !sessionExported && !userConnected) {
                console.log(`🔄 [${sessionId}] Restart detected - recreating socket...`);
                
                if (reconnectTimer) clearTimeout(reconnectTimer);
                
                // Recreate socket with existing auth state after delay
                setTimeout(() => {
                    if (!userConnected && !sessionExported && !cleaned) {
                        console.log(`🔁 [${sessionId}] Creating new socket after 515...`);
                        
                        // Remove old listeners and close old socket
                        if (sock) {
                            sock.ev.removeAllListeners();
                            try { sock.end(); } catch (e) {}
                        }
                        
                        // Create new socket with same auth state
                        const newSock = makeWASocket({
                            version,
                            auth: authState,
                            printQRInTerminal: false,
                            browser: Browsers.ubuntu("Chrome"),
                            syncFullHistory: false,
                            markOnlineOnConnect: true,
                            keepAliveIntervalMs: 30000,
                            defaultQueryTimeoutMs: 60000,
                            connectTimeoutMs: 60000
                        });
                        
                        sock = newSock;
                        attachEvents(sock);
                        console.log(`✅ [${sessionId}] New socket created, waiting for connection...`);
                    }
                }, 3000);
                
                // Set overall reconnect timeout
                reconnectTimer = setTimeout(() => {
                    if (!userConnected && !sessionExported && !cleaned) {
                        console.log(`⏰ [${sessionId}] Reconnect timeout`);
                        cleanup();
                    }
                }, 60000);
                return;
            }
            
            // ✅ Login detected
            if (connection === 'open' && socket?.user?.id && !userConnected) {
                userConnected = true;
                console.log(`🎉 [${sessionId}] USER CONNECTED!`);
                console.log(`👤 User: ${socket.user.id}`);
                
                if (reconnectTimer) clearTimeout(reconnectTimer);
                
                // Wait for files
                console.log(`⏳ [${sessionId}] Waiting for files...`);
                await delay(8000);
                
                try {
                    const sessionFiles = collectSessionFiles(sessionDir);
                    
                    if (!sessionFiles["creds.json"]) {
                        throw new Error('creds.json missing');
                    }
                    
                    const sessionPackage = {
                        id: sessionId,
                        user: socket.user.id,
                        timestamp: Date.now(),
                        files: sessionFiles
                    };
                    
                    const sessionString = encryptSession(sessionPackage, sessionId);
                    const sessionFile = path.join(sessionDir, 'session.txt');
                    fs.writeFileSync(sessionFile, sessionString);
                    
                    console.log(`📤 [${sessionId}] Sending session...`);
                    
                    // Send via WhatsApp
                    if (sessionString.length > 60000) {
                        await socket.sendMessage(socket.user.id, {
                            text: `🔐 Session too large! Use manual retrieval:\n${BASE_URL}/qr/session/${sessionId}`
                        });
                    } else {
                        await socket.sendMessage(socket.user.id, {
                            text: `🔐 *GLE Session String*\n\n\`${sessionString}\``
                        });
                    }
                    
                    await socket.sendMessage(socket.user.id, {
                        text: `✅ *Session Complete!*\n\nSession ID: \`${sessionId}\``
                    });
                    
                    console.log(`✅ [${sessionId}] Session sent`);
                    sessionExported = true;
                    
                    // Background Mega upload
                    (async () => {
                        try {
                            const megaUrl = await uploadSession(sessionString, sessionId);
                            if (megaUrl && !megaUrl.startsWith('local://') && socket?.user) {
                                await socket.sendMessage(socket.user.id, {
                                    text: `💾 *Mega Backup*\n\n${megaUrl}`
                                });
                            }
                        } catch (e) {}
                    })();
                    
                    setTimeout(() => cleanup(), 30000);
                    
                } catch (err) {
                    console.error(`❌ [${sessionId}] Export failed:`, err);
                    cleanup();
                }
            }
            
            // Handle other closes
            if (connection === 'close' && !sessionExported && !userConnected) {
                console.log(`🔴 [${sessionId}] Connection closed without export`);
                cleanup();
            }
        });
    };
    
    try {
        fs.mkdirSync(sessionDir, { recursive: true });
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        authState = state;
        saveCredsFn = saveCreds;
        version = await getCachedVersion();
        
        // Create initial socket
        sock = makeWASocket({
            version,
            auth: authState,
            printQRInTerminal: false,
            browser: Browsers.ubuntu("Chrome"),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 30000,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000
        });
        
        attachEvents(sock);
        
        // QR timeout
        setTimeout(() => {
            if (!qrSent && !res.headersSent && !cleaned) {
                res.status(504).json({ success: false, error: 'QR timeout', sessionId });
                cleanup();
            }
        }, 45000);
        
        // Overall timeout
        setTimeout(() => {
            if (!sessionExported && !cleaned) {
                console.log(`⏰ [${sessionId}] Timeout`);
                cleanup();
            }
        }, 180000);
        
    } catch (error) {
        console.error(`Fatal:`, error);
        if (!res.headersSent && !cleaned) {
            res.status(500).json({ success: false, error: error.message, sessionId });
        }
        cleanup();
    }
});

// Session retrieval
router.get('/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const sessionDir = path.join(TEMP_DIR, sessionId);
    const sessionFile = path.join(sessionDir, 'session.txt');
    
    if (fs.existsSync(sessionFile)) {
        const sessionString = fs.readFileSync(sessionFile, 'utf8');
        res.json({ success: true, sessionString, sessionId });
    } else {
        res.status(404).json({ success: false, error: 'Session not found', sessionId });
    }
});

export default router;
