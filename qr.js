import express from 'express';
import fs from 'fs';
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
        
        // Create socket
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
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
        
        activeSessions.set(sessionId, { sock, sessionDir, status: 'waiting', connected: false });
        
        let qrSent = false;
        let connected = false;
        let responseSent = false;
        let loginCompleted = false;
        
        // Handle connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;
            
            console.log(`[${sessionId}] State:`, connection || 'waiting');
            
            // ✅ QR CODE GENERATED - Send it immediately
            if (qr && !qrSent && !responseSent) {
                qrSent = true;
                try {
                    const qrImage = await QRCode.toDataURL(qr);
                    
                    // Send response immediately with QR
                    res.json({ 
                        success: true, 
                        qr: qrImage, 
                        sessionId,
                        message: 'Scan with WhatsApp',
                        instructions: [
                            '1. Open WhatsApp on your phone',
                            '2. Tap Menu or Settings and select Linked Devices',
                            '3. Tap "Link a Device"',
                            '4. Scan this QR code'
                        ]
                    });
                    responseSent = true;
                    console.log(`✅ [${sessionId}] QR sent to client`);
                    
                    // Set timeout for scan (3 minutes)
                    setTimeout(() => {
                        if (!connected && !loginCompleted) {
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
            
            // ✅ LOGIN COMPLETED - Now do everything else
            if (connection === 'open') {
                console.log(`🎉 [${sessionId}] LOGIN SUCCESSFUL!`);
                console.log(`👤 User: ${sock.user?.id}`);
                
                connected = true;
                loginCompleted = true;
                
                // ✅ Save session ID for potential restore
                fs.writeFileSync(ACTIVE_SESSION_FILE, sessionId);
                console.log(`✅ [${sessionId}] Session ID saved`);
                
                // Send confirmation to user
                try {
                    await sock.sendMessage(sock.user.id, {
                        text: `✅ *WhatsApp Linked Successfully!*\n\nSession ID: ${sessionId}`
                    });
                    console.log(`✅ [${sessionId}] Confirmation sent`);
                } catch (msgErr) {
                    console.error(`Failed to send confirmation:`, msgErr);
                }
                
                console.log(`✅ [${sessionId}] Post-login tasks completed`);
            }
            
            // Handle connection close
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`[${sessionId}] Closed:`, statusCode);
                
                // If login never completed and QR was sent, just cleanup
                if (!loginCompleted) {
                    activeSessions.delete(sessionId);
                    removeFile(sessionDir);
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
