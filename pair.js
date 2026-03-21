import express from 'express';
import fs from 'fs';
import { makeWASocket, useMultiFileAuthState, delay, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
import { uploadSession } from './mega.js';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import cors from 'cors';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

router.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    methods: ['GET'],
    credentials: true
}));

const TEMP_DIR = path.join(__dirname, 'temp_sessions');
const MAX_SESSIONS = 100;
const CLEANUP_AGE = 3600000;

let cachedVersion = null;
let versionCacheTime = 0;
const VERSION_CACHE_TTL = 3600000;

let encryptionWarningLogged = false;
const rateLimits = new Map();
const BASE_URL = process.env.BASE_URL || 'https://gle-session-2.onrender.com';

function makeid() {
    return crypto.randomBytes(8).toString('hex');
}

function removeFile(filePath) {
    try { if (fs.existsSync(filePath)) fs.rmSync(filePath, { recursive: true, force: true }); } catch (e) {}
}

function collectSessionFiles(sessionDir) {
    try {
        const sessionData = {};
        const files = fs.readdirSync(sessionDir);
        
        for (const file of files) {
            const filePath = path.join(sessionDir, file);
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
                const content = fs.readFileSync(filePath);
                sessionData[file] = content.toString('base64');
            }
        }
        return sessionData;
    } catch (err) {
        console.error(`Failed to collect session files:`, err);
        return {};
    }
}

function encryptSession(sessionData, sessionId) {
    const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
    if (!ENCRYPTION_KEY) {
        if (!encryptionWarningLogged) {
            console.warn(`⚠️ Encryption disabled - sessions will be plain text! Set ENCRYPTION_KEY in environment.`);
            encryptionWarningLogged = true;
        }
        return JSON.stringify(sessionData);
    }
    
    const key = crypto.createHash('sha256').update(ENCRYPTION_KEY + sessionId).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(JSON.stringify(sessionData), 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');
    
    const package_ = { iv: iv.toString('base64'), data: encrypted, authTag, sessionId };
    return Buffer.from(JSON.stringify(package_)).toString('base64');
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
        console.error('Failed to fetch version, using cached:', err.message);
        return cachedVersion || [2, 3000, 1035194821];
    }
}

function checkRateLimit(ip) {
    const now = Date.now();
    const limit = rateLimits.get(ip) || [];
    const recent = limit.filter(time => now - time < 60000);
    if (recent.length >= 3) {
        return false;
    }
    recent.push(now);
    rateLimits.set(ip, recent);
    return true;
}

