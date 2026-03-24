import express from 'express';
import fs from 'fs-extra';
import pino from 'pino';
import pn from 'awesome-phonenumber';
import crypto from 'crypto';
import zlib from 'zlib';
import {
    makeWASocket, useMultiFileAuthState, delay,
    makeCacheableSignalKeyStore, jidNormalizedUser,
    fetchLatestBaileysVersion, Browsers
} from '@whiskeysockets/baileys';

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

function encryptSession(credsBase64) {
    const compressed = zlib.deflateSync(credsBase64);
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

    // Clean number
    num = num.replace(/\D/g, '');
    
    // Validate
    const phone = pn('+' + num);
    if (!phone.isValid()) {
        if (num.length === 10 && !num.startsWith('1')) num = '1' + num;
        else if (num.length === 9 && num.startsWith('7')) num = '254' + num;
        else if (num.length === 10 && num.startsWith('7')) num = '254' + num;
        else return res.status(400).json({ error: 'Invalid phone number' });
    }
    
    const whatsappNumber = pn('+' + num).getNumber('e164').replace('+', '');
    console.log(`📱 Pairing for: +${whatsappNumber}`);
    
    const sessionDir = `./temp/${Date.now()}`;
    await fs.ensureDir(sessionDir);
    
    let responseSent = false;
    let sock = null;
    
    try {
        // Setup auth state
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        // Create socket
        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: Browsers.ubuntu("Chrome"),
            markOnlineOnConnect: false
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        // Handle connection when user enters code
        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;
            console.log(`📡 Connection: ${connection}`);
            
            if (connection === 'open') {
                console.log('✅ User connected!');
                try {
                    const credsBase64 = (await fs.readFile(`${sessionDir}/creds.json`)).toString('base64');
                    const sessionString = encryptSession(credsBase64);
                    const userJid = jidNormalizedUser(whatsappNumber + '@s.whatsapp.net');
                    
                    await sock.sendMessage(userJid, { text: sessionString });
                    console.log('📤 Session sent');
                    await sock.sendMessage(userJid, { text: MESSAGE });
                    
                    await delay(2000);
                    await sock.end();
                    await fs.remove(sessionDir);
                } catch (err) {
                    console.error('Error:', err);
                }
            }
        });
        
        // WAIT FOR SOCKET TO BE READY BEFORE REQUESTING PAIRING CODE
        console.log('⏳ Waiting for socket to connect...');
        
        // Wait for the socket to be connected to WhatsApp servers
        let isConnected = false;
        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log('⚠️ Socket connection timeout, proceeding anyway');
                resolve();
            }, 10000);
            
            sock.ev.on('connection.update', (update) => {
                if (update.connection === 'connecting') {
                    console.log('✅ Socket connected to WhatsApp, ready for pairing');
                    isConnected = true;
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });
        
        // NOW request the REAL pairing code from WhatsApp
        console.log(`🔑 Requesting REAL pairing code from WhatsApp for ${whatsappNumber}...`);
        let code = await sock.requestPairingCode(whatsappNumber);
        
        // Format the code for display (WhatsApp sends a numeric code)
        const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
        
        console.log(`✅ REAL pairing code from WhatsApp: ${formattedCode}`);
        
        if (!responseSent) {
            responseSent = true;
            res.json({ 
                success: true, 
                code: formattedCode,
                rawCode: code,
                message: 'Enter this code in WhatsApp: Settings → Linked Devices → Link a Device'
            });
        }
        
        // Cleanup after 2 minutes
        setTimeout(async () => {
            try {
                if (sock) await sock.end();
                await fs.remove(sessionDir);
            } catch (e) {}
        }, 120000);
        
    } catch (err) {
        console.error('❌ Error:', err);
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
            if (now - stat.mtimeMs > 10 * 60 * 1000) {
                await fs.remove(path);
            }
        }
    } catch (e) {}
}, 60000);

export default router;
