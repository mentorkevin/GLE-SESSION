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

const router = express.Router();
const SESSION_PREFIX = 'GleBot!';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ENCRYPTION_KEY_HASH = ENCRYPTION_KEY ? crypto.createHash('sha256').update(ENCRYPTION_KEY).digest() : null;

async function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        await fs.remove(FilePath);
        return true;
    } catch (e) { return false; }
}

function encryptSession(credsBase64) {
    if (!ENCRYPTION_KEY_HASH) throw new Error('ENCRYPTION_KEY not configured');
    
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
    if (!num) return res.status(400).send({ error: 'Phone number required' });

    num = num.replace(/[^0-9]/g, '');
    const phone = pn('+' + num);
    if (!phone.isValid()) {
        if (num.length === 10 && !num.startsWith('1')) num = '1' + num;
        else if (num.length === 9 && num.startsWith('7')) num = '254' + num;
        else if (num.length === 10 && num.startsWith('7')) num = '254' + num;
        else return res.status(400).send({ error: 'Invalid phone number' });
    }
    num = pn('+' + num).getNumber('e164').replace('+', '');

    const sessionId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    const dirs = `./temp/session_${sessionId}`;

    let responseSent = false, currentSocket = null;

    async function cleanup() {
        if (currentSocket) {
            try { currentSocket.ev.removeAllListeners(); await currentSocket.end(); } catch (e) {}
        }
        setTimeout(async () => { await removeFile(dirs); }, 5000);
    }

    try {
        await fs.ensureDir(dirs);
        const { state, saveCreds } = await useMultiFileAuthState(dirs);
        const { version } = await fetchLatestBaileysVersion();

        currentSocket = makeWASocket({
            version,
            auth: { 
                creds: state.creds, 
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })) 
            },
            printQRInTerminal: false, 
            logger: pino({ level: "silent" }),
            browser: Browsers.macOS('Chrome')
        });

        currentSocket.ev.on('creds.update', saveCreds);
        
        currentSocket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            
            if (connection === 'open') {
                try {
                    const credsFile = `${dirs}/creds.json`;
                    if (fs.existsSync(credsFile)) {
                        const credsBase64 = (await fs.readFile(credsFile)).toString('base64');
                        const sessionString = encryptSession(credsBase64);
                        const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                        
                        await currentSocket.sendMessage(userJid, { text: sessionString });
                        console.log(`✅ Session sent to ${num}`);
                        await delay(2000);
                        await cleanup();
                    }
                } catch (err) { 
                    console.error('Error:', err); 
                    await cleanup();
                }
            }
        });

        // Request pairing code
        await delay(1500);
        let code = await currentSocket.requestPairingCode(num);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        
        if (!responseSent) {
            responseSent = true;
            res.send({ success: true, code: code });
        }

        // Timeout cleanup
        setTimeout(async () => {
            await cleanup();
        }, 300000);

    } catch (err) {
        console.error('Error:', err);
        if (!responseSent) res.status(500).send({ error: 'Service error' });
        await cleanup();
    }
});

export default router;
