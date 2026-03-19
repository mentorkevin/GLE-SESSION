import express from 'express';
import fs from 'fs';
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    Browsers,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { uploadSession } from './mega.js';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMP_DIR = path.join(__dirname, 'temp_sessions');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const activeSessions = new Map();

// ================= HELPERS =================

function makeid() {
    return crypto.randomBytes(8).toString('hex');
}

function removeFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.rmSync(filePath, { recursive: true, force: true });
        }
    } catch {}
}

function cleanup(sessionId, sock, sessionDir) {
    try { sock?.ws?.close(); } catch {}
    removeFile(sessionDir);
    activeSessions.delete(sessionId);
    console.log(`🧹 [${sessionId}] Cleaned`);
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
    const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
    if (!ENCRYPTION_KEY) return JSON.stringify(sessionData);

    const key = crypto.createHash('sha256')
        .update(ENCRYPTION_KEY + sessionId)
        .digest();

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

// ================= ROUTE =================

router.get('/', async (req, res) => {
    const sessionId = makeid();
    const sessionDir = path.join(TEMP_DIR, sessionId);

    console.log(`🔷 [${sessionId}] QR session started`);

    try {
        fs.mkdirSync(sessionDir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            browser: Browsers.windows("Chrome"),
            printQRInTerminal: false
        });

        sock.ev.on('creds.update', saveCreds);

        activeSessions.set(sessionId, { sock, sessionDir });

        let qrSent = false;
        let loggedIn = false;

        const QR_TIMEOUT = 180000; // 3 minutes

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;

            console.log(`[${sessionId}] State:`, connection || 'waiting');

            // ================= QR =================
            if (qr && !qrSent) {
                qrSent = true;

                try {
                    const qrImage = await QRCode.toDataURL(qr);

                    if (!res.headersSent) {
                        res.json({
                            success: true,
                            qr: qrImage,
                            sessionId,
                            expiresIn: QR_TIMEOUT / 1000
                        });
                    }

                    console.log(`✅ [${sessionId}] QR sent`);
                } catch (err) {
                    console.error(`QR error:`, err);
                }

                // QR timeout cleanup
                setTimeout(() => {
                    if (!loggedIn) {
                        console.log(`⏰ [${sessionId}] QR timeout`);
                        cleanup(sessionId, sock, sessionDir);
                    }
                }, QR_TIMEOUT);
            }

            // ================= LOGIN =================
            if ((connection === 'open' || sock.user) && sock.user && !loggedIn) {
                loggedIn = true;

                console.log(`🎉 [${sessionId}] LOGIN SUCCESS`);
                console.log(`👤 ${sock.user.id}`);

                try {
                    await saveCreds();
                    await delay(4000);

                    const sessionFiles = collectSessionFiles(sessionDir);

                    const sessionPackage = {
                        id: sessionId,
                        user: sock.user.id,
                        timestamp: Date.now(),
                        files: sessionFiles
                    };

                    const sessionString = encryptSession(sessionPackage, sessionId);

                    // SEND SESSION
                    await sock.sendMessage(sock.user.id, {
                        text: `🔐 *SESSION STRING*\n\n\`\`\`\n${sessionString}\n\`\`\``
                    });

                    // SEND CREDS
                    const credsPath = path.join(sessionDir, 'creds.json');
                    if (fs.existsSync(credsPath)) {
                        await sock.sendMessage(sock.user.id, {
                            document: fs.readFileSync(credsPath),
                            mimetype: 'application/json',
                            fileName: 'creds.json'
                        });
                    }

                    // BACKGROUND MEGA
                    (async () => {
                        try {
                            const megaUrl = await uploadSession(sessionString, sessionId);
                            if (megaUrl) {
                                await sock.sendMessage(sock.user.id, {
                                    text: `💾 Mega Backup:\n${megaUrl}`
                                });
                            }
                        } catch (e) {
                            console.log(`Mega upload failed`);
                        }
                    })();

                } catch (err) {
                    console.error(`❌ Session export failed`, err);
                }

                // CLEANUP
                setTimeout(() => {
                    cleanup(sessionId, sock, sessionDir);
                }, 8000);
            }

            // ================= DISCONNECT =================
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;

                console.log(`[${sessionId}] Closed:`, statusCode);

                // Ignore restart (NORMAL)
                if (statusCode === 515) return;

                // Logout / bad session
                if (statusCode === 401 || statusCode === 403) {
                    console.log(`[${sessionId}] Logged out`);
                    cleanup(sessionId, sock, sessionDir);
                }
            }
        });

        // QR generation timeout
        setTimeout(() => {
            if (!qrSent) {
                if (!res.headersSent) {
                    res.status(504).json({
                        success: false,
                        error: 'QR generation timeout'
                    });
                }
                cleanup(sessionId, sock, sessionDir);
            }
        }, 30000);

    } catch (err) {
        console.error(`Fatal:`, err);

        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                error: err.message
            });
        }

        removeFile(sessionDir);
        activeSessions.delete(sessionId);
    }
});

export default router;
