import dotenv from 'dotenv';
import * as Mega from 'megajs';
import { Readable } from 'stream';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Try multiple auth methods
const MEGA_EMAIL = process.env.MEGA_EMAIL;
const MEGA_PASSWORD = process.env.MEGA_PASSWORD;
const MEGA_SESSION = process.env.MEGA_SESSION;

let storage = null;
let connectionAttempts = 0;
const MAX_ATTEMPTS = 2;

async function authenticate() {
    return new Promise((resolve) => {
        try {
            // Check for any credentials
            if (!MEGA_EMAIL && !MEGA_PASSWORD && !MEGA_SESSION) {
                console.log('📦 Mega: DISABLED (no credentials)');
                resolve(null);
                return;
            }

            console.log('🔄 Connecting to Mega...');

            // Prepare auth options
            const options = {};
            
            if (MEGA_EMAIL && MEGA_PASSWORD) {
                options.email = MEGA_EMAIL;
                options.password = MEGA_PASSWORD;
                console.log('📧 Using email/password auth');
            } else if (MEGA_SESSION) {
                options.session = MEGA_SESSION;
                console.log('🔑 Using session token auth');
            }

            storage = new Mega.Storage(options);
            
            // Set timeout for connection
            const timeout = setTimeout(() => {
                console.log('⏰ Mega connection timeout - continuing without Mega');
                storage = null;
                resolve(null);
            }, 10000);

            storage.on('ready', () => {
                clearTimeout(timeout);
                console.log('✅ Mega connected');
                connectionAttempts = 0;
                resolve(storage);
            });

            storage.on('error', (err) => {
                clearTimeout(timeout);
                console.error('❌ Mega error:', err.message);
                
                connectionAttempts++;
                if (connectionAttempts < MAX_ATTEMPTS) {
                    console.log(`🔄 Retrying (${connectionAttempts}/${MAX_ATTEMPTS})...`);
                    setTimeout(() => authenticate().then(resolve), 5000);
                } else {
                    console.log('📦 Mega: DISABLED (connection failed)');
                    storage = null;
                    resolve(null);
                }
            });

        } catch (err) {
            console.log('📦 Mega: DISABLED (error)');
            storage = null;
            resolve(null);
        }
    });
}

async function getStorage() {
    if (storage === undefined) {
        storage = await authenticate();
    }
    return storage;
}

export const uploadSession = async (sessionString, sessionId) => {
    try {
        const storage = await getStorage();
        if (!storage) {
            return `local://session/${sessionId}`;
        }

        const filename = `GleBot_${sessionId}_${Date.now()}.encrypted`;
        const buffer = Buffer.from(sessionString);
        const stream = Readable.from(buffer);
        
        return new Promise((resolve) => {
            const uploadStream = storage.upload({
                name: filename,
                size: buffer.length
            });

            stream.pipe(uploadStream);

            const timeout = setTimeout(() => {
                resolve(`local://session/${sessionId}`);
            }, 15000);

            uploadStream.on('complete', (file) => {
                clearTimeout(timeout);
                file.link((err, url) => {
                    if (err) resolve(`local://session/${sessionId}`);
                    else resolve(url);
                });
            });

            uploadStream.on('error', () => {
                clearTimeout(timeout);
                resolve(`local://session/${sessionId}`);
            });
        });
    } catch (err) {
        return `local://session/${sessionId}`;
    }
};

export const downloadSession = async (identifier) => {
    try {
        if (identifier?.startsWith?.('local://')) {
            throw new Error('Local session');
        }

        const file = Mega.File.fromURL(identifier);
        
        return new Promise((resolve, reject) => {
            file.loadAttributes((err) => {
                if (err) {
                    reject(err);
                    return;
                }

                file.download((err, data) => {
                    if (err) reject(err);
                    else resolve({
                        data: data.toString(),
                        filename: file.name
                    });
                });
            });
        });
    } catch (err) {
        throw err;
    }
};

export const testConnection = async () => {
    const storage = await getStorage();
    return { success: !!storage };
};

export default {
    uploadSession,
    downloadSession,
    testConnection
};
