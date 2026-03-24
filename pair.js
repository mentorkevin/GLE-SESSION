import express from 'express';
import fs from 'fs';
import { makeWASocket, useMultiFileAuthState, delay, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
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
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const MAX_SESSIONS = 100;
const CLEANUP_AGE = 3600000;
let encryptionWarningLogged = false;
const rateLimits = new Map();
const CHANNEL_LINK = "https://whatsapp.com/channel/0029VbBTYeRJP215nxFl4I0x";

function makeid() { return crypto.randomBytes(8).toString('hex'); }

function removeFile(filePath) {
    try { if (fs.existsSync(filePath)) fs.rmSync(filePath, { recursive: true, force: true }); } catch (e) {}
}

function getCredsFile(sessionDir) {
    try {
        const credsPath = path.join(sessionDir, 'creds.json');
        if (!fs.existsSync(credsPath)) return null;
        return fs.readFileSync(credsPath).toString('base64');
    } catch (err) {
        console.error('Failed to read creds.json:', err);
        return null;
    }
}

function encryptSession(credsBase64, sessionId) {
    const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
    if (!ENCRYPTION_KEY) {
        if (!encryptionWarningLogged) { console.warn('⚠️ Encryption disabled!'); encryptionWarningLogged = true; }
        return `GleBot!${zlib.deflateSync(credsBase64).toString('base64')}`;
    }
    const compressed = zlib.deflateSync(credsBase64);
    const dataToEncrypt = JSON.stringify({ sessionId, creds: compressed.toString('base64') });
    const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(dataToEncrypt, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return `GleBot!${iv.toString('base64')}:${encrypted}:${cipher.getAuthTag().toString('base64')}`;
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
        const now = Date.now();
        for (const file of fs.readdirSync(TEMP_DIR)) {
            const fp = path.join(TEMP_DIR, file);
            try { if (now - fs.statSync(fp).mtimeMs > CLEANUP_AGE) removeFile(fp); } catch (e) {}
        }
        const sessions = fs.readdirSync(TEMP_DIR);
        if (sessions.length > MAX_SESSIONS) {
            sessions
                .sort((a, b) => {
                    try { return fs.statSync(path.join(TEMP_DIR, a)).mtimeMs - fs.statSync(path.join(TEMP_DIR, b)).mtimeMs; }
                    catch (e) { return 0; }
                })
                .slice(0, sessions.length - MAX_SESSIONS)
                .forEach(s => removeFile(path.join(TEMP_DIR, s)));
        }
    } catch (e) {}
}, 600000);

