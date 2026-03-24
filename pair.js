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

// Generate PAIRING CODE (8-digit number)
function generatePairingCode() {
    return Math.floor(10000000 + Math.random() * 90000000).toString();
}

// Create SESSION STRING
function createSessionString(credsData) {
    const compressed = zlib.gzipSync(credsData);
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
    if (!num) return res.status(400).json({ error: 'Phone number required' });

    // ONLY remove non-digits - NO country code conversion
    num = num.replace(/\D/g, '');
    
    console.log(`📱 Raw number for pairing: ${num}`);
    
    const sessionId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    const sessionDir = `./temp/${sessionId}`;
    await fs.ensureDir(sessionDir);
    
    let responseSent = false;
    let sock = null;
    let connectionEstablished = false;
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        // Use EXACT same browser as gifted code
        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }).child({ level: "fatal" }),
            browser: ["Chrome (Linux)", "", ""],
            markOnlineOnConnect: false,
            syncFullHistory: false,
            generateHighQualityLinkPreview: false
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        // Handle when user enters the PAIRING CODE and connects
        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;
            console.log(`📡 Connection: ${connection || 'connecting'}`);
            
            if (connection === 'open' && !connectionEstablished) {
                connectionEstablished = true;
                console.log('✅ User entered pairing code and connected!');
                
                try {
                    await delay(3000);
                    
                    const credsPath = `${sessionDir}/creds.json`;
                    if (await fs.pathExists(credsPath)) {
                        const credsData = await fs.readFile(credsPath);
                        const sessionString = createSessionString(credsData);
                        const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                        
                        await sock.sendMessage(userJid, { text: sessionString });
                        console.log('📤 Session sent to user');
                        
                        try {
                            const megaLink = await megaUpload(sessionString, sessionId);
                            if (megaLink && !megaLink.startsWith('local://')) {
                                await sock.sendMessage(userJid, { text: `💾 Mega Backup: ${megaLink}` });
                            }
                        } catch (e) {}
                        
                        await sock.sendMessage(userJid, { text: MESSAGE });
                        await delay(2000);
                        await sock.end();
                        await fs.remove(sessionDir);
                        console.log('✅ Session complete');
                    }
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
        
        // Generate PAIRING CODE
        const pairingCode = generatePairingCode();
        console.log(`🔑 PAIRING CODE: ${pairingCode}`);
        
        // Send to WhatsApp with the RAW number (no conversion)
        await sock.requestPairingCode(num, pairingCode);
        
        console.log(`✅ WhatsApp will send "${pairingCode}" to number starting with ${num.substring(0, 5)}...`);
        
        const formattedCode = pairingCode.match(/.{1,4}/g)?.join('-') || pairingCode;
        
        if (!responseSent) {
            responseSent = true;
            res.json({ 
                success: true, 
                code: formattedCode,
                message: 'Enter this code in WhatsApp: Settings → Linked Devices → Link a Device'
            });
        }
        
        // Wait 3 minutes for user to enter code
        await new Promise((resolve) => setTimeout(resolve, 180000));
        
        if (!connectionEstablished) {
            await sock.end();
            await fs.remove(sessionDir);
        }
        
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
            }
        }
    } catch (e) {}
}, 60000);

export default router;
