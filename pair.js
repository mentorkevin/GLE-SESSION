import express from 'express';
import fs from 'fs';
import { makeWASocket, useMultiFileAuthState, delay, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
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
        if (!fs.existsSync(credsPath)) return null;
        const content = fs.readFileSync(credsPath);
        return content.toString('base64');
    } catch (err) {
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
    
    const dataToEncrypt = JSON.stringify({ sessionId, creds: compressedBase64 });
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
        if (cachedVersion && (now - versionCacheTime) < VERSION_CACHE_TTL) return cachedVersion;
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

// Cleanups 
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
    } catch (e) {}
}, 600000);

// ==================== PAIRING ENDPOINT ====================
router.get('/', async (req, res) => {
    const sessionId = makeid();
    let { number } = req.query;
    const sessionDir = path.join(TEMP_DIR, sessionId);
    
    const clientIp = req.headers['x-forwarded-for'] || req.ip;
    if (!checkRateLimit(clientIp)) {
        return res.status(429).json({ success: false, error: 'Rate limited. Please wait a minute.', sessionId });
    }
    
    if (!number) return res.status(400).json({ success: false, error: 'Phone number required', sessionId });

    number = number.replace(/\D/g, '');
    const phone = pn('+' + number);
    if (!phone.isValid()) return res.status(400).json({ success: false, error: 'Invalid number', sessionId });

    const formattedNumber = phone.getNumber('e164').replace('+', '');
    console.log(`\n🔷 [${sessionId}] Starting pairing flow for ${formattedNumber}`);

    let sock = null;
    let codeSent = false;
    let sessionExported = false;
    let userConnected = false;
    let cleaned = false;

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

    try {
        fs.mkdirSync(sessionDir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        sock = makeWASocket({
            version: await getCachedVersion(),
            auth: state,
            printQRInTerminal: false,
            // ⚠️ FIX: Real browser emulation stops WhatsApp from rejecting the code
            browser: ["Windows", "Chrome", "114.0.5735.198"],
            syncFullHistory: false,
            markOnlineOnConnect: true,
            logger: { level: 'silent' }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            if (sessionExported || cleaned) return;

            const { connection, lastDisconnect } = update;
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            console.log(`[${sessionId}] Socket: ${connection || 'waiting'}`);

            // ⚠️ FIX: Fire the pairing request ONLY when the socket is fully connected and idling
            if (connection === 'connecting' || update.qr || (connection === undefined && !codeSent)) {
                if (!codeSent && !sock.authState.creds.registered) {
                    codeSent = true; // Block double fires
                    
                    await delay(3000); // Give the TLS pipe 3 seconds to breathe
                    console.log(`🔑 [${sessionId}] Reaching out to WhatsApp for Pair Code...`);

                    try {
                        const code = await sock.requestPairingCode(formattedNumber);
                        const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;

                        if (!res.headersSent) {
                            res.json({
                                success: true,
                                code: formattedCode,
                                sessionId,
                                message: 'Link this code in WhatsApp linked devices'
                            });
                        }
                    } catch (err) {
                        console.error(`❌ [${sessionId}] Code Request Error:`, err.message);
                        if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
                        cleanup();
                    }
                }
            }

            // Normal linkage handshakes
            if (connection === 'close' && statusCode === 515) {
                console.log(`🔄 [${sessionId}] Re-establishing pipe (515 handshake).`);
                return;
            }

            if (connection === 'open' && socket?.user?.id && !userConnected) {
                userConnected = true;
                console.log(`🎉 [${sessionId}] LINK SUCCESSFUL!`);

                await delay(5000);

                try {
                    const credsBase64 = getCredsFile(sessionDir);
                    if (!credsBase64) throw new Error('creds.json was failed to create on disk.');

                    const sessionString = encryptSession(credsBase64, sessionId);
                    const userJid = socket.user.id;

                    await socket.sendMessage(userJid, { text: sessionString });

                    await socket.sendMessage(userJid, {
                        text: `⚠️ *DO NOT SHARE THIS SESSION WITH ANYONE* ⚠️\n\n©2026 GleBot Inc. All rights reserved.\n📢 Join: ${CHANNEL_LINK}`,
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

                    console.log(`✅ [${sessionId}] Sent session to DM.`);
                    sessionExported = true;

                    (async () => {
                        try {
                            const megaUrl = await uploadSession(sessionString, sessionId);
                            if (megaUrl && !megaUrl.startsWith('local://')) {
                                await socket.sendMessage(userJid, { text: `💾 *Mega Backup*\n\n${megaUrl}` });
                            }
                        } catch (e) {}
                    })();

                    setTimeout(() => cleanup(), 30000);

                } catch (err) {
                    cleanup();
                }
            }

            if (connection === 'close' && statusCode !== 515 && !userConnected) {
                cleanup();
            }
        });

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
