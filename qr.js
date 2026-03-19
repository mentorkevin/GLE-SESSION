import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, Browsers, fetchLatestBaileysVersion, jidNormalizedUser, DisconnectReason } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { uploadSession } from './mega.js';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==================== CONSTANTS ====================
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const TEMP_DIR = path.join(__dirname, 'temp_sessions');
const SESSION_ID_FILE = path.join(__dirname, '.active_session');

if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const logger = pino({
    level: 'debug',
    transport: {
        target: 'pino-pretty',
        options: { colorize: true }
    }
});

function makeid(length = 8) {
    return crypto.randomBytes(length).toString('hex');
}

function removeFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.rmSync(filePath, { recursive: true, force: true });
        }
        return true;
    } catch (e) {
        return false;
    }
}

function collectSessionFiles(sessionDir) {
    const sessionData = {};
    const files = fs.readdirSync(sessionDir);
    
    for (const file of files) {
        const filePath = path.join(sessionDir, file);
        const stat = fs.statSync(filePath);
        
        if (stat.isFile()) {
            const content = fs.readFileSync(filePath);
            sessionData[file] = {
                content: content.toString('base64'),
                size: stat.size,
                modified: stat.mtimeMs
            };
        }
    }
    
    return sessionData;
}

function encryptSessionPackage(sessionPackage, sessionId) {
    const key = crypto.createHmac('sha256', Buffer.from(ENCRYPTION_KEY, 'hex'))
        .update(sessionId)
        .digest();
    
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    
    let encrypted = cipher.update(JSON.stringify(sessionPackage), 'utf8', 'base64');
    encrypted += cipher.final('base64');
    
    const encryptedPackage = {
        iv: iv.toString('base64'),
        data: encrypted,
        sessionId: sessionId
    };
    
    return Buffer.from(JSON.stringify(encryptedPackage)).toString('base64');
}

// Main QR endpoint
router.get('/', async (req, res) => {
    const sessionId = makeid();
    const sessionDir = path.join(TEMP_DIR, sessionId);

    console.log(`\n🔷 [${sessionId}] QR session started`);

    try {
        // Create session directory
        fs.mkdirSync(sessionDir, { recursive: true });

        // Load auth state
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        // Create socket
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger,
            browser: Browsers.windows("Chrome"),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            keepAliveIntervalMs: 30000
        });

        sock.ev.on('creds.update', saveCreds);

        let qrGenerated = false;
        let responseSent = false;

        // Handle connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;
            
            console.log(`🔔 [${sessionId}] Connection: ${connection || 'no-change'}`);

            // Handle QR generation
            if (qr && !qrGenerated && !responseSent) {
                qrGenerated = true;
                
                try {
                    const qrImage = await QRCode.toDataURL(qr);
                    
                    responseSent = true;
                    res.json({
                        success: true,
                        qr: qrImage,
                        sessionId: sessionId,
                        message: 'Scan this QR code with WhatsApp',
                        instructions: [
                            '1. Open WhatsApp on your phone',
                            '2. Go to Settings → Linked Devices',
                            '3. Tap "Link a Device"',
                            '4. Scan this QR code',
                            '5. After connection, you will receive your session string'
                        ],
                        expiresIn: 120
                    });

                    console.log(`✅ [${sessionId}] QR code sent`);

                    // Set expiration timer
                    setTimeout(() => {
                        if (!sock.user && !responseSent) {
                            console.log(`⏰ [${sessionId}] QR code expired`);
                        }
                    }, 120000);
                    
                } catch (err) {
                    console.error(`❌ [${sessionId}] QR generation error:`, err);
                }
            }

            // Handle successful connection
            if (connection === 'open') {
                console.log(`✅ [${sessionId}] Connected!`);
                
                await delay(5000);

                try {
                    // Export session
                    const sessionFiles = collectSessionFiles(sessionDir);
                    const sessionPackage = {
                        id: sessionId,
                        user: sock.user?.id,
                        timestamp: Date.now(),
                        files: sessionFiles
                    };
                    
                    const sessionString = encryptSessionPackage(sessionPackage, sessionId);
                    
                    // Upload to Mega
                    let megaUrl = null;
                    try {
                        megaUrl = await uploadSession(sessionString, sessionId);
                    } catch (megaError) {
                        console.error(`Mega upload failed:`, megaError);
                    }
                    
                    // Save session ID for auto-restore
                    fs.writeFileSync(SESSION_ID_FILE, sessionId);
                    
                    // Send to user if we have their JID
                    if (sock.user?.id) {
                        await sock.sendMessage(sock.user.id, {
                            text: `🔐 *GLE Session String*\n\n\`${sessionString}\``
                        });

                        if (megaUrl) {
                            await sock.sendMessage(sock.user.id, {
                                text: `📦 *Mega Backup*\n\n${megaUrl}`
                            });
                        }

                        await sock.sendMessage(sock.user.id, {
                            text: `✅ *Bot Active!*\n\nSession saved and will auto-restore on server restart.`
                        });
                    }

                    console.log(`✅ [${sessionId}] Session exported`);
                    
                } catch (error) {
                    console.error(`Export error:`, error);
                }
            }

            // Handle connection close
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`🔴 [${sessionId}] Closed:`, statusCode);
            }
        });

        // Set timeout for QR generation
        setTimeout(() => {
            if (!qrGenerated && !responseSent && !res.headersSent) {
                res.status(504).json({
                    success: false,
                    error: 'QR generation timeout'
                });
            }
        }, 30000);

    } catch (error) {
        console.error(`❌ [${sessionId}] Fatal error:`, error);
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
});

// Get session string endpoint
router.get('/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    
    // Check if this is the active session
    if (fs.existsSync(SESSION_ID_FILE)) {
        const activeId = fs.readFileSync(SESSION_ID_FILE, 'utf8').trim();
        if (activeId === sessionId) {
            return res.json({
                success: true,
                data: {
                    sessionId,
                    message: 'Session is active'
                }
            });
        }
    }
    
    res.status(404).json({
        success: false,
        error: 'Session not found'
    });
});

export default router;