import express from 'express';
import fs from 'fs-extra';
import pino from 'pino';
import pn from 'awesome-phonenumber';
import crypto from 'crypto';
import zlib from 'zlib';
import {
    makeWASocket, useMultiFileAuthState, delay,
    makeCacheableSignalKeyStore, jidNormalizedUser,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { uploadSession as megaUpload } from './mega.js';

const router = express.Router();
const SESSION_PREFIX = 'GleBot!';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!ENCRYPTION_KEY) {
    console.error('❌ ENCRYPTION_KEY required');
    process.exit(1);
}

const ENCRYPTION_KEY_HASH = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();

const CHANNEL_LINK = "https://whatsapp.com/channel/0029VbBTYeRJP215nxFl4I0x";
const MESSAGE = `⚠️ *DO NOT SHARE THIS SESSION WITH ANYONE* ⚠️

┌┤✑  Thanks for using GleBot
│└────────────┈ ⳹        
│ ©2026 GleBot Inc. All rights reserved.
└─────────────────┈ ⳹

📢 Join our channel: ${CHANNEL_LINK}`;

// Generate PAIRING CODE (8-digit number user enters)
function generatePairingCode() {
    return Math.floor(10000000 + Math.random() * 90000000).toString();
}

// Create SESSION STRING (the GleBot!... that gets sent after pairing)
function createSessionString(credsData) {
    // Compress with gzip (like gifted code)
    const compressed = zlib.gzipSync(credsData);
    const compressedBase64 = compressed.toString('base64');
    
    // Encrypt with AES
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY_HASH, iv);
    let encrypted = cipher.update(compressedBase64, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');
    
    return `${SESSION_PREFIX}${iv.toString('base64')}:${encrypted}:${authTag}`;
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    if (!num) return res.status(400).json({ error: 'Phone number required' });

    // Clean and validate number
    num = num.replace(/\D/g, '');
    const phone = pn('+' + num);
    if (!phone.isValid()) {
        if (num.length === 10 && !num.startsWith('1')) num = '1' + num;
        else if (num.length === 9 && num.startsWith('7')) num = '254' + num;
        else if (num.length === 10 && num.startsWith('7')) num = '254' + num;
        else return res.status(400).json({ error: 'Invalid phone number' });
    }
    
    const whatsappNumber = pn('+' + num).getNumber('e164').replace('+', '');
    console.log(`📱 Pairing for: +${whatsappNumber}`);
    
    const sessionId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    const sessionDir = `./temp/${sessionId}`;
    await fs.ensureDir(sessionDir);
    
    let responseSent = false;
    let sock = null;
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: ["Chrome (Linux)", "", ""],
            markOnlineOnConnect: false
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        // Handle when user enters the PAIRING CODE and connects
        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;
            
            if (connection === 'open') {
                console.log('✅ User entered pairing code and connected!');
                try {
                    const credsData = await fs.readFile(`${sessionDir}/creds.json`);
                    
                    // Create the SESSION STRING
                    const sessionString = createSessionString(credsData);
                    const userJid = jidNormalizedUser(whatsappNumber + '@s.whatsapp.net');
                    
                    // Send the SESSION STRING to the user
                    await sock.sendMessage(userJid, { text: sessionString });
                    console.log('📤 Session string sent to user');
                    
                    // Upload to Mega for backup
                    try {
                        const megaLink = await megaUpload(sessionString, sessionId);
                        if (megaLink && !megaLink.startsWith('local://')) {
                            await sock.sendMessage(userJid, { text: `💾 Mega Backup: ${megaLink}` });
                            console.log('📤 Mega backup sent');
                        }
                    } catch (e) {
                        console.error('Mega upload failed:', e.message);
                    }
                    
                    await sock.sendMessage(userJid, { text: MESSAGE });
                    await delay(2000);
                    await sock.end();
                    await fs.remove(sessionDir);
                    console.log('✅ Session complete');
                } catch (err) {
                    console.error('Error sending session:', err);
                }
            }
        });
        
        // Wait for socket connection
        await new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(), 10000);
            const handler = (update) => {
                if (update.connection === 'connecting') {
                    clearTimeout(timeout);
                    sock.ev.off('connection.update', handler);
                    resolve();
                }
            };
            sock.ev.on('connection.update', handler);
        });
        
        // STEP 1: Generate the PAIRING CODE (8-digit number user will enter)
        const pairingCode = generatePairingCode();
        console.log(`🔑 PAIRING CODE: ${pairingCode}`);
        
        // STEP 2: Send the pairing code to WhatsApp
        await sock.requestPairingCode(whatsappNumber, pairingCode);
        
        console.log(`✅ WhatsApp will send "${pairingCode}" to +${whatsappNumber}`);
        console.log(`📱 User must enter: ${pairingCode} in WhatsApp → Settings → Linked Devices`);
        
        if (!responseSent) {
            responseSent = true;
            res.json({ 
                success: true, 
                code: pairingCode,  // Return the PAIRING CODE to frontend
                message: 'Enter this code in WhatsApp: Settings → Linked Devices → Link a Device'
            });
        }
        
        // Keep socket alive while user enters the pairing code (like gifted code does)
        console.log('⏳ Waiting for user to enter pairing code (3 minutes)...');
        await new Promise((resolve) => setTimeout(resolve, 180000));
        
        await sock.end();
        await fs.remove(sessionDir);
        
    } catch (err) {
        console.error('❌ Error:', err.message);
        if (!responseSent) res.status(500).json({ error: err.message });
        if (sock) await sock.end();
        await fs.remove(sessionDir);
    }
});

// Cleanup old sessions
setInterval(async () => {
    try {
        const dir = './temp';
        if (!await fs.pathExists(dir)) return;
        const sessions = await fs.readdir(dir);
        const now = Date.now();
        for (const session of sessions) {
            const path = `${dir}/${session}`;
            const stat = await fs.stat(path);
            if (now - stat.mtimeMs > 30 * 60 * 1000) {
                await fs.remove(path);
                console.log(`🧹 Cleaned old session: ${session}`);
            }
        }
    } catch (e) {}
}, 60000);

export default router;
