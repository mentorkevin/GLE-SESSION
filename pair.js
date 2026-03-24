import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
import { uploadSession } from './mega.js';
import crypto from 'crypto';
import zlib from 'zlib';

const router = express.Router();
const __dirname = process.cwd();

// Encryption key from environment
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ENCRYPTION_KEY_HASH = ENCRYPTION_KEY ? crypto.createHash('sha256').update(ENCRYPTION_KEY).digest() : null;

function makeid() {
    return crypto.randomBytes(8).toString('hex');
}

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
        console.log(`🗑️ Removed: ${FilePath}`);
    } catch (e) {
        console.error('Error removing file:', e);
    }
}

function encryptSession(credsBase64, sessionId) {
    if (!ENCRYPTION_KEY_HASH) {
        throw new Error('ENCRYPTION_KEY not configured');
    }
    
    const compressed = zlib.deflateSync(credsBase64);
    const compressedBase64 = compressed.toString('base64');
    
    const dataToEncrypt = JSON.stringify({
        sessionId: sessionId,
        creds: compressedBase64
    });
    
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY_HASH, iv);
    
    let encrypted = cipher.update(dataToEncrypt, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');
    
    return `GleBot!${iv.toString('base64')}:${encrypted}:${authTag}`;
}

router.get('/', async (req, res) => {
    const id = makeid();
    let num = req.query.number;
    const sessionDir = './temp/' + id;
    
    async function GLEBOT_PAIR_CODE() {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        try {
            const { version } = await fetchLatestBaileysVersion();
            let GleBot = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.windows('Chrome'),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 250,
                maxRetries: 5,
            });
            
            // Request pairing code if not registered
            if (!GleBot.authState.creds.registered) {
                await delay(1500);
                let cleanNum = num.replace(/[^0-9]/g, '');
                console.log(`🔑 Requesting pairing code for ${cleanNum}...`);
                const code = await GleBot.requestPairingCode(cleanNum);
                const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                
                if (!res.headersSent) {
                    console.log(`✅ Pairing code: ${formattedCode}`);
                    await res.send({ 
                        success: true, 
                        code: formattedCode,
                        sessionId: id,
                        message: 'Enter this code in WhatsApp'
                    });
                }
            }
            
            // Handle credentials update
            GleBot.ev.on('creds.update', saveCreds);
            
            // Handle connection updates
            GleBot.ev.on("connection.update", async (s) => {
                const { connection, lastDisconnect } = s;
                
                if (connection === "open") {
                    console.log("✅ Connected successfully!");
                    await delay(5000);
                    
                    try {
                        // Read creds.json
                        const credsPath = sessionDir + '/creds.json';
                        if (!fs.existsSync(credsPath)) {
                            throw new Error('creds.json not found');
                        }
                        
                        const credsBase64 = fs.readFileSync(credsPath).toString('base64');
                        
                        // Encrypt the session
                        const sessionString = encryptSession(credsBase64, id);
                        
                        // Save encrypted session to file
                        const sessionFile = sessionDir + '/session.txt';
                        fs.writeFileSync(sessionFile, sessionString);
                        
                        // Send encrypted session to user
                        const userJid = jidNormalizedUser(cleanNum + '@s.whatsapp.net');
                        
                        // Split into chunks if too long
                        const maxChunkSize = 60000;
                        if (sessionString.length > maxChunkSize) {
                            const chunks = [];
                            for (let i = 0; i < sessionString.length; i += maxChunkSize) {
                                chunks.push(sessionString.slice(i, i + maxChunkSize));
                            }
                            
                            for (let i = 0; i < chunks.length; i++) {
                                await delay(2000);
                                await GleBot.sendMessage(userJid, {
                                    text: `📦 *Session Part ${i+1}/${chunks.length}*\n\n${chunks[i]}`
                                });
                            }
                            await GleBot.sendMessage(userJid, { text: `✅ *Session Complete!*` });
                        } else {
                            await GleBot.sendMessage(userJid, { text: sessionString });
                        }
                        console.log("📄 Session sent successfully");
                        
                        // Send warning and channel link
                        const messageText = `⚠️ *DO NOT SHARE THIS SESSION WITH ANYONE* ⚠️

┌┤✑  Thanks for using GleBot
│└────────────┈ ⳹        
│ ©2026 GleBot Inc. All rights reserved.
└─────────────────┈ ⳹

📢 Join our channel: https://whatsapp.com/channel/0029VbBTYeRJP215nxFl4I0x`;
                        
                        await GleBot.sendMessage(userJid, { text: messageText });
                        console.log("📢 Channel link sent successfully");
                        
                        // Upload to Mega in background
                        setTimeout(async () => {
                            try {
                                const megaUrl = await uploadSession(sessionString, id);
                                if (megaUrl && !megaUrl.startsWith('local://')) {
                                    await GleBot.sendMessage(userJid, { text: `💾 *Mega Backup*\n\n${megaUrl}` });
                                }
                            } catch (e) {
                                console.error('Mega upload failed:', e.message);
                            }
                        }, 5000);
                        
                        // Close connection and cleanup
                        await delay(2000);
                        await GleBot.ws.close();
                        removeFile(sessionDir);
                        console.log("✅ Session cleaned up successfully");
                        
                    } catch (error) {
                        console.error("❌ Error sending messages:", error);
                        removeFile(sessionDir);
                    }
                    
                } else if (connection === "close" && lastDisconnect && lastDisconnect.error && lastDisconnect.error.output?.statusCode !== 401) {
                    console.log("🔁 Connection closed — restarting...");
                    await delay(10000);
                    GLEBOT_PAIR_CODE();
                }
            });
            
        } catch (err) {
            console.log("❌ Service error:", err);
            removeFile(sessionDir);
            if (!res.headersSent) {
                await res.send({ success: false, error: "Service Unavailable" });
            }
        }
    }
    
    return await GLEBOT_PAIR_CODE();
});

// Session retrieval endpoint
router.get('/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const sessionFile = `./temp/${sessionId}/session.txt`;
    
    if (fs.existsSync(sessionFile)) {
        const sessionString = fs.readFileSync(sessionFile, 'utf8');
        res.json({ success: true, sessionId, session: sessionString });
    } else {
        res.status(404).json({ success: false, error: 'Session not found' });
    }
});

// Status endpoint
router.get('/status', (req, res) => {
    const tempDir = './temp';
    const sessions = fs.existsSync(tempDir) ? fs.readdirSync(tempDir).length : 0;
    res.json({
        success: true,
        activeSessions: sessions,
        encryptionConfigured: !!ENCRYPTION_KEY
    });
});

// Global uncaught exception handler
process.on('uncaughtException', (err) => {
    let e = String(err);
    if (e.includes("conflict")) return;
    if (e.includes("not-authorized")) return;
    if (e.includes("Socket connection timeout")) return;
    if (e.includes("rate-overlimit")) return;
    if (e.includes("Connection Closed")) return;
    if (e.includes("Timed Out")) return;
    if (e.includes("Value not found")) return;
    if (e.includes("Stream Errored")) return;
    if (e.includes("Stream Errored (restart required)")) return;
    if (e.includes("statusCode: 515")) return;
    if (e.includes("statusCode: 503")) return;
    console.log('Caught exception: ', err);
});

export default router;
