import express from 'express';
import fs from 'fs';
import { makeWASocket, useMultiFileAuthState, delay, Browsers, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
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
    let authState = null;
    let saveCredsFn = null;
    let version = null;
    let formattedNumber = null;
    let pairingCodeRequested = false;
    
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        console.log(`🧹 [${sessionId}] Cleanup...`);
        if (sock) {
            sock.ev.removeAllListeners();
            try { sock.end(); } catch (e) {}
        }
        setTimeout(() => removeFile(sessionDir), 5000);
    };
    
    const attachEvents = (socket, numberToUse) => {
        // Handle credentials update
        socket.ev.on('creds.update', () => {
            console.log(`💾 [${sessionId}] creds.update`);
            if (saveCredsFn) saveCredsFn();
        });
        
        // Handle connection updates
        socket.ev.on('connection.update', async (update) => {
            if (sessionExported || cleaned) return;
            
            const { connection, lastDisconnect, qr } = update;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            console.log(`[${sessionId}] Connection state: ${connection || 'connecting'}`);
            
            // Handle QR code (fallback)
            if (qr && !codeSent && !pairingCodeRequested) {
                console.log(`📱 [${sessionId}] QR code received (fallback)`);
                if (!res.headersSent && !cleaned) {
                    res.json({
                        success: true,
                        qr: qr,
                        sessionId,
                        message: 'Scan QR code with WhatsApp',
                        fallback: true
                    });
                }
            }
            
            // Handle successful connection
            if (connection === 'open' && socket?.user?.id && !userConnected) {
                userConnected = true;
                console.log(`🎉 [${sessionId}] USER CONNECTED!`);
                console.log(`👤 User: ${socket.user.id}`);
                
                // Wait for creds to be saved
                await delay(3000);
                
                try {
                    const credsBase64 = getCredsFile(sessionDir);
                    
                    if (!credsBase64) {
                        throw new Error('creds.json not found');
                    }
                    
                    const sessionString = encryptSession(credsBase64, sessionId);
                    const sessionFile = path.join(sessionDir, 'session.txt');
                    fs.writeFileSync(sessionFile, sessionString);
                    
                    console.log(`📤 [${sessionId}] Sending session...`);
                    const userJid = numberToUse + '@s.whatsapp.net';
                    
                    // Send session string
                    await socket.sendMessage(userJid, { text: sessionString });
                    
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
                    
                    console.log(`✅ [${sessionId}] Session sent successfully`);
                    sessionExported = true;
                    
                    // Mega backup
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
            
            // Handle disconnection
            if (connection === 'close') {
                console.log(`🔴 [${sessionId}] Connection closed`);
                if (!sessionExported && !userConnected) {
                    cleanup();
                }
            }
        });
    };
    
    try {
        if (!number) {
            return res.status(400).json({ success: false, error: 'Phone number required', sessionId });
        }
        
        // Clean and format phone number
        number = number.replace(/\D/g, '');
        
        // Ensure number has country code
        if (number.length === 10) {
            number = '1' + number;
        }
        
        const phone = pn('+' + number);
        if (!phone.isValid()) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid number. Please include country code', 
                sessionId 
            });
        }
        
        formattedNumber = phone.getNumber('e164').replace('+', '');
        console.log(`📱 [${sessionId}] Formatted number: ${formattedNumber}`);
        
        fs.mkdirSync(sessionDir, { recursive: true });
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        authState = state;
        saveCredsFn = saveCreds;
        version = await getCachedVersion();
        
        // Create socket with proper configuration
        sock = makeWASocket({
            version,
            auth: authState,
            printQRInTerminal: false,
            browser: Browsers.ubuntu("GleBot"),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 30000,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            patchMessageBeforeSending: (message) => {
                const requiresPatch = !!(
                    message.buttonsMessage ||
                    message.templateMessage ||
                    message.listMessage
                );
                if (requiresPatch) {
                    message = {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: {
                                    deviceListMetadataVersion: 2,
                                    deviceListMetadata: {}
                                },
                                ...message
                            }
                        }
                    };
                }
                return message;
            }
        });
        
        attachEvents(sock, formattedNumber);
        
        // Wait for socket to be ready before requesting pairing code
        const waitForSocket = async () => {
            let attempts = 0;
            while (!sock.user && attempts < 20) {
                await delay(1000);
                attempts++;
                console.log(`[${sessionId}] Waiting for socket ready... (${attempts}/20)`);
            }
            
            if (!pairingCodeRequested && !codeSent && !userConnected && !cleaned) {
                pairingCodeRequested = true;
                try {
                    console.log(`🔑 [${sessionId}] Requesting pairing code for ${formattedNumber}...`);
                    
                    // Request pairing code
                    const code = await sock.requestPairingCode(formattedNumber);
                    
                    if (code) {
                        const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                        codeSent = true;
                        
                        console.log(`✅ [${sessionId}] Pairing code: ${formattedCode}`);
                        
                        if (!res.headersSent && !cleaned) {
                            res.json({
                                success: true,
                                code: formattedCode,
                                rawCode: code,
                                sessionId,
                                message: 'Enter this code in WhatsApp',
                                instructions: [
                                    '1. Open WhatsApp on your phone',
                                    '2. Go to Settings → Linked Devices',
                                    '3. Tap "Link a Device"',
                                    `4. Enter code: ${formattedCode}`,
                                    '5. Wait for connection...'
                                ],
                                expiresIn: 120
                            });
                        }
                    } else {
                        throw new Error('No code received');
                    }
                    
                } catch (error) {
                    console.error(`❌ [${sessionId}] Pairing code error:`, error.message);
                    
                    // Fallback to QR code
                    if (!res.headersSent && !cleaned) {
                        res.json({
                            success: true,
                            fallback: true,
                            sessionId,
                            message: 'Pairing code failed, please scan QR code',
                            qr: 'QR will appear in console'
                        });
                    }
                }
            }
        };
        
        // Start waiting for socket
        waitForSocket();
        
        // Set timeout
        setTimeout(() => {
            if (!sessionExported && !cleaned) {
                console.log(`⏰ [${sessionId}] Session timeout`);
                if (!res.headersSent) {
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
        res.status(404).json({ success: false, error: 'Session not found' });
    }
});

router.get('/status', (req, res) => {
    const sessions = fs.existsSync(TEMP_DIR) ? fs.readdirSync(TEMP_DIR).length : 0;
    res.json({
        success: true,
        activeSessions: sessions,
        maxSessions: MAX_SESSIONS
    });
});

export default router;
