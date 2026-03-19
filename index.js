import express from 'express';
import bodyParser from 'body-parser';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs';
import { restoreAndStartBot } from './restore.js';
import { testConnection } from './mega.js';

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
async function initializeBot() {
    console.log('\n🚀 [INIT] Starting GLE initialization...');
    
    try {
        // Check if we have a saved session ID
        let activeSessionId = null;
        if (fs.existsSync(SESSION_ID_FILE)) {
            activeSessionId = fs.readFileSync(SESSION_ID_FILE, 'utf8').trim();
            console.log(`🔍 [INIT] Found saved session ID: ${activeSessionId}`);
        } else {
            console.log(`🔍 [INIT] No saved session found - will start fresh`);
        }
        
        // Test Mega connection
        console.log(`🔍 [INIT] Testing Mega connection...`);
        try {
            const megaStatus = await testConnection();
            if (!megaStatus.success) {
                console.warn(`⚠️ [INIT] Mega connection failed: ${megaStatus.error}`);
            } else {
                console.log(`✅ [INIT] Mega connection successful`);
            }
        } catch (megaError) {
            console.warn(`⚠️ [INIT] Mega test error: ${megaError.message}`);
        }
        
        // Try to restore session if we have an ID
        if (activeSessionId) {
            console.log(`🔄 [INIT] Attempting to restore session: ${activeSessionId}`);
            // Don't await - let it run in background
            restoreAndStartBot(activeSessionId).then(result => {
                if (result.success) {
                    console.log(`✅ [INIT] Session restored successfully!`);
                    console.log(`👤 [INIT] User: ${result.userId}`);
                } else {
                    console.log(`⚠️ [INIT] Failed to restore session: ${result.error}`);
                    // Clear invalid session ID but DON'T exit
                    if (fs.existsSync(SESSION_ID_FILE)) {
                        fs.unlinkSync(SESSION_ID_FILE);
                    }
                }
            }).catch(err => {
                console.error(`❌ [INIT] Restore error:`, err);
            });
        }
        
        return true;
    } catch (error) {
        console.error(`❌ [INIT] Initialization error:`, error);
        return true; // Even on error, server stays alive
    }
}

// Middleware
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));

// ==================== HEALTH CHECK ENDPOINT ====================
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
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
            nodeVersion: process.version,
            platform: process.platform,
            memory: process.memoryUsage(),
            uptime: process.uptime()
        }
    });
});

// ==================== PING ENDPOINT ====================
app.get('/ping', (req, res) => {
    res.send('pong');
});

// ==================== WEB INTERFACE ====================
app.get('/', (req, res) => {
    const htmlPath = path.join(__dirname, 'pair.html');
    
    if (fs.existsSync(htmlPath)) {
        // Just serve the existing pair.html file
        res.sendFile(htmlPath);
    } else {
        // If pair.html is missing, show error
        res.status(404).send(`
            <h1>pair.html not found</h1>
            <p>The pair.html file is missing. Please ensure it exists in the root directory.</p>
            <p>Available endpoints:</p>
            <ul>
                <li><a href="/qr">/qr</a> - QR Code Login</li>
                <li><a href="/pair?number=+1234567890">/pair?number=+1234567890</a> - Pairing Code Login</li>
                <li><a href="/status">/status</a> - Server Status</li>
                <li><a href="/health">/health</a> - Health Check</li>
                <li><a href="/ping">/ping</a> - Ping</li>
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
    console.log(`\n🎬 [SERVER] GLE WhatsApp Linker starting...`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔐 Encryption: ${process.env.ENCRYPTION_KEY ? 'enabled' : 'DISABLED'}`);
    console.log(`📦 Mega: ${process.env.MEGA_SESSION ? 'configured' : 'NOT CONFIGURED'}`);
    
    // Check if pair.html exists
    const htmlPath = path.join(__dirname, 'pair.html');
    if (fs.existsSync(htmlPath)) {
        console.log(`✅ Found pair.html - will serve as web interface`);
    } else {
        console.log(`⚠️ pair.html not found - web interface will show error`);
    }
    
    // Initialize in background
    initializeBot().then(() => {
        console.log(`✅ [INIT] Background initialization complete`);
    }).catch(err => {
        console.error(`❌ [INIT] Background error:`, err);
    });
    
    console.log(`\n✅ [SERVER] Ready!`);
    console.log(`📍 Web Interface: http://localhost:${PORT}/ (serves pair.html)`);
    console.log(`📍 QR Login: http://localhost:${PORT}/qr`);
    console.log(`📍 Pairing: http://localhost:${PORT}/pair?number=+1234567890`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`📍 Status: http://localhost:${PORT}/status`);
    console.log(`📍 Ping: http://localhost:${PORT}/ping`);
});

// ==================== KEEP SERVER ALIVE ====================
// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('📴 [SERVER] Received SIGTERM, shutting down gracefully...');
    server.close(() => {
        console.log('✅ [SERVER] Shutdown complete');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('📴 [SERVER] Received SIGINT, shutting down gracefully...');
    server.close(() => {
        console.log('✅ [SERVER] Shutdown complete');
        process.exit(0);
    });
});

// Handle errors - LOG BUT NEVER EXIT
process.on('uncaughtException', (error) => {
    console.error('❌ [SERVER] Uncaught Exception:', error);
    console.log('🔄 [SERVER] Server continues running despite error');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ [SERVER] Unhandled Rejection at:', promise);
    console.error('📝 [SERVER] Reason:', reason);
    console.log('🔄 [SERVER] Server continues running despite rejection');
});

// Keep event loop alive
process.stdin.resume();

// Self-ping for Render
if (process.env.RENDER) {
    const https = require('https');
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    
    setInterval(() => {
        const url = `${RENDER_URL}/ping`;
        https.get(url, (res) => {
            console.log(`📡 [KEEP-ALIVE] Pinged self at ${new Date().toISOString()}`);
        }).on('error', (err) => {
            console.error(`❌ [KEEP-ALIVE] Ping failed:`, err.message);
        });
    }, 5 * 60 * 1000);
    
    console.log(`📡 [KEEP-ALIVE] Self-ping enabled for Render`);
}

console.log(`🔴 [SERVER] Process ID: ${process.pid} - Will stay alive indefinitely`);

export default app;
