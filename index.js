import express from 'express';
import bodyParser from 'body-parser';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs';
import { restoreAndStartBot } from './restore.js';
import { testConnection } from './mega.js';
import { DisconnectReason } from '@whiskeysockets/baileys';

// Load environment variables
dotenv.config();

// Import routers
import pairRouter from './pair.js';
import qrRouter from './qr.js';
import restoreRouter from './restore.js';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8000;
const SESSION_ID_FILE = path.join(__dirname, '.active_session');

// Increase event listeners for WebSocket
import('events').then(events => {
    events.EventEmitter.defaultMaxListeners = 500;
});

// ==================== AUTO-RESTORE ON STARTUP ====================
let activeBot = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 20;

async function initializeBot() {
    console.log('\n🚀 [INIT] Starting GLE Bot initialization...');
    
    try {
        // Check if we have a saved session ID
        let activeSessionId = null;
        if (fs.existsSync(SESSION_ID_FILE)) {
            activeSessionId = fs.readFileSync(SESSION_ID_FILE, 'utf8').trim();
            console.log(`🔍 [INIT] Found saved session ID: ${activeSessionId}`);
        } else {
            console.log(`🔍 [INIT] No saved session found - will start fresh`);
            return false;
        }
        
        // Test Mega connection (optional, doesn't block)
        console.log(`🔍 [INIT] Testing Mega connection...`);
        try {
            const megaStatus = await testConnection();
            if (!megaStatus.success) {
                console.warn(`⚠️ [INIT] Mega connection failed: ${megaStatus.error}`);
                console.log(`   Bot will still work but session persistence across restarts may fail`);
            } else {
                console.log(`✅ [INIT] Mega connection successful`);
            }
        } catch (megaError) {
            console.warn(`⚠️ [INIT] Mega test error: ${megaError.message}`);
        }
        
        // Try to restore session if we have an ID
        if (activeSessionId) {
            console.log(`🔄 [INIT] Attempting to restore session: ${activeSessionId}`);
            const restored = await restoreAndStartBot(activeSessionId);
            
            if (restored.success) {
                console.log(`✅ [INIT] Session restored successfully!`);
                console.log(`👤 [INIT] User: ${restored.userId}`);
                
                // Store active bot reference
                activeBot = restored.sock;
                reconnectAttempts = 0;
                
                // Set up reconnection handlers on the restored bot
                if (activeBot) {
                    setupReconnectionHandlers(activeBot, activeSessionId);
                }
                
                return true;
            } else {
                console.log(`⚠️ [INIT] Failed to restore session: ${restored.error}`);
                console.log(`   Will start fresh and wait for new login`);
                
                // Clear invalid session ID
                if (fs.existsSync(SESSION_ID_FILE)) {
                    fs.unlinkSync(SESSION_ID_FILE);
                }
                activeSessionId = null;
            }
        } else {
            console.log(`🔄 [INIT] No session to restore - waiting for new login`);
        }
        
        return false;
    } catch (error) {
        console.error(`❌ [INIT] Initialization error:`, error);
        return false;
    }
}

/**
 * Setup reconnection handlers for persistent connection
 */