// Cleanup intervals (same as qr.js)
setInterval(() => {
    try {
        if (!fs.existsSync(TEMP_DIR)) return;
        const files = fs.readdirSync(TEMP_DIR);
        const now = Date.now();
        for (const file of files) {
            const filePath = path.join(TEMP_DIR, file);
            try {
                const stat = fs.statSync(filePath);
                if (now - stat.mtimeMs > CLEANUP_AGE) {
                    removeFile(filePath);
                    console.log(`🧹 Cleaned old session: ${file}`);
                }
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
            for (const session of toDelete) {
                removeFile(path.join(TEMP_DIR, session));
                console.log(`🧹 Removed old session (limit): ${session}`);
            }
        }
    } catch (e) {
        console.log("Cleanup error:", e.message);
    }
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
    
    const clientIp = req.ip || req.connection.remoteAddress;
    if (!checkRateLimit(clientIp)) {
        return res.status(429).json({ 
            success: false, 
            error: 'Rate limited. Please wait a minute.',
            sessionId 
        });
    }
    
    console.log(`\n🔷 [${sessionId}] Pairing session started for ${number} from ${clientIp}`);
    
    let sock = null;
    let codeSent = false;
    let sessionExported = false;
    let userConnected = false;
    let credsUpdateCount = 0;
    let cleanupTimer = null;
    let cleaned = false;
    
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        
        console.log(`🧹 [${sessionId}] Starting cleanup...`);
        
        if (cleanupTimer) clearTimeout(cleanupTimer);
        
        if (sock) {
            sock.end();
        }
        
        setTimeout(() => {
            removeFile(sessionDir);
            console.log(`🧹 [${sessionId}] Cleanup complete`);
        }, 1000);
    };
    
    try {
        if (!number) {
            return res.status(400).json({ success: false, error: 'Phone number required', sessionId });
        }
        
        number = number.replace(/\D/g, '');
        const phone = pn('+' + number);
        if (!phone.isValid()) {
            return res.status(400).json({ success: false, error: 'Invalid number', sessionId });
        }
        
        const formattedNumber = phone.getNumber('e164').replace('+', '');
        fs.mkdirSync(sessionDir, { recursive: true });
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const version = await getCachedVersion();
        
        const onCredsUpdate = () => {
            credsUpdateCount++;
            console.log(`💾 [${sessionId}] creds.update #${credsUpdateCount}`);
            saveCreds();
        };
        
        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.windows("Chrome"),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 30000,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000
        });
        
        sock.ev.on('creds.update', onCredsUpdate);
        
        setTimeout(async () => {
            if (codeSent || sessionExported || cleaned) return;
            
            try {
                console.log(`🔑 [${sessionId}] Requesting pairing code...`);
                const code = await sock.requestPairingCode(formattedNumber);
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                codeSent = true;
                
                console.log(`✅ [${sessionId}] Code: ${formattedCode}`);
                
                if (!res.headersSent && !cleaned) {
                    res.json({
                        success: true,
                        code: formattedCode,
                        sessionId,
                        message: 'Enter this code in WhatsApp',
                        instructions: [
                            '1. Open WhatsApp on your phone',
                            '2. Go to Settings > Linked Devices',
                            '3. Tap "Link a Device"',
                            `4. Enter the code: ${formattedCode}`,
                            '',
                            '⏱️ Code expires in 2 minutes',
                            '',
                            `Session ID: ${sessionId} (save this for manual retrieval)`,
                            `Manual retrieval: ${BASE_URL}/pair/session/${sessionId}`
                        ],
                        expiresIn: 120
                    });
                }
                
            } catch (error) {
                console.error(`❌ [${sessionId}] Code error:`, error);
                if (!res.headersSent && !cleaned) {
                    res.status(500).json({ success: false, error: error.message, sessionId });
                }
                cleanup();
            }
        }, 3000);
        
        sock.ev.on('connection.update', async (update) => {
            if (sessionExported || cleaned) return;
            
            const { connection } = update;
            console.log(`[${sessionId}] State:`, connection || 'waiting');
            
            if (connection === 'close' && !sessionExported) {
                console.log(`🔴 [${sessionId}] Connection closed without export`);
                cleanup();
            }
            
            if (connection === 'open' && sock.user && !userConnected) {
                userConnected = true;
                console.log(`🎉 [${sessionId}] USER CONNECTED!`);
                console.log(`👤 User: ${sock.user.id}`);
                
                console.log(`⏳ [${sessionId}] Waiting 5 seconds for files to write...`);
                await delay(5000);
                
                try {
                    console.log(`📁 [${sessionId}] Collecting session files...`);
                    const sessionFiles = collectSessionFiles(sessionDir);
                    
                    if (!sessionFiles["creds.json"]) {
                        throw new Error('creds.json missing from session');
                    }
                    
                    if (Object.keys(sessionFiles).length === 0) {
                        throw new Error('No session files found');
                    }
                    
                    const sessionPackage = {
                        id: sessionId,
                        user: sock.user.id,
                        number: formattedNumber,
                        timestamp: Date.now(),
                        files: sessionFiles
                    };
                    
                    console.log(`🔐 [${sessionId}] Encrypting session...`);
                    const sessionString = encryptSession(sessionPackage, sessionId);
                    
                    const sessionFile = path.join(sessionDir, 'session.txt');
                    fs.writeFileSync(sessionFile, sessionString);
                    
                    console.log(`📤 [${sessionId}] Sending session to user...`);
                    const userJid = formattedNumber + '@s.whatsapp.net';
                    
                    try {
                        await sock.sendMessage(userJid, {
                            text: `🔐 *GLE Session String*\n\n\`${sessionString}\``
                        });
                        console.log(`✅ [${sessionId}] Session string sent`);
                        
                        await sock.sendMessage(userJid, {
                            text: `✅ *Session Export Complete!*\n\nSession ID: \`${sessionId}\`\n\nManual retrieval: ${BASE_URL}/pair/session/${sessionId}`
                        });
                        
                        console.log(`✅ [${sessionId}] Session sent to user`);
                        sessionExported = true;
                        
                        // Mega upload - no sessionExported check
                        (async () => {
                            try {
                                console.log(`☁️ [${sessionId}] Background Mega upload...`);
                                const megaUrl = await uploadSession(sessionString, sessionId);
                                if (megaUrl && !megaUrl.startsWith('local://')) {
                                    console.log(`✅ [${sessionId}] Mega upload complete`);
                                    if (sock && sock.user) {
                                        try {
                                            await sock.sendMessage(userJid, {
                                                text: `💾 *Mega Backup*\n\n${megaUrl}`
                                            });
                                            console.log(`✅ [${sessionId}] Mega link sent`);
                                        } catch (e) {
                                            console.log(`⚠️ [${sessionId}] Could not send Mega link: ${e.message}`);
                                        }
                                    }
                                }
                            } catch (e) {
                                console.log(`⚠️ [${sessionId}] Mega upload failed: ${e.message}`);
                            }
                        })();
                        
                        setTimeout(() => cleanup(), 60000);
                        
                    } catch (err) {
                        console.error(`❌ [${sessionId}] Failed to send:`, err);
                        throw err;
                    }
                    
                } catch (err) {
                    console.error(`❌ [${sessionId}] Export failed:`, err);
                    cleanup();
                }
            }
        });
        
        setTimeout(() => {
            if (!sessionExported && !cleaned) {
                console.log(`⏰ [${sessionId}] Code timeout`);
                cleanup();
            }
        }, 120000);
        
    } catch (error) {
        console.error(`Fatal:`, error);
        if (!res.headersSent && !cleaned) {
            res.status(500).json({ success: false, error: error.message, sessionId });
        }
        cleanup();
    }
});

// Session retrieval endpoint with optional key
router.get('/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { key } = req.query;
    const expectedKey = process.env.SESSION_RETRIEVAL_KEY;
    
    if (expectedKey && key !== expectedKey) {
        return res.status(401).json({ success: false, error: 'Invalid or missing key' });
    }
    
    const sessionDir = path.join(TEMP_DIR, sessionId);
    const sessionFile = path.join(sessionDir, 'session.txt');
    
    if (fs.existsSync(sessionFile)) {
        const sessionString = fs.readFileSync(sessionFile, 'utf8');
        res.json({ success: true, sessionString, sessionId });
    } else {
        res.status(404).json({ success: false, error: 'Session not found or not ready', sessionId });
    }
});

export default router;
