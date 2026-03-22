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
    
    if (!number) {
        return res.status(400).json({ success: false, error: 'Phone number required', sessionId });
    }

    number = number.replace(/\D/g, '');
    const phone = pn('+' + number);
    if (!phone.isValid()) {
        return res.status(400).json({ success: false, error: 'Invalid number', sessionId });
    }

    const formattedNumber = phone.getNumber('e164').replace('+', '');
    console.log(`\n🔷 [${sessionId}] Pairing session started for ${formattedNumber}`);

    let sock = null;
    let codeSent = false;
    let sessionExported = false;
    let userConnected = false;
    let cleaned = false;
    let reconnectTimer = null;
    let saveCredsFn = null;

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

        socket.ev.on('connection.update', async (update) => {
            if (sessionExported || cleaned) return;

            const { connection, lastDisconnect } = update;
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            console.log(`[${sessionId}] State:`, connection || 'waiting', statusCode ? `(code: ${statusCode})` : '');

            // ⚠️ FIX: Catch the standard Error 515 (Handshake reset) so that pairing doesn't fail.
            if (connection === 'close' && statusCode === 515 && !sessionExported && !userConnected) {
                console.log(`🔄 [${sessionId}] Restart detected (515) - waiting for client auto-rebind...`);
                if (reconnectTimer) clearTimeout(reconnectTimer);

                setTimeout(() => {
                    if (!userConnected && !sessionExported && !cleaned) {
                        if (sock) {
                            sock.ev.removeAllListeners();
                            try { sock.end(); } catch (e) {}
                        }

                        const newSock = makeWASocket({
                            version: cachedVersion,
                            auth: socket.authState,
                            printQRInTerminal: false,
                            browser: Browsers.ubuntu("Chrome"),
                            syncFullHistory: false,
                            markOnlineOnConnect: true,
                        });

                        sock = newSock;
                        attachEvents(sock);
                    }
                }, 3000);
                return;
            }

            if (connection === 'open' && socket?.user?.id && !userConnected) {
                userConnected = true;
                console.log(`🎉 [${sessionId}] USER CONNECTED!`);

                if (reconnectTimer) clearTimeout(reconnectTimer);

                console.log(`⏳ [${sessionId}] Waiting for files...`);
                await delay(5000);

                try {
                    const credsBase64 = getCredsFile(sessionDir);
                    if (!credsBase64) throw new Error('creds.json not found');

                    const sessionString = encryptSession(credsBase64, sessionId);
                    const sessionFile = path.join(sessionDir, 'session.txt');
                    fs.writeFileSync(sessionFile, sessionString);

                    const userJid = socket.user.id;

                    await socket.sendMessage(userJid, { text: sessionString });

                    await socket.sendMessage(userJid, {
                        text: `⚠️ *DO NOT SHARE THIS SESSION WITH ANYONE* ⚠️\n\n┌┤✑  Thanks for using GleBot\n│└────────────┈ ⳹\n│ ©2026 GleBot Inc. All rights reserved.\n└─────────────────┈ ⳹\n\n📢 Join our channel: ${CHANNEL_LINK}`,
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

                    console.log(`✅ [${sessionId}] Session sent to user.`);
                    sessionExported = true;

                    // Mega Upload Stream
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

            if (connection === 'close' && !sessionExported && !userConnected && statusCode !== 515) {
                cleanup();
            }
        });
    };

    try {
        fs.mkdirSync(sessionDir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        saveCredsFn = saveCreds;

        sock = makeWASocket({
            version: await getCachedVersion(),
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu("Chrome"),
            syncFullHistory: false,
            markOnlineOnConnect: true,
        });

        attachEvents(sock);

        // ⚠️ FIX: Pause for 4 seconds so Web Socket handshakes can happen. 
        setTimeout(async () => {
            if (codeSent || cleaned || sessionExported) return;

            try {
                const code = await sock.requestPairingCode(formattedNumber);
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                codeSent = true;

                res.json({
                    success: true,
                    code: formattedCode,
                    sessionId,
                    message: 'Link this code in WhatsApp linked devices'
                });

            } catch (err) {
                if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
                cleanup();
            }
        }, 4000);

        setTimeout(() => {
            if (!codeSent && !res.headersSent && !cleaned) {
                res.status(504).json({ success: false, error: 'Code generation timeout' });
                cleanup();
            }
        }, 45000);

    } catch (error) {
        if (!res.headersSent) res.status(500).json({ success: false, error: error.message });
        cleanup();
    }
});

router.get('/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const sessionFile = path.join(TEMP_DIR, sessionId, 'session.txt');

    if (fs.existsSync(sessionFile)) {
        const sessionString = fs.readFileSync(sessionFile, 'utf8');
        res.json({ success: true, sessionString });
    } else {
        res.status(404).json({ success: false, error: 'Session not found' });
    }
});

export default router;