setInterval(() => {
    const now = Date.now();
    for (const [ip, times] of rateLimits.entries()) {
        const recent = times.filter(t => now - t < 60000);
        if (recent.length === 0) rateLimits.delete(ip);
        else rateLimits.set(ip, recent);
    }
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

    console.log(`\n🔷 [${sessionId}] Pairing started for ${number}`);

    let sock = null;
    let codeSent = false;
    let sessionExported = false;
    let userConnected = false;
    let cleaned = false;
    let codeTimeout = null;
    let overallTimeout = null;
    let formattedNumber = null;
    let saveCredsFn = null;

    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        console.log(`🧹 [${sessionId}] Cleanup`);
        if (codeTimeout) clearTimeout(codeTimeout);
        if (overallTimeout) clearTimeout(overallTimeout);
        if (sock) {
            sock.ev.removeAllListeners();
            try { sock.ws?.close(); } catch (e) {}
            try { sock.end(new Error('cleanup')); } catch (e) {}
        }
        setTimeout(() => removeFile(sessionDir), 5000);
    };

    const handleOpen = async () => {
        if (userConnected) return;
        userConnected = true;
        console.log(`🎉 [${sessionId}] USER CONNECTED! ${sock.user?.id}`);
        if (codeTimeout) clearTimeout(codeTimeout);

        await delay(3000);
        try {
            const credsBase64 = getCredsFile(sessionDir);
            if (!credsBase64) throw new Error('creds.json not found');

            const sessionString = encryptSession(credsBase64, sessionId);
            fs.writeFileSync(path.join(sessionDir, 'session.txt'), sessionString);

            const userJid = formattedNumber + '@s.whatsapp.net';
            console.log(`📤 [${sessionId}] Sending session (${sessionString.length} chars)...`);

            await sock.sendMessage(userJid, { text: sessionString });
            await sock.sendMessage(userJid, {
                text: `⚠️ *DO NOT SHARE THIS SESSION WITH ANYONE* ⚠️\n\n┌┤✑  Thanks for using GleBot\n│└────────────┈ ⳹        \n│ ©2026 GleBot Inc. All rights reserved.\n└─────────────────┈ ⳹\n\n📢 Join our channel: ${CHANNEL_LINK}`,
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

            console.log(`✅ [${sessionId}] Session sent`);
            sessionExported = true;
            setTimeout(() => cleanup(), 30000);
        } catch (err) {
            console.error(`❌ [${sessionId}] Export failed:`, err);
            cleanup();
        }
    };

    try {
        if (!number) return res.status(400).json({ success: false, error: 'Phone number required' });

        number = number.replace(/\D/g, '');
        const phone = pn('+' + number);
        if (!phone.isValid()) return res.status(400).json({ success: false, error: 'Invalid number' });

        formattedNumber = phone.getNumber('e164').replace('+', '');
        fs.mkdirSync(sessionDir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        saveCredsFn = saveCreds;

        const { version } = await fetchLatestBaileysVersion();
        console.log(`📦 WA Version: ${version}`);

        // ✅ KEY FIX: getMessage required for pairing to complete + macOS Safari browser
        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.macOS("Safari"),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            keepAliveIntervalMs: 10000,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            generateHighQualityLinkPreview: false,
            getMessage: async () => ({ conversation: '' })
        });

        sock.ev.on('creds.update', () => {
            if (saveCredsFn) saveCredsFn();
        });

        sock.ev.on('connection.update', async (update) => {
            if (sessionExported || cleaned) return;

            const { connection, lastDisconnect } = update;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`[${sessionId}] State: ${connection || 'waiting'} ${statusCode ? `(${statusCode})` : ''}`);

            // ✅ KEY FIX: 515 = WhatsApp restarting after code entry — DO NOTHING
            // Baileys auto-reconnects internally. Do NOT recreate socket.
            if (connection === 'close' && statusCode === 515) {
                console.log(`🔄 [${sessionId}] 515 restart — waiting for user to complete linking...`);
                return;
            }

            // ✅ User successfully linked device
            if (connection === 'open' && sock.user && !userConnected) {
                await handleOpen();
                return;
            }

            // Fatal close (not 515) — give up
            if (connection === 'close' && statusCode !== 515 && !userConnected && !sessionExported) {
                console.log(`🔴 [${sessionId}] Fatal close (${statusCode})`);
                if (!codeSent && !res.headersSent) {
                    res.status(500).json({ success: false, error: `Connection failed (${statusCode})` });
                }
                cleanup();
            }
        });

        // ✅ Request pairing code after socket is ready
        setTimeout(async () => {
            if (codeSent || sessionExported || cleaned) return;
            try {
                console.log(`🔑 [${sessionId}] Requesting pairing code...`);
                const code = await sock.requestPairingCode(formattedNumber);
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                codeSent = true;
                console.log(`✅ [${sessionId}] Code: ${formattedCode}`);

                if (!res.headersSent) {
                    res.json({
                        success: true,
                        code: formattedCode,
                        sessionId,
                        message: 'Enter this code in WhatsApp',
                        instructions: [
                            '1. Open WhatsApp on your phone',
                            '2. Tap Menu > Linked Devices',
                            '3. Tap "Link a Device"',
                            `4. Enter this code: ${formattedCode}`,
                            '⏱️ Code expires in 3 minutes'
                        ]
                    });
                }

                // Timeout if user never enters code
                codeTimeout = setTimeout(() => {
                    if (!userConnected && !sessionExported && !cleaned) {
                        console.log(`⏰ [${sessionId}] Code entry timeout`);
                        cleanup();
                    }
                }, 180000);

            } catch (err) {
                console.error(`Code error:`, err);
                if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
                cleanup();
            }
        }, 3000);

        // Code generation timeout
        setTimeout(() => {
            if (!codeSent && !res.headersSent && !cleaned) {
                res.status(504).json({ success: false, error: 'Code generation timeout' });
                cleanup();
            }
        }, 30000);

        // Overall session timeout
        overallTimeout = setTimeout(() => {
            if (!sessionExported && !cleaned) {
                console.log(`⏰ [${sessionId}] Overall timeout`);
                cleanup();
            }
        }, 300000);

    } catch (error) {
        console.error(`Fatal:`, error);
        if (!res.headersSent) res.status(500).json({ success: false, error: error.message });
        cleanup();
    }
});

router.get('/session/:sessionId', (req, res) => {
    const sessionFile = path.join(TEMP_DIR, req.params.sessionId, 'session.txt');
    if (fs.existsSync(sessionFile)) {
        res.json({ success: true, sessionString: fs.readFileSync(sessionFile, 'utf8') });
    } else {
        res.status(404).json({ success: false, error: 'Session not found' });
    }
});

export default router;
