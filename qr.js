import express from 'express';
import fs from 'fs';
import { makeWASocket, useMultiFileAuthState, delay, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { uploadSession } from './mega.js';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMP_DIR = path.join(__dirname, 'temp_sessions');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const activeSessions = new Map();

function makeid() {
    return crypto.randomBytes(8).toString('hex');
}

function removeFile(filePath) {
    try { if (fs.existsSync(filePath)) fs.rmSync(filePath, { recursive: true, force: true }); } catch (e) {}
}

// ==================== SESSION EXPORT FUNCTIONS ====================
function collectSessionFiles(sessionDir) {
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
}

function encryptSession(sessionData, sessionId) {
    const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
    if (!ENCRYPTION_KEY) return JSON.stringify(sessionData);
    
    const key = crypto.createHash('sha256').update(ENCRYPTION_KEY + sessionId).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    
    let encrypted = cipher.update(JSON.stringify(sessionData), 'utf8', 'base64');
    encrypted += cipher.final('base64');
    
    const package_ = { iv: iv.toString('base64'), data: encrypted, sessionId };
    return Buffer.from(JSON.stringify(package_)).toString('base64');
}

// ==================== QR ENDPOINT ====================
router.get('/', async (req, res) => {
    const sessionId = makeid();
    const sessionDir = path.join(TEMP_DIR, sessionId);
    
    console.log(`\n🔷 [${sessionId}] QR session started`);
    
    try {
        fs.mkdirSync(sessionDir, { recursive: true });
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.windows("Chrome"),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            keepAliveIntervalMs: 30000,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            shouldSyncHistoryMessage: false,
            emitOwnEvents: true
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        activeSessions.set(sessionId, { sock, sessionDir, status: 'waiting' });
        
        let qrSent = false;
        let responseSent = false;
        let loggedIn = false;
        let apiResponseSent = false;
        let pairingConfigured = false;
        let reconnectTimer = null;
        
        // QR timeout: 3 minutes
        const QR_TIMEOUT = 180000;
        const RECONNECT_TIMEOUT = 30000;
        
        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect, isNewLogin } = update;
            
            console.log(`[${sessionId}] State:`, connection || 'waiting', isNewLogin ? '(new login)' : '');
            
            // QR CODE GENERATED
            if (qr && !qrSent && !responseSent) {
                qrSent = true;
                try {
                    const qrImage = await QRCode.toDataURL(qr);
                    
                    res.json({ 
                        success: true, 
                        qr: qrImage, 
                        sessionId,
                        message: 'Scan with WhatsApp',
                        instructions: [
                            '1. Open WhatsApp on your phone',
                            '2. Tap Menu > Linked Devices',
                            '3. Tap "Link a Device"',
                            '4. Scan this QR code',
                            '',
                            `⏱️ QR expires in ${QR_TIMEOUT/1000} seconds`
                        ]
                    });
                    responseSent = true;
                    console.log(`✅ [${sessionId}] QR sent to client (timeout: ${QR_TIMEOUT/1000}s)`);
                    
                    setTimeout(() => {
                        if (!loggedIn && !pairingConfigured) {
                            console.log(`⏰ [${sessionId}] QR timeout - cleaning up`);
                            sock.ws?.close();
                            activeSessions.delete(sessionId);
                            removeFile(sessionDir);
                        }
                    }, QR_TIMEOUT);
                    
                } catch (err) {
                    console.error(`QR error:`, err);
                }
            }
            
            // Detect QR scan
            if (isNewLogin) {
                console.log(`📱 [${sessionId}] QR SCANNED!`);
                pairingConfigured = true;
            }
            
            // Handle close - expected restart after scan
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`[${sessionId}] Closed with code:`, statusCode);
                
                if (pairingConfigured && !loggedIn) {
                    console.log(`🔄 [${sessionId}] Expected restart after scan - waiting for reconnect...`);
                    if (reconnectTimer) clearTimeout(reconnectTimer);
                    reconnectTimer = setTimeout(() => {
                        if (!loggedIn) {
                            console.log(`⏰ [${sessionId}] Reconnect timeout - cleaning up`);
                            sock.ws?.close();
                            activeSessions.delete(sessionId);
                            removeFile(sessionDir);
                        }
                    }, RECONNECT_TIMEOUT);
                    return;
                }
                
                if (!loggedIn && !pairingConfigured) {
                    console.log(`[${sessionId}] Connection closed without scan - cleaning up`);
                    activeSessions.delete(sessionId);
                    removeFile(sessionDir);
                }
            }
            
            // ✅ FINAL LOGIN DETECTION - Check for creds.registered OR sock.user
            if (!loggedIn && (sock.authState?.creds?.registered || sock.user)) {
                console.log(`🎉 [${sessionId}] LOGIN SUCCESSFUL!`);
                console.log(`👤 User: ${sock.user?.id || 'unknown'}`);
                
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = null;
                }
                
                loggedIn = true;
                
                // Force save credentials
                console.log(`💾 [${sessionId}] Forcing credentials save...`);
                await saveCreds();
                
                // Wait for files to write
                console.log(`⏳ [${sessionId}] Waiting 4 seconds for files to stabilize...`);
                await delay(4000);
                
                try {
                    // Collect session files
                    console.log(`📁 [${sessionId}] Collecting session files...`);
                    const sessionFiles = collectSessionFiles(sessionDir);
                    
                    if (Object.keys(sessionFiles).length === 0) {
                        throw new Error('No session files found');
                    }
                    
                    const sessionPackage = {
                        id: sessionId,
                        user: sock.user?.id || 'unknown',
                        timestamp: Date.now(),
                        files: sessionFiles
                    };
                    
                    // Encrypt session
                    console.log(`🔐 [${sessionId}] Encrypting session...`);
                    const sessionString = encryptSession(sessionPackage, sessionId);
                    
                    if (!apiResponseSent && sock.user) {
                        console.log(`📤 [${sessionId}] Sending session via WhatsApp...`);
                        const userJid = sock.user.id;
                        
                        await sock.sendMessage(userJid, {
                            text: `🔐 *GLE Session String*\n\nCopy this entire string for session restore:\n\n\`${sessionString}\``
                        });
                        console.log(`✅ [${sessionId}] Session string sent`);
                        
                        const credsPath = path.join(sessionDir, 'creds.json');
                        if (fs.existsSync(credsPath)) {
                            await sock.sendMessage(userJid, {
                                document: fs.readFileSync(credsPath),
                                mimetype: 'application/json',
                                fileName: 'creds.json',
                                caption: '📁 Your WhatsApp session credentials file'
                            });
                            console.log(`✅ [${sessionId}] creds.json sent`);
                        }
                        
                        await sock.sendMessage(userJid, {
                            text: `✅ *Login Complete!*\n\nSession saved and sent.`
                        });
                        
                        apiResponseSent = true;
                    }
                    
                    // Mega upload in background
                    (async () => {
                        try {
                            console.log(`☁️ [${sessionId}] Background Mega upload...`);
                            const megaUrl = await uploadSession(sessionString, sessionId);
                            if (megaUrl && !megaUrl.startsWith('local://')) {
                                console.log(`✅ [${sessionId}] Mega upload complete`);
                                if (sock.user) {
                                    await sock.sendMessage(sock.user.id, {
                                        text: `💾 *Mega Backup*\n\n${megaUrl}`
                                    });
                                }
                            }
                        } catch (e) {
                            console.log(`⚠️ [${sessionId}] Mega upload failed: ${e.message}`);
                        }
                    })();
                    
                    // Cleanup
                    setTimeout(() => {
                        console.log(`🔌 [${sessionId}] Closing session socket...`);
                        sock.ws?.close();
                        setTimeout(() => {
                            activeSessions.delete(sessionId);
                            removeFile(sessionDir);
                            console.log(`🧹 [${sessionId}] Cleanup complete`);
                        }, 5000);
                    }, 5000);
                    
                } catch (err) {
                    console.error(`❌ [${sessionId}] Session processing failed:`, err);
                    if (sock.user) {
                        try {
                            await sock.sendMessage(sock.user.id, {
                                text: `❌ *Error*\n\n${err.message}`
                            });
                        } catch (e) {}
                    }
                    sock.ws?.close();
                    activeSessions.delete(sessionId);
                    removeFile(sessionDir);
                }
            }
        });
        
        // QR generation timeout
        setTimeout(() => {
            if (!qrSent && !responseSent) {
                res.status(504).json({ success: false, error: 'QR generation timeout' });
                sock.ws?.close();
                activeSessions.delete(sessionId);
                removeFile(sessionDir);
            }
        }, 30000);
        
    } catch (error) {
        console.error(`Fatal:`, error);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: error.message });
        }
        removeFile(sessionDir);
        activeSessions.delete(sessionId);
    }
});

export default router;
