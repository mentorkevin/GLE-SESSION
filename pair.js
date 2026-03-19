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
import { restoreAndStartBot } from './restore.js';

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

// Logger
const logger = pino({
    level: 'debug',
    transport: {
        target: 'pino-pretty',
        options: { colorize: true }
    }
});

// Helper functions
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

// Session export functions
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

// Main pairing endpoint
router.get('/', async (req, res) => {
    const sessionId = makeid();
    let { number } = req.query;
    const sessionDir = path.join(TEMP_DIR, sessionId);

    console.log(`\n🔷 [${sessionId}] Pairing session started`);

    try {
        // Validate number
        if (!number) {
            return res.status(400).json({ success: false, error: 'Phone number required' });
        }

        number = number.replace(/\D/g, '');
        const phone = pn('+' + number);
        
        if (!phone.isValid()) {
            return res.status(400).json({ success: false, error: 'Invalid phone number' });
        }

        const formattedNumber = phone.getNumber('e164').replace('+', '');
        
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
            keepAliveIntervalMs: 30000,
            defaultQueryTimeoutMs: 60000
        });

        sock.ev.on('creds.update', saveCreds);

        let codeGenerated = false;
        let responseSent = false;

        // Handle connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            console.log(`🔔 [${sessionId}] Connection: ${connection}`);

            if (connection === 'open') {
                console.log(`✅ [${sessionId}] Connected!`);
                
                // Wait for files to save
                await delay(5000);

                try {
                    // Export session
                    const sessionFiles = collectSessionFiles(sessionDir);
                    const sessionPackage = {
                        id: sessionId,
                        user: sock.user?.id,
                        number: formattedNumber,
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
                    
                    // Send to user
                    const userJid = jidNormalizedUser(formattedNumber + '@s.whatsapp.net');
                    
                    await sock.sendMessage(userJid, {
                        text: `🔐 *GLE Session String*\n\n\`${sessionString}\``
                    });

                    if (megaUrl) {
                        await sock.sendMessage(userJid, {
                            text: `📦 *Mega Backup*\n\n${megaUrl}`
                        });
                    }

                    await sock.sendMessage(userJid, {
                        text: `✅ *Bot Active!*\n\nSession saved and will auto-restore on server restart.`
                    });

                    console.log(`✅ [${sessionId}] Session exported`);
                    
                } catch (error) {
                    console.error(`Export error:`, error);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`🔴 [${sessionId}] Closed:`, statusCode);
            }
        });

        // Request pairing code
        if (!sock.authState.creds.registered) {
            await delay(3000);
            
            try {
                const code = await sock.requestPairingCode(formattedNumber);
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                codeGenerated = true;
                
                if (!res.headersSent) {
                    responseSent = true;
                    res.json({
                        success: true,
                        code: formattedCode,
                        sessionId: sessionId,
                        message: 'Enter code in WhatsApp Linked Devices',
                        expiresIn: 180
                    });
                }
            } catch (error) {
                console.error(`Code error:`, error);
                if (!res.headersSent) {
                    res.status(500).json({ success: false, error: 'Failed to generate code' });
                }
            }
        }

    } catch (error) {
        console.error(`Fatal error:`, error);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: error.message });
        }
    }
});

export default router;