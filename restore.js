import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { downloadSession } from './mega.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==================== CONSTANTS ====================
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const RESTORE_DIR = path.join(__dirname, 'restored_sessions');

if (!ENCRYPTION_KEY) {
    console.warn('⚠️ ENCRYPTION_KEY not set. Session restore will not work.');
}

// Ensure restore directory exists
if (!fs.existsSync(RESTORE_DIR)) {
    fs.mkdirSync(RESTORE_DIR, { recursive: true });
}

// Logger setup
const logger = pino({
    level: 'debug',
    transport: {
        target: 'pino-pretty',
        options: { colorize: true }
    }
});

// Store active bot instances
const activeBots = new Map();

// ==================== DECRYPTION FUNCTIONS ====================
/**
 * Decrypt session string back to session package
 */
function decryptSessionString(encryptedBase64) {
    console.log(`🔓 [DECRYPT] Starting decryption...`);
    
    try {
        // Parse the encrypted package
        const encryptedPackage = JSON.parse(Buffer.from(encryptedBase64, 'base64').toString());
        
        const { iv, data, sessionId } = encryptedPackage;
        
        if (!iv || !data || !sessionId) {
            throw new Error('Invalid encrypted package format');
        }
        
        // Derive key using same method as encryption
        const key = crypto.createHash('sha256').update(ENCRYPTION_KEY + sessionId).digest();
        
        // Create decipher
        const decipher = crypto.createDecipheriv(
            'aes-256-cbc', 
            key, 
            Buffer.from(iv, 'base64')
        );
        
        // Decrypt
        let decrypted = decipher.update(data, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        
        // Parse the session package
        const sessionPackage = JSON.parse(decrypted);
        
        console.log(`✅ [DECRYPT] Decryption successful`);
        console.log(`   Session ID: ${sessionPackage.id}`);
        console.log(`   User: ${sessionPackage.user}`);
        console.log(`   Files: ${Object.keys(sessionPackage.files || {}).length}`);
        
        return sessionPackage;
    } catch (error) {
        console.error(`❌ [DECRYPT] Decryption failed:`, error);
        throw new Error(`Failed to decrypt session string: ${error.message}`);
    }
}

/**
 * Restore session files from session package
 */
function restoreSessionFiles(sessionPackage, restorePath) {
    console.log(`📁 [RESTORE] Restoring session files to: ${restorePath}`);
    
    const { files, id, user } = sessionPackage;
    
    if (!files || typeof files !== 'object') {
        throw new Error('Invalid session package: no files found');
    }
    
    // Create restore directory
    if (!fs.existsSync(restorePath)) {
        fs.mkdirSync(restorePath, { recursive: true });
    }
    
    // Restore each file
    let restoredCount = 0;
    for (const [filename, fileData] of Object.entries(files)) {
        const filePath = path.join(restorePath, filename);
        
        // Handle both old and new format
        let content;
        if (typeof fileData === 'string') {
            // Base64 string
            content = Buffer.from(fileData, 'base64');
        } else if (fileData.content) {
            // Object with content field
            content = Buffer.from(fileData.content, 'base64');
        } else {
            console.warn(`⚠️ [RESTORE] Unknown format for ${filename}, skipping`);
            continue;
        }
        
        fs.writeFileSync(filePath, content);
        restoredCount++;
        console.log(`  📄 Restored: ${filename}`);
    }
    
    console.log(`✅ [RESTORE] Restored ${restoredCount} files`);
    
    return { id, user, restoredCount };
}

/**
 * ✅ EXPORTED FUNCTION: Restore and start bot
 */
export async function restoreAndStartBot(sessionIdOrUrl) {
    console.log(`\n🔄 [RESTORE] restoreAndStartBot called with: ${sessionIdOrUrl}`);
    
    try {
        let sessionString;
        let source;
        
        // Check if it's a Mega URL
        if (sessionIdOrUrl.startsWith('https://mega.nz/') || sessionIdOrUrl.startsWith('mega://')) {
            console.log(`📥 [RESTORE] Downloading from Mega...`);
            source = 'mega';
            const downloadResult = await downloadSession(sessionIdOrUrl);
            sessionString = downloadResult.data;
        } else {
            // Assume it's a session string
            console.log(`📥 [RESTORE] Using provided session string`);
            source = 'string';
            sessionString = sessionIdOrUrl;
        }
        
        // Decrypt session
        console.log(`🔓 [RESTORE] Decrypting session...`);
        const sessionPackage = decryptSessionString(sessionString);
        
        const sessionId = sessionPackage.id;
        const restorePath = path.join(RESTORE_DIR, sessionId);
        
        // Restore files
        console.log(`📁 [RESTORE] Restoring session files...`);
        restoreSessionFiles(sessionPackage, restorePath);
        
        // Start bot
        console.log(`🤖 [RESTORE] Starting bot...`);
        
        // Load auth state
        const { state, saveCreds } = await useMultiFileAuthState(restorePath);
        
        // Get latest version
        const { version } = await fetchLatestBaileysVersion();
        
        // Create socket
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: logger,
            browser: Browsers.windows("Chrome"),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 30000,
            defaultQueryTimeoutMs: 60000
        });
        
        // Save creds on update
        sock.ev.on('creds.update', saveCreds);
        
        // Store in active bots
        activeBots.set(sessionId, {
            sock,
            startTime: Date.now()
        });
        
        // Handle connection updates
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            
            console.log(`🔔 [BOT:${sessionId}] Connection: ${connection || 'no-change'}`);
            
            if (connection === 'open') {
                console.log(`✅ [BOT:${sessionId}] Bot connected successfully!`);
                console.log(`👤 [BOT:${sessionId}] User: ${sock.user?.id}`);
            }
            
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`🔴 [BOT:${sessionId}] Connection closed:`, { statusCode });
                
                // Auto-reconnect if not logged out
                if (statusCode !== DisconnectReason.loggedOut) {
                    console.log(`🔄 [BOT:${sessionId}] Attempting to reconnect in 5 seconds...`);
                    setTimeout(() => {
                        restoreAndStartBot(sessionIdOrUrl);
                    }, 5000);
                } else {
                    // Logged out - remove from active bots
                    activeBots.delete(sessionId);
                }
            }
        });
        
        console.log(`✅ [RESTORE] Bot started successfully`);
        
        return {
            success: true,
            sock,
            userId: sock.user?.id,
            sessionId
        };
        
    } catch (error) {
        console.error(`❌ [RESTORE] Restore failed:`, error);
        return {
            success: false,
            error: error.message
        };
    }
}

