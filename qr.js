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
        
        let sock = null;
        let qrSent = false;
        let responseSent = false;
        let loggedIn = false;
        let apiResponseSent = false;
        let pairingConfigured = false;
        let reconnectTimer = null;
        let isReconnecting = false;
        
        // ✅ INCREASED QR TIMEOUT: 3 minutes (180 seconds)
        const QR_TIMEOUT = 180000; // 180 seconds
        // ✅ Reconnect timeout: 30 seconds
        const RECONNECT_TIMEOUT = 30000; // 30 seconds
        
        // Function to create socket
        const createSocket = async () => {
            const newSock = makeWASocket({
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
            
            newSock.ev.on('creds.update', saveCreds);
            
            newSock.ev.on('connection.update', async (update) => {
                const { connection, qr, lastDisconnect, isNewLogin } = update;
                
                console.log(`[${sessionId}] State:`, connection || 'waiting', isNewLogin ? '(new login)' : '');
                
                // QR CODE GENERATED - Send it immediately
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
                        
                        // Set timeout for scan
                        setTimeout(() => {
                            if (!loggedIn && !pairingConfigured) {
                                console.log(`⏰ [${sessionId}] QR timeout (${QR_TIMEOUT/1000}s) - cleaning up`);
                                newSock.ws?.close();
                                activeSessions.delete(sessionId);
                                removeFile(sessionDir);
                            }
                        }, QR_TIMEOUT);
                        
                    } catch (err) {
                        console.error(`QR error:`, err);
                    }
                }
                
                // ✅ Detect when user scans QR
                if (isNewLogin) {
                    console.log(`📱 [${sessionId}] QR SCANNED - pairing configured`);
                    pairingConfigured = true;
                }
                
                // Handle close - this is the expected restart after scan
                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    console.log(`[${sessionId}] Closed with code:`, statusCode);
                    
                    // If QR was scanned and not logged in, manually reconnect
                    if (pairingConfigured && !loggedIn && !isReconnecting) {
                        console.log(`🔄 [${sessionId}] Manual reconnect after scan...`);
                        isReconnecting = true;
                        
                        // Set a timeout for reconnect
                        if (reconnectTimer) clearTimeout(reconnectTimer);
                        reconnectTimer = setTimeout(async () => {
                            if (!loggedIn) {
                                console.log(`🔄 [${sessionId}] Attempting manual reconnect...`);
                                try {
                                    // Create new socket with same auth state
                                    const newSocket = await createSocket();
                                    sock = newSocket;
                                    activeSessions.set(sessionId, { sock: newSocket, sessionDir, status: 'reconnecting' });
                                    isReconnecting = false;
                                } catch (err) {
                                    console.error(`❌ [${sessionId}] Manual reconnect failed:`, err);
                                    console.log(`⏰ [${sessionId}] Reconnect failed - cleaning up`);
                                    activeSessions.delete(sessionId);
                                    removeFile(sessionDir);
                                }
                            }
                        }, 3000); // Wait 3 seconds before reconnecting
                        
                        return; // DON'T cleanup yet
                    }
                    
                    // If no scan and not logged in, cleanup
                    if (!loggedIn && !pairingConfigured) {
                        console.log(`[${sessionId}] Connection closed without scan - cleaning up`);
                        activeSessions.delete(sessionId);
                        removeFile(sessionDir);
                    }
                }
                
                // ✅ FINAL LOGIN DETECTION - After reconnect
                if (connection === 'open' && newSock.authState?.creds?.registered && !loggedIn) {
                    console.log(`🎉 [${sessionId}] LOGIN SUCCESSFUL!`);
                    console.log(`👤 User: ${newSock.user?.id || 'unknown'}`);
                    
                    // Clear reconnect timeout
                    if (reconnectTimer) {
                        clearTimeout(reconnectTimer);
                        reconnectTimer = null;
                    }
                    
                    loggedIn = true;
                    
                    // ✅ STEP 1: Force save credentials immediately
                    console.log(`💾 [${sessionId}] Forcing credentials save...`);
                    await saveCreds();
                    
                    // ✅ STEP 2: Wait 4 seconds for files to fully write on Render
                    console.log(`⏳ [${sessionId}] Waiting 4 seconds for files to stabilize on Render...`);
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
                            user: newSock.user?.id || 'unknown',
                            timestamp: Date.now(),
                            files: sessionFiles
                        };
                        
                        // Encrypt session
                        console.log(`🔐 [${sessionId}] Encrypting session...`);
                        const sessionString = encryptSession(sessionPackage, sessionId);
                        
                        // ✅ RETURN SESSION VIA API (faster + reliable)
                        if (!apiResponseSent && newSock.user) {
                            // Send session string via WhatsApp
                            console.log(`📤 [${sessionId}] Sending session via WhatsApp...`);
                            const userJid = newSock.user.id;
                            
                            await newSock.sendMessage(userJid, {
                                text: `🔐 *GLE Session String*\n\nCopy this entire string for session restore:\n\n\`${sessionString}\``
                            });
                            console.log(`✅ [${sessionId}] Session string sent to user`);
                            
                            // Send creds.json
                            const credsPath = path.join(sessionDir, 'creds.json');
                            if (fs.existsSync(credsPath)) {
                                await newSock.sendMessage(userJid, {
                                    document: fs.readFileSync(credsPath),
                                    mimetype: 'application/json',
                                    fileName: 'creds.json',
                                    caption: '📁 Your WhatsApp session credentials file'
                                });
                                console.log(`✅ [${sessionId}] creds.json sent to user`);
                            }
                            
                            await newSock.sendMessage(userJid, {
                                text: `✅ *Login Complete!*\n\nSession saved and sent. The linker will now close.`
                            });
                            
                            apiResponseSent = true;
                        }
                        
                        // ✅ MEGA UPLOAD IN BACKGROUND (non-blocking)
                        (async () => {
                            try {
                                console.log(`☁️ [${sessionId}] Background Mega upload started...`);
                                const megaUrl = await uploadSession(sessionString, sessionId);
                                if (megaUrl && !megaUrl.startsWith('local://')) {
                                    console.log(`✅ [${sessionId}] Background Mega upload complete`);
                                    
                                    // Try to send Mega link if still connected
                                    try {
                                        if (newSock.user) {
                                            await newSock.sendMessage(newSock.user.id, {
                                                text: `💾 *Mega Backup*\n\n${megaUrl}`
                                            });
                                            console.log(`✅ [${sessionId}] Mega link sent`);
                                        }
                                    } catch (e) {
                                        console.log(`⚠️ [${sessionId}] Could not send Mega link: ${e.message}`);
                                    }
                                }
                            } catch (e) {
                                console.log(`⚠️ [${sessionId}] Background Mega upload failed: ${e.message}`);
                            }
                        })();
                        
                        // ✅ CLEANUP - Close socket after delay
                        setTimeout(() => {
                            console.log(`🔌 [${sessionId}] Closing session socket...`);
                            newSock.ws?.close();
                            
                            // Final cleanup
                            setTimeout(() => {
                                activeSessions.delete(sessionId);
                                removeFile(sessionDir);
                                console.log(`🧹 [${sessionId}] Session cleanup complete - server continues running`);
                            }, 5000);
                        }, 5000);
                        
                    } catch (err) {
                        console.error(`❌ [${sessionId}] Session processing failed:`, err);
                        
                        // Try to notify user
                        try {
                            if (newSock.user) {
                                await newSock.sendMessage(newSock.user.id, {
                                    text: `❌ *Error*\n\n${err.message}\nPlease try again.`
                                });
                            }
                        } catch (e) {}
                        
                        // Cleanup
                        newSock.ws?.close();
                        activeSessions.delete(sessionId);
                        removeFile(sessionDir);
                    }
                }
            });
            
            return newSock;
        };
        
        // Create initial socket
        sock = await createSocket();
        activeSessions.set(sessionId, { sock, sessionDir, status: 'waiting' });
        
        // Timeout for QR generation
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
