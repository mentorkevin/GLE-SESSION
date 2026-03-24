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
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS) || 100;
const PAIRING_TIMEOUT = 120000;
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

const CLEANUP_AGE = 3600000;
const RATE_LIMIT_MAP = new Map();
const ACTIVE_SESSIONS = new Map(); // Single source of truth: Map<phoneNumber, {sessionId, timestamp, socket, state, cleanupTimeout}>
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
    
    if (cleaned.length === 10 && cleaned.startsWith('0')) {
        cleaned = cleaned.substring(1);
    }
    
    if (cleaned.length === 9 && cleaned.startsWith('7')) {
        cleaned = '254' + cleaned;
    } else if (cleaned.length === 10 && cleaned.startsWith('7')) {
        cleaned = '254' + cleaned;
    } else if (cleaned.length === 10 && !cleaned.startsWith('1')) {
        cleaned = '1' + cleaned;
    }
    
    return cleaned;
}

function redactNumber(number) {
    if (!number) return 'unknown';
    const len = number.length;
    if (len <= 4) return '****';
    return number.substring(0, 2) + '****' + number.substring(len - 2);
}

function isDeviceLimitError(error) {
    const errorStr = error?.message?.toLowerCase() || '';
    return errorStr.includes('device') || 
           errorStr.includes('limit') || 
           errorStr.includes('too many') ||
           errorStr.includes('max devices');
}

// Cleanup old session directories
setInterval(() => {
    try {
        if (!fs.existsSync(TEMP_DIR)) return;
        const files = fs.readdirSync(TEMP_DIR);
        const now = Date.now();
        let sessionCount = 0;
        
        for (const file of files) {
            const filePath = path.join(TEMP_DIR, file);
            try {
                const stat = fs.statSync(filePath);
                if (now - stat.mtimeMs > CLEANUP_AGE) {
                    removeFile(filePath, true);
                } else {
                    sessionCount++;
                }
            } catch (e) {}
        }
        
        if (sessionCount > MAX_SESSIONS) {
            const sessions = files
                .map(f => ({ name: f, path: path.join(TEMP_DIR, f) }))
                .filter(f => fs.existsSync(f.path))
                .map(f => ({ ...f, stat: fs.statSync(f.path) }))
                .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
            
            const toDelete = sessions.slice(0, sessionCount - MAX_SESSIONS);
            for (const session of toDelete) {
                removeFile(session.path, true);
            }
        }
    } catch (e) {}
}, 600000);