function setupReconnectionHandlers(sock, sessionId) {
    if (!sock) return;
    
    // Remove existing handlers to avoid duplicates
    sock.ev.removeAllListeners('connection.update');
    
    // Add new connection handler
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'open') {
            console.log(`✅ [BOT] Connection open - bot is active`);
            console.log(`👤 [BOT] User: ${sock.user?.id || 'unknown'}`);
            reconnectAttempts = 0; // Reset reconnect attempts on successful connection
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMessage = lastDisconnect?.error?.message || 'Unknown error';
            
            // Check if we should reconnect
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut 
                && statusCode !== 401 // Unauthorized
                && reconnectAttempts < MAX_RECONNECT_ATTEMPTS;
            
            console.log(`🔴 [BOT] Connection closed. Code: ${statusCode}, Error: ${errorMessage}`);
            console.log(`   Should reconnect: ${shouldReconnect}, Attempt: ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS}`);
            
            // Handle specific error cases
            if (statusCode === 408) {
                console.log(`   ⚠️ 408 Timeout - This is usually temporary, will retry`);
            } else if (statusCode === 429) {
                console.log(`   ⚠️ 429 Rate limited - Waiting longer before retry`);
            } else if (errorMessage.includes('ENOTFOUND')) {
                console.log(`   ⚠️ DNS Error - Network issue, will retry`);
            }
            
            if (shouldReconnect) {
                // Clear existing timer
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                }
                
                // Calculate backoff delay (exponential with jitter)
                const baseDelay = Math.min(5000 * Math.pow(1.5, reconnectAttempts), 60000);
                const jitter = Math.random() * 2000;
                const delay = baseDelay + jitter;
                
                console.log(`🔄 [BOT] Reconnecting in ${Math.round(delay/1000)} seconds...`);
                
                reconnectTimer = setTimeout(async () => {
                    reconnectAttempts++;
                    console.log(`🔄 [BOT] Attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
                    
                    // Try to restore session again
                    const restored = await restoreAndStartBot(sessionId);
                    
                    if (restored.success) {
                        console.log(`✅ [BOT] Reconnection successful!`);
                        activeBot = restored.sock;
                        reconnectAttempts = 0;
                        
                        // Re-attach handlers to new socket
                        if (activeBot) {
                            setupReconnectionHandlers(activeBot, sessionId);
                        }
                    } else {
                        console.log(`❌ [BOT] Reconnection failed: ${restored.error}`);
                        // Will retry in next loop
                    }
                }, delay);
                
            } else {
                console.log(`🚫 [BOT] Not reconnecting - manual intervention required`);
                
                // Clear session if logged out
                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    console.log(`🧹 [BOT] Clearing invalid session...`);
                    if (fs.existsSync(SESSION_ID_FILE)) {
                        fs.unlinkSync(SESSION_ID_FILE);
                    }
                    activeBot = null;
                }
            }
        }
    });
    
    // Handle credentials updates
    sock.ev.on('creds.update', () => {
        console.log(`🔐 [BOT] Credentials updated - saving...`);
        // Session files are automatically saved by useMultiFileAuthState
    });
    
    console.log(`✅ [BOT] Reconnection handlers setup complete`);
}

// ==================== MIDDLEWARE ====================
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));

// ==================== HEALTH CHECK ENDPOINT ====================
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        botActive: activeBot !== null
    });
});

// ==================== STATUS ENDPOINT ====================
app.get('/status', (req, res) => {
    const hasSession = fs.existsSync(SESSION_ID_FILE);
    const sessionId = hasSession ? fs.readFileSync(SESSION_ID_FILE, 'utf8').trim() : null;
    
    res.json({
        success: true,
        data: {
            server: 'running',
            port: PORT,
            hasActiveSession: hasSession,
            sessionId: sessionId,
            botActive: activeBot !== null,
            nodeVersion: process.version,
            platform: process.platform,
            memory: process.memoryUsage(),
            uptime: process.uptime(),
            reconnectAttempts: reconnectAttempts
        }
    });
});

// ==================== BOT CONTROL ENDPOINTS ====================

/**
 * Manually restart bot
 */
app.post('/api/bot/restart', async (req, res) => {
    try {
        if (!fs.existsSync(SESSION_ID_FILE)) {
            return res.status(400).json({ 
                success: false, 
                error: 'No active session found' 
            });
        }
        
        const sessionId = fs.readFileSync(SESSION_ID_FILE, 'utf8').trim();
        
        // Clear existing bot
        if (activeBot) {
            try {
                activeBot.ws?.close();
            } catch (e) {}
            activeBot = null;
        }
        
        // Clear reconnect timer
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        
        // Restore session
        const restored = await restoreAndStartBot(sessionId);
        
        if (restored.success) {
            activeBot = restored.sock;
            setupReconnectionHandlers(activeBot, sessionId);
            reconnectAttempts = 0;
            
            res.json({ 
                success: true, 
                message: 'Bot restarted successfully',
                userId: restored.userId
            });
        } else {
            res.status(500).json({ 
                success: false, 
                error: restored.error || 'Failed to restart bot' 
            });
        }
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Stop bot
 */
app.post('/api/bot/stop', (req, res) => {
    try {
        if (activeBot) {
            activeBot.ws?.close();
            activeBot = null;
        }
        
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        
        res.json({ 
            success: true, 
            message: 'Bot stopped' 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

/**
 * Get bot status
 */
app.get('/api/bot/status', (req, res) => {
    res.json({
        success: true,
        data: {
            active: activeBot !== null,
            user: activeBot?.user?.id || null,
            reconnectAttempts: reconnectAttempts,
            maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS
        }
    });
});

// ==================== WEB INTERFACE ====================
app.get('/', (req, res) => {
    const htmlPath = path.join(__dirname, 'pair.html');
    
    if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
    } else {
        // Simple message if pair.html is missing
        res.status(404).send(`
            <h1>pair.html not found</h1>
            <p>The pair.html file is missing. Please ensure it exists in the root directory.</p>
            <p>Available endpoints:</p>
            <ul>
                <li><a href="/qr">/qr</a> - QR Code Login</li>
                <li><a href="/pair?number=+1234567890">/pair?number=+1234567890</a> - Pairing Code Login</li>
                <li><a href="/status">/status</a> - Server Status</li>
                <li><a href="/health">/health</a> - Health Check</li>
                <li><a href="/api/bot/status">/api/bot/status</a> - Bot Status API</li>
            </ul>
        `);
    }
});

// ==================== API ROUTES ====================
app.use('/pair', pairRouter);
app.use('/qr', qrRouter);
app.use('/restore', restoreRouter);

// ==================== START SERVER ====================
const server = app.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n🎬 [SERVER] GLE Bot starting...`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔐 Encryption: ${process.env.ENCRYPTION_KEY ? 'enabled' : 'DISABLED'}`);
    console.log(`📦 Mega: ${process.env.MEGA_SESSION ? 'configured' : 'NOT CONFIGURED'}`);
    console.log(`🔄 Max reconnect attempts: ${MAX_RECONNECT_ATTEMPTS}`);
    
    // Auto-restore session on startup
    await initializeBot();
    
    console.log(`\n✅ [SERVER] Ready!`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`📍 Status: http://localhost:${PORT}/status`);
    console.log(`📍 Bot API: http://localhost:${PORT}/api/bot/status`);
    console.log(`📍 Web Interface: http://localhost:${PORT}/ (uses pair.html)`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('📴 [SERVER] Received SIGTERM, shutting down gracefully...');
    
    // Clear reconnect timer
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }
    
    // Close bot connection
    if (activeBot) {
        try {
            activeBot.ws?.close();
        } catch (e) {}
    }
    
    server.close(() => {
        console.log('✅ [SERVER] Shutdown complete');
        process.exit(0);
    });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ [SERVER] Uncaught Exception:', error);
    // Don't exit - let the process continue
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ [SERVER] Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit - let the process continue
});

export default app;
