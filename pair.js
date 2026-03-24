import express from 'express';
import fs from 'fs-extra';
import pino from 'pino';
import pn from 'awesome-phonenumber';
import crypto from 'crypto';
import zlib from 'zlib';
import {
    makeWASocket, useMultiFileAuthState, delay,
    makeCacheableSignalKeyStore, Browsers, jidNormalizedUser,
    fetchLatestBaileysVersion, DisconnectReason
} from '@whiskeysockets/baileys';
import { uploadSession as megaUpload } from './mega.js';

const router = express.Router();
const MAX_RECONNECT_ATTEMPTS = 3;
const SESSION_TIMEOUT = 5 * 60 * 1000;
const CLEANUP_DELAY = 5000;

const SESSION_PREFIX = 'GleBot!';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ENCRYPTION_KEY_HASH = ENCRYPTION_KEY ? crypto.createHash('sha256').update(ENCRYPTION_KEY).digest() : null;

const CHANNEL_LINK = "https://whatsapp.com/channel/0029VbBTYeRJP215nxFl4I0x";
const MESSAGE = `⚠️ *DO NOT SHARE THIS SESSION WITH ANYONE* ⚠️

┌┤✑  Thanks for using GleBot
│└────────────┈ ⳹        
│ ©2026 GleBot Inc. All rights reserved.
└─────────────────┈ ⳹

📢 Join our channel: ${CHANNEL_LINK}`;

async function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        await fs.remove(FilePath);
        return true;
    } catch (e) { console.error('Error removing file:', e); return false; }
}

function randomMegaId(len = 6, numLen = 4) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < len; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return `${out}${Math.floor(Math.random() * Math.pow(10, numLen))}`;
}

