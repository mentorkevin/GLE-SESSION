import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
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

// ==================== SIMPLE PAIRING ENDPOINT ====================
router.get('/', async (req, res) => {
    const sessionId = makeid();
    let { number } = req.query;
    const sessionDir = path.join(TEMP_DIR, sessionId);
    
    console.log(`\n🔷 [${sessionId}] Pairing session started for ${number}`);
    
    try {
        if (!number) {
            return res.status(400).json({ success: false, error: 'Phone number required' });
        }
        
        number = number.replace(/\D/g, '');
        const phone = pn('+' + number);
        if (!phone.isValid()) {
            return res.status(400).json({ success: false, error: 'Invalid number' });
        }
        
        const formattedNumber = phone.getNumber('e164').replace('+', '');
        
        fs.mkdirSync(sessionDir, { recursive: true });
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        // DIFFERENT browser config for pairing
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ["Ubuntu", "Chrome", "120.0.0.0"], // This works for pairing
            syncFullHistory: false,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 30000
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        activeSessions.set(sessionId, { sock, sessionDir, status: 'waiting', connected: false });
        
        let codeSent = false;
        let connected = false;
        
        // Handle connection
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            console.log(`[${sessionId}] State:`, connection || 'waiting');
            
            if (connection === 'open') {
                connected = true;
                console.log(`🎉 [${sessionId}] WHATSAPP CONNECTED!`);
                console.log(`👤 User: ${sock.user?.id}`);
                
                // Send confirmation
                try {
                    await sock.sendMessage(sock.user.id, {
                        text: `✅ *WhatsApp Connected!*\n\nSession ID: ${sessionId}`
                    });
                } catch (e) {}
                
                fs.writeFileSync(path.join(__dirname, '.last_session'), sessionId);
            }
            
            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log(`[${sessionId}] Closed:`, code);
                
                if (connected) {
                    console.log(`✅ Session ended normally`);
                } else if (codeSent && !connected) {
                    console.log(`⏳ Waiting for code entry...`);
                } else {
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
                        if (session && !session.connected) {
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
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: error.message });
        }
        removeFile(sessionDir);
        activeSessions.delete(sessionId);
    }
});

export default router;
