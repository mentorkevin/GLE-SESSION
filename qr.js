import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, Browsers, fetchLatestBaileysVersion, jidNormalizedUser, DisconnectReason } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
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

// ==================== FIXED QR ENDPOINT ====================
router.get('/', async (req, res) => {
    const sessionId = makeid();
    const sessionDir = path.join(TEMP_DIR, sessionId);
    
    console.log(`\n🔷 [${sessionId}] QR session started`);
    
    try {
        fs.mkdirSync(sessionDir, { recursive: true });
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        // FIX 1: Proper socket configuration
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            browser: Browsers.windows("Chrome"), // ✅ FIXED: Use proper browser config
            syncFullHistory: false,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 30000, // ✅ FIXED: Keep connection alive
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000, // ✅ FIXED: Add connection timeout
            generateHighQualityLinkPreview: false,
            patchMessageBeforeSending: true // ✅ FIXED: Fix 408 errors
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        // Store session
        activeSessions.set(sessionId, { sock, sessionDir, status: 'waiting', connected: false });
        
        let qrSent = false;
        let connected = false;
        let responseSent = false;
        
        // FIX 2: Proper connection lifecycle handling
        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;
            
            console.log(`[${sessionId}] State:`, connection || 'waiting');
            
            // QR CODE GENERATED
            if (qr && !qrSent && !responseSent) {
                qrSent = true;
                try {
                    const qrImage = await QRCode.toDataURL(qr);
                    
                    // ✅ FIX: Send response but KEEP CONNECTION ALIVE
                    res.json({ 
                        success: true, 
                        qr: qrImage, 
                        sessionId,
                        message: 'Scan with WhatsApp - connection will stay alive',
                        instructions: [
                            '1. Open WhatsApp on your phone',
                            '2. Tap Menu or Settings and select Linked Devices',
                            '3. Tap "Link a Device"',
                            '4. Scan this QR code'
                        ]
                    });
                    responseSent = true;
                    console.log(`✅ [${sessionId}] QR sent to client - waiting for scan...`);
                    
                    // Set timeout for scan (3 minutes)
                    setTimeout(() => {
                        if (!connected) {
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
            
            // ✅ FIX 3: CRITICAL - Wait for 'open' state before considering connected
            if (connection === 'open') {
                connected = true;
                console.log(`🎉 [${sessionId}] WHATSAPP CONNECTED!`);
                console.log(`👤 User: ${sock.user?.id}`);
                
                // ✅ FIX 4: ONLY save session after 'open' state
                // Save session ID for future restore
                fs.writeFileSync(ACTIVE_SESSION_FILE, sessionId);
                
                // Send confirmation to user
                try {
                    await sock.sendMessage(sock.user.id, {
                        text: `✅ *WhatsApp Connected Successfully!*\n\nSession ID: ${sessionId}`
                    });
                    console.log(`✅ [${sessionId}] Confirmation sent`);
                } catch (msgErr) {
                    console.error(`Failed to send confirmation:`, msgErr);
                }
                
                // Keep socket alive - don't close
            }
            
            // ✅ FIX 5: Handle connection close with reconnection logic
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log(`[${sessionId}] Closed:`, { statusCode, shouldReconnect });
                
                // If we were connected, try to reconnect
                if (connected && shouldReconnect) {
                    console.log(`🔄 [${sessionId}] Reconnecting in 5 seconds...`);
                    // Don't delete session - let it reconnect
                    return;
                }
                
                // Only cleanup if not connected or logged out
                if (!connected || !shouldReconnect) {
                    activeSessions.delete(sessionId);
                    removeFile(sessionDir);
                }
                
                // If QR was sent but never scanned, error response already sent
                if (!connected && !responseSent) {
                    res.status(500).json({ 
                        success: false, 
                        error: `Connection failed: ${statusCode || 'unknown'}` 
                    });
                    responseSent = true;
                }
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