function encryptSession(credsBase64, sessionId) {
    if (!ENCRYPTION_KEY_HASH) {
        throw new Error('ENCRYPTION_KEY not configured');
    }
    
    const compressed = zlib.deflateSync(credsBase64);
    const compressedBase64 = compressed.toString('base64');
    
    const dataToEncrypt = JSON.stringify({
        sessionId: sessionId,
        creds: compressedBase64
    });
    
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY_HASH, iv);
    
    let encrypted = cipher.update(dataToEncrypt, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');
    
    return `${SESSION_PREFIX}${iv.toString('base64')}:${encrypted}:${authTag}`;
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    if (!num) return res.status(400).send({ success: false, error: 'Phone number is required' });

    // Clean phone number
    num = num.replace(/[^0-9]/g, '');
    
    // Validate phone number
    const phone = pn('+' + num);
    if (!phone.isValid()) {
        if (num.length === 10 && !num.startsWith('1')) {
            num = '1' + num;
        } else if (num.length === 9 && num.startsWith('7')) {
            num = '254' + num;
        } else if (num.length === 10 && num.startsWith('7')) {
            num = '254' + num;
        } else {
            return res.status(400).send({ success: false, error: 'Invalid phone number. Please include country code (e.g., 1234567890 for US, 447911123456 for UK, 254712345678 for Kenya)' });
        }
        const phone2 = pn('+' + num);
        if (!phone2.isValid()) {
            return res.status(400).send({ success: false, error: 'Invalid phone number' });
        }
        num = phone2.getNumber('e164').replace('+', '');
    } else {
        num = phone.getNumber('e164').replace('+', '');
    }

    const sessionId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    const dirs = `./temp/session_${sessionId}`;

    let pairingCodeSent = false, sessionCompleted = false, isCleaningUp = false;
    let responseSent = false, reconnectAttempts = 0, currentSocket = null, timeoutHandle = null;

    async function cleanup(reason = 'unknown') {
        if (isCleaningUp) return;
        isCleaningUp = true;
        console.log(`🧹 Cleanup ${sessionId} (${num}) - ${reason}`);
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        if (currentSocket) {
            try { currentSocket.ev.removeAllListeners(); await currentSocket.end(); } catch (e) {}
            currentSocket = null;
        }
        setTimeout(async () => { await removeFile(dirs); }, CLEANUP_DELAY);
    }

    async function initiateSession() {
        if (sessionCompleted || isCleaningUp) return;
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            if (!responseSent && !res.headersSent) { 
                responseSent = true; 
                res.status(503).send({ success: false, error: 'Connection failed after multiple attempts' }); 
            }
            await cleanup('max_reconnects'); 
            return;
        }
        
        try {
            await fs.ensureDir(dirs);
            const { state, saveCreds } = await useMultiFileAuthState(dirs);
            const { version } = await fetchLatestBaileysVersion();

            if (currentSocket) {
                try { currentSocket.ev.removeAllListeners(); await currentSocket.end(); } catch (e) {}
            }

            currentSocket = makeWASocket({
                version,
                auth: { 
                    creds: state.creds, 
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })) 
                },
                printQRInTerminal: false, 
                logger: pino({ level: "silent" }),
                browser: Browsers.macOS('Chrome'), 
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false, 
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000, 
                keepAliveIntervalMs: 30000, 
                retryRequestDelayMs: 250, 
                maxRetries: 3,
            });

            const sock = currentSocket;

            sock.ev.on('connection.update', async (update) => {
                if (isCleaningUp) return;
                const { connection, lastDisconnect, isNewLogin } = update;

                if (connection === 'open') {
                    if (sessionCompleted) return;
                    sessionCompleted = true;
                    console.log(`✅ Connected successfully for ${num}`);
                    
                    try {
                        const credsFile = `${dirs}/creds.json`;
                        if (fs.existsSync(credsFile)) {
                            const credsData = await fs.readFile(credsFile);
                            const credsBase64 = credsData.toString('base64');
                            
                            // Encrypt the session
                            const sessionString = encryptSession(credsBase64, sessionId);
                            const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                            
                            // Send encrypted session
                            await sock.sendMessage(userJid, { text: sessionString });
                            console.log(`📤 GleBot! session sent to ${num}`);
                            
                            // Upload to Mega for backup
                            try {
                                const megaLink = await megaUpload(sessionString, sessionId);
                                if (megaLink && !megaLink.startsWith('local://')) {
                                    await sock.sendMessage(userJid, { text: `💾 *Mega Backup*\n\n${megaLink}` });
                                    console.log(`📤 Mega backup sent`);
                                }
                            } catch (megaErr) {
                                console.error('Mega upload failed:', megaErr.message);
                            }
                            
                            // Send warning message
                            await sock.sendMessage(userJid, { text: MESSAGE });
                            console.log(`📢 Warning message sent`);
                            
                            await delay(1000);
                        }
                    } catch (err) { 
                        console.error('Error sending session:', err); 
                    } finally { 
                        await cleanup('session_complete'); 
                    }
                }

                if (isNewLogin) console.log(`🔐 New login via pair code for ${num}`);

                if (connection === 'close') {
                    if (sessionCompleted || isCleaningUp) { 
                        await cleanup('already_complete'); 
                        return; 
                    }
                    
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    
                    if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                        if (!responseSent && !res.headersSent) { 
                            responseSent = true; 
                            res.status(401).send({ success: false, error: 'Invalid pairing code or session expired' }); 
                        }
                        await cleanup('logged_out');
                    } else if (pairingCodeSent && !sessionCompleted) {
                        reconnectAttempts++;
                        console.log(`🔄 Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
                        await delay(2000); 
                        await initiateSession();
                    } else { 
                        await cleanup('connection_closed'); 
                    }
                }
            });

            // Request pairing code
            if (!sock.authState.creds.registered && !pairingCodeSent && !isCleaningUp) {
                await delay(1500);
                try {
                    pairingCodeSent = true;
                    console.log(`🔑 Requesting pairing code for ${num}...`);
                    let code = await sock.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    
                    if (!responseSent && !res.headersSent) { 
                        responseSent = true; 
                        console.log(`✅ Pairing code: ${code}`);
                        res.send({ 
                            success: true, 
                            code: code, 
                            sessionId: sessionId
                        }); 
                    }
                } catch (error) {
                    console.error('Error requesting pairing code:', error);
                    pairingCodeSent = false;
                    if (!responseSent && !res.headersSent) { 
                        responseSent = true; 
                        res.status(503).send({ success: false, error: 'Failed to get pairing code. Please try again.' }); 
                    }
                    await cleanup('pairing_code_error');
                }
            }

            sock.ev.on('creds.update', saveCreds);

            timeoutHandle = setTimeout(async () => {
                if (!sessionCompleted && !isCleaningUp) {
                    if (!responseSent && !res.headersSent) { 
                        responseSent = true; 
                        res.status(408).send({ success: false, error: 'Pairing timeout. Please try again.' }); 
                    }
                    await cleanup('timeout');
                }
            }, SESSION_TIMEOUT);

        } catch (err) {
            console.error(`❌ Error initializing session for ${num}:`, err);
            if (!responseSent && !res.headersSent) { 
                responseSent = true; 
                res.status(503).send({ success: false, error: 'Service Unavailable' }); 
            }
            await cleanup('init_error');
        }
    }

    await initiateSession();
});

// Cleanup old sessions
setInterval(async () => {
    try {
        const baseDir = './temp';
        if (!fs.existsSync(baseDir)) return;
        const sessions = await fs.readdir(baseDir);
        const now = Date.now();
        for (const session of sessions) {
            try {
                const stats = await fs.stat(`${baseDir}/${session}`);
                if (now - stats.mtimeMs > 10 * 60 * 1000) {
                    await fs.remove(`${baseDir}/${session}`);
                    console.log(`🧹 Cleaned up old session: ${session}`);
                }
            } catch (e) {}
        }
    } catch (e) { console.error('Error in cleanup interval:', e); }
}, 60000);

// Status endpoint
router.get('/status', async (req, res) => {
    const tempDir = './temp';
    const sessions = fs.existsSync(tempDir) ? await fs.readdir(tempDir) : [];
    res.json({
        success: true,
        activeSessions: sessions.length,
        encryptionConfigured: !!ENCRYPTION_KEY
    });
});

process.on('SIGTERM', async () => { 
    try { 
        console.log('🛑 Cleaning up on SIGTERM...');
        await fs.remove('./temp'); 
    } catch (e) {} 
    process.exit(0); 
});

process.on('SIGINT', async () => { 
    try { 
        console.log('🛑 Cleaning up on SIGINT...');
        await fs.remove('./temp'); 
    } catch (e) {} 
    process.exit(0); 
});

process.on('uncaughtException', (err) => {
    const e = String(err);
    const ignore = [
        "conflict", "not-authorized", "Socket connection timeout", 
        "rate-overlimit", "Connection Closed", "Timed Out", 
        "Value not found", "Stream Errored", "statusCode: 515", 
        "statusCode: 503", "QR refs"
    ];
    if (!ignore.some(x => e.includes(x))) {
        console.log('Caught exception:', err);
    }
});

export default router;
