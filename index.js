require('dotenv').config(); // Membaca file .env
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const SESSION_PATH = process.env.SESSION_PATH || 'auth_info_baileys';

// Helper fungsi untuk delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// CORS Header
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-API-Key');
    next();
});

// Middleware Validasi API Key (Abaikan untuk status & QR agar frontend tetap lancar)
const verifyApiKey = (req, res, next) => {
    if (!API_KEY) return next(); // Jika API_KEY di .env kosong, lewati
    const apiKeyHeader = req.headers['x-api-key'];
    if (apiKeyHeader && apiKeyHeader === API_KEY) {
        return next();
    }
    // Izinkan GET status & qr tanpa API Key jika diakses langsung dari browser
    if (req.path === '/status.json' || req.path === '/qr.json') {
        return next();
    }
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid API Key' });
};

app.use(verifyApiKey);

let sock;
let qrData = '';
let connectionStatus = 'offline';

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
        version,
        auth: state,
        browser: ['Absensi Sekolah', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrData = await qrcode.toDataURL(qr);
            connectionStatus = 'qr_required';
            console.log('>>> QR Code baru dibuat, silakan scan dari web.');
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            connectionStatus = 'offline';
            qrData = '';
            
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('Koneksi terputus, mencoba menghubungkan ulang...');
                setTimeout(connectToWhatsApp, 3000);
            } else {
                console.log('Sesi keluar (Logged Out). Menghapus folder sesi...');
                if (fs.existsSync(SESSION_PATH)) {
                    fs.rmSync(SESSION_PATH, { recursive: true, force: true });
                }
                setTimeout(connectToWhatsApp, 3000);
            }
        } else if (connection === 'open') {
            connectionStatus = 'connected';
            qrData = '';
            console.log('>>> WhatsApp Gateway BERHASIL Terhubung!');
        }
    });
}

// Endpoints
app.get('/status.json', (req, res) => {
    res.json({ status: connectionStatus });
});

app.get('/qr.json', (req, res) => {
    res.json({ qr: qrData });
});

app.post('/reconnect', async (req, res) => {
    qrData = '';
    connectionStatus = 'offline';
    if (sock) {
        try { sock.end(undefined); } catch (e) {}
    }
    connectToWhatsApp();
    res.json({ success: true, message: 'Memulai ulang koneksi...' });
});

// === SISTEM ANTREAN (QUEUE) ANTI-SPAM ===
let messageQueue = [];
let isProcessingQueue = false;

async function processMessageQueue() {
    // Jika antrean sedang diproses atau antrean kosong, hentikan
    if (isProcessingQueue || messageQueue.length === 0) return;
    
    isProcessingQueue = true; // Kunci proses agar tidak tumpang tindih

    while (messageQueue.length > 0) {
        const { phone, message } = messageQueue.shift(); // Ambil pesan pertama dari antrean

        // Pastikan koneksi masih hidup sebelum mencoba mengirim
        if (!sock || connectionStatus !== 'connected') {
            console.log(`[${new Date().toLocaleTimeString()}] Gateway terputus, membatalkan sisa antrean di memori.`);
            break; 
        }

        try {
            let formattedPhone = phone.replace(/[^0-9]/g, '');
            if (formattedPhone.startsWith('0')) {
                formattedPhone = '62' + formattedPhone.slice(1);
            }
            formattedPhone += '@s.whatsapp.net';

            // Jeda TUNGGAL acak 4 - 8 detik antar pengiriman
            const jeda = Math.floor(Math.random() * (8000 - 4000 + 1)) + 4000;
            console.log(`[${new Date().toLocaleTimeString()}] Mengetik... (${jeda/1000} detik) untuk ${formattedPhone}`);
            
            // Tahan proses Node.js di sini selama waktu jeda
            await delay(jeda); 
            
            // Kirim pesan ke WhatsApp
            await sock.sendMessage(formattedPhone, { text: message });
            
            console.log(`[${new Date().toLocaleTimeString()}] Berhasil mengirim ke ${formattedPhone}`);
        } catch (err) {
            console.error(`[${new Date().toLocaleTimeString()}] Gagal mengirim ke ${phone}:`, err.message);
        }
    }
    
    // Buka kembali kunci setelah antrean habis diproses
    isProcessingQueue = false;
}

app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;
    
    if (!sock || connectionStatus !== 'connected') {
        return res.status(500).json({ success: false, error: 'WhatsApp Gateway belum terhubung' });
    }
    
    // 1. Berikan respons sukses langsung ke PHP agar PHP tidak timeout (loading lama)
    res.json({ success: true, status: 'queued_in_node' });

    // 2. Masukkan pesan ke dalam keranjang antrean Node.js
    messageQueue.push({ phone, message });

    // 3. Jalankan mesin pemroses antrean (jika belum berjalan)
    processMessageQueue();
});

// Jalankan Server
app.listen(PORT, () => {
    console.log(`Server WhatsApp Gateway berjalan di http://localhost:${PORT}`);
    connectToWhatsApp();
});