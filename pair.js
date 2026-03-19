import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, Browsers, fetchLatestBaileysVersion, jidNormalizedUser } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
import { uploadSession } from './mega.js';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMP_DIR = path.join(__dirname, 'temp_sessions');
const SESSION_ID_FILE = path.join(__dirname, '.active_session');

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

// ==================== MAIN PAIRING ENDPOINT ====================
router.get('/', async (req, res) => {
    const sessionId = makeid();
    let { number } = req.query;
    const sessionDir = path.join(TEMP_DIR, sessionId);
    
    console.log(`\n🔷 [${sessionId}] Pairing session started for ${number}`);
    
    try {
        if (!number) return res.status(400).json({ success: false, error: 'Phone number required' });
        
        number = number.replace(/\D/g, '');
        const phone = pn('+' + number);
        if (!phone.isValid()) return res.status(400).json({ success: false, error: 'Invalid number' });
        
        const formattedNumber = phone.getNumber('e164').replace('+', '');
        fs.mkdirSync(sessionDir, { recursive: true });
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ["Ubuntu", "Chrome", "120.0.0.0"],
            syncFullHistory: false,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 30000
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        activeSessions.set(sessionId, { sock, sessionDir, number: formattedNumber, status: 'waiting', connected: false });
        
        let codeSent = false;
        let connected = false;
        let exported = false;
        
        // ==================== CRITICAL: Detect user info as soon as available ====================
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, user } = update;
            
            console.log(`[${sessionId}] State:`, connection || 'waiting');
            
            // If we get user info, connection is successful!
            if (user) {
                console.log(`🎉 [${sessionId}] USER DETECTED:`, user.id);
                connected = true;
                
                // Save immediately before connection closes
                if (!exported) {
                    exported = true;
                    
                    // Wait a moment for files to save
                    await delay(2000);
                    
                    try {
                        // Collect session files
                        const sessionFiles = collectSessionFiles(sessionDir);
                        
                        // Create session package
                        const sessionPackage = {
                            id: sessionId,
                            user: user.id,
                            number: formattedNumber,
                            timestamp: Date.now(),
                            files: sessionFiles
                        };
                        
                        // Encrypt
                        const sessionString = encryptSession(sessionPackage, sessionId);
                        
                        // Save session ID
                        fs.writeFileSync(SESSION_ID_FILE, sessionId);
                        
                        // Upload to Mega (optional)
                        let megaUrl = null;
                        try {
                            megaUrl = await uploadSession(sessionString, sessionId);
                        } catch (e) {}
                        
                        // Send to user via WhatsApp
                        try {
                            const userJid = jidNormalizedUser(formattedNumber + '@s.whatsapp.net');
                            await sock.sendMessage(userJid, {
                                text: `🔐 *GLE Session String*\n\n\`${sessionString}\``
                            });
                            console.log(`✅ [${sessionId}] Session sent to user`);
                        } catch (e) {
                            console.log(`⚠️ Could not send message, but session is saved`);
                        }
                        
                        // Save to file as backup
                        fs.writeFileSync(path.join(sessionDir, 'session.txt'), sessionString);
                        
                    } catch (err) {
                        console.error(`Export error:`, err);
                    }
                }
            }
            
            if (connection === 'open') {
                console.log(`🎉 [${sessionId}] CONNECTION OPEN`);
                // If we haven't exported yet, do it now
                if (!exported && sock.user) {
                    exported = true;
                    // ... same export code as above
                }
            }
            
            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log(`[${sessionId}] Closed:`, code);
                
                // If we already exported, we're done
                if (exported) {
                    console.log(`✅ [${sessionId}] Session exported successfully`);
                    // Clean up after a delay
                    setTimeout(() => {
                        activeSessions.delete(sessionId);
                        removeFile(sessionDir);
                    }, 5000);
                }
                // If code was sent but not connected, keep waiting
                else if (codeSent && !connected) {
                    console.log(`⏳ Waiting for code entry...`);
                }
                else {
                    activeSessions.delete(sessionId);
                    removeFile(sessionDir);
                }
            }
        });
        
        // Request pairing code
        if (!sock.authState.creds.registered) {
            await delay(3000);
            
            try {
                const code = await sock.requestPairingCode(formattedNumber);
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                codeSent = true;
                
                console.log(`✅ [${sessionId}] Code: ${formattedCode}`);
                
                if (!res.headersSent) {
                    res.json({
                        success: true,
                        code: formattedCode,
                        sessionId,
                        message: 'Enter this code in WhatsApp',
                        expiresIn: 180
                    });
                    
                    // Expire after 3 min
                    setTimeout(() => {
                        const session = activeSessions.get(sessionId);
                        if (session && !session.connected && !exported) {
                            console.log(`⏰ [${sessionId}] Code expired`);
                            activeSessions.delete(sessionId);
                            removeFile(sessionDir);
                        }
                    }, 180000);
                }
            } catch (error) {
                console.error(`Code error:`, error);
                if (!res.headersSent) {
                    res.status(500).json({ success: false, error: error.message });
                }
                removeFile(sessionDir);
                activeSessions.delete(sessionId);
            }
        }
        
    } catch (error) {
        console.error(`Fatal:`, error);
        if (!res.headersSent) res.status(500).json({ success: false, error: error.message });
        removeFile(sessionDir);
        activeSessions.delete(sessionId);
    }
});

// Endpoint to retrieve session
router.get('/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const sessionFile = path.join(TEMP_DIR, sessionId, 'session.txt');
    
    if (fs.existsSync(sessionFile)) {
        const sessionString = fs.readFileSync(sessionFile, 'utf8');
        res.json({ success: true, sessionString });
    } else {
        res.status(404).json({ success: false, error: 'Session not found' });
    }
});

export default router;