// Clean up stale active sessions
setInterval(() => {
    const now = Date.now();
    for (const [number, data] of ACTIVE_SESSIONS.entries()) {
        if (now - data.timestamp > PAIRING_TIMEOUT) {
            console.log(`🧹 Cleaning up stale session for ${redactNumber(number)}`);
            if (data.cleanupTimeout) clearTimeout(data.cleanupTimeout);
            if (data.socket) {
                try { data.socket.end(); } catch (e) {}
            }
            ACTIVE_SESSIONS.delete(number);
            activePairingCount = Math.max(0, activePairingCount - 1);
        }
    }
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
    
    // Check for existing session
    if (ACTIVE_SESSIONS.has(formattedNumber)) {
        const activeSession = ACTIVE_SESSIONS.get(formattedNumber);
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
    let megaTimer = null;
    let cleanupTimer = null;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 3;
    
    // Register session
    ACTIVE_SESSIONS.set(formattedNumber, {
        sessionId,
        timestamp: Date.now(),
        ip: clientIp,
        socket: null,
        state: 'pairing'
    });
    activePairingCount++;
    console.log(`📊 Active pairings: ${activePairingCount}`);
    
    const cleanup = (delayMs = 10000, reason = 'cleanup') => {
        if (cleaned) return;
        cleaned = true;
        console.log(`🧹 [${sessionId}] Cleanup (${reason}) scheduled`);
        
        // Clear all timers
        if (megaTimer) clearTimeout(megaTimer);
        if (cleanupTimer) clearTimeout(cleanupTimer);
        
        // Remove from active sessions
        if (ACTIVE_SESSIONS.has(formattedNumber)) {
            const session = ACTIVE_SESSIONS.get(formattedNumber);
            if (session.cleanupTimeout) clearTimeout(session.cleanupTimeout);
            ACTIVE_SESSIONS.delete(formattedNumber);
            console.log(`🗑️ [${sessionId}] Removed ${redactedNumber} from active sessions`);
        }
        
        // Decrement counter
        activePairingCount = Math.max(0, activePairingCount - 1);
        console.log(`📊 Active pairings after cleanup: ${activePairingCount}`);
        
        // Remove listeners and close socket
        if (currentSock) {
            if (connectionListener) currentSock.ev.off('connection.update', connectionListener);
            if (credsListener) currentSock.ev.off('creds.update', credsListener);
            currentSock.ev.removeAllListeners();
            try { currentSock.end(); } catch (e) {}
        }
        
        // Schedule directory removal
        if (sessionDirCreated && fs.existsSync(sessionDir)) {
            setTimeout(() => {
                if (fs.existsSync(sessionDir)) removeFile(sessionDir, true);
            }, delayMs);
        }
    };
    
    const sendResponse = (data) => {
        if (!responseSent && !cleaned && !res.headersSent) {
            responseSent = true;
            res.json(data);
        }
    };
    
    const reconnectSocket = async () => {
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.error(`❌ [${sessionId}] Max reconnect attempts reached`);
            return null;
        }
        
        reconnectAttempts++;
        console.log(`🔄 [${sessionId}] Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
        
        try {
            // Clean up old socket
            if (currentSock) {
                if (connectionListener) currentSock.ev.off('connection.update', connectionListener);
                if (credsListener) currentSock.ev.off('creds.update', credsListener);
                try { currentSock.end(); } catch (e) {}
            }
            
            // Create new socket
            const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
            saveCredsFn = saveCreds;
            const version = await getCachedVersion();
            
            const newSock = makeWASocket({
                version,
                auth: state,
                browser: Browsers.macOS("Chrome"),
                printQRInTerminal: false,
                markOnlineOnConnect: false,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                keepAliveIntervalMs: 30000
            });
            
            // Reattach listeners
            credsListener = async (creds) => {
                console.log(`💾 [${sessionId}] creds.update - registered: ${creds?.registered}`);
                try {
                    if (saveCredsFn) await saveCredsFn();
                } catch (err) {
                    console.error(`❌ [${sessionId}] Failed to save creds:`, err.message);
                }
            };
            newSock.ev.on('creds.update', credsListener);
            
            connectionListener = async (update) => {
                await handleConnectionUpdate(update, newSock);
            };
            newSock.ev.on('connection.update', connectionListener);
            
            // Update session reference
            if (ACTIVE_SESSIONS.has(formattedNumber)) {
                ACTIVE_SESSIONS.get(formattedNumber).socket = newSock;
            }
            
            return newSock;
            
        } catch (err) {
            console.error(`❌ [${sessionId}] Reconnect failed:`, err.message);
            return null;
        }
    };
    
    const handleConnectionUpdate = async (update, socket) => {
        try {
            const { connection, lastDisconnect } = update;
            
            console.log(`[${sessionId}] Connection: ${connection || 'connecting'}`);
            
            // Handle connection close - attempt recovery
            if (connection === 'close') {
                console.log(`⚠️ [${sessionId}] Connection closed`);
                
                if (!sessionExported && !userConnected) {
                    console.log(`🔄 [${sessionId}] Attempting to recover...`);
                    const newSock = await reconnectSocket();
                    if (newSock) {
                        currentSock = newSock;
                        // Retry pairing with new socket
                        const retryResult = await requestPairingWithRetry(currentSock, formattedNumber);
                        if (retryResult.success && !responseSent) {
                            const formattedCode = retryResult.code.match(/.{1,4}/g)?.join('-') || retryResult.code;
                            sendResponse({
                                success: true,
                                code: formattedCode,
                                rawCode: retryResult.code,
                                sessionId,
                                phoneNumber: redactedNumber,
                                message: 'Enter this code in WhatsApp',
                                instructions: [
                                    '1. WhatsApp → Settings → Linked Devices',
                                    '2. Tap "Link a Device"',
                                    `3. Enter code: ${formattedCode}`,
                                    '4. Wait for connection...'
                                ]
                            });
                        }
                    }
                }
                return;
            }
            
            if (lastDisconnect?.error) {
                const statusCode = lastDisconnect.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log(`⚠️ [${sessionId}] User logged out`);
                    cleanup(5000, 'logged_out');
                    return;
                }
                console.error(`❌ [${sessionId}] Error:`, lastDisconnect.error.message);
            }
            
            // Check for successful connection
            if (connection === 'open' && socket?.user?.id && !sessionExported && !userConnected) {
                const connectedNumber = socket.user.id.split(':')[0];
                const phoneMatches = connectedNumber === formattedNumber;
                
                console.log(`🎉 [${sessionId}] Connection open! Phone match: ${phoneMatches}`);
                
                if (phoneMatches) {
                    userConnected = true;
                    
                    // Update session state
                    if (ACTIVE_SESSIONS.has(formattedNumber)) {
                        ACTIVE_SESSIONS.get(formattedNumber).state = 'connected';
                    }
                    
                    await delay(2000);
                    
                    // Wait for creds file
                    const credsPath = path.join(sessionDir, 'creds.json');
                    let credsWait = 0;
                    while (!fs.existsSync(credsPath) && credsWait < 30) {
                        await delay(500);
                        credsWait++;
                    }
                    
                    const credsBase64 = getCredsFile(sessionDir);
                    if (!credsBase64) {
                        console.error(`❌ [${sessionId}] creds.json not found`);
                        cleanup(5000, 'no_creds');
                        return;
                    }
                    
                    const sessionString = encryptSession(credsBase64, sessionId);
                    const sessionFile = path.join(sessionDir, 'session.txt');
                    fs.writeFileSync(sessionFile, sessionString);
                    
                    const userJid = socket.user.id;
                    console.log(`📤 [${sessionId}] Sending session...`);
                    
                    const chunks = splitSessionIntoChunks(sessionString);
                    let sendSuccess = true;
                    
                    try {
                        if (chunks.length === 1) {
                            await socket.sendMessage(userJid, { text: sessionString });
                        } else {
                            for (let i = 0; i < chunks.length; i++) {
                                await delay(2000);
                                await socket.sendMessage(userJid, { 
                                    text: `📦 *Part ${i+1}/${chunks.length}*\n\n${chunks[i]}` 
                                });
                            }
                            await socket.sendMessage(userJid, { text: `✅ *Complete!*` });
                        }
                        
                        await socket.sendMessage(userJid, {
                            text: `⚠️ *DO NOT SHARE THIS SESSION* ⚠️\n\nThanks for using GleBot\n\n📢 Join: ${CHANNEL_LINK}`
                        });
                        
                        console.log(`✅ [${sessionId}] Session exported`);
                        sessionExported = true;
                        
                        // Mega backup
                        if (!megaUploadStarted) {
                            megaUploadStarted = true;
                            megaTimer = setTimeout(async () => {
                                try {
                                    const megaUrl = await uploadSession(sessionString, sessionId);
                                    if (megaUrl && !megaUrl.startsWith('local://') && socket?.user) {
                                        await socket.sendMessage(userJid, { 
                                            text: `💾 *Mega Backup*\n\n${megaUrl}` 
                                        });
                                    }
                                } catch (e) {
                                    console.error(`Mega failed:`, e.message);
                                }
                            }, 15000);
                        }
                        
                        // Success cleanup
                        cleanupTimer = setTimeout(() => cleanup(5000, 'success'), 5000);
                        
                    } catch (err) {
                        console.error(`❌ [${sessionId}] Send failed:`, err.message);
                        cleanup(5000, 'send_failed');
                    }
                }
            }
        } catch (err) {
            console.error(`❌ [${sessionId}] Connection handler error:`, err);
        }
    };
    
    const requestPairingWithRetry = async (socket, phoneNumber, maxRetries = 3) => {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`🔑 [${sessionId}] Requesting pairing code (attempt ${attempt}/${maxRetries})...`);
                
                if (attempt === 1) await delay(2000);
                
                const code = await Promise.race([
                    socket.requestPairingCode(phoneNumber),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), PAIRING_CODE_TIMEOUT))
                ]);
                
                if (code) return { success: true, code };
                
            } catch (err) {
                console.error(`❌ [${sessionId}] Attempt ${attempt} failed:`, err.message);
                
                // Check if socket is dead and need recreation
                if (attempt < maxRetries) {
                    const newSock = await reconnectSocket();
                    if (newSock) {
                        socket = newSock;
                        currentSock = socket;
                    }
                    await delay(3000);
                }
            }
        }
        return { success: false, error: 'All pairing attempts failed' };
    };
    
    try {
        // Create session directory
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
            sessionDirCreated = true;
        }
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        saveCredsFn = saveCreds;
        const version = await getCachedVersion();
        
        console.log(`🔨 [${sessionId}] Creating socket...`);
        
        currentSock = makeWASocket({
            version,
            auth: state,
            browser: Browsers.macOS("Chrome"),
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000
        });
        
        // Update session with socket
        if (ACTIVE_SESSIONS.has(formattedNumber)) {
            ACTIVE_SESSIONS.get(formattedNumber).socket = currentSock;
        }
        
        // Set up listeners
        credsListener = async (creds) => {
            console.log(`💾 [${sessionId}] creds.update - registered: ${creds?.registered}`);
            try {
                if (saveCredsFn) await saveCredsFn();
            } catch (err) {
                console.error(`❌ [${sessionId}] Failed to save creds:`, err.message);
            }
        };
        currentSock.ev.on('creds.update', credsListener);
        
        connectionListener = async (update) => {
            await handleConnectionUpdate(update, currentSock);
        };
        currentSock.ev.on('connection.update', connectionListener);
        
        // Request pairing code
        const pairingResult = await requestPairingWithRetry(currentSock, formattedNumber);
        
        if (!pairingResult.success) {
            const isDeviceLimit = isDeviceLimitError(pairingResult.error);
            sendResponse({
                success: false,
                error: isDeviceLimit ? 'Too many linked devices. Please remove one from WhatsApp settings.' : `Pairing failed: ${pairingResult.error}`,
                sessionId,
                code: isDeviceLimit ? 'DEVICE_LIMIT' : 'PAIRING_FAILED'
            });
            cleanup(5000, 'pairing_failed');
            return;
        }
        
        const formattedCode = pairingResult.code.match(/.{1,4}/g)?.join('-') || pairingResult.code;
        console.log(`✅ [${sessionId}] Pairing code: ${formattedCode}`);
        
        sendResponse({
            success: true,
            code: formattedCode,
            rawCode: pairingResult.code,
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
        
        // Final timeout
        cleanupTimer = setTimeout(() => {
            if (!sessionExported && !cleaned) {
                console.log(`⏰ [${sessionId}] Timeout waiting for connection`);
                if (!responseSent) {
                    sendResponse({ 
                        success: false, 
                        error: 'Timeout waiting for connection',
                        sessionId
                    });
                }
                cleanup(5000, 'timeout');
            }
        }, PAIRING_TIMEOUT);
        
    } catch (error) {
        console.error(`❌ [${sessionId}] Fatal:`, error);
        if (!responseSent && !cleaned) {
            sendResponse({ success: false, error: error.message, sessionId });
        }
        cleanup(5000, 'fatal');
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
        activeSessions: Math.min(sessions, MAX_SESSIONS),
        activePairings: ACTIVE_SESSIONS.size,
        maxConcurrentPairings: MAX_CONCURRENT_PAIRINGS,
        maxSessions: MAX_SESSIONS,
        availableSlots: Math.max(0, MAX_CONCURRENT_PAIRINGS - activePairingCount)
    });
});

export default router;
