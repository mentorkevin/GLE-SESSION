import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, Browsers, fetchLatestBaileysVersion, jidNormalizedUser, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
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

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Store active sessions in memory
const activeSessions = new Map();

// Logger setup
const logger = pino({
    level: 'debug',
    transport: {
        target: 'pino-pretty',
        options: { colorize: true }
    }
});

// ==================== HELPER FUNCTIONS ====================
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

// ==================== SESSION COLLECTION FUNCTIONS ====================
function collectSessionFiles(sessionDir) {
    console.log(`📁 Collecting session files from: ${sessionDir}`);
    
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
                modified: stat.mtimeMs,
                encoding: 'base64'
            };
            console.log(`  📄 Added: ${file} (${stat.size} bytes)`);
        }
    }
    
    console.log(`✅ Collected ${Object.keys(sessionData).length} files`);
    return sessionData;
}

function buildSessionPackage(sessionId, sessionFiles, userInfo = {}) {
    return {
        id: sessionId,
        version: '1.0',
        createdAt: new Date().toISOString(),
        user: {
            id: userInfo.id || null,
            name: userInfo.name || null
        },
        files: sessionFiles
    };
}

function encryptSessionPackage(sessionPackage, sessionId) {
    console.log(`🔐 Encrypting session...`);
    
    try {
        const jsonString = JSON.stringify(sessionPackage);
        
        const key = crypto.createHmac('sha256', Buffer.from(ENCRYPTION_KEY, 'hex'))
            .update(sessionId)
            .digest();
        
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        
        let encrypted = cipher.update(jsonString, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        
        const encryptedPackage = {
            iv: iv.toString('base64'),
            data: encrypted,
            sessionId: sessionId,
            algorithm: 'aes-256-cbc',
            timestamp: Date.now()
        };
        
        const sessionString = Buffer.from(JSON.stringify(encryptedPackage)).toString('base64');
        
        console.log(`✅ Encryption successful`);
        return sessionString;
    } catch (error) {
        console.error(`❌ Encryption failed:`, error);
        throw error;
    }
}

async function exportSession(sessionId, sessionDir, userInfo = {}) {
    console.log(`\n📦 Exporting session ${sessionId}...`);
    
    try {
        const sessionFiles = collectSessionFiles(sessionDir);
        const sessionPackage = buildSessionPackage(sessionId, sessionFiles, userInfo);
        const sessionString = encryptSessionPackage(sessionPackage, sessionId);
        
        // Upload to Mega (optional)
        let megaUrl = null;
        try {
            console.log(`📤 Uploading to Mega...`);
            megaUrl = await uploadSession(sessionString, sessionId);
            if (megaUrl && !megaUrl.startsWith('local://')) {
                console.log(`✅ Mega upload successful`);
            }
        } catch (megaError) {
            console.log(`⚠️ Mega upload skipped`);
        }
        
        return {
            sessionString,
            megaUrl,
            fileCount: Object.keys(sessionFiles).length
        };
    } catch (error) {
        console.error(`❌ Export failed:`, error);
        throw error;
    }
}

// ==================== MAIN QR ENDPOINT ====================
router.get('/', async (req, res) => {
    const sessionId = makeid();
    const sessionDir = path.join(TEMP_DIR, sessionId);

    console.log(`\n🔷 [${sessionId}] === NEW QR SESSION ===`);

    try {
        // Create session directory
        fs.mkdirSync(sessionDir, { recursive: true });

        // Load auth state
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        // Get latest Baileys version
        const { version } = await fetchLatestBaileysVersion();
        console.log(`📦 [${sessionId}] Baileys version: ${version.join('.')}`);

        // Create socket with proper configuration
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: logger,
            browser: Browsers.windows("Chrome"),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000, // CRITICAL: Keeps socket alive
            defaultQueryTimeoutMs: 60000,
            retryRequestDelayMs: 500,
            maxRetries: 3,
            shouldIgnoreJid: () => true
        });

        // Save credentials on update
        sock.ev.on('creds.update', saveCreds);

        // Store session in memory
        activeSessions.set(sessionId, {
            sock,
            sessionDir,
            status: 'initializing',
            qrGenerated: false,
            connected: false,
            createdAt: Date.now(),
            exportedSession: null
        });

        let qrGenerated = false;
        let responseSent = false;
        let connectionEstablished = false;

        // ==================== CONNECTION UPDATE HANDLER ====================
        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;
            
            const session = activeSessions.get(sessionId);
            if (!session) return;

            console.log(`🔔 [${sessionId}] Connection: ${connection || 'no-change'}`);

            // ==================== QR CODE GENERATION ====================
            if (qr && !qrGenerated && !responseSent) {
                qrGenerated = true;
                session.qrGenerated = true;
                session.status = 'qr_generated';
                
                try {
                    // Generate QR code as data URL
                    const qrImage = await QRCode.toDataURL(qr);
                    
                    responseSent = true;
                    
                    // Send response immediately
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

                    console.log(`✅ [${sessionId}] QR code sent - waiting for scan...`);

                    // Set expiration timer (2 minutes)
                    setTimeout(() => {
                        const session = activeSessions.get(sessionId);
                        if (session && !session.connected) {
                            console.log(`⏰ [${sessionId}] QR code expired - no scan`);
                            session.status = 'expired';
                        }
                    }, 120000);
                    
                } catch (err) {
                    console.error(`❌ [${sessionId}] QR generation error:`, err);
                    if (!responseSent) {
                        responseSent = true;
                        res.status(500).json({
                            success: false,
                            error: 'Failed to generate QR code'
                        });
                    }
                }
            }

            // ==================== CONNECTING STATE ====================
            if (connection === 'connecting') {
                session.status = 'connecting';
                console.log(`🔄 [${sessionId}] Connecting to WhatsApp...`);
            }

            // ==================== OPEN STATE (SUCCESS) ====================
            if (connection === 'open') {
                connectionEstablished = true;
                session.status = 'connected';
                session.connected = true;
                console.log(`✅ [${sessionId}] WHATSAPP CONNECTED SUCCESSFULLY!`);
                console.log(`👤 [${sessionId}] User: ${sock.user?.id || 'Unknown'}`);
                
                // Wait for credentials to be fully saved
                await delay(5000);

                try {
                    // ==================== EXPORT SESSION ====================
                    const exportResult = await exportSession(
                        sessionId, 
                        sessionDir, 
                        { id: sock.user?.id, name: sock.user?.name }
                    );
                    
                    session.exportedSession = exportResult;
                    
                    console.log(`✅ [${sessionId}] Session exported successfully`);
                    console.log(`   Session string length: ${exportResult.sessionString.length} chars`);
                    
                    // Save session ID for auto-restore
                    fs.writeFileSync(SESSION_ID_FILE, sessionId);

                    // ==================== SEND TO USER VIA WHATSAPP ====================
                    if (sock.user?.id) {
                        try {
                            // Send session string
                            await sock.sendMessage(sock.user.id, {
                                text: `🔐 *GLE Session String*\n\n\`${exportResult.sessionString}\`\n\n⚠️ Keep this safe! It contains your WhatsApp session.`
                            });

                            // Send Mega URL if available
                            if (exportResult.megaUrl && !exportResult.megaUrl.startsWith('local://')) {
                                await sock.sendMessage(sock.user.id, {
                                    text: `📦 *Mega Backup*\n\nURL: ${exportResult.megaUrl}`
                                });
                            }

                            // Send welcome message
                            await sock.sendMessage(sock.user.id, {
                                text: `🎬 *GLE Bot Connected via QR!*\n\n✅ Your bot is now active\n🔑 Session string sent above\n📱 This session will auto-restore on server restart.`
                            });

                            console.log(`✅ [${sessionId}] Session info sent to user`);
                        } catch (msgError) {
                            console.error(`❌ [${sessionId}] Failed to send messages:`, msgError);
                        }
                    }
                    
                } catch (exportError) {
                    console.error(`❌ [${sessionId}] Export failed:`, exportError);
                }
            }

            // ==================== CLOSE STATE ====================
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const errorMessage = lastDisconnect?.error?.message;
                
                console.log(`🔴 [${sessionId}] Connection closed:`, { 
                    statusCode, 
                    error: errorMessage,
                    connected: connectionEstablished,
                    qrSent: qrGenerated
                });

                // Handle different disconnect reasons
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log(`🚫 [${sessionId}] Logged out from WhatsApp`);
                    session.status = 'logged_out';
                    activeSessions.delete(sessionId);
                } 
                else if (connectionEstablished) {
                    console.log(`✅ [${sessionId}] Session completed - connection closed normally`);
                    // Keep session in memory for a while
                    setTimeout(() => {
                        activeSessions.delete(sessionId);
                        removeFile(sessionDir);
                    }, 60000);
                }
                else if (qrGenerated && !connectionEstablished) {
                    console.log(`⏳ [${sessionId}] Still waiting for QR scan...`);
                    // Don't cleanup - session still valid
                }
                else {
                    console.log(`❌ [${sessionId}] Connection failed - cleaning up`);
                    activeSessions.delete(sessionId);
                    removeFile(sessionDir);
                }
            }
        });

        // ==================== TIMEOUT FOR QR GENERATION ====================
        setTimeout(() => {
            if (!qrGenerated && !responseSent && !res.headersSent) {
                console.log(`⏰ [${sessionId}] QR generation timeout`);
                res.status(504).json({
                    success: false,
                    error: 'QR generation timeout'
                });
                activeSessions.delete(sessionId);
                removeFile(sessionDir);
            }
        }, 30000);

    } catch (error) {
        console.error(`❌ [${sessionId}] Fatal error:`, error);
        removeFile(sessionDir);
        activeSessions.delete(sessionId);
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                error: 'Internal server error',
                details: error.message
            });
        }
    }
});

// ==================== GET SESSION STRING ENDPOINT ====================
router.get('/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({
            success: false,
            error: 'Session not found'
        });
    }
    
    if (!session.exportedSession) {
        return res.status(202).json({
            success: false,
            status: session.status,
            message: 'Session not yet exported',
            connected: session.connected
        });
    }
    
    res.json({
        success: true,
        data: {
            sessionId,
            sessionString: session.exportedSession.sessionString,
            megaUrl: session.exportedSession.megaUrl,
            fileCount: session.exportedSession.fileCount,
            status: session.status,
            connected: session.connected,
            createdAt: session.createdAt
        }
    });
});

// ==================== STATUS ENDPOINT ====================
router.get('/status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({
            success: false,
            error: 'Session not found'
        });
    }
    
    res.json({
        success: true,
        data: {
            sessionId,
            status: session.status,
            qrGenerated: session.qrGenerated || false,
            connected: session.connected || false,
            hasExportedSession: !!session.exportedSession,
            createdAt: session.createdAt,
            uptime: Date.now() - session.createdAt
        }
    });
});

export default router;
