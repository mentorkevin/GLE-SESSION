import express from 'express';
import fs from 'fs';
import { makeWASocket, useMultiFileAuthState, delay, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys';
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
        return fs.readFileSync(credsPath).toString('base64');
    } catch (err) {
        return null;
    }
}

function encryptSession(credsBase64, sessionId) {
    const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
    
    if (!ENCRYPTION_KEY) {
        const compressed = zlib.deflateSync(credsBase64);
        return `GleBot!${compressed.toString('base64')}`;
    }
    
    const compressed = zlib.deflateSync(credsBase64);
    const dataToEncrypt = JSON.stringify({ sessionId, creds: compressed.toString('base64') });
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

// ==================== PAIRING ENDPOINT ====================
router.get('/', async (req, res) => {
    const sessionId = makeid();
    let { number } = req.query;
    const sessionDir = path.join(TEMP_DIR, sessionId);
    
    if (!number) return res.status(400).json({ success: false, error: 'Phone number required' });

    number = number.replace(/\D/g, '');
    const phone = pn('+' + number);
    if (!phone.isValid()) return res.status(400).json({ success: false, error: 'Invalid number' });

    const formattedNumber = phone.getNumber('e164').replace('+', '');
    console.log(`\n🔷 [${sessionId}] Starting Pairing Flow for ${formattedNumber}...`);

    let sock = null;
    let codeSent = false;
    let sessionExported = false;
    let userConnected = false;
    let cleaned = false;

    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        console.log(`🧹 [${sessionId}] Cleanup invoked.`);
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
            // ⚠️ FIX: Set browser platform explicitly to Chrome running on Windows (more trusted for pairing codes than Linux headless)
            browser: Browsers.windows("Chrome"),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            logger: { level: 'silent' }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            if (sessionExported || cleaned) return;

            const { connection, lastDisconnect } = update;
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            console.log(`[${sessionId}] Socket state: ${connection || 'processing'}`);

            // ⚠️ FIX: Ignore normal handshake disconnect 515 (WhatsApp naturally resets pipe during pairing)
            if (connection === 'close' && statusCode === 515) {
                console.log(`🔄 [${sessionId}] Handshake restart (515)... ignoring cleanup.`);
                return;
            }

            if (connection === 'open' && !userConnected) {
                userConnected = true;
                console.log(`🎉 [${sessionId}] LINKED SUCCESSFULLY! Dumping session text in private DM...`);

                await delay(5000); // Give the server a small moment to flush creds.json

                try {
                    const credsBase64 = getCredsFile(sessionDir);
                    if (!credsBase64) throw new Error("Creds generation failed on Render.");

                    const sessionString = encryptSession(credsBase64, sessionId);
                    const userJid = `${formattedNumber}@s.whatsapp.net`;

                    await sock.sendMessage(userJid, { text: sessionString });
                    await sock.sendMessage(userJid, {
                        text: `⚠️ *DO NOT SHARE THIS SESSION WITH ANYONE* ⚠️\n\n©2026 GleBot Inc. All rights reserved.\n📢 Join: ${CHANNEL_LINK}`
                    });

                    console.log(`✅ [${sessionId}] Session successfully dispatched.`);
                    sessionExported = true;

                    // Forward to Mega in background
                    (async () => {
                        try {
                            const megaUrl = await uploadSession(sessionString, sessionId);
                            if (megaUrl && !megaUrl.startsWith('local://')) {
                                await sock.sendMessage(userJid, { text: `💾 *Mega Backup*\n\n${megaUrl}` });
                            }
                        } catch (e) {}
                    })();

                    setTimeout(cleanup, 20000);
                } catch (err) {
                    cleanup();
                }
            }
        });

        // ⚠️ FIX: Fire query only after 6 seconds of secure handshake stabilization
        setTimeout(async () => {
            if (codeSent || cleaned) return;

            try {
                console.log(`🔑 [${sessionId}] Querying Pairing Code from WhatsApp...`);
                const code = await sock.requestPairingCode(formattedNumber);
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                codeSent = true;

                console.log(`✅ [${sessionId}] Code Generated: ${formattedCode}`);

                if (!res.headersSent) {
                    res.json({
                        success: true,
                        code: formattedCode,
                        sessionId,
                        message: 'Enter code in WhatsApp'
                    });
                }
            } catch (err) {
                console.error(`❌ Pairing request failed: `, err.message);
                if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
                cleanup();
            }
        }, 6000);

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
