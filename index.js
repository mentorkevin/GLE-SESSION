import express from 'express';
import bodyParser from 'body-parser';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs';

// Load environment variables
dotenv.config();

// Import routers
import pairRouter from './pair.js';
import qrRouter from './qr.js';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8000;

// Trust proxy for correct IP on Render
app.set('trust proxy', true);

// Increase event listeners for WebSocket
import('events').then(events => {
    events.EventEmitter.defaultMaxListeners = 500;
});

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
    res.json({
        success: true,
        data: {
            server: 'running',
            port: PORT,
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
        res.status(404).send(`
            <h1>pair.html not found</h1>
            <p>The pair.html file is missing. Please ensure it exists in the root directory.</p>
            <p>Available endpoints:</p>
            <ul>
                <li><a href="/qr">/qr</a> - QR Code Login</li>
                <li><a href="/pair?number=+1234567890">/pair?number=+1234567890</a> - Pairing Code Login</li>
                <li><a href="/status">/status</a> - Server Status</li>
                <li><a href="/health">/health</a> - Health Check</li>
            </ul>
        `);
    }
});

// ==================== API ROUTES ====================
app.use('/pair', pairRouter);
app.use('/qr', qrRouter);

// ==================== START SERVER ====================
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎬 [SERVER] GLE WhatsApp Linker starting...`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔐 Encryption: ${process.env.ENCRYPTION_KEY ? 'enabled' : 'DISABLED'}`);
    console.log(`📦 Mega: ${process.env.MEGA_SESSION ? 'configured' : 'NOT CONFIGURED'}`);
    console.log(`📍 Trust proxy: ${app.get('trust proxy')}`);
    
    const htmlPath = path.join(__dirname, 'pair.html');
    if (fs.existsSync(htmlPath)) {
        console.log(`✅ Found pair.html - will serve as web interface`);
    } else {
        console.log(`⚠️ pair.html not found - web interface will show error`);
    }
    
    console.log(`\n✅ [SERVER] Ready!`);
    console.log(`📍 Web Interface: http://localhost:${PORT}/ (serves pair.html)`);
    console.log(`📍 QR Login: http://localhost:${PORT}/qr`);
    console.log(`📍 Pairing: http://localhost:${PORT}/pair?number=+1234567890`);
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

// Handle errors - log but don't exit
process.on('uncaughtException', (error) => {
    console.error('❌ [SERVER] Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ [SERVER] Unhandled Rejection:', reason);
});

export default app;
