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

const CLEANUP_AGE = 3600000;
const RATE_LIMIT_MAP = new Map();
const ACTIVE_NUMBERS = new Map();
let activePairingCount = 0;
const activePairingLock = new Map(); // For precise counter management

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
    
    // Check for valid country code patterns first
    for (const { pattern } of COUNTRY_PATTERNS) {
        if (pattern.test(cleaned)) return cleaned;
    }
    
    // Handle common cases with better detection
    if (cleaned.length === 10 && cleaned.startsWith('0')) {
        // Remove leading 0 and try to detect country
        cleaned = cleaned.substring(1);
    }
    
    if (cleaned.length === 9 && cleaned.startsWith('7')) {
        cleaned = '254' + cleaned; // Kenya
    } else if (cleaned.length === 10 && cleaned.startsWith('7')) {
        cleaned = '254' + cleaned; // Kenya
    } else if (cleaned.length === 10 && !cleaned.startsWith('1')) {
        cleaned = '1' + cleaned; // US/CA fallback
    }
    
    return cleaned;
}

function redactNumber(number) {
    if (!number) return 'unknown';
    const len = number.length;
    if (len <= 4) return '****';
    return number.substring(0, 2) + '****' + number.substring(len - 2);
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
        
        // Enforce MAX_SESSIONS limit
        if (sessionCount > MAX_SESSIONS) {
            console.log(`⚠️ Session count (${sessionCount}) exceeds limit (${MAX_SESSIONS}), cleaning oldest...`);
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
    for (const [number, data] of ACTIVE_NUMBERS.entries()) {
        if (now - data.timestamp > PAIRING_TIMEOUT) {
            console.log(`🧹 Cleaning up stale active session for ${redactNumber(number)}`);
            if (data.cleanupTimeout) clearTimeout(data.cleanupTimeout);
            ACTIVE_NUMBERS.delete(number);
            
            // Decrement counter if this session was counted
            if (activePairingLock.has(data.sessionId)) {
                activePairingCount = Math.max(0, activePairingCount - 1);
                activePairingLock.delete(data.sessionId);
            }
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
    let megaTimer = null;
    let cleanupTimer = null;
    let activeTimer = null;
    let credsFileWritten = false;
    
    // Track this session for counter management
    activePairingLock.set(sessionId, true);
    activePairingCount++;
    console.log(`📊 Active pairings: ${activePairingCount}`);
    
    const cleanup = (delayMs = 10000) => {
        if (cleaned) return;
        cleaned = true;
        console.log(`🧹 [${sessionId}] Cleanup scheduled`);
        
        // Clear all timers
        if (megaTimer) clearTimeout(megaTimer);
        if (cleanupTimer) clearTimeout(cleanupTimer);
        
        // Remove from active numbers with proper cleanup
        if (ACTIVE_NUMBERS.has(formattedNumber)) {
            const active = ACTIVE_NUMBERS.get(formattedNumber);
            if (active.cleanupTimeout) clearTimeout(active.cleanupTimeout);
            ACTIVE_NUMBERS.delete(formattedNumber);
            console.log(`🗑️ [${sessionId}] Removed ${redactedNumber} from active sessions`);
        }
        
        // Decrement counter safely
        if (activePairingLock.has(sessionId)) {
            activePairingCount = Math.max(0, activePairingCount - 1);
            activePairingLock.delete(sessionId);
            console.log(`📊 Active pairings after cleanup: ${activePairingCount}`);
        }
        
        // Remove listeners
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
    
    // Wait for creds.json to be written (with timeout)
    const waitForCredsFile = (timeoutMs = 10000) => {
        return new Promise((resolve) => {
            const startTime = Date.now();
            const checkInterval = setInterval(() => {
                if (fs.existsSync(path.join(sessionDir, 'creds.json'))) {
                    clearInterval(checkInterval);
                    resolve(true);
                } else if (Date.now() - startTime > timeoutMs) {
                    clearInterval(checkInterval);
                    resolve(false);
                }
            }, 500);
        });
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
            
            // Wait for creds.json to be written
            const credsExist = await waitForCredsFile();
            if (!credsExist) {
                throw new Error('creds.json not found after waiting');
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
    
    // Request pairing code with retry
    const requestPairingWithRetry = async (socket, phoneNumber, maxRetries = 3) => {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`🔑 [${sessionId}] Requesting pairing code (attempt ${attempt}/${maxRetries})...`);
                
                // Small delay before first attempt to allow initialization
                if (attempt === 1) await delay(2000);
                
                const code = await Promise.race([
                    socket.requestPairingCode(phoneNumber),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), PAIRING_CODE_TIMEOUT))
                ]);
                
                if (code) return { success: true, code };
                
            } catch (err) {
                console.error(`❌ [${sessionId}] Attempt ${attempt} failed:`, err.message);
                if (attempt < maxRetries) {
                    await delay(3000);
                }
            }
        }
        return { success: false, error: 'All pairing attempts failed' };
    };
    
    try {
        // Register active session with extended timeout to prevent early removal
        activeTimer = setTimeout(() => {
            if (ACTIVE_NUMBERS.has(formattedNumber) && !sessionExported) {
                console.log(`⏰ [${sessionId}] Active session timeout - extending`);
                // Don't delete, just log - let the connection handler manage
            }
        }, PAIRING_TIMEOUT - 10000); // Warn 10 seconds before timeout
        
        ACTIVE_NUMBERS.set(formattedNumber, {
            sessionId,
            timestamp: Date.now(),
            ip: clientIp,
            cleanupTimeout: activeTimer
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
        
        // Single creds listener with file tracking
        credsListener = async (creds) => {
            console.log(`💾 [${sessionId}] creds.update - registered: ${creds?.registered}`);
            if (creds?.registered) credsFileWritten = true;
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
                
                // Handle all close scenarios
                if (connection === 'close') {
                    console.log(`⚠️ [${sessionId}] Connection closed`);
                    
                    // Check if we're already connected/exported
                    if (!sessionExported && !userConnected) {
                        // Don't cleanup immediately - let pairing retry handle it
                        console.log(`[${sessionId}] Connection closed before pairing, waiting for retry...`);
                    }
                    return;
                }
                
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
                        
                        // Wait for creds file to be written
                        await delay(2000);
                        
                        const result = await exportSession(currentSock, sessionDir, sessionId, formattedNumber);
                        
                        if (result.success) {
                            sessionExported = true;
                            
                            // Clear any pending cleanup
                            if (cleanupTimer) clearTimeout(cleanupTimer);
                            
                            // Mega upload with safe socket check
                            if (!megaUploadStarted) {
                                megaUploadStarted = true;
                                const sessionStringCopy = result.sessionString;
                                const userJidCopy = currentSock.user.id;
                                
                                megaTimer = setTimeout(async () => {
                                    try {
                                        // Check if socket still exists before sending
                                        if (currentSock && !cleaned && currentSock.user) {
                                            const megaUrl = await uploadSession(sessionStringCopy, sessionId);
                                            if (megaUrl && !megaUrl.startsWith('local://')) {
                                                await currentSock.sendMessage(userJidCopy, { 
                                                    text: `💾 *Mega Backup*\n\n${megaUrl}` 
                                                });
                                            }
                                        }
                                    } catch (e) {
                                        console.error(`Mega failed:`, e.message);
                                    }
                                }, 15000); // Longer delay to ensure cleanup doesn't interfere
                            }
                            
                            // Success cleanup
                            cleanupTimer = setTimeout(() => cleanup(5000), 5000);
                        }
                    }
                }
            } catch (err) {
                console.error(`❌ [${sessionId}] Connection handler error:`, err);
            }
        };
        currentSock.ev.on('connection.update', connectionListener);
        
        // Request pairing code with retry
        const pairingResult = await requestPairingWithRetry(currentSock, formattedNumber);
        
        if (!pairingResult.success) {
            console.error(`❌ [${sessionId}] Pairing failed after retries`);
            
            // Check for device limit error
            const isDeviceLimit = pairingResult.error?.includes('device') || pairingResult.error?.includes('limit');
            sendResponse({
                success: false,
                error: isDeviceLimit ? 'Too many linked devices. Please remove one from WhatsApp settings.' : `Pairing failed: ${pairingResult.error}`,
                sessionId,
                code: isDeviceLimit ? 'DEVICE_LIMIT' : 'PAIRING_FAILED'
            });
            cleanup(5000);
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
        
        // Timeout for user to enter code
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
        activeSessions: Math.min(sessions, MAX_SESSIONS),
        activePairings: ACTIVE_NUMBERS.size,
        maxConcurrentPairings: MAX_CONCURRENT_PAIRINGS,
        maxSessions: MAX_SESSIONS,
        availableSlots: Math.max(0, MAX_CONCURRENT_PAIRINGS - activePairingCount)
    });
});

export default router;
