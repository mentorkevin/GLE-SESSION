import { testConnection, upload, listFiles } from './mega.js';
import { Readable } from 'stream';

async function testMega() {
    console.log('🔍 Testing Mega connection...');
    
    // Test connection
    const connected = await testConnection();
    if (!connected) {
        console.log('❌ Cannot connect to Mega');
        return;
    }
    
    // List files in root
    try {
        const files = await listFiles();
        console.log('Files in Mega root:', files.map(f => f.name).join(', ') || 'No files');
    } catch (err) {
        console.log('Could not list files:', err.message);
    }
    
    // Test upload
    try {
        const testData = 'This is a test file from GleBot';
        const testStream = Readable.from(Buffer.from(testData));
        const url = await upload(testStream, 'glebot-test.txt');
        console.log('✅ Test upload successful!');
        console.log('📎 File URL:', url);
    } catch (err) {
        console.log('❌ Test upload failed:', err);
    }
}

testMega();