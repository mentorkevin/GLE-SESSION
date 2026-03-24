import express from 'express';
import fs from 'fs';
import pino from 'pino';
import pn from 'awesome-phonenumber';
import crypto from 'crypto';
import zlib from 'zlib';
import {
    makeWASocket, useMultiFileAuthState, delay,
    makeCacheableSignalKeyStore, jidNormalizedUser,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

const router = express.Router();
const SESSION_PREFIX = 'GleBot!';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!ENCRYPTION_KEY) {
    console.error('❌ ENCRYPTION_KEY required in .env');
    process.exit(1);
}

const ENCRYPTION_KEY_HASH = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();

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
    if (!num) {
        return res.status(400).json({ error: 'Phone number required' });
    }

    // Clean phone number - keep only digits
    num = num.replace(/\D/g, '');
    
    // Validate with awesome-phonenumber
    const phone = pn('+' + num);
    if (!phone.isValid()) {
        return res.status(400).json({ error: 'Invalid phone number' });
    }
    
    const whatsappNumber = phone.getNumber('e164').replace('+', '');
    console.log(`📱 Pairing for: +${whatsappNumber}`);
    
    const sessionId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    const sessionDir = `./temp/${sessionId}`;
    
    // Create session directory
    fs.mkdirSync(sessionDir, { recursive: true });
    
    let responseSent = false;
    let sock = null;
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        // Create socket with EXACT browser string that works
        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" }))
            },
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }).child({ level: "fatal" }),
            browser: ["Chrome (Linux)", "", ""],
            markOnlineOnConnect: false
        });
        
        // Handle credentials update
        sock.ev.on('creds.update', saveCreds);
        
        // Wait for socket to be ready before requesting pairing code
        let socketReady = false;
        
        sock.ev.on('connection.update', (update) => {
            console.log(`🔔 Connection update: ${update.connection || 'connecting'}`);
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
                    if (fs.existsSync(credsFile)) {
                        const credsBase64 = fs.readFileSync(credsFile).toString('base64');
                        const sessionString = encryptSession(credsBase64);
                        const userJid = jidNormalizedUser(whatsappNumber + '@s.whatsapp.net');
                        
                        await sock.sendMessage(userJid, { text: sessionString });
                        console.log('📤 Session sent to user');
                        
                        await delay(2000);
                        await sock.end();
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                        console.log('🧹 Cleaned up session');
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
                return res.status(500).json({ error: 'Connection failed. Please try again.' });
            }
        }
        
        // Request pairing code NOW that socket is ready
        console.log(`🔑 Requesting pairing code for ${whatsappNumber}...`);
        let code = await sock.requestPairingCode(whatsappNumber);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        
        console.log(`✅ Pairing code: ${code}`);
        
        if (!responseSent) {
            responseSent = true;
            res.json({ success: true, code: code });
        }
        
        // Cleanup after 2 minutes if no connection
        setTimeout(() => {
            if (sock) {
                try {
                    sock.end();
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                    console.log('🧹 Cleaned up after timeout');
                } catch (e) {}
            }
        }, 120000);
        
    } catch (err) {
        console.error('❌ Error:', err);
        if (!responseSent) {
            res.status(500).json({ error: err.message });
        }
        if (sock) {
            try {
                sock.end();
                fs.rmSync(sessionDir, { recursive: true, force: true });
            } catch (e) {}
        }
    }
});

export default router;
