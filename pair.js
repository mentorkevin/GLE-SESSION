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
    
    // No encryption - plain compressed
    if (!ENCRYPTION_KEY) {
        if (!encryptionWarningLogged) {
            console.warn(`⚠️ Encryption disabled - plain text!`);
            encryptionWarningLogged = true;
        }
        const compressed = zlib.deflateSync(credsBase64);
        const base64 = compressed.toString('base64');
        return `GleBot!${base64}`;
    }
    
    // ✅ STEP 1: Compress the creds first
    const compressed = zlib.deflateSync(credsBase64);
    const compressedBase64 = compressed.toString('base64');
    
    // ✅ STEP 2: Package includes sessionId for later decryption
    const dataToEncrypt = JSON.stringify({
        sessionId: sessionId,
        creds: compressedBase64
    });
    
    // ✅ STEP 3: Derive key using ENCRYPTION_KEY ONLY
    const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(dataToEncrypt, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');
    
    // ✅ STEP 4: Format: GleBot!iv:encrypted:authTag
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
    let pairingCode = null;
    
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
                        attachEvents(sock, numberToUse);
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
                    const userJid = numberToUse + '@s.whatsapp.net';
                    
                    // Split session into chunks if too long (WhatsApp has message limit)
                    const maxChunkSize = 65000;
                    if (sessionString.length > maxChunkSize) {
                        const chunks = [];
                        for (let i = 0; i < sessionString.length; i += maxChunkSize) {
                            chunks.push(sessionString.slice(i, i + maxChunkSize));
                        }
                        
                        // Send first chunk with header
                        await socket.sendMessage(userJid, { 
                            text: `🔐 *GleBot Session* (Part 1/${chunks.length})\n\n${chunks[0]}` 
                        });
                        
                        // Send remaining chunks
                        for (let i = 1; i < chunks.length; i++) {
                            await delay(2000);
                            await socket.sendMessage(userJid, { 
                                text: `📦 *Part ${i+1}/${chunks.length}*\n\n${chunks[i]}` 
                            });
                        }
                        
                        await socket.sendMessage(userJid, { 
                            text: `✅ *Session Complete!*\n\nTotal: ${chunks.length} parts\nSave this session securely.` 
                        });
                    } else {
                        await socket.sendMessage(userJid, { text: sessionString });
                    }
                    
                    // Send warning and channel link
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
                    
                    // Background Mega upload
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
        if (!number) {
            return res.status(400).json({ success: false, error: 'Phone number required', sessionId });
        }
        
        // Clean and format phone number
        number = number.replace(/\D/g, '');
        
        // Ensure number has country code (default to international format)
        if (number.length === 10) {
            // Assume US/CA numbers if 10 digits (add 1)
            number = '1' + number;
        }
        
        const phone = pn('+' + number);
        if (!phone.isValid()) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid number. Please include country code (e.g., 1234567890 for US)', 
                sessionId 
            });
        }
        
        // Get formatted number without + for pairing
        formattedNumber = phone.getNumber('e164').replace('+', '');
        
        console.log(`📱 [${sessionId}] Formatted number: ${formattedNumber}`);
        
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
        
        // Request pairing code after socket is ready
        setTimeout(async () => {
            if (codeSent || sessionExported || cleaned) return;
            
            try {
                console.log(`🔑 [${sessionId}] Requesting pairing code for ${formattedNumber}...`);
                
                // Wait for socket to be ready
                await delay(2000);
                
                // Request pairing code
                const code = await sock.requestPairingCode(formattedNumber);
                
                if (code) {
                    // Format code with hyphens for display (e.g., 123-456-789)
                    const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                    pairingCode = code;
                    codeSent = true;
                    
                    console.log(`✅ [${sessionId}] Pairing code: ${formattedCode}`);
                    console.log(`📱 Tell user to enter: ${formattedCode} in WhatsApp > Settings > Linked Devices`);
                    
                    if (!res.headersSent && !cleaned) {
                        res.json({
                            success: true,
                            code: formattedCode,
                            rawCode: code,
                            sessionId,
                            message: 'Enter this code in WhatsApp',
                            instructions: [
                                '1. Open WhatsApp on your phone',
                                '2. Go to Settings (3 dots)',
                                '3. Tap "Linked Devices"',
                                '4. Tap "Link a Device"',
                                `5. Enter this code: ${formattedCode}`,
                                '6. Wait for connection...'
                            ],
                            expiresIn: 120,
                            note: 'Code expires in 2 minutes'
                        });
                    }
                } else {
                    throw new Error('No code received from WhatsApp');
                }
                
            } catch (error) {
                console.error(`❌ [${sessionId}] Code error:`, error.message);
                if (!res.headersSent && !cleaned) {
                    res.status(500).json({ 
                        success: false, 
                        error: `Failed to get pairing code: ${error.message}`,
                        sessionId,
                        help: 'Make sure the phone number is correct with country code'
                    });
                }
                cleanup();
            }
        }, 5000); // Increased delay to ensure socket is ready
        
        // Set timeout for entire process
        setTimeout(() => {
            if (!sessionExported && !cleaned) {
                console.log(`⏰ [${sessionId}] Session timeout - no connection established`);
                if (!res.headersSent && !codeSent) {
                    res.status(408).json({ 
                        success: false, 
                        error: 'Timeout waiting for connection',
                        sessionId 
                    });
                }
                cleanup();
            }
        }, 120000);
        
    } catch (error) {
        console.error(`❌ [${sessionId}] Fatal error:`, error);
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
        res.status(404).json({ success: false, error: 'Session not found or expired' });
    }
});

router.get('/status', (req, res) => {
    const sessions = fs.existsSync(TEMP_DIR) ? fs.readdirSync(TEMP_DIR).length : 0;
    res.json({
        success: true,
        activeSessions: sessions,
        maxSessions: MAX_SESSIONS,
        cleanupAge: CLEANUP_AGE / 1000 / 60 + ' minutes'
    });
});

export default router;
