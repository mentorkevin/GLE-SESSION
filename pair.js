import express from 'express';
import fs from 'fs';
import pino from 'pino';
import crypto from 'crypto';
import zlib from 'zlib';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser } from '@whiskeysockets/baileys';
import { upload } from './mega.js';

const router = express.Router();
const SESSION_PREFIX = 'GleBot!';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!ENCRYPTION_KEY) {
    console.error('❌ ENCRYPTION_KEY required');
    process.exit(1);
}

const ENCRYPTION_KEY_HASH = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();

// Ensure the session directory exists
function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
        console.log(`🗑️ Removed: ${FilePath}`);
    } catch (e) {
        console.error('Error removing file:', e);
    }
}

function generateRandomId(length = 6, numberLength = 4) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    const number = Math.floor(Math.random() * Math.pow(10, numberLength));
    return `${result}${number}`;
}

function encryptSession(credsBase64) {
    const compressed = zlib.gzipSync(credsBase64);
    const compressedBase64 = compressed.toString('base64');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY_HASH, iv);
    let encrypted = cipher.update(compressedBase64, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');
    return `${SESSION_PREFIX}${iv.toString('base64')}:${encrypted}:${authTag}`;
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    if (!num) {
        return res.status(400).json({ error: 'Phone number required' });
    }
    
    // Clean number - keep only digits
    num = num.replace(/[^0-9]/g, '');
    console.log(`📱 Pairing for: ${num}`);
    
    const sessionId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    const dirs = `./temp/${sessionId}`;
    
    let retryCount = 0;
    const MAX_RETRIES = 5;
    let responseSent = false;
    let sock = null;

    // Enhanced session initialization function
    async function initiateSession() {
        // Remove existing session if present
        if (fs.existsSync(dirs)) {
            removeFile(dirs);
        }
        fs.mkdirSync(dirs, { recursive: true });
        
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            // Initialize socket connection
            sock = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' })),
                },
                version: [2, 3000, 1033105955],
                printQRInTerminal: false,
                logger: pino({ level: 'silent' }),
                browser: Browsers.windows('Edge'),
                markOnlineOnConnect: false
            });
            
            sock.ev.on('creds.update', saveCreds);

            sock.ev.on("connection.update", async (s) => {
                const { connection, lastDisconnect } = s;

                if (connection === "open") {
                    console.log("✅ Connection opened successfully");
                    
                    try {
                        await sock.sendMessage(sock.user.id, { text: `🔄 Generating your GleBot session, please wait...` });
                        console.log("📤 Sent waiting message");
                        
                        await delay(10000);
                        
                        const credsPath = `${dirs}/creds.json`;
                        if (fs.existsSync(credsPath)) {
                            const credsData = fs.readFileSync(credsPath);
                            const credsBase64 = credsData.toString('base64');
                            
                            // Encrypt the session
                            const sessionString = encryptSession(credsBase64);
                            
                            // Save encrypted session to file
                            fs.writeFileSync(`${dirs}/session.txt`, sessionString);
                            
                            // Upload to Mega
                            const megaUrl = await upload(fs.createReadStream(credsPath), `${generateRandomId()}.json`);
                            console.log(`📤 Uploaded to Mega: ${megaUrl}`);
                            
                            // Send the encrypted session
                            await sock.sendMessage(sock.user.id, { text: sessionString });
                            console.log("📤 Encrypted session sent to user");
                            
                            // Send Mega backup link
                            await sock.sendMessage(sock.user.id, { text: `💾 *Mega Backup*\n\n${megaUrl}` });
                            
                            // Send confirmation message
                            await sock.sendMessage(sock.user.id, { 
                                text: `✅ *GleBot Session Generated Successfully!*

⚠️ *DO NOT SHARE THIS SESSION WITH ANYONE*

┌┤✑  Thanks for using GleBot
│└────────────┈ ⳹        
│ ©2026 GleBot Inc. All rights reserved.
└─────────────────┈ ⳹

📢 Join our channel: https://whatsapp.com/channel/0029VbBTYeRJP215nxFl4I0x

Copy and save this session string. You'll need it to authenticate your bot.` 
                            });
                            
                            console.log("✅ Session sent successfully");
                            
                            // Clean up session after use
                            await delay(2000);
                            removeFile(dirs);
                            console.log("🧹 Session cleaned up");
                            process.exit(0);
                        } else {
                            console.error("❌ creds.json not found");
                        }
                    } catch (err) {
                        console.error('Error sending session:', err);
                        removeFile(dirs);
                    }
                } else if (connection === 'close' && lastDisconnect && lastDisconnect.error && lastDisconnect.error.output?.statusCode !== 401) {
                    console.log('Connection closed unexpectedly:', lastDisconnect.error.message);
                    retryCount++;

                    if (retryCount < MAX_RETRIES) {
                        console.log(`🔄 Retrying connection... Attempt ${retryCount}/${MAX_RETRIES}`);
                        await delay(10000);
                        initiateSession();
                    } else {
                        console.log('Max retries reached, stopping reconnection attempts.');
                        if (!responseSent && !res.headersSent) {
                            responseSent = true;
                            res.status(500).json({ error: 'Unable to reconnect after multiple attempts.' });
                        }
                    }
                }
            });

            // Request pairing code
            if (!sock.authState.creds.registered) {
                await delay(2000);
                const custom = generateRandomId(4, 4);
                console.log(`🔑 Generated pairing code: ${custom}`);
                
                const code = await sock.requestPairingCode(num, custom);
                const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                console.log(`✅ Pairing code: ${formattedCode}`);
                
                if (!responseSent && !res.headersSent) {
                    responseSent = true;
                    res.json({ 
                        success: true, 
                        code: formattedCode,
                        message: 'Enter this code in WhatsApp: Settings → Linked Devices → Link a Device'
                    });
                }
            }

        } catch (err) {
            console.error('Error initializing session:', err);
            if (!responseSent && !res.headersSent) {
                responseSent = true;
                res.status(503).json({ error: 'Service Unavailable' });
            }
            removeFile(dirs);
        }
    }

    await initiateSession();
    
    // Cleanup after timeout (3 minutes)
    setTimeout(() => {
        if (fs.existsSync(dirs)) {
            console.log('⏰ Session timeout, cleaning up...');
            removeFile(dirs);
        }
    }, 180000);
});

// Catch uncaught errors and handle session cleanup
process.on('uncaughtException', (err) => {
    const e = String(err);
    const ignore = ["conflict","not-authorized","Socket connection timeout","rate-overlimit","Connection Closed","Timed Out","Value not found","Stream Errored","statusCode: 515","statusCode: 503"];
    if (!ignore.some(x => e.includes(x))) {
        console.log('Caught exception:', err);
    }
});

export default router;