// ==================== RESTORE ENDPOINTS ====================

/**
 * RESTORE FROM MEGA URL
 * POST /restore
 * Body: { megaUrl }
 */
router.post('/', async (req, res) => {
    try {
        const { megaUrl } = req.body;
        
        if (!megaUrl) {
            return res.status(400).json({
                success: false,
                error: 'megaUrl is required'
            });
        }
        
        const result = await restoreAndStartBot(megaUrl);
        
        if (result.success) {
            res.json({
                success: true,
                data: {
                    sessionId: result.sessionId,
                    userId: result.userId,
                    message: 'Session restored and bot started successfully'
                }
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error
            });
        }
        
    } catch (error) {
        console.error('❌ Restore route error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * RESTORE FROM SESSION STRING
 * POST /restore/from-string
 * Body: { sessionString }
 */
router.post('/from-string', async (req, res) => {
    try {
        const { sessionString } = req.body;
        
        if (!sessionString) {
            return res.status(400).json({
                success: false,
                error: 'sessionString is required'
            });
        }
        
        const result = await restoreAndStartBot(sessionString);
        
        if (result.success) {
            res.json({
                success: true,
                data: {
                    sessionId: result.sessionId,
                    userId: result.userId,
                    message: 'Session restored and bot started successfully'
                }
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error
            });
        }
        
    } catch (error) {
        console.error('❌ Restore route error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * CHECK RESTORED BOT STATUS
 * GET /restore/status/:sessionId
 */
router.get('/status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const bot = activeBots.get(sessionId);
    
    if (bot) {
        res.json({
            success: true,
            data: {
                sessionId,
                active: true,
                startTime: bot.startTime,
                uptime: Date.now() - bot.startTime
            }
        });
    } else {
        res.json({
            success: true,
            data: {
                sessionId,
                active: false
            }
        });
    }
});

/**
 * LIST ALL ACTIVE BOTS
 * GET /restore/active
 */
router.get('/active', (req, res) => {
    const bots = Array.from(activeBots.entries()).map(([id, bot]) => ({
        sessionId: id,
        startTime: bot.startTime,
        uptime: Date.now() - bot.startTime
    }));
    
    res.json({
        success: true,
        data: {
            count: bots.length,
            bots
        }
    });
});

/**
 * STOP A BOT
 * POST /restore/stop/:sessionId
 */
router.post('/stop/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const bot = activeBots.get(sessionId);
    
    if (!bot) {
        return res.status(404).json({
            success: false,
            error: 'Bot not found'
        });
    }
    
    try {
        await bot.sock.logout();
        bot.sock.ws?.close();
        activeBots.delete(sessionId);
        
        // Optionally clean up files
        const restorePath = path.join(RESTORE_DIR, sessionId);
        if (fs.existsSync(restorePath)) {
            fs.rmSync(restorePath, { recursive: true, force: true });
        }
        
        res.json({
            success: true,
            message: 'Bot stopped and cleaned up'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

export default router;
