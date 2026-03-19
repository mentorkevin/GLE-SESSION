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

// ==================== AUTO-RESTORE ON STARTUP ====================
/**
 * This is CRITICAL for Render deployment:
 * - When Render restarts, we need to restore the session automatically
 * - No user interaction should be required
 */
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
        }
        
        // Test Mega connection
        console.log(`🔍 [INIT] Testing Mega connection...`);
        const megaStatus = await testConnection();
        if (!megaStatus.success) {
            console.warn(`⚠️ [INIT] Mega connection failed: ${megaStatus.error}`);
            console.log(`   Bot will still work but session persistence across restarts may fail`);
        } else {
            console.log(`✅ [INIT] Mega connection successful`);
        }
        
        // Try to restore session if we have an ID
        if (activeSessionId) {
            console.log(`🔄 [INIT] Attempting to restore session: ${activeSessionId}`);
            const restored = await restoreAndStartBot(activeSessionId);
            
            if (restored.success) {
                console.log(`✅ [INIT] Session restored successfully!`);
                console.log(`👤 [INIT] User: ${restored.userId}`);
                return true;
            } else {
                console.log(`⚠️ [INIT] Failed to restore session: ${restored.error}`);
                console.log(`   Will start fresh and wait for new login`);
                
                // Clear invalid session ID
                if (fs.existsSync(SESSION_ID_FILE)) {
                    fs.unlinkSync(SESSION_ID_FILE);
                }
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

// Increase event listeners for WebSocket
import('events').then(events => {
    events.EventEmitter.defaultMaxListeners = 500;
});

// Middleware
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));

// ==================== HEALTH CHECK ENDPOINT ====================
// Required for Render to know the app is running
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

// ==================== WEB INTERFACE ====================
app.get('/', (req, res) => {
    const htmlPath = path.join(__dirname, 'pair.html');
    
    if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
    } else {
        // Fallback HTML if file not found
        res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>GLE Bot - Render Deployment</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: Arial; max-width: 600px; margin: 50px auto; padding: 20px; }
        .container { background: #f5f5f5; padding: 30px; border-radius: 10px; }
        h1 { color: #333; }
        button { background: #25D366; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin: 5px; }
        #output { margin-top: 20px; padding: 10px; background: white; border-radius: 5px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>GLE Bot - Render Deployment</h1>
        <p>Server is running on Render!</p>
        <button onclick="getStatus()">Check Status</button>
        <button onclick="window.location.href='/qr'">Generate QR</button>
        <div id="output"></div>
    </div>
    <script>
        async function getStatus() {
            const res = await fetch('/status');
            const data = await res.json();
            document.getElementById('output').innerHTML = '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
        }
    </script>
</body>
</html>
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
    
    // Auto-restore session on startup
    await initializeBot();
    
    console.log(`\n✅ [SERVER] Ready!`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`📍 Status: http://localhost:${PORT}/status`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('📴 [SERVER] Received SIGTERM, shutting down gracefully...');
    server.close(() => {
        console.log('✅ [SERVER] Shutdown complete');
        process.exit(0);
    });
});

export default app;