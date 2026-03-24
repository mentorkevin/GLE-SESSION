import express from 'express';
import fs from 'fs-extra';
import pino from 'pino';
import pn from 'awesome-phonenumber';
import crypto from 'crypto';
import zlib from 'zlib';
import {
    makeWASocket, useMultiFileAuthState, delay,
    makeCacheableSignalKeyStore, jidNormalizedUser,
    fetchLatestBaileysVersion, DisconnectReason
} from '@whiskeysockets/bailejs';

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
    let socketReady = false;
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        // CRITICAL: Use EXACT browser string that works for pairing
        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" }))
            },
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }).child({ level: "fatal" }),
            browser: ["Chrome (Linux)", "", ""],  // THIS IS THE KEY - NOT Browsers.macOS
            markOnlineOnConnect: false
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        // Listen for socket ready
        sock.ev.on('connection.update', (update) => {
            console.log(`🔔 Connection: ${update.connection || 'connecting'}`);
            if (update.connection === 'connecting') {
                socketReady = true;
                console.log('✅ Socket ready for pairing');
            }
        });
        
        // Handle successful connection after user enters code
        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                console.log('✅ User connected! Sending session...');
                try {
                    const credsFile = `${sessionDir}/creds.json`;
                    if (await fs.pathExists(credsFile)) {
                        const credsBase64 = (await fs.readFile(credsFile)).toString('base64');
                        const sessionString = encryptSession(credsBase64);
                        const userJid = jidNormalizedUser(whatsappNumber + '@s.whatsapp.net');
                        
                        await sock.sendMessage(userJid, { text: sessionString });
                        console.log('📤 Session sent');
                        
                        await sock.sendMessage(userJid, { text: MESSAGE });
                        console.log('📢 Warning sent');
                        
                        await delay(2000);
                        await sock.end();
                        await fs.remove(sessionDir);
                    }
                } catch (err) {
                    console.error('Error sending session:', err);
                }
            }
        });
        
        // Wait for socket to be ready (max 10 seconds)
        console.log('⏳ Waiting for socket to be ready...');
        let attempts = 0;
        while (!socketReady && attempts < 20) {
            await delay(500);
            attempts++;
        }
        
        if (!socketReady) {
            console.error('❌ Socket never became ready');
            if (!responseSent) {
                responseSent = true;
                return res.status(500).json({ error: 'Connection failed' });
            }
        }
        
        // Request pairing code
        console.log(`🔑 Requesting pairing code for ${whatsappNumber}...`);
        let code = await sock.requestPairingCode(whatsappNumber);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        
        console.log(`✅ Pairing code: ${code}`);
        
        if (!responseSent) {
            responseSent = true;
            res.json({ success: true, code: code });
        }
        
        // Cleanup after timeout
        setTimeout(async () => {
            try {
                if (sock) await sock.end();
                await fs.remove(sessionDir);
            } catch (e) {}
        }, 120000);
        
    } catch (err) {
        console.error('❌ Error:', err);
        if (!responseSent) {
            res.status(500).json({ error: err.message });
        }
        if (sock) await sock.end();
        await fs.remove(sessionDir);
    }
});

// Cleanup old sessions
setInterval(async () => {
    try {
        const baseDir = './temp';
        if (!await fs.pathExists(baseDir)) return;
        const sessions = await fs.readdir(baseDir);
        const now = Date.now();
        for (const session of sessions) {
            const sessionPath = `${baseDir}/${session}`;
            const stats = await fs.stat(sessionPath);
            if (now - stats.mtimeMs > 10 * 60 * 1000) {
                await fs.remove(sessionPath);
                console.log(`🧹 Cleaned old session: ${session}`);
            }
        }
    } catch (e) {}
}, 60000);

export default router;
