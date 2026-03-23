import express from 'express';
import fs from 'fs';
import { makeWASocket, useMultiFileAuthState, delay, Browsers, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import { uploadSession } from './mega.js';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import zlib from 'zlib';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `https://glebot-session.onrender.com`;
const CHANNEL_LINK = "https://whatsapp.com/channel/0029VbBTYeRJP215nxFl4I0x";

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
const RATE_LIMIT_MAP = new Map();

let cachedVersion = null;
let versionCacheTime = 0;
const VERSION_CACHE_TTL = 3600000;

function makeid() {
    return crypto.randomBytes(8).toString('hex');
}

function removeFile(filePath) {
    try { if (fs.existsSync(filePath)) fs.rmSync(filePath, { recursive: true, force: true }); } catch (e) {}
}

function getCredsFile(sessionDir) {
    try {
        const credsPath = path.join(sessionDir, 'creds.json');
        if (!fs.existsSync(credsPath)) return null;
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
        console.warn(`⚠️ Encryption disabled - plain text!`);
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
    const limit = RATE_LIMIT_MAP.get(ip) || [];
    const recent = limit.filter(t => now - t < 60000);
    if (recent.length >= 3) return false;
    recent.push(now);
    RATE_LIMIT_MAP.set(ip, recent);
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
        for (const [ip, times] of RATE_LIMIT_MAP.entries()) {
            const recent = times.filter(t => now - t < 60000);
            if (recent.length === 0) RATE_LIMIT_MAP.delete(ip);
            else RATE_LIMIT_MAP.set(ip, recent);
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
        return res.status(429).json({ success: false, error: 'Rate limited. Please wait a minute.' });
    }
    
    // Validate number - pure digits only, 10-15 digits
    if (!number || !/^\d{10,15}$/.test(number)) {
        return res.status(400).json({ 
            success: false, 
            error: 'Invalid phone number. Must be 10-15 digits only (no spaces, no +, no dashes).',
            example: '1234567890'
        });
    }
    
    console.log(`\n🔷 [${sessionId}] Pairing session started for ${number}`);
    
    let sock = null;
    let sessionExported = false;
    let userConnected = false;
    let cleaned = false;
    let authState = null;
    let saveCredsFn = null;
    let version = null;
    let responseSent = false;
    let pairingRequested = false;
    let connectionEstablished = false;
    
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
    
    const sendResponse = (data) => {
        if (!responseSent && !cleaned) {
            responseSent = true;
            res.json(data);
        }
    };
    
    try {
        // Delete any old session to ensure fresh pairing
        if (fs.existsSync(sessionDir)) {
            console.log(`🗑️ [${sessionId}] Removing old session directory (ensuring fresh start)`);
            removeFile(sessionDir);
        }
        fs.mkdirSync(sessionDir, { recursive: true });
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        authState = state;
        saveCredsFn = saveCreds;
        version = await getCachedVersion();
        
        // Log session state for debugging
        const hasExistingCreds = authState?.creds !== undefined;
        const isRegistered = authState?.creds?.registered === true;
        console.log(`[${sessionId}] Existing creds file: ${hasExistingCreds}`);
        console.log(`[${sessionId}] Session registered: ${isRegistered}`);
        
        // Create socket
        sock = makeWASocket({
            version,
            auth: authState,
            printQRInTerminal: true,
            browser: Browsers.ubuntu("GleBot"),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 30000,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000
        });
        
        // Handle credentials update
        sock.ev.on('creds.update', () => {
            console.log(`💾 [${sessionId}] creds.update`);
            if (saveCredsFn) saveCredsFn();
        });
        
        // Handle connection updates - exactly like qr.js
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            console.log(`[${sessionId}] Connection: ${connection}`);
            
            // Post-link tasks on connection === 'open'
            if (connection === 'open' && sock?.user?.id && !userConnected) {
                connectionEstablished = true;
                userConnected = true;
                console.log(`🎉 [${sessionId}] USER CONNECTED!`);
                console.log(`👤 User: ${sock.user.id}`);
                
                try {
                    // Wait for creds to be saved
                    await delay(2000);
                    
                    const credsBase64 = getCredsFile(sessionDir);
                    if (!credsBase64) {
                        throw new Error('creds.json not found after connection');
                    }
                    
                    const sessionString = encryptSession(credsBase64, sessionId);
                    const sessionFile = path.join(sessionDir, 'session.txt');
                    fs.writeFileSync(sessionFile, sessionString);
                    
                    console.log(`📤 [${sessionId}] Sending session...`);
                    const userJid = number + '@s.whatsapp.net';
                    
                    // Send session
                    await sock.sendMessage(userJid, { text: sessionString });
                    
                    // Send warning and channel link
                    await sock.sendMessage(userJid, {
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
                    
                    // Mega backup (background)
                    (async () => {
                        try {
                            const megaUrl = await uploadSession(sessionString, sessionId);
                            if (megaUrl && !megaUrl.startsWith('local://') && sock?.user) {
                                await sock.sendMessage(userJid, { text: `💾 *Mega Backup*\n\n${megaUrl}` });
                            }
                        } catch (e) {
                            console.error(`Mega backup failed:`, e.message);
                        }
                    })();
                    
                } catch (err) {
                    console.error(`❌ [${sessionId}] Export failed:`, err);
                }
            }
            
            // Handle close - check if it was a logout
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                
                console.log(`🔴 [${sessionId}] Connection closed, code: ${statusCode}, loggedOut: ${isLoggedOut}`);
                
                // If user logged out, we need to cleanup and allow new pairing
                if (isLoggedOut && !sessionExported) {
                    console.log(`⚠️ [${sessionId}] User logged out - clearing session for fresh pairing`);
                    cleanup();
                }
            }
        });
        
        // Always request pairing code for a fresh session
        // We deleted the old session directory, so it's definitely fresh
        console.log(`⏳ [${sessionId}] Waiting 2 seconds for socket to initialize...`);
        await delay(2000);
        
        console.log(`🔑 [${sessionId}] Requesting pairing code for ${number}...`);
        pairingRequested = true;
        
        try {
            const code = await sock.requestPairingCode(number);
            
            if (code) {
                // Format code with hyphens for display
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                console.log(`✅ [${sessionId}] Pairing code: ${formattedCode}`);
                
                sendResponse({
                    success: true,
                    code: formattedCode,
                    rawCode: code,
                    sessionId,
                    phoneNumber: number,
                    baseUrl: BASE_URL,
                    message: 'Enter this code in WhatsApp',
                    instructions: [
                        '1. Open WhatsApp on your phone',
                        '2. Go to Settings → Linked Devices',
                        '3. Tap "Link a Device"',
                        `4. Enter this code: ${formattedCode}`,
                        '5. Wait for connection...'
                    ],
                    note: 'Code expires in 2 minutes'
                });
            } else {
                throw new Error('No code received from WhatsApp');
            }
            
        } catch (error) {
            // Log EVERY error from requestPairingCode
            console.error(`❌ [${sessionId}] requestPairingCode() ERROR:`);
            console.error(`   Message: ${error.message}`);
            console.error(`   Stack: ${error.stack}`);
            
            sendResponse({
                success: false,
                error: `Pairing failed: ${error.message}`,
                sessionId,
                fallback: true,
                message: 'Pairing code failed. Check server logs.'
            });
            cleanup();
            return;
        }
        
        // Single timeout: 180 seconds, no premature cleanup
        setTimeout(() => {
            if (!sessionExported && !cleaned) {
                console.log(`⏰ [${sessionId}] Timeout after 180s`);
                if (!responseSent) {
                    sendResponse({ 
                        success: false, 
                        error: 'Timeout waiting for connection',
                        sessionId 
                    });
                }
                cleanup();
            }
        }, 180000);
        
    } catch (error) {
        console.error(`❌ [${sessionId}] Fatal error:`, error);
        if (!responseSent && !cleaned) {
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
        maxSessions: MAX_SESSIONS,
        baseUrl: BASE_URL
    });
});

export default router;
