import express from 'express';
import fs from 'fs';
import { makeWASocket, useMultiFileAuthState, delay, Browsers, fetchLatestBaileysVersion, jidNormalizedUser } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
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

// ==================== FIXED QR ENDPOINT ====================
router.get('/', async (req, res) => {
    const sessionId = makeid();
    const sessionDir = path.join(TEMP_DIR, sessionId);
    
    console.log(`\n🔷 [${sessionId}] QR session started`);
    
    try {
        fs.mkdirSync(sessionDir, { recursive: true });
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        // Create socket
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            browser: Browsers.windows("Chrome"),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 30000,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        activeSessions.set(sessionId, { sock, sessionDir, status: 'waiting' });
        
        let qrSent = false;
        let responseSent = false;
        let loginCompleted = false;
        
        // Handle connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;
            
            console.log(`[${sessionId}] State:`, connection || 'waiting');
            
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
                            '2. Tap Menu or Settings and select Linked Devices',
                            '3. Tap "Link a Device"',
                            '4. Scan this QR code',
                            '',
                            '⏱️ QR expires in 3 minutes'
                        ]
                    });
                    responseSent = true;
                    console.log(`✅ [${sessionId}] QR sent to client`);
                    
                    // Set timeout for scan
                    setTimeout(() => {
                        if (!loginCompleted) {
                            console.log(`⏰ [${sessionId}] QR scan timeout`);
                            sock.ws?.close();
                            activeSessions.delete(sessionId);
                            removeFile(sessionDir);
                        }
                    }, 180000);
                    
                } catch (err) {
                    console.error(`QR error:`, err);
                    if (!responseSent) {
                        res.status(500).json({ success: false, error: 'QR generation failed' });
                        responseSent = true;
                    }
                }
            }
            
            // ✅ LOGIN COMPLETED - Now export session
            if (connection === 'open' && !loginCompleted) {
                console.log(`🎉 [${sessionId}] LOGIN SUCCESSFUL!`);
                console.log(`👤 User: ${sock.user?.id}`);
                
                loginCompleted = true;
                
                // Small delay to ensure all files are written
                await delay(2000);
                
                try {
                    console.log(`📦 [${sessionId}] Exporting session...`);
                    
                    // 1. Collect all session files
                    const sessionFiles = collectSessionFiles(sessionDir);
                    
                    // 2. Create session package
                    const sessionPackage = {
                        id: sessionId,
                        user: sock.user?.id,
                        timestamp: Date.now(),
                        files: sessionFiles
                    };
                    
                    // 3. Encrypt session to single string
                    const sessionString = encryptSession(sessionPackage, sessionId);
                    
                    // 4. Get creds.json content for file attachment
                    const credsPath = path.join(sessionDir, 'creds.json');
                    let credsContent = null;
                    if (fs.existsSync(credsPath)) {
                        credsContent = fs.readFileSync(credsPath, 'utf8');
                    }
                    
                    // 5. Send session string to user's WhatsApp
                    const userJid = sock.user.id;
                    
                    // Send session string as text
                    await sock.sendMessage(userJid, {
                        text: `🔐 *GLE Session String*\n\nCopy this entire string for session restore:\n\n\`${sessionString}\``
                    });
                    console.log(`✅ [${sessionId}] Session string sent to user`);
                    
                    // 6. Send creds.json as a file if it exists
                    if (credsContent) {
                        // Send as a document
                        await sock.sendMessage(userJid, {
                            document: fs.readFileSync(credsPath),
                            mimetype: 'application/json',
                            fileName: 'creds.json',
                            caption: '📁 Your WhatsApp session credentials file'
                        });
                        console.log(`✅ [${sessionId}] creds.json sent as file`);
                    }
                    
                    // 7. Optional: Upload to Mega as backup
                    try {
                        const megaUrl = await uploadSession(sessionString, sessionId);
                        if (megaUrl && !megaUrl.startsWith('local://')) {
                            await sock.sendMessage(userJid, {
                                text: `💾 *Mega Backup*\n\n${megaUrl}`
                            });
                            console.log(`✅ [${sessionId}] Mega backup sent`);
                        }
                    } catch (e) {
                        console.log(`⚠️ [${sessionId}] Mega upload failed: ${e.message}`);
                    }
                    
                    // 8. Send completion message
                    await sock.sendMessage(userJid, {
                        text: `✅ *Session Export Complete!*\n\nYou can now close this window.`
                    });
                    
                    console.log(`✅ [${sessionId}] All session data sent to user`);
                    
                    // ✅ Close the socket - job done!
                    console.log(`🔌 [${sessionId}] Closing socket...`);
                    await delay(2000); // Wait for messages to send
                    sock.ws?.close();
                    
                    // Clean up after socket closes
                    setTimeout(() => {
                        activeSessions.delete(sessionId);
                        removeFile(sessionDir);
                        console.log(`🧹 [${sessionId}] Cleanup complete`);
                    }, 5000);
                    
                } catch (err) {
                    console.error(`❌ [${sessionId}] Export failed:`, err);
                    
                    // Try to send error message to user
                    try {
                        await sock.sendMessage(sock.user.id, {
                            text: `❌ *Export Failed*\n\n${err.message}\nPlease try again.`
                        });
                    } catch (e) {}
                    
                    sock.ws?.close();
                    activeSessions.delete(sessionId);
                    removeFile(sessionDir);
                }
            }
            
            // Handle connection close (if login never happened)
            if (connection === 'close' && !loginCompleted) {
                console.log(`[${sessionId}] Connection closed without login`);
                activeSessions.delete(sessionId);
                removeFile(sessionDir);
            }
        });
        
        // Timeout for QR generation
        setTimeout(() => {
            if (!qrSent && !responseSent) {
                res.status(504).json({ success: false, error: 'QR generation timeout' });
                responseSent = true;
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
