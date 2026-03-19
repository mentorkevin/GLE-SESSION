import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, Browsers, fetchLatestBaileysVersion, jidNormalizedUser, DisconnectReason } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
import { uploadSession } from './mega.js';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMP_DIR = path.join(__dirname, 'temp_sessions');
const ACTIVE_SESSION_FILE = path.join(__dirname, '.active_session');

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

// ==================== FIXED PAIRING ENDPOINT ====================
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
        
        // ✅ FIX 1: Proper socket configuration
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.windows("Chrome"),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 30000,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            generateHighQualityLinkPreview: false,
            patchMessageBeforeSending: true
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        activeSessions.set(sessionId, { sock, sessionDir, number: formattedNumber, status: 'connecting', connected: false });
        
        let codeSent = false;
        let connected = false;
        let exported = false;
        let responseSent = false;
        let socketReady = false;
        let readyCheckInterval = null;
        
        // ✅ FIX 2: Track connection state properly
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, user } = update;
            
            console.log(`[${sessionId}] State:`, connection || 'waiting');
            
            // ✅ FIX 3: Detect when socket is ready for pairing
            if (connection === 'connecting') {
                console.log(`[${sessionId}] Socket connecting...`);
                // Socket is connecting, not ready yet
            }
            
            if (connection === 'open') {
                console.log(`🎉 [${sessionId}] CONNECTION OPEN!`);
                console.log(`👤 User: ${sock.user?.id}`);
                
                connected = true;
                socketReady = true;
                
                // ✅ FIX 5: ONLY export session after 'open' state
                if (!exported) {
                    exported = true;
                    
                    try {
                        // Collect session files
                        const sessionFiles = collectSessionFiles(sessionDir);
                        
                        // Create session package
                        const sessionPackage = {
                            id: sessionId,
                            user: sock.user?.id || user?.id,
                            number: formattedNumber,
                            timestamp: Date.now(),
                            files: sessionFiles
                        };
                        
                        // Encrypt
                        const sessionString = encryptSession(sessionPackage, sessionId);
                        
                        // Save active session ID for restores
                        fs.writeFileSync(ACTIVE_SESSION_FILE, sessionId);
                        
                        // Upload to Mega (optional)
                        try {
                            await uploadSession(sessionString, sessionId);
                        } catch (e) {}
                        
                        // Send to user via WhatsApp
                        try {
                            const userJid = formattedNumber + '@s.whatsapp.net';
                            await sock.sendMessage(userJid, {
                                text: `✅ *WhatsApp Linked Successfully!*\n\nSession ID: \`${sessionId}\``
                            });
                            console.log(`✅ [${sessionId}] Confirmation sent`);
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
            
            // If connection is stable enough for pairing (not necessarily open yet)
            if (connection === 'connecting' && !socketReady) {
                // Mark as ready after a short delay - the socket can now handle requests
                setTimeout(() => {
                    if (!socketReady && !codeSent && !responseSent) {
                        console.log(`[${sessionId}] Socket appears ready for pairing`);
                        socketReady = true;
                    }
                }, 5000);
            }
            
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log(`[${sessionId}] Closed:`, { statusCode, shouldReconnect });
                
                // Only cleanup if not connected
                if (!connected) {
                    activeSessions.delete(sessionId);
                    removeFile(sessionDir);
                }
                
                // If code wasn't sent and response not sent, send error
                if (!codeSent && !responseSent) {
                    res.status(500).json({ 
                        success: false, 
                        error: `Connection failed: ${statusCode || 'unknown'}` 
                    });
                    responseSent = true;
                }
            }
        });
        
        // ✅ FIX 4: Wait for socket to be ready before requesting code
        // Use a readiness detection approach
        const tryRequestCode = async () => {
            // Clear any existing interval
            if (readyCheckInterval) {
                clearInterval(readyCheckInterval);
            }
            
            // Wait a minimum of 3 seconds for connection to stabilize
            await delay(3000);
            
            // Check if socket is ready (either connecting or open)
            if (!socketReady && !codeSent && !responseSent) {
                console.log(`[${sessionId}] Socket not ready yet, waiting longer...`);
                
                // Try again in 2 seconds
                readyCheckInterval = setTimeout(tryRequestCode, 2000);
                return;
            }
            
            // If we already sent code or response, don't proceed
            if (codeSent || responseSent) return;
            
            // Socket should be ready now - request pairing code
            try {
                console.log(`🔑 [${sessionId}] Requesting pairing code for ${formattedNumber}...`);
                
                // Check if already registered
                if (sock.authState.creds.registered) {
                    console.log(`[${sessionId}] Already registered, reusing session`);
                    // Already have a session, just return success
                    res.json({
                        success: true,
                        message: 'Already have an active session',
                        sessionId
                    });
                    responseSent = true;
                    return;
                }
                
                // Request the pairing code
                const code = await sock.requestPairingCode(formattedNumber);
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                codeSent = true;
                
                console.log(`✅ [${sessionId}] Code generated: ${formattedCode}`);
                
                // Send response
                res.json({
                    success: true,
                    code: formattedCode,
                    sessionId,
                    message: 'Enter this code in your WhatsApp app',
                    instructions: [
                        '1. Open WhatsApp on your phone',
                        '2. Go to Settings > Linked Devices',
                        '3. Tap "Link a Device"',
                        `4. Enter the code: ${formattedCode}`,
                        '',
                        '⏱️ Code expires in 3 minutes'
                    ],
                    expiresIn: 180
                });
                responseSent = true;
                
                // Set expiration timeout
                setTimeout(() => {
                    if (!connected) {
                        console.log(`⏰ [${sessionId}] Code expired - no connection established`);
                        sock.ws?.close();
                        activeSessions.delete(sessionId);
                        removeFile(sessionDir);
                    }
                }, 180000);
                
            } catch (error) {
                console.error(`❌ [${sessionId}] Failed to get pairing code:`, error);
                
                if (!responseSent) {
                    // Check for specific errors
                    if (error.message?.includes('409')) {
                        res.status(409).json({ 
                            success: false, 
                            error: 'Conflict: Device already connected. Please wait a moment and try again.',
                            retry: true
                        });
                    } else if (error.message?.includes('429')) {
                        res.status(429).json({ 
                            success: false, 
                            error: 'Rate limited. Please wait a few minutes before trying again.',
                            retryAfter: 120
                        });
                    } else if (error.message?.includes('ENOTFOUND') || error.message?.includes('ECONNREFUSED')) {
                        res.status(503).json({ 
                            success: false, 
                            error: 'Network error. Please try again.',
                            retry: true
                        });
                    } else {
                        res.status(500).json({ 
                            success: false, 
                            error: error.message || 'Failed to generate pairing code'
                        });
                    }
                    responseSent = true;
                }
                
                // Cleanup
                sock.ws?.close();
                activeSessions.delete(sessionId);
                removeFile(sessionDir);
            }
        };
        
        // Start the code request process
        tryRequestCode();
        
    } catch (error) {
        console.error(`Fatal:`, error);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: error.message });
        }
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
