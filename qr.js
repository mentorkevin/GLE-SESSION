import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, Browsers, fetchLatestBaileysVersion, jidNormalizedUser } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
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

// ==================== SIMPLE QR ENDPOINT ====================
router.get('/', async (req, res) => {
    const sessionId = makeid();
    const sessionDir = path.join(TEMP_DIR, sessionId);
    
    console.log(`\n🔷 [${sessionId}] QR session started`);
    
    try {
        fs.mkdirSync(sessionDir, { recursive: true });
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        // SIMPLE socket configuration
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true, // Let it print QR in terminal too
            browser: Browsers.windows("Chrome"),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 30000,
            defaultQueryTimeoutMs: 60000
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        // Store session
        activeSessions.set(sessionId, { sock, sessionDir, status: 'waiting', connected: false });
        
        let qrSent = false;
        let connected = false;
        
        // Handle connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;
            
            console.log(`[${sessionId}] State:`, connection || 'waiting');
            
            // QR CODE GENERATED
            if (qr && !qrSent && !res.headersSent) {
                qrSent = true;
                try {
                    const qrImage = await QRCode.toDataURL(qr);
                    res.json({ 
                        success: true, 
                        qr: qrImage, 
                        sessionId,
                        message: 'Scan with WhatsApp'
                    });
                    console.log(`✅ [${sessionId}] QR sent to client`);
                } catch (err) {
                    console.error(`QR error:`, err);
                }
            }
            
            // CONNECTION OPEN - SUCCESS!
            if (connection === 'open') {
                connected = true;
                console.log(`🎉 [${sessionId}] WHATSAPP CONNECTED!`);
                console.log(`👤 User: ${sock.user?.id}`);
                
                // Save session ID for potential restore
                fs.writeFileSync(path.join(__dirname, '.last_session'), sessionId);
                
                // Send confirmation to user
                try {
                    await sock.sendMessage(sock.user.id, {
                        text: `✅ *WhatsApp Connected Successfully!*\n\nSession ID: ${sessionId}`
                    });
                    console.log(`✅ [${sessionId}] Confirmation sent`);
                } catch (msgErr) {
                    console.error(`Failed to send confirmation:`, msgErr);
                }
                
                // Don't close socket - keep alive
            }
            
            // CONNECTION CLOSED
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`[${sessionId}] Closed:`, statusCode);
                
                // If we were connected, this is normal
                if (connected) {
                    console.log(`✅ [${sessionId}] Session ended normally`);
                } 
                // If QR was sent but never scanned, keep waiting (don't cleanup)
                else if (qrSent && !connected) {
                    console.log(`⏳ [${sessionId}] Waiting for scan...`);
                }
                // Otherwise cleanup
                else {
                    activeSessions.delete(sessionId);
                    removeFile(sessionDir);
                }
            }
        });
        
        // Timeout for QR generation
        setTimeout(() => {
            if (!qrSent && !res.headersSent) {
                res.status(504).json({ success: false, error: 'QR timeout' });
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
