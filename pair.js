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
        throw new Error('ENCRYPTION_KEY is required for session encryption');
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
        // More stable fallback version
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
        for (const [key, times] of RATE_LIMIT_MAP.entries()) {
            const recent = times.filter(t => now - t < 60000);
            if (recent.length === 0) RATE_LIMIT_MAP.delete(key);
            else RATE_LIMIT_MAP.set(key, recent);
        }
    } catch (e) {}
}, 60000);

// ==================== PAIRING ENDPOINT ====================
router.get('/', async (req, res) => {
    const sessionId = makeid();
    let { number } = req.query;
    const sessionDir = path.join(TEMP_DIR, sessionId);
    
    // Properly parse x-forwarded-for header
    const clientIp = (req.headers['x-forwarded-for'] || req.ip || '')
        .toString()
        .split(',')[0]
        .trim();
    
    if (!number || !/^\d{10,15}$/.test(number)) {
        return res.status(400).json({ 
            success: false, 
            error: 'Invalid phone number. Must be 10-15 digits only (no spaces, no +, no dashes).',
            example: '1234567890'
        });
    }
    
    if (!checkRateLimit(clientIp, number)) {
        return res.status(429).json({ success: false, error: 'Rate limited. Please wait a minute.' });
    }
    
    console.log(`\n🔷 [${sessionId}] Pairing session started for ${number} (IP: ${clientIp})`);
    
    let currentSock = null;
    let sessionExported = false;
    let userConnected = false;
    let cleaned = false;
    let saveCredsFn = null;
    let version = null;
    let responseSent = false;
    let megaUploadPromise = null;
    let megaUploadCompleted = false;
    
    const cleanup = (delayMs = 30000) => {
        if (cleaned) return;
        cleaned = true;
        console.log(`🧹 [${sessionId}] Cleanup scheduled in ${delayMs}ms...`);
        setTimeout(async () => {
            console.log(`🧹 [${sessionId}] Executing cleanup...`);
            
            if (megaUploadPromise && !megaUploadCompleted) {
                console.log(`⏳ [${sessionId}] Waiting for Mega upload to complete...`);
                await megaUploadPromise;
            }
            
            if (currentSock) {
                currentSock.ev.removeAllListeners();
                try { currentSock.end(); } catch (e) {}
            }
            removeFile(sessionDir);
        }, delayMs);
    };
    
    const sendResponse = (data) => {
        if (!responseSent && !cleaned) {
            responseSent = true;
            res.json(data);
        }
    };
    
    const createSocket = async (attemptNum = 1) => {
        console.log(`🔨 [${sessionId}] Creating socket (attempt ${attemptNum})...`);
        
        if (fs.existsSync(sessionDir)) {
            console.log(`🗑️ [${sessionId}] Removing old session directory`);
            removeFile(sessionDir);
        }
        fs.mkdirSync(sessionDir, { recursive: true });
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        saveCredsFn = saveCreds;
        version = await getCachedVersion();
        
        const socket = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.macOS("Chrome"),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 30000,
            defaultQueryTimeoutMs: 20000,
            connectTimeoutMs: 20000
        });
        
        return socket;
    };
    
    const waitForSocketReadiness = (socket, maxAttempts = 3) => {
        return new Promise((resolve, reject) => {
            let readinessTimeout = null;
            let connectionState = null;
            
            const checkReadiness = () => {
                const isReady = socket?.ws?.readyState === 1 && connectionState === 'connecting';
                
                if (isReady) {
                    console.log(`✅ [${sessionId}] Socket fully ready (ws:${socket.ws.readyState}, conn:${connectionState})`);
                    if (readinessTimeout) clearTimeout(readinessTimeout);
                    socket.ev.off('connection.update', connectionHandler);
                    resolve({ success: true, connectionState });
                } else if (connectionState === 'close') {
                    if (readinessTimeout) clearTimeout(readinessTimeout);
                    socket.ev.off('connection.update', connectionHandler);
                    reject(new Error(`Socket closed before ready (ws:${socket.ws?.readyState}, conn:${connectionState})`));
                }
            };
            
            const connectionHandler = (update) => {
                const { connection, lastDisconnect } = update;
                // Only update if connection has a value (prevent undefined overwriting)
                if (connection) connectionState = connection;
                
                if (lastDisconnect?.error) {
                    console.error(`❌ [${sessionId}] Connection error:`, lastDisconnect.error.message);
                }
                
                console.log(`[${sessionId}] State: ws=${socket.ws?.readyState}, conn=${connectionState}`);
                checkReadiness();
            };
            
            socket.ev.on('connection.update', connectionHandler);
            checkReadiness();
            
            readinessTimeout = setTimeout(() => {
                socket.ev.off('connection.update', connectionHandler);
                reject(new Error(`Timeout waiting for socket readiness (ws:${socket.ws?.readyState}, conn:${connectionState})`));
            }, 30000);
        });
    };
    
    const requestPairingWithFullRetry = async (phoneNumber, maxAttempts = 3) => {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            console.log(`🔑 [${sessionId}] Pairing attempt ${attempt}/${maxAttempts}...`);
            
            try {
                const newSocket = await createSocket(attempt);
                currentSock = newSocket;
                
                await waitForSocketReadiness(currentSock);
                
                if (currentSock.ws?.readyState !== 1) {
                    throw new Error(`Socket not alive after readiness (ws:${currentSock.ws?.readyState})`);
                }
                
                const code = await currentSock.requestPairingCode(phoneNumber);
                
                if (code) {
                    const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                    console.log(`✅ [${sessionId}] Pairing code: ${formattedCode}`);
                    return { success: true, code, formattedCode, socket: currentSock };
                }
                
                throw new Error('No code received from WhatsApp');
                
            } catch (error) {
                console.error(`❌ [${sessionId}] Pairing attempt ${attempt} failed:`, error.message);
                
                if (currentSock) {
                    try { currentSock.end(); } catch (e) {}
                    currentSock = null;
                }
                
                if (attempt < maxAttempts) {
                    console.log(`🔄 [${sessionId}] Retrying in 3 seconds...`);
                    await delay(3000);
                } else {
                    return { success: false, error: error.message };
                }
            }
        }
        
        return { success: false, error: 'All pairing attempts failed' };
    };
    
    const sendSessionWithRetry = async (socket, userJid, sessionString, retryCount = 0) => {
        try {
            await socket.sendMessage(userJid, { text: sessionString });
            console.log(`✅ [${sessionId}] Session sent successfully`);
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
    
    try {
        const pairingResult = await requestPairingWithFullRetry(number, 3);
        
        if (!pairingResult.success) {
            sendResponse({
                success: false,
                error: `Pairing failed: ${pairingResult.error}`,
                sessionId
            });
            cleanup(5000);
            return;
        }
        
        currentSock = pairingResult.socket;
        
        sendResponse({
            success: true,
            code: pairingResult.formattedCode,
            rawCode: pairingResult.code,
            sessionId,
            phoneNumber: number,
            message: 'Enter this code in WhatsApp',
            instructions: [
                '1. Open WhatsApp on your phone',
                '2. Go to Settings → Linked Devices',
                '3. Tap "Link a Device"',
                `4. Enter this code: ${pairingResult.formattedCode}`,
                '5. Wait for connection...'
            ],
            expiresIn: 120
        });
        
        // Handle credentials update
        currentSock.ev.on('creds.update', () => {
            console.log(`💾 [${sessionId}] creds.update`);
            if (saveCredsFn) saveCredsFn();
        });
        
        // Handle connection updates for post-link tasks
        currentSock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (lastDisconnect?.error) {
                console.error(`❌ [${sessionId}] Connection error:`, lastDisconnect.error.message);
            }
            
            console.log(`[${sessionId}] Connection: ${connection}`);
            
            if (connection === 'open' && currentSock?.user?.id && !userConnected) {
                const connectedNumber = currentSock.user.id.split(':')[0];
                const isCorrectNumber = connectedNumber === number;
                
                console.log(`🎉 [${sessionId}] USER CONNECTED!`);
                console.log(`👤 Connected number: ${connectedNumber}`);
                console.log(`✅ Matches requested: ${isCorrectNumber}`);
                
                userConnected = true;
                
                try {
                    await delay(3000);
                    
                    const credsBase64 = getCredsFile(sessionDir);
                    if (!credsBase64) {
                        throw new Error('creds.json not found after connection');
                    }
                    
                    const sessionString = encryptSession(credsBase64, sessionId);
                    const sessionFile = path.join(sessionDir, 'session.txt');
                    fs.writeFileSync(sessionFile, sessionString);
                    
                    console.log(`📤 [${sessionId}] Sending session...`);
                    const userJid = number + '@s.whatsapp.net';
                    
                    const sent = await sendSessionWithRetry(currentSock, userJid, sessionString);
                    
                    if (sent) {
                        await currentSock.sendMessage(userJid, {
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
                        
                        // Start Mega upload with tracking
                        megaUploadPromise = (async () => {
                            try {
                                const megaUrl = await uploadSession(sessionString, sessionId);
                                if (megaUrl && !megaUrl.startsWith('local://') && currentSock?.user) {
                                    await currentSock.sendMessage(userJid, { text: `💾 *Mega Backup*\n\n${megaUrl}` });
                                }
                            } catch (e) {
                                console.error(`Mega backup failed:`, e.message);
                            } finally {
                                megaUploadCompleted = true;
                            }
                        })();
                        
                        cleanup(30000);
                    } else {
                        throw new Error('Failed to send session after retries');
                    }
                    
                } catch (err) {
                    console.error(`❌ [${sessionId}] Export failed:`, err);
                    cleanup(5000);
                }
            }
            
            if (connection === 'close' && !sessionExported && !userConnected) {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`🔴 [${sessionId}] Connection closed before pairing, code: ${statusCode}`);
                // Let the timeout handle cleanup - no automatic recreation here
            }
        });
        
        // Extended cleanup timer - 5 minutes for user to enter code
        setTimeout(() => {
            if (!sessionExported && !cleaned) {
                console.log(`⏰ [${sessionId}] Session timeout - no connection established`);
                if (!responseSent) {
                    sendResponse({ 
                        success: false, 
                        error: 'Timeout waiting for connection. Make sure you entered the code within 2 minutes.',
                        sessionId
                    });
                }
                cleanup(5000);
            }
        }, 300000);
        
    } catch (error) {
        console.error(`❌ [${sessionId}] Fatal error:`, error);
        if (!responseSent && !cleaned) {
            res.status(500).json({ success: false, error: error.message, sessionId });
        }
        cleanup(5000);
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
        maxSessions: MAX_SESSIONS
    });
});

export default router;
