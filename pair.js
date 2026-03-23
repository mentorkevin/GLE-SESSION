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
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',') || [];
const MAX_CONCURRENT_PAIRINGS = parseInt(process.env.MAX_CONCURRENT_PAIRINGS) || 10;
const PAIRING_TIMEOUT = 120000; // 2 minutes
const PAIRING_CODE_TIMEOUT = 30000;
const MAX_MESSAGE_SIZE = 8192;

// Strict CORS
router.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Methods', 'GET');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        next();
    } else if (!origin && process.env.NODE_ENV === 'development') {
        res.header('Access-Control-Allow-Origin', '*');
        next();
    } else {
        res.status(403).json({ success: false, error: 'CORS origin not allowed' });
    }
});

const TEMP_DIR = path.join(__dirname, 'temp_sessions');
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!ENCRYPTION_KEY) {
    console.error('❌ FATAL: ENCRYPTION_KEY is required');
    process.exit(1);
}

const ENCRYPTION_KEY_HASH = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();

if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const MAX_SESSIONS = 100;
const CLEANUP_AGE = 3600000;
const RATE_LIMIT_MAP = new Map();
const ACTIVE_NUMBERS = new Map();
let activePairingCount = 0;

let cachedVersion = null;
let versionCacheTime = 0;
const VERSION_CACHE_TTL = 3600000;

const COUNTRY_PATTERNS = [
    { pattern: /^1\d{10}$/, code: '1', name: 'US/CA' },
    { pattern: /^44\d{10}$/, code: '44', name: 'UK' },
    { pattern: /^91\d{10}$/, code: '91', name: 'India' },
    { pattern: /^61\d{9}$/, code: '61', name: 'Australia' },
    { pattern: /^254\d{9}$/, code: '254', name: 'Kenya' }
];

function makeid() {
    return crypto.randomBytes(8).toString('hex');
}

function removeFile(filePath, silent = false) {
    try { 
        if (fs.existsSync(filePath)) {
            fs.rmSync(filePath, { recursive: true, force: true });
            if (!silent) console.log(`🗑️ Removed: ${filePath}`);
        }
    } catch (e) {
        if (!silent) console.error(`Failed to remove ${filePath}:`, e.message);
    }
}

function getCredsFile(sessionDir) {
    try {
        const credsPath = path.join(sessionDir, 'creds.json');
        if (!fs.existsSync(credsPath)) return null;
        const content = fs.readFileSync(credsPath);
        return content.toString('base64');
    } catch (err) {
        console.error(`Failed to read creds.json:`, err.message);
        return null;
    }
}

function encryptSession(credsBase64, sessionId) {
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
        console.error(`Version fetch failed:`, err.message);
        return cachedVersion || [2, 2413, 1];
    }
}

function checkRateLimit(ip, phoneNumber) {
    const key = `${ip}:${phoneNumber}`;
    const now = Date.now();
    const limit = RATE_LIMIT_MAP.get(key) || [];
    const recent = limit.filter(t => now - t < 60000);
    if (recent.length >= 2) return false;
    recent.push(now);
    RATE_LIMIT_MAP.set(key, recent);
    return true;
}

function formatPhoneNumber(number) {
    let cleaned = number.replace(/\D/g, '');
    
    for (const { pattern } of COUNTRY_PATTERNS) {
        if (pattern.test(cleaned)) return cleaned;
    }
    
    if (cleaned.length === 10 && !cleaned.startsWith('1')) cleaned = '1' + cleaned;
    else if (cleaned.length === 9 && cleaned.startsWith('7')) cleaned = '254' + cleaned;
    else if (cleaned.length === 10 && cleaned.startsWith('7')) cleaned = '254' + cleaned;
    else if (cleaned.length === 11 && cleaned.startsWith('0')) cleaned = cleaned.substring(1);
    
    return cleaned;
}

function redactNumber(number) {
    if (!number) return 'unknown';
    const len = number.length;
    if (len <= 4) return '****';
    return number.substring(0, 2) + '****' + number.substring(len - 2);
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
                if (now - stat.mtimeMs > CLEANUP_AGE) removeFile(filePath, true);
            } catch (e) {}
        }
    } catch (e) {}
}, 600000);

setInterval(() => {
    const now = Date.now();
    for (const [number, data] of ACTIVE_NUMBERS.entries()) {
        if (now - data.timestamp > PAIRING_TIMEOUT) {
            console.log(`🧹 Cleaning up stale active session for ${redactNumber(number)}`);
            if (data.cleanupTimeout) clearTimeout(data.cleanupTimeout);
            ACTIVE_NUMBERS.delete(number);
        }
    }
    if (activePairingCount < 0) activePairingCount = 0;
}, 60000);

