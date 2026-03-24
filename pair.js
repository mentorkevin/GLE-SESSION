import express from 'express';
import fs from 'fs-extra';
import pino from 'pino';
import pn from 'awesome-phonenumber';
import crypto from 'crypto';
import zlib from 'zlib';
import {
    makeWASocket, useMultiFileAuthState, delay,
    makeCacheableSignalKeyStore, Browsers, jidNormalizedUser,
    fetchLatestBaileysVersion, DisconnectReason
} from '@whiskeysockets/baileys';
import { uploadSession as megaUpload } from './mega.js';

const router = express.Router();

const SESSION_PREFIX = 'GleBot!';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ENCRYPTION_KEY_HASH = ENCRYPTION_KEY ? crypto.createHash('sha256').update(ENCRYPTION_KEY).digest() : null;

const CHANNEL_LINK = "https://whatsapp.com/channel/0029VbBTYeRJP215nxFl4I0x";
const MESSAGE = `⚠️ *DO NOT SHARE THIS SESSION WITH ANYONE* ⚠️

┌┤✑  Thanks for using GleBot
│└────────────┈ ⳹        
│ ©2026 GleBot Inc. All rights reserved.
└─────────────────┈ ⳹

📢 Join our channel: ${CHANNEL_LINK}`;

function encryptSession(credsBase64, sessionId) {
    if (!ENCRYPTION_KEY_HASH) throw new Error('ENCRYPTION_KEY not configured');
    
    const compressed = zlib.deflateSync(credsBase64);
    const compressedBase64 = compressed.toString('base64');
    
    const dataToEncrypt = JSON.stringify({ sessionId, creds: compressedBase64 });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY_HASH, iv);
    
    let encrypted = cipher.update(dataToEncrypt, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');
    
    return `${SESSION_PREFIX}${iv.toString('base64')}:${encrypted}:${authTag}`;
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    if (!num) return res.status(400).json({ error: 'Phone number required' });

    // Clean number - keep only digits
    num = num.replace(/\D/g, '');
    
    // Validate with awesome-phonenumber
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
    
    let sock = null;
    let responseSent = false;
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        // CRITICAL: Use EXACT browser string that works
        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" }))
            },
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }).child({ level: "fatal" }),
            browser: ["Chrome (Linux)", "", ""],  // THIS IS THE KEY
            markOnlineOnConnect: false
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;
            
            if (connection === 'open') {
                console.log(`✅ Connected for ${whatsappNumber}`);
                try {
                    const credsFile = `${sessionDir}/creds.json`;
                    if (fs.existsSync(credsFile)) {
                        const credsBase64 = (await fs.readFile(credsFile)).toString('base64');
                        const sessionString = encryptSession(credsBase64, sessionId);
                        const userJid = jidNormalizedUser(whatsappNumber + '@s.whatsapp.net');
                        
                        await sock.sendMessage(userJid, { text: sessionString });
                        console.log(`📤 Session sent`);
                        
                        // Mega backup (optional)
                        try {
                            const megaLink = await megaUpload(sessionString, sessionId);
                            if (megaLink && !megaLink.startsWith('local://')) {
                                await sock.sendMessage(userJid, { text: `💾 Backup: ${megaLink}` });
                            }
                        } catch (e) {}
                        
                        await sock.sendMessage(userJid, { text: MESSAGE });
                        await delay(2000);
                        await sock.end();
                        await fs.remove(sessionDir);
                    }
                } catch (err) {
                    console.error('Error:', err);
                }
            }
        });
        
        // Request pairing code
        console.log(`🔑 Requesting pairing code for ${whatsappNumber}...`);
        let code = await sock.requestPairingCode(whatsappNumber);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        
        console.log(`✅ Pairing code: ${code}`);
        
        if (!responseSent) {
            responseSent = true;
            res.json({ success: true, code: code });
        }
        
        // Cleanup after 3 minutes
        setTimeout(async () => {
            try {
                if (sock) await sock.end();
                await fs.remove(sessionDir);
            } catch (e) {}
        }, 180000);
        
    } catch (err) {
        console.error('Error:', err);
        if (!responseSent) res.status(500).json({ error: err.message });
        if (sock) await sock.end();
        await fs.remove(sessionDir);
    }
});

export default router;
