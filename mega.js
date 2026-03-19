import dotenv from 'dotenv';
import * as Mega from 'megajs';
import { Readable } from 'stream';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mega credentials
const MEGA_SESSION = process.env.MEGA_SESSION;

let storage = null;
let connectionAttempts = 0;
const MAX_ATTEMPTS = 3;

// Authenticate with Mega
async function authenticate() {
    return new Promise((resolve, reject) => {
        try {
            if (!MEGA_SESSION) {
                console.warn('⚠️ No Mega credentials found - Mega features disabled');
                resolve(null);
                return;
            }

            console.log('🔄 Connecting to Mega...');

            const options = { session: MEGA_SESSION };
            
            storage = new Mega.Storage(options);
            
            storage.on('ready', () => {
                console.log('✅ Connected to Mega');
                connectionAttempts = 0;
                resolve(storage);
            });

            storage.on('error', (err) => {
                console.error('❌ Mega connection error:', err.message);
                
                connectionAttempts++;
                if (connectionAttempts < MAX_ATTEMPTS) {
                    console.log(`🔄 Retrying Mega connection (${connectionAttempts}/${MAX_ATTEMPTS})...`);
                    setTimeout(() => authenticate().then(resolve).catch(reject), 5000);
                } else {
                    console.warn('⚠️ Mega connection failed - continuing without Mega');
                    storage = null;
                    resolve(null);
                }
            });

        } catch (err) {
            console.error('❌ Mega auth error:', err.message);
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
        
        console.log(`📤 Uploading ${filename}...`);
        
        return new Promise((resolve) => {
            const uploadStream = storage.upload({
                name: filename,
                size: buffer.length
            });

            stream.pipe(uploadStream);

            uploadStream.on('complete', (file) => {
                file.link((err, url) => {
                    if (err) {
                        resolve(`local://session/${sessionId}`);
                    } else {
                        console.log(`✅ Upload complete`);
                        resolve(url);
                    }
                });
            });

            uploadStream.on('error', () => {
                resolve(`local://session/${sessionId}`);
            });
        });
    } catch (err) {
        return `local://session/${sessionId}`;
    }
};

export const downloadSession = async (identifier) => {
    try {
        if (typeof identifier === 'string' && identifier.startsWith('local://')) {
            throw new Error('Local session');
        }

        console.log(`📥 Downloading from Mega...`);
        
        const file = Mega.File.fromURL(identifier);
        
        return new Promise((resolve, reject) => {
            file.loadAttributes((err) => {
                if (err) {
                    reject(err);
                    return;
                }

                file.download((err, data) => {
                    if (err) {
                        reject(err);
                    } else {
                        console.log(`✅ Download complete`);
                        resolve({
                            data: data.toString(),
                            filename: file.name
                        });
                    }
                });
            });
        });
    } catch (err) {
        throw err;
    }
};

export const testConnection = async () => {
    try {
        const storage = await getStorage();
        return { success: !!storage };
    } catch (err) {
        return { success: false, error: err.message };
    }
};

export default {
    uploadSession,
    downloadSession,
    testConnection
};
