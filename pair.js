import express from 'express';
import fs from 'fs';
import pino from 'pino';
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    Browsers,
    fetchLatestBaileysVersion,
    DisconnectReason
} from '@whiskeysockets/baileys';

import pn from 'awesome-phonenumber';
import { uploadSession } from './mega.js';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMP_DIR = path.join(__dirname, 'temp_sessions');
const SESSION_ID_FILE = path.join(__dirname, '.active_session');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

function makeid() {
    return crypto.randomBytes(8).toString('hex');
}

function collectSessionFiles(sessionDir) {
    const sessionData = {};
    const files = fs.readdirSync(sessionDir);

    for (const file of files) {
        const filePath = path.join(sessionDir, file);
        if (fs.statSync(filePath).isFile()) {
            sessionData[file] = fs.readFileSync(filePath).toString('base64');
        }
    }
    return sessionData;
}

function encryptSession(sessionData, sessionId) {
    const keyRaw = process.env.ENCRYPTION_KEY;
    if (!keyRaw) return JSON.stringify(sessionData);

    const key = crypto.createHash('sha256').update(keyRaw + sessionId).digest();
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

    let encrypted = cipher.update(JSON.stringify(sessionData), 'utf8', 'base64');
    encrypted += cipher.final('base64');

    return Buffer.from(JSON.stringify({
        iv: iv.toString('base64'),
        data: encrypted,
        sessionId
    })).toString('base64');
}

// ==================== MAIN ROUTE ====================
router.get('/', async (req, res) => {
    const sessionId = makeid();
    let { number } = req.query;

    console.log(`\n🔷 [${sessionId}] Pairing session started`);

    if (!number) {
        return res.status(400).json({ error: 'Phone number required' });
    }

    number = number.replace(/\D/g, '');
    const phone = pn('+' + number);

    if (!phone.isValid()) {
        return res.status(400).json({ error: 'Invalid number' });
    }

    const formattedNumber = phone.getNumber('e164').replace('+', '');
    const sessionDir = path.join(TEMP_DIR, sessionId);

    fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.windows("Chrome"),
        syncFullHistory: false,
        markOnlineOnConnect: true,
        keepAliveIntervalMs: 30000,
        defaultQueryTimeoutMs: 60000
    });

    sock.ev.on('creds.update', saveCreds);

    let codeSent = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        console.log(`[${sessionId}] State:`, connection || 'waiting');

        // ==================== SEND PAIR CODE ====================
        if (!codeSent && connection === 'connecting') {
            try {
                const code = await sock.requestPairingCode(formattedNumber);
                codeSent = true;

                res.json({
                    success: true,
                    code,
                    sessionId
                });

                console.log(`✅ [${sessionId}] Pairing code: ${code}`);
            } catch (err) {
                console.error(`❌ Pair code error:`, err);
            }
        }

        // ==================== SUCCESS ====================
        if (connection === 'open') {
            console.log(`🎉 [${sessionId}] FULLY CONNECTED`);

            await delay(2000);

            try {
                const sessionFiles = collectSessionFiles(sessionDir);

                const sessionPackage = {
                    id: sessionId,
                    number: formattedNumber,
                    timestamp: Date.now(),
                    files: sessionFiles
                };

                const sessionString = encryptSession(sessionPackage, sessionId);

                fs.writeFileSync(SESSION_ID_FILE, sessionId);

                try {
                    await uploadSession(sessionString, sessionId);
                    console.log(`☁️ Uploaded to Mega`);
                } catch (err) {
                    console.error(`Mega upload failed:`, err.message);
                }

                console.log(`✅ SESSION SAVED`);

            } catch (err) {
                console.error(`❌ Export failed:`, err);
            }
        }

        // ==================== HANDLE CLOSE ====================
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;

            console.log(`🔴 [${sessionId}] Closed:`, reason);

            if (reason !== DisconnectReason.loggedOut) {
                console.log(`🔄 Reconnecting...`);

                setTimeout(() => {
                    router.handle(req, res);
                }, 3000);
            }
        }
    });
});

export default router;
