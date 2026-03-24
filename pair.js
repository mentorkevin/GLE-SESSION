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

function generatePairingCode() {
    return Math.floor(10000000 + Math.random() * 90000000).toString();
}

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

    num = num.replace(/\D/g, '');
    console.log(`📱 Number: ${num}`);
    
    const sessionId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    const sessionDir = `./temp/${sessionId}`;
    await fs.ensureDir(sessionDir);
    
    let responseSent = false;
    let sock = null;
    let connectionEstablished = false;
    let pairingCodeSent = false;
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }).child({ level: "fatal" }),
            browser: ["Chrome (Linux)", "", ""],
            markOnlineOnConnect: false,
            syncFullHistory: false
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
                        console.log('📤 Session sent');
                        
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
                        console.log('✅ Complete');
                    }
                } catch (err) {
                    console.error('Error:', err);
                }
            }
        });
        
        // STEP 1: Wait for WhatsApp connection to be established
        console.log('⏳ Waiting for WhatsApp connection...');
        await new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(), 15000);
            const handler = (update) => {
                if (update.connection === 'connecting') {
                    console.log('✅ WhatsApp connection established');
                    clearTimeout(timeout);
                    sock.ev.off('connection.update', handler);
                    resolve();
                }
            };
            sock.ev.on('connection.update', handler);
        });
        
        // STEP 2: Generate the pairing code
        const pairingCode = generatePairingCode();
        console.log(`🔑 Generated code: ${pairingCode}`);
        
        // STEP 3: Request WhatsApp to send the code to the user's phone
        console.log(`📱 Requesting WhatsApp to send code to ${num}...`);
        await sock.requestPairingCode(num, pairingCode);
        
        // STEP 4: NOW WhatsApp has sent the notification, so we can reveal the code
        console.log(`✅ WhatsApp has sent "${pairingCode}" to the user's phone`);
        
        const formattedCode = pairingCode.match(/.{1,4}/g)?.join('-') || pairingCode;
        
        if (!responseSent) {
            responseSent = true;
            res.json({ 
                success: true, 
                code: formattedCode,
                message: 'Check your WhatsApp - you will receive a notification with this code'
            });
        }
        
        // STEP 5: Wait for user to enter the code (3 minutes)
        console.log('⏳ Waiting for user to enter code...');
        await new Promise((resolve) => setTimeout(resolve, 180000));
        
        if (!connectionEstablished) {
            console.log('⏰ No connection - cleaning up');
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
