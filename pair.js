import express from 'express';
import fs from 'fs';
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
        
        // Create socket
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
        let responseSent = false;
        let loginCompleted = false;
        
        // ✅ FIX: Wait for socket to be ready before requesting code
        setTimeout(async () => {
            if (codeSent || responseSent || loginCompleted) return;
            
            try {
                console.log(`🔑 [${sessionId}] Requesting pairing code for ${formattedNumber}...`);
                
                // Request the pairing code
                const code = await sock.requestPairingCode(formattedNumber);
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                codeSent = true;
                
                console.log(`✅ [${sessionId}] Code generated: ${formattedCode}`);
                
                // Send response immediately with the code
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
                    if (!connected && !loginCompleted) {
                        console.log(`⏰ [${sessionId}] Code expired - no connection established`);
                        sock.ws?.close();
                        activeSessions.delete(sessionId);
                        removeFile(sessionDir);
                    }
                }, 180000);
                
            } catch (error) {
                console.error(`❌ [${sessionId}] Failed to get pairing code:`, error);
                
                if (!responseSent) {
                    res.status(500).json({ 
                        success: false, 
                        error: error.message || 'Failed to generate pairing code'
                    });
                    responseSent = true;
                }
                
                // Cleanup
                sock.ws?.close();
                activeSessions.delete(sessionId);
                removeFile(sessionDir);
            }
        }, 3000); // Wait 3 seconds for socket to initialize
        
        // ✅ CRITICAL: Handle connection.update - ONLY do post-login stuff AFTER connection is open
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            console.log(`[${sessionId}] State:`, connection || 'waiting');
            
            // ✅ LOGIN COMPLETED - Now do everything else
            if (connection === 'open') {
                console.log(`🎉 [${sessionId}] LOGIN SUCCESSFUL!`);
                console.log(`👤 User: ${sock.user?.id}`);
                
                connected = true;
                loginCompleted = true;
                
                // ✅ NOW we can do all post-login tasks
                try {
                    console.log(`📦 [${sessionId}] Starting post-login tasks...`);
                    
                    // 1. Collect session files
                    const sessionFiles = collectSessionFiles(sessionDir);
                    
                    // 2. Create session package
                    const sessionPackage = {
                        id: sessionId,
                        user: sock.user?.id,
                        number: formattedNumber,
                        timestamp: Date.now(),
                        files: sessionFiles
                    };
                    
                    // 3. Encrypt session
                    const sessionString = encryptSession(sessionPackage, sessionId);
                    
                    // 4. Save session ID for future restores
                    fs.writeFileSync(ACTIVE_SESSION_FILE, sessionId);
                    console.log(`✅ [${sessionId}] Session ID saved`);
                    
                    // 5. Upload to Mega (optional - don't let it block)
                    try {
                        await uploadSession(sessionString, sessionId);
                        console.log(`✅ [${sessionId}] Mega upload complete`);
                    } catch (e) {
                        console.log(`⚠️ [${sessionId}] Mega upload failed: ${e.message}`);
                    }
                    
                    // 6. Send confirmation via WhatsApp
                    try {
                        const userJid = formattedNumber + '@s.whatsapp.net';
                        await sock.sendMessage(userJid, {
                            text: `✅ *WhatsApp Linked Successfully!*\n\nSession ID: \`${sessionId}\``
                        });
                        console.log(`✅ [${sessionId}] Confirmation sent to user`);
                    } catch (e) {
                        console.log(`⚠️ [${sessionId}] Could not send confirmation: ${e.message}`);
                    }
                    
                    // 7. Save to file as backup
                    fs.writeFileSync(path.join(sessionDir, 'session.txt'), sessionString);
                    console.log(`✅ [${sessionId}] Session backup saved`);
                    
                    console.log(`✅ [${sessionId}] All post-login tasks completed`);
                    
                } catch (err) {
                    console.error(`❌ [${sessionId}] Post-login tasks failed:`, err);
                }
                
                // Don't close socket - let it stay connected
            }
            
            // Handle connection close
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`[${sessionId}] Closed:`, statusCode);
                
                // If login never completed and code was sent, just cleanup
                if (!loginCompleted) {
                    activeSessions.delete(sessionId);
                    removeFile(sessionDir);
                }
            }
        });
        
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
