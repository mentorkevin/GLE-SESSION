import express from 'express';
import fs from 'fs';
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

if (!ENCRYPTION_KEY) {
    console.error('❌ ENCRYPTION_KEY required');
    process.exit(1);
}

const ENCRYPTION_KEY_HASH = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();

function encryptSession(credsBase64, sessionId) {
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

    num = num.replace(/\D/g, '');
    const phone = pn('+' + num);
    if (!phone.isValid()) {
        if (num.length === 10 && !num.startsWith('1')) num = '1' + num;
        else if (num.length === 9 && num.startsWith('7')) num = '254' + num;
        else if (num.length === 10 && num.startsWith('7')) num = '254' + num;
        else return res.status(400).json({ error: 'Invalid phone number' });
    }
    
    const whatsappNumber = pn('+' + num).getNumber('e164').replace('+', '');
    const sessionId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    const sessionDir = `./temp/${sessionId}`;
    
    fs.mkdirSync(sessionDir, { recursive: true });
    
    let responseSent = false;
    let sock = null;
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" }))
            },
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }).child({ level: "fatal" }),
            browser: Browsers.macOS("Safari"),
            markOnlineOnConnect: false
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    const credsFile = `${sessionDir}/creds.json`;
                    if (fs.existsSync(credsFile)) {
                        const credsBase64 = fs.readFileSync(credsFile).toString('base64');
                        const sessionString = encryptSession(credsBase64, sessionId);
                        const userJid = jidNormalizedUser(whatsappNumber + '@s.whatsapp.net');
                        await sock.sendMessage(userJid, { text: sessionString });
                        try {
                            const megaLink = await megaUpload(sessionString, sessionId);
                            if (megaLink && !megaLink.startsWith('local://')) {
                                await sock.sendMessage(userJid, { text: `Mega: ${megaLink}` });
                            }
                        } catch (e) {}
                        await delay(2000);
                        await sock.end();
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    }
                } catch (err) {
                    console.error('Error:', err);
                }
            }
        });
        
        await delay(1500);
        let code = await sock.requestPairingCode(whatsappNumber);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        
        if (!responseSent) {
            responseSent = true;
            res.json({ success: true, code: code });
        }
        
        setTimeout(() => {
            if (sock) sock.end();
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }, 120000);
        
    } catch (err) {
        console.error('Error:', err);
        if (!responseSent) res.status(500).json({ error: err.message });
        if (sock) sock.end();
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

export default router;
