import dotenv from 'dotenv';
import * as Mega from 'megajs';
import { Readable } from 'stream';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mega credentials - try both formats
const MEGA_EMAIL = process.env.MEGA_EMAIL;
const MEGA_PASSWORD = process.env.MEGA_PASSWORD;
const MEGA_SESSION = process.env.MEGA_SESSION;

let storage = null;
let connectionAttempts = 0;
const MAX_ATTEMPTS = 3;

// Authenticate with Mega - support multiple auth methods
async function authenticate() {
    return new Promise((resolve, reject) => {
        try {
            // Check if we have any credentials
            if (!MEGA_EMAIL && !MEGA_PASSWORD && !MEGA_SESSION) {
                console.warn('⚠️ No Mega credentials found - Mega features disabled');
                resolve(null);
                return;
            }

            console.log('🔄 Connecting to Mega...');

            // Prepare auth options
            const options = {};
            
            if (MEGA_EMAIL && MEGA_PASSWORD) {
                // Email/password authentication
                options.email = MEGA_EMAIL;
                options.password = MEGA_PASSWORD;
                console.log('📧 Using email/password authentication');
            } else if (MEGA_SESSION) {
                // Session token authentication - try different formats
                console.log('🔑 Using session token authentication');
                
                // Handle different session token formats
                if (MEGA_SESSION.includes(':')) {
                    // Format: userhandle:sessionid
                    const [userHandle, sessionId] = MEGA_SESSION.split(':');
                    options.userHandle = userHandle;
                    options.sessionId = sessionId;
                } else if (MEGA_SESSION.length > 50) {
                    // Raw session string
                    options.session = MEGA_SESSION;
                } else {
                    // Assume it's just the session ID
                    options.sessionId = MEGA_SESSION;
                }
            }

            // Create storage with options
            storage = new Mega.Storage(options);
            
            // Handle ready event
            storage.on('ready', () => {
                console.log('✅ Connected to Mega');
                connectionAttempts = 0;
                resolve(storage);
            });

            // Handle error event
            storage.on('error', (err) => {
                console.error('❌ Mega connection error:', err.message);
                
                connectionAttempts++;
                if (connectionAttempts < MAX_ATTEMPTS) {
                    console.log(`🔄 Retrying Mega connection (${connectionAttempts}/${MAX_ATTEMPTS})...`);
                    setTimeout(() => authenticate().then(resolve).catch(reject), 5000);
                } else {
                    console.warn('⚠️ Mega connection failed after multiple attempts - continuing without Mega');
                    storage = null;
                    resolve(null);
                }
            });

        } catch (err) {
            console.error('❌ Mega auth error:', err.message);
            console.warn('⚠️ Continuing without Mega - session persistence across restarts will not work');
            resolve(null);
        }
    });
}

// Get storage - always returns a value (null if not connected)
async function getStorage() {
    if (storage === undefined) {
        storage = await authenticate();
    }
    return storage;
}

// Create GleBot folder
async function ensureGleBotFolder() {
    return new Promise(async (resolve) => {
        try {
            const storage = await getStorage();
            if (!storage) {
                resolve(null);
                return;
            }
            
            storage.root.children((err, files) => {
                if (err) {
                    console.warn('⚠️ Could not access Mega root:', err.message);
                    resolve(null);
                    return;
                }
                
                let folder = files?.find(f => f && f.directory && f.name === 'GleBot_Sessions');
                
                if (!folder) {
                    console.log('📁 Creating GleBot_Sessions folder...');
                    storage.mkdir('GleBot_Sessions', (err, newFolder) => {
                        if (err) {
                            console.warn('⚠️ Could not create folder:', err.message);
                            resolve(null);
                        } else {
                            resolve(newFolder);
                        }
                    });
                } else {
                    resolve(folder);
                }
            });
        } catch (err) {
            console.warn('⚠️ Mega folder error:', err.message);
            resolve(null);
        }
    });
}

// Upload session to Mega (graceful failure)
export const uploadSession = async (sessionString, sessionId) => {
    try {
        const storage = await getStorage();
        if (!storage) {
            console.log('📤 [MEGA] Skipping upload - Mega not connected');
            return `local://session/${sessionId}`;
        }

        const folder = await ensureGleBotFolder();
        if (!folder) {
            console.log('📤 [MEGA] Skipping upload - folder not accessible');
            return `local://session/${sessionId}`;
        }
        
        const filename = `GleBot_${sessionId}_${Date.now()}.encrypted`;
        const buffer = Buffer.from(sessionString);
        const stream = Readable.from(buffer);
        
        console.log(`📤 Uploading ${filename} (${buffer.length} bytes)...`);
        
        return new Promise((resolve, reject) => {
            const uploadStream = folder.upload({
                name: filename,
                size: buffer.length
            });

            stream.pipe(uploadStream);

            uploadStream.on('complete', (file) => {
                file.link((err, url) => {
                    if (err) {
                        console.warn('⚠️ Could not generate link:', err.message);
                        resolve(`local://session/${sessionId}`);
                    } else {
                        console.log(`✅ Upload complete: ${filename}`);
                        resolve(url);
                    }
                });
            });

            uploadStream.on('error', (err) => {
                console.warn('⚠️ Upload failed:', err.message);
                resolve(`local://session/${sessionId}`);
            });
        });
    } catch (err) {
        console.warn('⚠️ Upload error:', err.message);
        return `local://session/${sessionId}`;
    }
};

// Download session from Mega (graceful failure)
export const downloadSession = async (identifier) => {
    try {
        // Handle local fallback
        if (typeof identifier === 'string' && identifier.startsWith('local://')) {
            throw new Error('Local session - not stored in Mega');
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
                        console.log(`✅ Download complete: ${file.name}`);
                        resolve({
                            data: data.toString(),
                            filename: file.name,
                            size: file.size
                        });
                    }
                });
            });
        });
    } catch (err) {
        console.warn('⚠️ Download failed:', err.message);
        throw err;
    }
};

// List sessions (graceful failure)
export const listSessions = async () => {
    try {
        const storage = await getStorage();
        if (!storage) {
            return [];
        }
        
        const folder = await ensureGleBotFolder();
        if (!folder) {
            return [];
        }
        
        return new Promise((resolve) => {
            folder.children((err, files) => {
                if (err) {
                    console.warn('⚠️ Could not list files:', err.message);
                    resolve([]);
                } else {
                    const sessions = (files || [])
                        .filter(f => f && f.name && f.name.startsWith('GleBot_'))
                        .map(f => ({
                            name: f.name,
                            id: f.id,
                            size: f.size,
                            timestamp: parseInt(f.name.split('_')[2]?.split('.')[0] || '0')
                        }))
                        .sort((a, b) => b.timestamp - a.timestamp);
                    
                    resolve(sessions);
                }
            });
        });
    } catch (err) {
        console.warn('⚠️ List error:', err.message);
        return [];
    }
};

// Test connection (never throws)
export const testConnection = async () => {
    try {
        const storage = await getStorage();
        return { 
            success: !!storage, 
            error: storage ? null : 'Not connected' 
        };
    } catch (err) {
        return { success: false, error: err.message };
    }
};

export default {
    uploadSession,
    downloadSession,
    listSessions,
    testConnection
};