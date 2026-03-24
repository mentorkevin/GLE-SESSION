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

const CHANNEL_LINK = "https://whatsapp.com/channel/0029VbBTYeRJP215nxFl4I0x";
const MAX_CONCURRENT_PAIRINGS = parseInt(process.env.MAX_CONCURRENT_PAIRINGS) || 10;
const PAIRING_TIMEOUT = 120000;
const MAX_MESSAGE_SIZE = 8192;

// CORS
router.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

const TEMP_DIR = path.join(__dirname, 'temp_sessions');
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!ENCRYPTION_KEY) {
    console.error('❌ ENCRYPTION_KEY required');
    process.exit(1);
}

const ENCRYPTION_KEY_HASH = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const ACTIVE_SESSIONS = new Map();
let activePairingCount = 0;
let cachedVersion = null;

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
    const compressed = zlib.deflateSync(credsBase64);
    const compressedBase64 = compressed.toString('base64');
    
    const dataToEncrypt = JSON.stringify({ sessionId, creds: compressedBase64 });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY_HASH, iv);
    
    let encrypted = cipher.update(dataToEncrypt, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');
    
    return `GleBot!${iv.toString('base64')}:${encrypted}:${authTag}`;
}

async function getVersion() {
    try {
        if (cachedVersion) return cachedVersion;
        const { version } = await fetchLatestBaileysVersion();
        cachedVersion = version;
        return version;
    } catch (err) {
        return [2, 2413, 1];
    }
}

function formatPhoneNumber(number) {
    let cleaned = number.replace(/\D/g, '');
    if (cleaned.length === 9 && cleaned.startsWith('7')) cleaned = '254' + cleaned;
    else if (cleaned.length === 10 && cleaned.startsWith('7')) cleaned = '254' + cleaned;
    else if (cleaned.length === 10 && !cleaned.startsWith('1')) cleaned = '1' + cleaned;
    return cleaned;
}

function redactNumber(number) {
    if (!number) return 'unknown';
    return number.substring(0, 2) + '****' + number.substring(number.length - 2);
}

const splitSessionIntoChunks = (sessionString) => {
    const chunks = [];
    const maxSize = MAX_MESSAGE_SIZE - 100;
    for (let i = 0; i < sessionString.length; i += maxSize) {
        chunks.push(sessionString.slice(i, i + maxSize));
    }
    return chunks;
};

router.get('/health', (req, res) => {
    res.json({ status: 'healthy', activePairings: ACTIVE_SESSIONS.size });
});

