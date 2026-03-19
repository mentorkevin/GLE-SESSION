import express from 'express';
import fs from 'fs';
import { makeWASocket, useMultiFileAuthState, delay, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
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

// ==================== PAIRING ENDPOINT ====================
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
            browser: Browsers.windows("Chrome"),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            keepAliveIntervalMs: 30000,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        activeSessions.set(sessionId, { sock, sessionDir, number: formattedNumber, status: 'connecting' });
        
        let codeSent = false;
        let responseSent = false;
        let loginCompleted = false;
        
        // Request pairing code after socket is ready
        setTimeout(async () => {
            if (codeSent || responseSent || loginCompleted) return;
            
            try {
                console.log(`🔑 [${sessionId}] Requesting pairing code for ${formattedNumber}...`);
                const code = await sock.requestPairingCode(formattedNumber);
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                codeSent = true;
                
                console.log(`✅ [${sessionId}] Code generated: ${formattedCode}`);
                
                res.json({
                    success: true,
                    code: formattedCode,
                    sessionId,
                    message: 'Enter this code in your WhatsApp app',
                    instructions: [
                        '1. Open WhatsApp on your phone',
                        '2. Go to Settings > Linked Devices',
                        '3. Tap "Link a Device"',
                        `4. Enter the code: ${formattedCode}`
                    ],
                    expiresIn: 120
                });
                responseSent = true;
                
                // Set timeout for code entry
                setTimeout(() => {
                    if (!loginCompleted) {
                        console.log(`⏰ [${sessionId}] Code expired - no login`);
                        sock.ws?.close();
                        activeSessions.delete(sessionId);
                        removeFile(sessionDir);
                    }
                }, 120000);
                
            } catch (error) {
                console.error(`❌ [${sessionId}] Failed to get pairing code:`, error);
                if (!responseSent) {
                    res.status(500).json({ success: false, error: error.message });
                }
                sock.ws?.close();
                activeSessions.delete(sessionId);
                removeFile(sessionDir);
            }
        }, 3000);
        
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            console.log(`[${sessionId}] State:`, connection || 'waiting');
            
            // Handle expected restart after pairing
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === 515 && !loginCompleted) {
                    console.log(`🔄 [${sessionId}] Restarting after pairing...`);
                    return;
                }
                if (!loginCompleted) {
                    activeSessions.delete(sessionId);
                    removeFile(sessionDir);
                }
            }
            
            // ✅ STEP 1: LOGIN SUCCESSFUL - ONLY NOW do encryption + mega
            if (connection === 'open' && !loginCompleted) {
                console.log(`🎉 [${sessionId}] LOGIN SUCCESSFUL!`);
                console.log(`👤 User: ${sock.user?.id}`);
                
                loginCompleted = true;
                
                // Wait for all session files to be written
                console.log(`⏳ [${sessionId}] Waiting for session files...`);
                await delay(5000);
                
                try {
                    // Collect session files
                    console.log(`📁 [${sessionId}] Collecting session files...`);
                    const sessionFiles = collectSessionFiles(sessionDir);
                    
                    const sessionPackage = {
                        id: sessionId,
                        user: sock.user?.id,
                        number: formattedNumber,
                        timestamp: Date.now(),
                        files: sessionFiles
                    };
                    
                    // ✅ STEP 2: ENCRYPT (ONLY AFTER LOGIN)
                    console.log(`🔐 [${sessionId}] Encrypting session...`);
                    const sessionString = encryptSession(sessionPackage, sessionId);
                    
                    // ✅ STEP 3: UPLOAD TO MEGA (ONLY AFTER LOGIN)
                    console.log(`☁️ [${sessionId}] Uploading to Mega...`);
                    let megaUrl = null;
                    try {
                        megaUrl = await uploadSession(sessionString, sessionId);
                        if (megaUrl && !megaUrl.startsWith('local://')) {
                            console.log(`✅ [${sessionId}] Mega upload complete`);
                        } else {
                            console.log(`⚠️ [${sessionId}] Mega upload returned local fallback`);
                        }
                    } catch (e) {
                        console.log(`⚠️ [${sessionId}] Mega upload failed: ${e.message}`);
                    }
                    
                    // ✅ STEP 4: SEND TO USER
                    console.log(`📤 [${sessionId}] Sending to user...`);
                    const userJid = formattedNumber + '@s.whatsapp.net';
                    
                    // Send session string
                    await sock.sendMessage(userJid, {
                        text: `🔐 *GLE Session String*\n\nCopy this entire string for session restore:\n\n\`${sessionString}\``
                    });
                    console.log(`✅ [${sessionId}] Session string sent`);
                    
                    // Send creds.json
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
                    
                    // Send Mega link if available
                    if (megaUrl && !megaUrl.startsWith('local://')) {
                        await sock.sendMessage(userJid, {
                            text: `💾 *Mega Backup*\n\n${megaUrl}`
                        });
                        console.log(`✅ [${sessionId}] Mega link sent`);
                    }
                    
                    // Send completion message
                    await sock.sendMessage(userJid, {
                        text: `✅ *Session Export Complete!*\n\nYou can now close this window.`
                    });
                    
                    console.log(`✅ [${sessionId}] All data sent to user`);
                    
                    // ✅ STEP 5: EXIT
                    console.log(`🔌 [${sessionId}] Job complete - closing socket...`);
                    await delay(3000);
                    sock.ws?.close();
                    
                    setTimeout(() => {
                        activeSessions.delete(sessionId);
                        removeFile(sessionDir);
                        console.log(`🧹 [${sessionId}] Cleanup complete`);
                    }, 5000);
                    
                } catch (err) {
                    console.error(`❌ [${sessionId}] Export failed:`, err);
                    
                    // Try to notify user of error
                    try {
                        await sock.sendMessage(formattedNumber + '@s.whatsapp.net', {
                            text: `❌ *Export Failed*\n\n${err.message}\nPlease try again.`
                        });
                    } catch (e) {}
                    
                    sock.ws?.close();
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

export default router;
