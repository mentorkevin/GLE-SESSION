import express from 'express';
import fs from 'fs';
import { makeWASocket, useMultiFileAuthState, delay, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { uploadSession } from './mega.js';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import zlib from 'zlib';

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
const CHANNEL_JID = "120363422461414831@newsletter";
const CHANNEL_LINK = "https://whatsapp.com/channel/0029VbBTYeRJP215nxFl4I0x";

function makeid() {
    return crypto.randomBytes(8).toString('hex');
}

function removeFile(filePath) {
    try { if (fs.existsSync(filePath)) fs.rmSync(filePath, { recursive: true, force: true }); } catch (e) {}
}

function getCredsFile(sessionDir) {
    try {
        const credsPath = path.join(sessionDir, 'creds.json');
        if (!fs.existsSync(credsPath)) {
            return null;
        }
        const content = fs.readFileSync(credsPath);
        return content.toString('base64');
    } catch (err) {
        console.error(`Failed to read creds.json:`, err);
        return null;
    }
}

function encryptSession(credsBase64, sessionId) {
    const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
    
    const dataWithMarker = `AI:${credsBase64}`;
    
    if (!ENCRYPTION_KEY) {
        if (!encryptionWarningLogged) {
            console.warn(`⚠️ Encryption disabled - plain text!`);
            encryptionWarningLogged = true;
        }
        const compressed = zlib.deflateSync(dataWithMarker);
        const base64 = compressed.toString('base64');
        return `GleBot!${base64}`;
    }
    
    const key = crypto.createHash('sha256').update(ENCRYPTION_KEY + sessionId).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(dataWithMarker, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');
    
    return `GleBot!${iv.toString('base64')}:${encrypted}:${authTag}`;
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
    
    const attachEvents = (socket) => {
        socket.ev.on('creds.update', () => {
            console.log(`💾 [${sessionId}] creds.update`);
            if (saveCredsFn) saveCredsFn();
        });
        
        socket.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message) return;
            
            if (msg.message?.buttonsResponseMessage) {
                const buttonId = msg.message.buttonsResponseMessage.selectedButtonId;
                const from = msg.key.remoteJid;
                
                console.log(`📱 [${sessionId}] Button clicked: ${buttonId}`);
                
                if (buttonId.startsWith('glebot_get_session_')) {
                    const clickedSessionId = buttonId.replace('glebot_get_session_', '');
                    const sessionFile = path.join(TEMP_DIR, clickedSessionId, 'session.txt');
                    
                    if (fs.existsSync(sessionFile)) {
                        const sessionString = fs.readFileSync(sessionFile, 'utf8');
                        await socket.sendMessage(from, { text: sessionString });
                        console.log(`✅ [${sessionId}] Session sent via button click`);
                    } else {
                        await socket.sendMessage(from, { text: `❌ Session expired.` });
                    }
                }
            }
        });
        
        socket.ev.on('connection.update', async (update) => {
            if (sessionExported || cleaned) return;
            
            const { connection, qr, lastDisconnect } = update;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            console.log(`[${sessionId}] State:`, connection || 'waiting', statusCode ? `(code: ${statusCode})` : '');
            
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
                            '4. Scan this QR code'
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
            
            if (connection === 'close' && statusCode === 515 && !sessionExported && !userConnected) {
                console.log(`🔄 [${sessionId}] Restart detected - recreating socket...`);
                
                if (reconnectTimer) clearTimeout(reconnectTimer);
                
                setTimeout(() => {
                    if (!userConnected && !sessionExported && !cleaned) {
                        console.log(`🔁 [${sessionId}] Creating new socket after 515...`);
                        
                        if (sock) {
                            sock.ev.removeAllListeners();
                            try { sock.end(); } catch (e) {}
                        }
                        
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
                
                reconnectTimer = setTimeout(() => {
                    if (!userConnected && !sessionExported && !cleaned) {
                        console.log(`⏰ [${sessionId}] Reconnect timeout`);
                        cleanup();
                    }
                }, 60000);
                return;
            }
            
            if (connection === 'open' && socket?.user?.id && !userConnected) {
                userConnected = true;
                console.log(`🎉 [${sessionId}] USER CONNECTED!`);
                console.log(`👤 User: ${socket.user.id}`);
                
                if (reconnectTimer) clearTimeout(reconnectTimer);
                
                console.log(`⏳ [${sessionId}] Waiting for files...`);
                await delay(5000);
                
                try {
                    const credsBase64 = getCredsFile(sessionDir);
                    
                    if (!credsBase64) {
                        throw new Error('creds.json not found');
                    }
                    
                    const sessionString = encryptSession(credsBase64, sessionId);
                    const sessionFile = path.join(sessionDir, 'session.txt');
                    fs.writeFileSync(sessionFile, sessionString);
                    
                    console.log(`📤 [${sessionId}] Sending session...`);
                    console.log(`📏 Session string length: ${sessionString.length} chars`);
                    
                    // 1. Send session string (clean)
                    await socket.sendMessage(socket.user.id, { text: sessionString });
                    
                    // 2. Send warning, thank you, and channel invite
                    await socket.sendMessage(socket.user.id, {
                        text: `⚠️ *DO NOT SHARE THIS SESSION WITH ANYONE* ⚠️

┌┤✑  Thanks for using GleBot
│└────────────┈ ⳹        
│ ©2026 GleBot Inc. All rights reserved.
└─────────────────┈ ⳹

📢 Join our channel below`,

                        contextInfo: {
                            mentionedJid: [CHANNEL_JID],

                            externalAdReply: {
                                title: "GleBot AI Channel",
                                body: "Tap image to join channel",
                                thumbnailUrl: "https://files.catbox.moe/9f1z2t.jpg",
                                mediaType: 1,
                                renderLargerThumbnail: true,
                                showAdAttribution: true,
                                sourceUrl: CHANNEL_LINK
                            }
                        }
                    });
                    
                    console.log(`✅ [${sessionId}] Session sent with warning and channel invite`);
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
        
        setTimeout(() => {
            if (!qrSent && !res.headersSent && !cleaned) {
                res.status(504).json({ success: false, error: 'QR timeout', sessionId });
                cleanup();
            }
        }, 45000);
        
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

router.get('/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const sessionDir = path.join(TEMP_DIR, sessionId);
    const sessionFile = path.join(sessionDir, 'session.txt');
    
    if (fs.existsSync(sessionFile)) {
        const sessionString = fs.readFileSync(sessionFile, 'utf8');
        res.json({ success: true, sessionString });
    } else {
        res.status(404).json({ success: false, error: 'Session not found' });
    }
});

export default router;
