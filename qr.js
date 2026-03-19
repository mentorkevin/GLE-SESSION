// In your qr.js, find the connection.update handler and ensure it has:

sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;
    
    console.log(`🔔 [${sessionId}] Connection: ${connection || 'no-change'}`);

    // QR generation
    if (qr && !qrGenerated && !responseSent) {
        qrGenerated = true;
        
        try {
            const qrImage = await QRCode.toDataURL(qr);
            
            responseSent = true;
            res.json({
                success: true,
                qr: qrImage,
                sessionId: sessionId,
                message: 'Scan this QR code with WhatsApp',
                instructions: [
                    '1. Open WhatsApp on your phone',
                    '2. Go to Settings → Linked Devices',
                    '3. Tap "Link a Device"',
                    '4. Scan this QR code'
                ],
                expiresIn: 120
            });

            console.log(`✅ [${sessionId}] QR code sent - waiting for scan...`);
            
        } catch (err) {
            console.error(`❌ [${sessionId}] QR error:`, err);
        }
    }

    // Connection opened successfully
    if (connection === 'open') {
        console.log(`✅ [${sessionId}] WhatsApp CONNECTED!`);
        console.log(`👤 User: ${sock.user?.id}`);
        
        // Your existing export logic here...
    }

    // Connection closed
    if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`🔴 [${sessionId}] Connection closed:`, statusCode);
        
        // Don't cleanup immediately - give time for reconnect
        if (!sock.user && !responseSent) {
            console.log(`⏳ [${sessionId}] Waiting for scan...`);
        }
    }
});
