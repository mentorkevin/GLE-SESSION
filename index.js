import express from 'express';
import bodyParser from 'body-parser';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

import pairRouter from './pair.js';
import qrRouter from './qr.js';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Use Render's PORT or fallback to 10000
const PORT = process.env.PORT || 10000;

app.set('trust proxy', true);

import('events').then(events => {
    events.EventEmitter.defaultMaxListeners = 500;
});

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));

// Health check - critical for Render
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        port: PORT
    });
});

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

app.get('/', (req, res) => {
    const htmlPath = path.join(__dirname, 'pair.html');
    if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
    } else {
        res.status(404).send(`
            <h1>pair.html not found</h1>
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

app.use('/pair', pairRouter);
app.use('/qr', qrRouter);

// ✅ Force immediate port binding with error handling
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎬 [SERVER] GLE WhatsApp Linker starting...`);
    console.log(`📡 Port: ${PORT} (bound to 0.0.0.0)`);
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
    
    console.log(`\n✅ [SERVER] Ready on port ${PORT}!`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
});

// ✅ Handle port binding errors
server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use. Trying alternative port...`);
        const altPort = PORT + 1;
        server.listen(altPort, '0.0.0.0', () => {
            console.log(`✅ [SERVER] Now listening on port ${altPort}`);
        });
    } else {
        console.error('❌ Server error:', error);
        process.exit(1);
    }
});

process.on('SIGTERM', () => {
    console.log('📴 Received SIGTERM, shutting down...');
    server.close(() => {
        console.log('✅ Shutdown complete');
        process.exit(0);
    });
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    // Don't exit - keep server running
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
});

export default app;
