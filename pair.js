import express from 'express';
import fs from 'fs';
import { makeWASocket, useMultiFileAuthState, delay, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
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
const BASE_URL = process.env.BASE_URL || 'https://glebot-session.onrender.com';
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
    
    if (!ENCRYPTION_KEY) {
        if (!encryptionWarningLogged) {
            console.warn(`⚠️ Encryption disabled - plain text!`);
            encryptionWarningLogged = true;
        }
        const compressed = zlib.deflateSync(credsBase64);
        const base64 = compressed.toString('base64');
        return `GleBot!${base64}`;
    }
    
    const compressed = zlib.deflateSync(credsBase64);
    const compressedBase64 = compressed.toString('base64');
    
    const dataToEncrypt = JSON.stringify({
        sessionId: sessionId,
        creds: compressedBase64
    });
    
    const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(dataToEncrypt, 'utf8', 'base64');
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

// ==================== PAIRING ENDPOINT ====================
router.get('/', async (req, res) => {
    const sessionId = makeid();
    let { number } = req.query;
    const sessionDir = path.join(TEMP_DIR, sessionId);
    
    const clientIp = req.headers['x-forwarded-for'] || req.ip;
    if (!checkRateLimit(clientIp)) {
        return res.status(429).json({ success: false, error: 'Rate limited. Please wait a minute.', sessionId });
    }
    
    console.log(`\n🔷 [${sessionId}] Pairing session started for ${number}`);
    
    let sock = null;
    let codeSent = false;
    let sessionExported = false;
    let userConnected = false;
    let cleaned = false;
    let reconnectTimer = null;
    let authState = null;
    let saveCredsFn = null;
    let version = null;
    let formattedNumber = null;
    
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        console.log(`🧹 [${sessionId}] Starting cleanup...`);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (sock) {
            sock.ev.removeAllListeners();
            try { sock.end(); } catch (e) {}
        }
        setTimeout(() => removeFile(sessionDir), 5000);
    };
    
    const attachEvents = (socket, numberToUse) => {
        socket.ev.on('creds.update', () => {
            console.log(`💾 [${sessionId}] creds.update`);
            if (saveCredsFn) saveCredsFn();
        });
        
        socket.ev.on('connection.update', async (update) => {
            if (sessionExported || cleaned) return;
            
            const { connection, lastDisconnect } = update;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            console.log(`[${sessionId}] State:`, connection || 'waiting', statusCode ? `(code: ${statusCode})` : '');
            
            // ✅ Only cleanup on close if code wasn't sent yet
            if (connection === 'close' && !codeSent && !sessionExported && !userConnected) {
                console.log(`🔴 [${sessionId}] Connection closed before code sent`);
                cleanup();
                return;
            }
            
            // ✅ Handle 515 restart - don't cleanup, wait for reconnect
            if (connection === 'close' && statusCode === 515 && codeSent && !sessionExported && !userConnected) {
                console.log(`🔄 [${sessionId}] Restart after code - waiting for user to enter code...`);
                // Set timeout for user to enter code
                if (reconnectTimer) clearTimeout(reconnectTimer);
                reconnectTimer = setTimeout(() => {
                    if (!userConnected && !sessionExported) {
                        console.log(`⏰ [${sessionId}] User didn't enter code in time`);
                        cleanup();
                    }
                }, 120000);
                return;
            }
            
            // ✅ Only cleanup on other closes if not connected
            if (connection === 'close' && !sessionExported && !userConnected) {
                console.log(`🔴 [${sessionId}] Connection closed without export`);
                cleanup();
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
                    const userJid = numberToUse + '@s.whatsapp.net';
                    
                    await socket.sendMessage(userJid, { text: sessionString });
                    
                    await socket.sendMessage(userJid, {
                        text: `⚠️ *DO NOT SHARE THIS SESSION WITH ANYONE* ⚠️

┌┤✑  Thanks for using GleBot
│└────────────┈ ⳹        
│ ©2026 GleBot Inc. All rights reserved.
└─────────────────┈ ⳹

📢 Join our channel: ${CHANNEL_LINK}`,
                        contextInfo: {
                            externalAdReply: {
                                title: "GleBot AI Channel",
                                body: "Join our community",
                                thumbnailUrl: "https://files.catbox.moe/9f1z2t.jpg",
                                mediaType: 1,
                                sourceUrl: CHANNEL_LINK,
                                showAdAttribution: true
                            }
                        }
                    });
                    
                    console.log(`✅ [${sessionId}] Session sent with warning and channel link`);
                    sessionExported = true;
                    
                    (async () => {
                        try {
                            const megaUrl = await uploadSession(sessionString, sessionId);
                            if (megaUrl && !megaUrl.startsWith('local://') && socket?.user) {
                                await socket.sendMessage(userJid, {
                                    text: `💾 *Mega Backup*\n\n${megaUrl}`
                                });
                            }
                        } catch (e) {}
                    })();
                    
                    // ✅ Cleanup after successful export
                    setTimeout(() => cleanup(), 30000);
                    
                } catch (err) {
                    console.error(`❌ [${sessionId}] Export failed:`, err);
                    cleanup();
                }
            }
        });
    };
    
    try {
        if (!number) {
            return res.status(400).json({ success: false, error: 'Phone number required', sessionId });
        }
        
        number = number.replace(/\D/g, '');
        const phone = pn('+' + number);
        if (!phone.isValid()) {
            return res.status(400).json({ success: false, error: 'Invalid number', sessionId });
        }
        
        formattedNumber = phone.getNumber('e164').replace('+', '');
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
        
        attachEvents(sock, formattedNumber);
        
        // ✅ Request pairing code after a simple delay
        setTimeout(async () => {
            if (codeSent || sessionExported || cleaned) return;
            
            try {
                console.log(`🔑 [${sessionId}] Requesting pairing code for ${formattedNumber}...`);
                
                // Wait for socket to stabilize
                await delay(3000);
                
                const code = await sock.requestPairingCode(formattedNumber);
                
                // Log the raw code
                console.log(`📝 Raw code from WhatsApp: "${code}"`);
                console.log(`📝 Code length: ${code.length}`);
                console.log(`📝 Code is numeric: ${/^\d+$/.test(code)}`);
                
                // Format code
                let formattedCode;
                if (code && code.length === 6 && /^\d+$/.test(code)) {
                    formattedCode = `${code.slice(0, 3)}-${code.slice(3)}`;
                } else {
                    formattedCode = code;
                }
                
                codeSent = true;
                
                console.log(`✅ [${sessionId}] Code: ${formattedCode}`);
                
                if (!res.headersSent && !cleaned) {
                    res.json({
                        success: true,
                        code: formattedCode,
                        sessionId,
                        message: 'Enter this code in WhatsApp',
                        instructions: [
                            '1. Open WhatsApp on your phone',
                            '2. Tap the 3 dots (Android) or Settings (iPhone)',
                            '3. Go to "Linked Devices"',
                            '4. Tap "Link a Device"',
                            `5. Enter this code: ${formattedCode}`,
                            '',
                            '⚠️ DO NOT SCAN A QR CODE - Enter the code manually!',
                            '',
                            '⏱️ Code expires in 2 minutes'
                        ],
                        expiresIn: 120
                    });
                }
                
            } catch (error) {
                console.error(`❌ [${sessionId}] Code error:`, error);
                if (!res.headersSent && !cleaned) {
                    res.status(500).json({ success: false, error: error.message, sessionId });
                }
                cleanup();
            }
        }, 5000);
        
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
