import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, Browsers, fetchLatestBaileysVersion, jidNormalizedUser, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pn from 'awesome-phonenumber';
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

const activeSessions = new Map();

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

// Session export functions (same as QR)
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

// ==================== MAIN PAIRING ENDPOINT ====================
router.get('/', async (req, res) => {
    const sessionId = makeid();
    let { number } = req.query;
    const sessionDir = path.join(TEMP_DIR, sessionId);

    console.log(`\n🔷 [${sessionId}] === NEW PAIRING SESSION ===`);
    console.log(`📱 Phone: ${number}`);

    try {
        if (!number) {
            return res.status(400).json({ success: false, error: 'Phone number required' });
        }

        number = number.replace(/\D/g, '');
        const phone = pn('+' + number);
        
        if (!phone.isValid()) {
            return res.status(400).json({ success: false, error: 'Invalid phone number' });
        }

        const formattedNumber = phone.getNumber('e164').replace('+', '');
        
        fs.mkdirSync(sessionDir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        // ==================== CRITICAL FIX FOR PAIRING ====================
        // Pairing requires a DIFFERENT browser config than QR
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger,
            // For pairing, use this specific format - NOT Browsers.windows()
            browser: ["Chrome (Linux)", "", ""], // This works best for pairing
            syncFullHistory: false,
            markOnlineOnConnect: false,
            keepAliveIntervalMs: 30000,
            defaultQueryTimeoutMs: 60000,
            generateHighQualityLinkPreview: false,
            shouldIgnoreJid: () => true
        });

        sock.ev.on('creds.update', saveCreds);

        // Store session
        activeSessions.set(sessionId, {
            sock,
            sessionDir,
            number: formattedNumber,
            status: 'initializing',
            codeGenerated: false,
            connected: false,
            createdAt: Date.now()
        });

        let codeGenerated = false;
        let responseSent = false;

        // ==================== CONNECTION UPDATE HANDLER ====================
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            const session = activeSessions.get(sessionId);
            if (!session) return;

            console.log(`🔔 [${sessionId}] Connection: ${connection || 'no-change'}`);

            if (connection === 'open') {
                session.status = 'connected';
                session.connected = true;
                console.log(`✅ [${sessionId}] WHATSAPP CONNECTED!`);
                console.log(`👤 User: ${sock.user?.id}`);

                await delay(5000);

                try {
                    // Export session (same as QR)
                    const sessionFiles = collectSessionFiles(sessionDir);
                    const sessionPackage = {
                        id: sessionId,
                        user: sock.user?.id,
                        number: formattedNumber,
                        timestamp: Date.now(),
                        files: sessionFiles
                    };
                    
                    const sessionString = encryptSessionPackage(sessionPackage, sessionId);
                    
                    // Upload to Mega (optional)
                    let megaUrl = null;
                    try {
                        megaUrl = await uploadSession(sessionString, sessionId);
                    } catch (megaError) {
                        console.log(`⚠️ Mega upload skipped`);
                    }
                    
                    // Save session ID
                    fs.writeFileSync(SESSION_ID_FILE, sessionId);
                    
                    // Send to user
                    const userJid = jidNormalizedUser(formattedNumber + '@s.whatsapp.net');
                    
                    await sock.sendMessage(userJid, {
                        text: `🔐 *GLE Session String*\n\n\`${sessionString}\``
                    });

                    if (megaUrl && !megaUrl.startsWith('local://')) {
                        await sock.sendMessage(userJid, {
                            text: `📦 *Mega Backup*\n\n${megaUrl}`
                        });
                    }

                    await sock.sendMessage(userJid, {
                        text: `✅ *GLE Bot Connected via Pairing Code!*\n\nSession saved and will auto-restore.`
                    });

                    console.log(`✅ [${sessionId}] Session exported and sent`);
                    
                } catch (error) {
                    console.error(`❌ Export error:`, error);
                }
            }

            // ==================== HANDLE 515 ERROR GRACEFULLY ====================
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`🔴 [${sessionId}] Closed:`, statusCode);

                // 515 is normal - connection closes after successful pairing
                if (statusCode === 515 && session.connected) {
                    console.log(`✅ [${sessionId}] Pairing completed successfully (515 is normal)`);
                    // Clean up after delay
                    setTimeout(() => {
                        activeSessions.delete(sessionId);
                        removeFile(sessionDir);
                    }, 10000);
                }
                // Don't cleanup if code was generated but not used
                else if (codeGenerated && !session.connected) {
                    console.log(`⏳ [${sessionId}] Waiting for code entry...`);
                }
                else {
                    // Failed connection - cleanup
                    activeSessions.delete(sessionId);
                    removeFile(sessionDir);
                }
            }
        });

        // ==================== REQUEST PAIRING CODE ====================
        if (!sock.authState.creds.registered) {
            await delay(3000);
            
            try {
                console.log(`🔑 [${sessionId}] Requesting pairing code...`);
                
                // CRITICAL: Use the formatted number WITHOUT @s.whatsapp.net
                const code = await sock.requestPairingCode(formattedNumber);
                
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                codeGenerated = true;
                
                const session = activeSessions.get(sessionId);
                if (session) {
                    session.status = 'code_generated';
                    session.codeGenerated = true;
                }

                console.log(`✅ [${sessionId}] Pairing code: ${formattedCode}`);
                
                if (!res.headersSent) {
                    responseSent = true;
                    res.json({
                        success: true,
                        code: formattedCode,
                        sessionId: sessionId,
                        message: 'Enter this code in WhatsApp Linked Devices',
                        instructions: [
                            '1. Open WhatsApp on your phone',
                            '2. Go to Settings → Linked Devices',
                            '3. Tap "Link a Device"',
                            `4. Enter code: ${formattedCode}`,
                            '5. Wait a few seconds for connection',
                            '6. You will receive your session string via WhatsApp'
                        ],
                        expiresIn: 180
                    });

                    // Expire after 3 minutes
                    setTimeout(() => {
                        const session = activeSessions.get(sessionId);
                        if (session && !session.connected) {
                            console.log(`⏰ [${sessionId}] Pairing code expired`);
                            session.status = 'expired';
                        }
                    }, 180000);
                }
            } catch (error) {
                console.error(`❌ [${sessionId}] Pairing code error:`, error);
                if (!res.headersSent) {
                    responseSent = true;
                    res.status(500).json({
                        success: false,
                        error: 'Failed to generate pairing code',
                        details: error.message
                    });
                }
                removeFile(sessionDir);
                activeSessions.delete(sessionId);
            }
        }

    } catch (error) {
        console.error(`❌ [${sessionId}] Fatal error:`, error);
        removeFile(sessionDir);
        activeSessions.delete(sessionId);
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
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
            codeGenerated: session.codeGenerated || false,
            connected: session.connected || false,
            createdAt: session.createdAt
        }
    });
});

export default router;
