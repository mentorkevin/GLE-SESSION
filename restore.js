import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion, DisconnectReason, jidNormalizedUser } from '@whiskeysockets/baileys';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { downloadSession, uploadSession } from './mega.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==================== CONSTANTS ====================
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const SESSION_DIR = path.join(__dirname, 'active_session');
const SESSION_ID_FILE = path.join(__dirname, '.active_session');

if (!ENCRYPTION_KEY) {
    console.warn('⚠️ ENCRYPTION_KEY not set. Session persistence across restarts will not work.');
}

// Ensure directories exist
if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Logger setup
const logger = pino({
    level: 'debug',
    transport: {
        target: 'pino-pretty',
        options: { colorize: true }
    }
});

// Store active bot instance
let activeBot = null;

// ==================== DECRYPTION FUNCTIONS ====================
/**
 * Decrypt session string back to session package
 */
function decryptSessionString(encryptedBase64, expectedSessionId = null) {
    console.log(`🔓 [DECRYPT] Starting decryption...`);
    
    try {
        // Parse the encrypted package
        const encryptedPackage = JSON.parse(Buffer.from(encryptedBase64, 'base64').toString());
        
        const { iv, data, sessionId } = encryptedPackage;
        
        if (!iv || !data || !sessionId) {
            throw new Error('Invalid encrypted package format');
        }
        
        // Verify session ID if provided
        if (expectedSessionId && sessionId !== expectedSessionId) {
            throw new Error(`Session ID mismatch: expected ${expectedSessionId}, got ${sessionId}`);
        }
        
        // Derive key using same method as encryption
        const key = crypto.createHmac('sha256', Buffer.from(ENCRYPTION_KEY, 'hex'))
            .update(sessionId)
            .digest();
        
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
function restoreSessionFiles(sessionPackage) {
    console.log(`📁 [RESTORE] Restoring session files to: ${SESSION_DIR}`);
    
    const { files, id } = sessionPackage;
    
    if (!files || typeof files !== 'object') {
        throw new Error('Invalid session package: no files found');
    }
    
    // Clear existing session files
    if (fs.existsSync(SESSION_DIR)) {
        const existingFiles = fs.readdirSync(SESSION_DIR);
        for (const file of existingFiles) {
            fs.unlinkSync(path.join(SESSION_DIR, file));
        }
    }
    
    // Restore each file
    let restoredCount = 0;
    for (const [filename, fileData] of Object.entries(files)) {
        const filePath = path.join(SESSION_DIR, filename);
        
        // Handle both old and new format
        let content;
        if (typeof fileData === 'string') {
            // Old format: direct base64 string
            content = Buffer.from(fileData, 'base64');
        } else if (fileData.content) {
            // New format: object with content field
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
    
    // Save session ID
    fs.writeFileSync(SESSION_ID_FILE, id);
    
    return restoredCount;
}

/**
 * Start bot with restored session
 */
async function startBotWithRestoredSession() {
    console.log(`\n🤖 [BOT] Starting bot with restored session...`);
    
    try {
        // Check if session files exist
        if (!fs.existsSync(SESSION_DIR) || fs.readdirSync(SESSION_DIR).length === 0) {
            throw new Error('No session files found');
        }
        
        // Load auth state
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
        
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
        
        // Handle connection updates
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            
            console.log(`🔔 [BOT] Connection: ${connection || 'no-change'}`);
            
            if (connection === 'open') {
                console.log(`✅ [BOT] Bot connected successfully!`);
                console.log(`👤 [BOT] User: ${sock.user?.id}`);
            }
            
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`🔴 [BOT] Connection closed:`, { statusCode });
                
                // Auto-reconnect if not logged out
                if (statusCode !== DisconnectReason.loggedOut) {
                    console.log(`🔄 [BOT] Attempting to reconnect in 5 seconds...`);
                    setTimeout(() => startBotWithRestoredSession(), 5000);
                }
            }
        });
        
        activeBot = sock;
        console.log(`✅ [BOT] Bot started successfully`);
        
        return {
            success: true,
            sock,
            userId: sock.user?.id
        };
        
    } catch (error) {
        console.error(`❌ [BOT] Failed to start bot:`, error);
        return {
            success: false,
            error: error.message
        };
    }
}