setInterval(() => {
    try {
        const now = Date.now();
        for (const [key, times] of RATE_LIMIT_MAP.entries()) {
            const recent = times.filter(t => now - t < 60000);
            if (recent.length === 0) RATE_LIMIT_MAP.delete(key);
            else RATE_LIMIT_MAP.set(key, recent);
        }
    } catch (e) {}
}, 60000);

// Split session into safe-sized chunks
const splitSessionIntoChunks = (sessionString) => {
    const chunks = [];
    const maxContentSize = MAX_MESSAGE_SIZE - 100;
    for (let i = 0; i < sessionString.length; i += maxContentSize) {
        chunks.push(sessionString.slice(i, i + maxContentSize));
    }
    return chunks;
};

// ==================== PAIRING ENDPOINT ====================
router.get('/', async (req, res) => {
    if (activePairingCount >= MAX_CONCURRENT_PAIRINGS) {
        return res.status(503).json({ 
            success: false, 
            error: 'Server at capacity. Please try again later.',
            activePairings: activePairingCount
        });
    }
    
    const sessionId = makeid();
    let { number } = req.query;
    const sessionDir = path.join(TEMP_DIR, sessionId);
    
    const clientIp = (req.headers['x-forwarded-for'] || req.ip || '')
        .toString()
        .split(',')[0]
        .trim();
    
    if (!number) {
        return res.status(400).json({ success: false, error: 'Phone number required' });
    }
    
    const formattedNumber = formatPhoneNumber(number);
    const redactedNumber = redactNumber(formattedNumber);
    
    if (!/^\d{10,15}$/.test(formattedNumber)) {
        return res.status(400).json({ success: false, error: 'Invalid phone number format' });
    }
    
    if (ACTIVE_NUMBERS.has(formattedNumber)) {
        const activeSession = ACTIVE_NUMBERS.get(formattedNumber);
        const elapsed = Math.floor((Date.now() - activeSession.timestamp) / 1000);
        console.log(`⚠️ [${sessionId}] Active session exists for ${redactedNumber} (${elapsed}s)`);
        return res.status(409).json({ 
            success: false, 
            error: 'Active session already exists for this number',
            waitSeconds: Math.max(0, Math.floor((PAIRING_TIMEOUT - elapsed) / 1000))
        });
    }
    
    if (!checkRateLimit(clientIp, formattedNumber)) {
        return res.status(429).json({ success: false, error: 'Rate limited. Please wait a minute.' });
    }
    
    console.log(`\n🔷 [${sessionId}] Pairing started for ${redactedNumber}`);
    
    let currentSock = null;
    let sessionExported = false;
    let userConnected = false;
    let cleaned = false;
    let saveCredsFn = null;
    let responseSent = false;
    let megaUploadStarted = false;
    let sessionDirCreated = false;
    let exportInProgress = false;
    let connectionListener = null;
    let credsListener = null;
    let pairingCodeResolved = false;
    
    activePairingCount++;
    console.log(`📊 Active pairings: ${activePairingCount}`);
    
    const cleanup = (delayMs = 10000) => {
        if (cleaned) return;
        cleaned = true;
        console.log(`🧹 [${sessionId}] Cleanup scheduled`);
        
        activePairingCount = Math.max(0, activePairingCount - 1);
        
        if (ACTIVE_NUMBERS.has(formattedNumber)) {
            const active = ACTIVE_NUMBERS.get(formattedNumber);
            if (active.cleanupTimeout) clearTimeout(active.cleanupTimeout);
            ACTIVE_NUMBERS.delete(formattedNumber);
            console.log(`🗑️ [${sessionId}] Removed ${redactedNumber} from active sessions`);
        }
        
        if (currentSock) {
            if (connectionListener) currentSock.ev.off('connection.update', connectionListener);
            if (credsListener) currentSock.ev.off('creds.update', credsListener);
            currentSock.ev.removeAllListeners();
            try { currentSock.end(); } catch (e) {}
        }
        
        if (sessionDirCreated && fs.existsSync(sessionDir)) {
            setTimeout(() => removeFile(sessionDir, true), 10000);
        }
    };
    
    const sendResponse = (data) => {
        if (!responseSent && !cleaned && !res.headersSent) {
            responseSent = true;
            res.json(data);
        }
    };
    
    // Send session with safe chunk size
    const sendSessionWithRetry = async (socket, userJid, sessionString, retryCount = 0) => {
        try {
            const chunks = splitSessionIntoChunks(sessionString);
            
            if (chunks.length === 1) {
                await socket.sendMessage(userJid, { text: sessionString });
            } else {
                for (let i = 0; i < chunks.length; i++) {
                    await delay(2000);
                    await socket.sendMessage(userJid, { 
                        text: `📦 *Session Part ${i+1}/${chunks.length}*\n\n${chunks[i]}` 
                    });
                }
                await socket.sendMessage(userJid, { text: `✅ *Session Complete!*` });
            }
            
            console.log(`✅ [${sessionId}] Session sent (${chunks.length} parts)`);
            return true;
        } catch (error) {
            console.error(`❌ [${sessionId}] Send attempt ${retryCount + 1} failed:`, error.message);
            if (retryCount < 2) {
                await delay(3000);
                return sendSessionWithRetry(socket, userJid, sessionString, retryCount + 1);
            }
            return false;
        }
    };
    
    // Export session with phone number verification
    const exportSession = async (socket, sessionDir, sessionId, phoneNumber) => {
        if (exportInProgress) {
            console.log(`⚠️ [${sessionId}] Export already in progress, skipping`);
            return { success: false, alreadyInProgress: true };
        }
        exportInProgress = true;
        
        try {
            const connectedNumber = socket.user?.id?.split(':')[0];
            if (connectedNumber !== phoneNumber) {
                console.error(`❌ [${sessionId}] Phone mismatch: expected ${redactNumber(phoneNumber)}, got ${redactNumber(connectedNumber)}`);
                return { success: false, error: 'Phone number mismatch' };
            }
            
            const credsBase64 = getCredsFile(sessionDir);
            if (!credsBase64) throw new Error('creds.json not found');
            
            const sessionString = encryptSession(credsBase64, sessionId);
            const sessionFile = path.join(sessionDir, 'session.txt');
            fs.writeFileSync(sessionFile, sessionString);
            
            const userJid = socket.user.id;
            console.log(`📤 [${sessionId}] Sending session to ${userJid}...`);
            
            const sent = await sendSessionWithRetry(socket, userJid, sessionString);
            
            if (sent) {
                await socket.sendMessage(userJid, {
                    text: `⚠️ *DO NOT SHARE THIS SESSION* ⚠️\n\nThanks for using GleBot\n\n📢 Join: ${CHANNEL_LINK}`
                });
                
                console.log(`✅ [${sessionId}] Session exported successfully`);
                return { success: true, sessionString };
            }
            throw new Error('Failed to send session after retries');
        } catch (err) {
            console.error(`❌ [${sessionId}] Export failed:`, err);
            return { success: false, error: err.message };
        } finally {
            exportInProgress = false;
        }
    };
    
    try {
        // Register active session with auto-cleanup
        const cleanupTimeout = setTimeout(() => {
            if (ACTIVE_NUMBERS.has(formattedNumber)) {
                console.log(`⏰ [${sessionId}] Active session auto-cleaned`);
                ACTIVE_NUMBERS.delete(formattedNumber);
            }
        }, PAIRING_TIMEOUT);
        
        ACTIVE_NUMBERS.set(formattedNumber, {
            sessionId,
            timestamp: Date.now(),
            ip: clientIp,
            cleanupTimeout
        });
        
        // Create session directory
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
            sessionDirCreated = true;
        }
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        saveCredsFn = saveCreds;
        const version = await getCachedVersion();
        
        console.log(`🔨 [${sessionId}] Creating socket...`);
        
        // Create socket with correct browser
        currentSock = makeWASocket({
            version,
            auth: state,
            browser: Browsers.macOS("Chrome"), // More reliable than Ubuntu
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000
        });
        
        // Single creds listener
        credsListener = async (creds) => {
            console.log(`💾 [${sessionId}] creds.update - registered: ${creds?.registered}`);
            try {
                if (saveCredsFn) await saveCredsFn();
            } catch (err) {
                console.error(`❌ [${sessionId}] Failed to save creds:`, err.message);
            }
        };
        currentSock.ev.on('creds.update', credsListener);
        
        // Connection listener for post-pairing events
        connectionListener = async (update) => {
            try {
                const { connection, lastDisconnect } = update;
                
                console.log(`[${sessionId}] Connection: ${connection || 'connecting'}`);
                
                if (lastDisconnect?.error) {
                    const statusCode = lastDisconnect.error?.output?.statusCode;
                    if (statusCode === DisconnectReason.loggedOut) {
                        console.log(`⚠️ [${sessionId}] User logged out`);
                        cleanup(5000);
                        return;
                    }
                    console.error(`❌ [${sessionId}] Error:`, lastDisconnect.error.message);
                }
                
                // Check for successful connection after pairing
                if (connection === 'open' && currentSock?.user?.id && !sessionExported && !userConnected) {
                    const connectedNumber = currentSock.user.id.split(':')[0];
                    const phoneMatches = connectedNumber === formattedNumber;
                    
                    console.log(`🎉 [${sessionId}] Connection open! Phone match: ${phoneMatches}`);
                    
                    if (phoneMatches) {
                        userConnected = true;
                        await delay(2000);
                        
                        const result = await exportSession(currentSock, sessionDir, sessionId, formattedNumber);
                        
                        if (result.success) {
                            sessionExported = true;
                            
                            if (!megaUploadStarted) {
                                megaUploadStarted = true;
                                const sessionStringCopy = result.sessionString;
                                setTimeout(async () => {
                                    try {
                                        const megaUrl = await uploadSession(sessionStringCopy, sessionId);
                                        if (megaUrl && !megaUrl.startsWith('local://') && currentSock?.user) {
                                            await currentSock.sendMessage(currentSock.user.id, { 
                                                text: `💾 *Mega Backup*\n\n${megaUrl}` 
                                            });
                                        }
                                    } catch (e) {
                                        console.error(`Mega failed:`, e.message);
                                    }
                                }, 10000);
                            }
                            
                            setTimeout(() => cleanup(5000), 3000);
                        }
                    }
                }
            } catch (err) {
                console.error(`❌ [${sessionId}] Connection handler error:`, err);
            }
        };
        currentSock.ev.on('connection.update', connectionListener);
        
        // REQUEST PAIRING CODE IMMEDIATELY - This is the correct flow
        console.log(`🔑 [${sessionId}] Requesting pairing code...`);
        
        let pairingCode = null;
        try {
            // Race between pairing code and timeout
            pairingCode = await Promise.race([
                currentSock.requestPairingCode(formattedNumber),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Pairing code request timeout')), PAIRING_CODE_TIMEOUT))
            ]);
        } catch (err) {
            console.error(`❌ [${sessionId}] Pairing request failed:`, err.message);
            sendResponse({
                success: false,
                error: `Failed to request pairing code: ${err.message}`,
                sessionId
            });
            cleanup(5000);
            return;
        }
        
        if (!pairingCode) {
            console.error(`❌ [${sessionId}] No pairing code received`);
            sendResponse({
                success: false,
                error: 'No pairing code received from WhatsApp',
                sessionId
            });
            cleanup(5000);
            return;
        }
        
        const formattedCode = pairingCode.match(/.{1,4}/g)?.join('-') || pairingCode;
        console.log(`✅ [${sessionId}] Pairing code: ${formattedCode}`);
        
        sendResponse({
            success: true,
            code: formattedCode,
            rawCode: pairingCode,
            sessionId,
            phoneNumber: redactedNumber,
            message: 'Enter this code in WhatsApp',
            instructions: [
                '1. WhatsApp → Settings → Linked Devices',
                '2. Tap "Link a Device"',
                `3. Enter code: ${formattedCode}`,
                '4. Wait for connection...'
            ],
            expiresIn: Math.floor(PAIRING_TIMEOUT / 1000)
        });
        
        // Timeout for user to enter code
        setTimeout(() => {
            if (!sessionExported && !cleaned) {
                console.log(`⏰ [${sessionId}] Timeout waiting for connection`);
                if (!responseSent) {
                    sendResponse({ 
                        success: false, 
                        error: 'Timeout waiting for connection',
                        sessionId
                    });
                }
                cleanup(5000);
            }
        }, PAIRING_TIMEOUT);
        
    } catch (error) {
        console.error(`❌ [${sessionId}] Fatal:`, error);
        if (!responseSent && !cleaned) {
            sendResponse({ success: false, error: error.message, sessionId });
        }
        cleanup(5000);
    }
});

router.get('/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const sessionDir = path.join(TEMP_DIR, sessionId);
    const sessionFile = path.join(sessionDir, 'session.txt');
    
    if (fs.existsSync(sessionFile)) {
        res.json({ success: true, sessionId, exists: true });
    } else {
        res.status(404).json({ success: false, error: 'Session not found' });
    }
});

router.get('/status', (req, res) => {
    const sessions = fs.existsSync(TEMP_DIR) ? fs.readdirSync(TEMP_DIR).length : 0;
    res.json({
        success: true,
        activeSessions: sessions,
        activePairings: ACTIVE_NUMBERS.size,
        maxConcurrentPairings: MAX_CONCURRENT_PAIRINGS,
        availableSlots: Math.max(0, MAX_CONCURRENT_PAIRINGS - activePairingCount)
    });
});

export default router;
