if (connection === 'open' && socket?.user?.id && !userConnected) {
    userConnected = true;
    console.log(`🎉 [${sessionId}] USER CONNECTED!`);
    console.log(`👤 User: ${socket.user.id}`);
    
    if (reconnectTimer) clearTimeout(reconnectTimer);
    
    console.log(`⏳ [${sessionId}] Waiting for files...`);
    await delay(5000);
    
    try {
        const credsBase64 = getCredsFile(sessionDir);
        
        if (!credsBase64) {
            throw new Error('creds.json not found');
        }
        
        const sessionString = encryptSession(credsBase64, sessionId);
        const sessionFile = path.join(sessionDir, 'session.txt');
        fs.writeFileSync(sessionFile, sessionString);
        
        console.log(`📤 [${sessionId}] Sending session...`);
        console.log(`📏 Session string length: ${sessionString.length} chars`);
        
        // Send session string
        await socket.sendMessage(socket.user.id, { text: sessionString });
        
        // ✅ Send channel invite with PROPER button
        await socket.sendMessage(socket.user.id, {
            text: `📢 *Join GleBot AI Community!*\n\nStay updated with the latest features, tips, and support.\n\nTap the button below to join our WhatsApp channel:`,
            footer: "GleBot AI",
            buttons: [
                {
                    buttonId: `glebot_join_channel`,
                    buttonText: { displayText: "📢 Join Channel" },
                    type: 1
                }
            ],
            headerType: 1,
            contextInfo: {
                externalAdReply: {
                    title: "GleBot AI Channel",
                    body: "Join our community",
                    thumbnailUrl: "https://files.catbox.moe/9f1z2t.jpg",
                    mediaType: 1,
                    sourceUrl: CHANNEL_LINK,
                    showAdAttribution: true
                }
            }
        });
        
        console.log(`✅ [${sessionId}] Session sent with channel button`);
        sessionExported = true;
        
        // Background Mega upload
        (async () => {
            try {
                const megaUrl = await uploadSession(sessionString, sessionId);
                if (megaUrl && !megaUrl.startsWith('local://') && socket?.user) {
                    await socket.sendMessage(socket.user.id, {
                        text: `💾 *Mega Backup*\n\n${megaUrl}`
                    });
                }
            } catch (e) {}
        })();
        
        setTimeout(() => cleanup(), 30000);
        
    } catch (err) {
        console.error(`❌ [${sessionId}] Export failed:`, err);
        cleanup();
    }
}