// ==================== EXPORTED FUNCTIONS ====================
/**
 * Restore session from Mega URL or session string and start bot
 */
export async function restoreAndStartBot(sessionIdOrUrl) {
    console.log(`\n🔄 [RESTORE] Attempting to restore session: ${sessionIdOrUrl}`);
    
    try {
        let sessionString;
        
        // Check if it's a Mega URL
        if (sessionIdOrUrl.startsWith('https://mega.nz/')) {
            console.log(`📥 [RESTORE] Downloading from Mega...`);
            const downloadResult = await downloadSession(sessionIdOrUrl);
            sessionString = downloadResult.data;
        } else {
            // Assume it's a session string
            sessionString = sessionIdOrUrl;
        }
        
        // Decrypt session
        const sessionPackage = decryptSessionString(sessionString);
        
        // Restore files
        restoreSessionFiles(sessionPackage);
        
        // Start bot
        const botResult = await startBotWithRestoredSession();
        
        return botResult;
        
    } catch (error) {
        console.error(`❌ [RESTORE] Restore failed:`, error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Get active bot instance
 */
export function getActiveBot() {
    return activeBot;
}

/**
 * Check if session exists
 */
export function hasActiveSession() {
    return fs.existsSync(SESSION_ID_FILE) && fs.existsSync(SESSION_DIR) && fs.readdirSync(SESSION_DIR).length > 0;
}

/**
 * Get active session ID
 */
export function getActiveSessionId() {
    if (fs.existsSync(SESSION_ID_FILE)) {
        return fs.readFileSync(SESSION_ID_FILE, 'utf8').trim();
    }
    return null;
}

// ==================== EXPRESS ROUTES ====================

/**
 * RESTORE ENDPOINT - Accept session string or Mega URL
 * POST /restore
 * Body: { sessionString } or { megaUrl }
 */
router.post('/', async (req, res) => {
    try {
        const { sessionString, megaUrl } = req.body;
        
        if (!sessionString && !megaUrl) {
            return res.status(400).json({
                success: false,
                error: 'Either sessionString or megaUrl is required'
            });
        }
        
        const identifier = sessionString || megaUrl;
        const result = await restoreAndStartBot(identifier);
        
        res.json({
            success: result.success,
            data: result.success ? {
                userId: result.userId,
                message: 'Session restored and bot started successfully'
            } : {
                error: result.error
            }
        });
        
    } catch (error) {
        console.error('❌ Restore route error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * CHECK SESSION STATUS
 * GET /restore/status
 */
router.get('/status', (req, res) => {
    const hasSession = hasActiveSession();
    const sessionId = getActiveSessionId();
    const botActive = activeBot !== null;
    
    res.json({
        success: true,
        data: {
            hasActiveSession: hasSession,
            sessionId: sessionId,
            botActive: botActive,
            sessionDir: SESSION_DIR,
            files: hasSession ? fs.readdirSync(SESSION_DIR) : []
        }
    });
});

/**
 * FORCE RESTART BOT
 * POST /restore/restart
 */
router.post('/restart', async (req, res) => {
    try {
        if (!hasActiveSession()) {
            return res.status(400).json({
                success: false,
                error: 'No active session to restart'
            });
        }
        
        const sessionId = getActiveSessionId();
        const result = await restoreAndStartBot(sessionId);
        
        res.json({
            success: result.success,
            data: result.success ? {
                userId: result.userId,
                message: 'Bot restarted successfully'
            } : {
                error: result.error
            }
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * LOGOUT AND CLEAR SESSION
 * POST /restore/logout
 */
router.post('/logout', async (req, res) => {
    try {
        if (activeBot) {
            await activeBot.logout();
            activeBot.ws.close();
            activeBot = null;
        }
        
        // Clear session files
        if (fs.existsSync(SESSION_DIR)) {
            const files = fs.readdirSync(SESSION_DIR);
            for (const file of files) {
                fs.unlinkSync(path.join(SESSION_DIR, file));
            }
        }
        
        if (fs.existsSync(SESSION_ID_FILE)) {
            fs.unlinkSync(SESSION_ID_FILE);
        }
        
        res.json({
            success: true,
            message: 'Logged out and session cleared'
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

export default router;