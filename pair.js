import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
import { uploadSession } from './mega.js';
import crypto from 'crypto';
import zlib from 'zlib';

const router = express.Router();

// Encryption key from environment
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ENCRYPTION_KEY_HASH = ENCRYPTION_KEY ? crypto.createHash('sha256').update(ENCRYPTION_KEY).digest() : null;

// Ensure the session directory exists
function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
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
    let num = req.query.number;
    const sessionId = crypto.randomBytes(8).toString('hex');
    let dirs = './temp_sessions/' + sessionId;

    // Remove existing session if present
    await removeFile(dirs);

    // Clean the phone number - remove any non-digit characters
    num = num.replace(/[^0-9]/g, '');

    // Validate the phone number using awesome-phonenumber
    const phone = pn('+' + num);
    if (!phone.isValid()) {
        if (!res.headersSent) {
            return res.status(400).send({ success: false, error: 'Invalid phone number. Please enter your full international number (e.g., 15551234567 for US, 447911123456 for UK, 254712345678 for Kenya) without + or spaces.' });
        }
        return;
    }
    // Use the international number format (E.164, without '+')
    num = phone.getNumber('e164').replace('+', '');

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

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

            GleBot.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, isNewLogin, isOnline } = update;

                if (connection === 'open') {
                    console.log("✅ Connected successfully!");
                    console.log("📱 Sending session file to user...");
                    
                    try {
                        // Read creds.json
                        const credsPath = dirs + '/creds.json';
                        if (!fs.existsSync(credsPath)) {
                            throw new Error('creds.json not found');
                        }
                        
                        const credsBase64 = fs.readFileSync(credsPath).toString('base64');
                        
                        // Encrypt the session
                        const sessionString = encryptSession(credsBase64, sessionId);
                        
                        // Save encrypted session to file
                        const sessionFile = dirs + '/session.txt';
                        fs.writeFileSync(sessionFile, sessionString);
                        
                        // Send encrypted session as text
                        const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                        
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

                        // Send channel link
                        await GleBot.sendMessage(userJid, {
                            text: `⚠️ *DO NOT SHARE THIS SESSION WITH ANYONE* ⚠️

┌┤✑  Thanks for using GleBot
│└────────────┈ ⳹        
│ ©2026 GleBot Inc. All rights reserved.
└─────────────────┈ ⳹

📢 Join our channel: https://whatsapp.com/channel/0029VbBTYeRJP215nxFl4I0x`
                        });
                        console.log("📢 Channel link sent successfully");

                        // Upload to Mega in background
                        setTimeout(async () => {
                            try {
                                const megaUrl = await uploadSession(sessionString, sessionId);
                                if (megaUrl && !megaUrl.startsWith('local://')) {
                                    await GleBot.sendMessage(userJid, { text: `💾 *Mega Backup*\n\n${megaUrl}` });
                                }
                            } catch (e) {
                                console.error('Mega upload failed:', e.message);
                            }
                        }, 5000);

                        // Clean up session after use
                        console.log("🧹 Cleaning up session...");
                        await delay(2000);
                        removeFile(dirs);
                        console.log("✅ Session cleaned up successfully");
                        console.log("🎉 Process completed successfully!");
                        
                    } catch (error) {
                        console.error("❌ Error sending messages:", error);
                        removeFile(dirs);
                    }
                }

                if (isNewLogin) {
                    console.log("🔐 New login via pair code");
                }

                if (isOnline) {
                    console.log("📶 Client is online");
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;

                    if (statusCode === DisconnectReason.loggedOut) {
                        console.log("❌ Logged out from WhatsApp. Need to generate new pair code.");
                        removeFile(dirs);
                    } else if (statusCode === 515 || statusCode === 503 || statusCode === 408) {
                        console.log(`⚠️ Connection closed (${statusCode}). Reconnecting...`);
                        setTimeout(() => initiateSession(), 5000);
                    } else {
                        console.log("🔁 Connection closed — restarting...");
                        setTimeout(() => initiateSession(), 3000);
                    }
                }
            });

            // Handle credentials update
            GleBot.ev.on('creds.update', saveCreds);

            // Request pairing code if not registered
            if (!GleBot.authState.creds.registered) {
                console.log("🔑 Requesting pairing code...");
                await delay(3000); // Wait 3 seconds before requesting pairing code
                let cleanNum = num.replace(/[^\d+]/g, '');
                if (cleanNum.startsWith('+')) cleanNum = cleanNum.substring(1);

                try {
                    let code = await GleBot.requestPairingCode(cleanNum);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    if (!res.headersSent) {
                        console.log(`✅ Pairing code: ${code}`);
                        await res.send({ 
                            success: true, 
                            code: code,
                            sessionId: sessionId,
                            message: 'Enter this code in WhatsApp'
                        });
                    }
                } catch (error) {
                    console.error('Error requesting pairing code:', error);
                    if (!res.headersSent) {
                        res.status(503).send({ 
                            success: false, 
                            error: 'Failed to get pairing code. Please check your phone number and try again.' 
                        });
                    }
                    removeFile(dirs);
                }
            }

        } catch (err) {
            console.error('Error initializing session:', err);
            if (!res.headersSent) {
                res.status(503).send({ success: false, error: 'Service Unavailable' });
            }
            removeFile(dirs);
        }
    }

    await initiateSession();
});

// Session retrieval endpoint
router.get('/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const sessionFile = `./temp_sessions/${sessionId}/session.txt`;
    
    if (fs.existsSync(sessionFile)) {
        const sessionString = fs.readFileSync(sessionFile, 'utf8');
        res.json({ success: true, sessionId, session: sessionString });
    } else {
        res.status(404).json({ success: false, error: 'Session not found' });
    }
});

// Status endpoint
router.get('/status', (req, res) => {
    const tempDir = './temp_sessions';
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