router.get('/', async (req, res) => {
    if (activePairingCount >= MAX_CONCURRENT_PAIRINGS) {
        return res.status(503).json({ success: false, error: 'Server at capacity' });
    }
    
    const sessionId = makeid();
    let { number } = req.query;
    
    if (!number) {
        return res.status(400).json({ success: false, error: 'Phone number required' });
    }
    
    const formattedNumber = formatPhoneNumber(number);
    const redactedNumber = redactNumber(formattedNumber);
    
    if (ACTIVE_SESSIONS.has(formattedNumber)) {
        return res.status(409).json({ success: false, error: 'Active session exists', waitSeconds: 60 });
    }
    
    console.log(`\n🔷 [${sessionId}] Pairing started for ${redactedNumber}`);
    
    const sessionDir = path.join(TEMP_DIR, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    
    let currentSock = null;
    let sessionExported = false;
    let cleaned = false;
    let saveCredsFn = null;
    let responseSent = false;
    
    ACTIVE_SESSIONS.set(formattedNumber, { sessionId, timestamp: Date.now() });
    activePairingCount++;
    
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        ACTIVE_SESSIONS.delete(formattedNumber);
        activePairingCount--;
        if (currentSock) {
            try { currentSock.end(); } catch (e) {}
        }
        setTimeout(() => removeFile(sessionDir), 5000);
    };
    
    const sendResponse = (data) => {
        if (!responseSent && !cleaned && !res.headersSent) {
            responseSent = true;
            res.json(data);
        }
    };
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        saveCredsFn = saveCreds;
        const version = await getVersion();
        
        currentSock = makeWASocket({
            version,
            auth: state,
            browser: Browsers.macOS("Chrome"),
            printQRInTerminal: false,
            markOnlineOnConnect: false
        });
        
        currentSock.ev.on('creds.update', async () => {
            try { if (saveCredsFn) await saveCredsFn(); } catch (e) {}
        });
        
        // Handle connection - when user enters code, this fires
        currentSock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
                cleanup();
                return;
            }
            
            // User entered code and connected!
            if (connection === 'open' && currentSock?.user?.id && !sessionExported) {
                const connectedNumber = currentSock.user.id.split(':')[0];
                if (connectedNumber !== formattedNumber) return;
                
                console.log(`🎉 [${sessionId}] User connected!`);
                sessionExported = true;
                
                await delay(2000);
                
                const credsBase64 = getCredsFile(sessionDir);
                if (!credsBase64) {
                    cleanup();
                    return;
                }
                
                const sessionString = encryptSession(credsBase64, sessionId);
                fs.writeFileSync(path.join(sessionDir, 'session.txt'), sessionString);
                
                const userJid = currentSock.user.id;
                const chunks = splitSessionIntoChunks(sessionString);
                
                try {
                    if (chunks.length === 1) {
                        await currentSock.sendMessage(userJid, { text: sessionString });
                    } else {
                        for (let i = 0; i < chunks.length; i++) {
                            await delay(2000);
                            await currentSock.sendMessage(userJid, { 
                                text: `📦 Part ${i+1}/${chunks.length}\n\n${chunks[i]}` 
                            });
                        }
                    }
                    
                    await currentSock.sendMessage(userJid, {
                        text: `⚠️ DO NOT SHARE THIS SESSION ⚠️\n\nThanks for using GleBot\n\n📢 Join: ${CHANNEL_LINK}`
                    });
                    
                    console.log(`✅ [${sessionId}] Session sent`);
                    
                    // Mega backup in background
                    setTimeout(async () => {
                        try {
                            const megaUrl = await uploadSession(sessionString, sessionId);
                            if (megaUrl && currentSock?.user) {
                                await currentSock.sendMessage(userJid, { text: `💾 Mega Backup: ${megaUrl}` });
                            }
                        } catch (e) {}
                    }, 5000);
                    
                    setTimeout(() => cleanup(), 3000);
                    
                } catch (err) {
                    console.error(`❌ [${sessionId}] Send failed:`, err.message);
                    cleanup();
                }
            }
        });
        
        // Request pairing code - THIS IS THE ONLY STEP NEEDED
        console.log(`🔑 [${sessionId}] Requesting pairing code...`);
        const code = await currentSock.requestPairingCode(formattedNumber);
        
        if (!code) throw new Error('No code received');
        
        const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
        console.log(`✅ [${sessionId}] Pairing code: ${formattedCode}`);
        
        sendResponse({
            success: true,
            code: formattedCode,
            sessionId,
            message: 'Enter this code in WhatsApp',
            instructions: [
                '1. WhatsApp → Settings → Linked Devices',
                '2. Tap "Link a Device"',
                `3. Enter code: ${formattedCode}`,
                '4. Wait for connection...'
            ]
        });
        
        // Timeout
        setTimeout(() => {
            if (!sessionExported && !cleaned) {
                console.log(`⏰ [${sessionId}] Timeout`);
                if (!responseSent) sendResponse({ success: false, error: 'Timeout', sessionId });
                cleanup();
            }
        }, PAIRING_TIMEOUT);
        
    } catch (error) {
        console.error(`❌ [${sessionId}] Error:`, error.message);
        if (!responseSent) sendResponse({ success: false, error: error.message, sessionId });
        cleanup();
    }
});

router.get('/session/:sessionId', (req, res) => {
    const sessionDir = path.join(TEMP_DIR, req.params.sessionId);
    const sessionFile = path.join(sessionDir, 'session.txt');
    
    if (fs.existsSync(sessionFile)) {
        res.json({ success: true, exists: true });
    } else {
        res.status(404).json({ success: false, error: 'Session not found' });
    }
});

router.get('/status', (req, res) => {
    res.json({
        success: true,
        activePairings: ACTIVE_SESSIONS.size,
        maxConcurrentPairings: MAX_CONCURRENT_PAIRINGS,
        availableSlots: Math.max(0, MAX_CONCURRENT_PAIRINGS - activePairingCount)
    });
});

export default router;
