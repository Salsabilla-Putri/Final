const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');
require('dotenv').config();
const { transformPublicStatus } = require('./public_status');

mongoose.set('bufferCommands', false);

const mqttModulePath = path.join(__dirname, 'node_modules', 'mqtt', 'build', 'index.js');
const mqtt = fs.existsSync(mqttModulePath) ? require('mqtt') : null;

function createDisabledMqttClient() {
    const client = new EventEmitter();
    client.subscribe = () => undefined;
    client.publish = () => undefined;
    client.end = () => undefined;

    process.nextTick(() => {
        client.emit('error', new Error('MQTT module unavailable; running without live broker connection.'));
    });

    return client;
}

const { analyzeReportRows } = require('./lib_report_analysis');
const { generateMaintenanceDecision, toSuggestionDocument } = require('./maintenance_decision');

const app = express();

// SECURITY HEADERS
app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'self' * 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'self' * ws: wss:;");
    next();
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'login.html')); });

function isDbReady() {
    return mongoose.connection.readyState === 1;
}

let dbConnectPromise = null;

async function ensureDbReady() {
    if (isDbReady()) return true;

    if (dbConnectPromise) {
        await dbConnectPromise;
        return isDbReady();
    }

    dbConnectPromise = mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/generator_monitoring', {
        useNewUrlParser: true,
        useUnifiedTopology: true
    })
    .then(async () => {
        console.log('✅ MongoDB Connected');
        await loadThresholdsFromDB(); // Load threshold saat server nyala/reconnect
    })
    .catch((err) => {
        console.error('❌ MongoDB Connection Error:', err);
        throw err;
    })
    .finally(() => {
        dbConnectPromise = null;
    });

    await dbConnectPromise;
    return isDbReady();
}

// DATABASE (startup connect + auto retry via ensureDbReady saat endpoint dipanggil)
ensureDbReady().catch(() => undefined);

// --- SCHEMAS ---
const generatorDataSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now },
    deviceId: { type: String, required: true },
    rpm: Number, volt: Number, amp: Number, power: Number,
    freq: Number, temp: Number, coolant: Number, fuel: Number,
    sync: String, status: String, oil: Number, iat: Number,
    map: Number, batt: Number, afr: Number, tps: Number
});
const GeneratorData = mongoose.model('GeneratorData', generatorDataSchema);

const alertSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now },
    deviceId: String,
    parameter: String,
    value: Number,
    message: String,
    severity: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
    resolved: { type: Boolean, default: false }
});
const Alert = mongoose.model('Alert', alertSchema);

// NEW: Schema untuk menyimpan Konfigurasi Threshold
const configSchema = new mongoose.Schema({
    key: { type: String, unique: true }, // e.g. "engine_thresholds"
    value: Object // Menyimpan object JSON threshold
});
const Config = mongoose.model('Config', configSchema);


const userSchema = new mongoose.Schema({
    name: { type: String, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    role: { type: String, required: true, default: 'Masyarakat' }
});
const User = mongoose.model('User', userSchema);

const activeTimeHistorySchema = new mongoose.Schema({
    deviceId: { type: String, required: true, index: true },
    startedAt: { type: Date, required: true, index: true },
    endedAt: { type: Date, default: null, index: true },
    durationMs: { type: Number, default: 0 },
    source: { type: String, enum: ['mqtt', 'manual'], default: 'mqtt' }
}, { timestamps: true });
const ActiveTimeHistory = mongoose.model('ActiveTimeHistory', activeTimeHistorySchema);


const EMAIL_NOTIF_FROM = process.env.ALERT_EMAIL_FROM || 'onboarding@resend.dev';
const ALERT_EMAIL_COOLDOWN_MS = parseInt(process.env.ALERT_EMAIL_COOLDOWN_MS || '60000', 10);
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
let lastCriticalEmailAt = 0;

async function sendViaResend({ from, to, subject, html }) {
    const payload = JSON.stringify({ from, to, subject, html });
    return await new Promise((resolve, reject) => {
        const req = https.request('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${RESEND_API_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body);
                reject(new Error(`Resend error ${res.statusCode}: ${body}`));
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function smtpReadLine(socket, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error('SMTP timeout waiting response'));
        }, timeoutMs);

        const onData = (chunk) => {
            buffer += chunk.toString('utf8');
            if (buffer.includes('\r\n')) {
                const lines = buffer.split('\r\n').filter(Boolean);
                const last = lines[lines.length - 1] || '';
                if (/^\d{3} /.test(last)) {
                    cleanup();
                    resolve(buffer);
                }
            }
        };
        const onError = (err) => {
            cleanup();
            reject(err);
        };
        const onClose = () => {
            cleanup();
            reject(new Error('SMTP connection closed unexpectedly'));
        };

        function cleanup() {
            clearTimeout(timer);
            socket.off('data', onData);
            socket.off('error', onError);
            socket.off('close', onClose);
        }

        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('close', onClose);
    });
}

async function smtpSend(socket, cmd, expectedCodes = [250]) {
    socket.write(`${cmd}\r\n`);
    const response = await smtpReadLine(socket);
    const status = parseInt(response.slice(0, 3), 10);
    if (!expectedCodes.includes(status)) {
        throw new Error(`SMTP command failed (${cmd}) -> ${response.trim()}`);
    }
    return response;
}

async function sendViaSmtp({ host, port, user, pass, from, toList, subject, html }) {
    const socket = await new Promise((resolve, reject) => {
        const secure = port === 465;
        const conn = secure
            ? tls.connect(port, host, { servername: host }, () => resolve(conn))
            : net.createConnection(port, host, () => resolve(conn));
        conn.once('error', reject);
    });

    try {
        const banner = await smtpReadLine(socket);
        if (!banner.startsWith('220')) {
            throw new Error(`SMTP banner invalid: ${banner.trim()}`);
        }

        await smtpSend(socket, `EHLO ${host}`, [250]);
        await smtpSend(socket, 'AUTH LOGIN', [334]);
        await smtpSend(socket, Buffer.from(user).toString('base64'), [334]);
        await smtpSend(socket, Buffer.from(pass).toString('base64'), [235]);
        await smtpSend(socket, `MAIL FROM:<${from}>`, [250]);
        for (const to of toList) {
            await smtpSend(socket, `RCPT TO:<${to}>`, [250, 251]);
        }
        await smtpSend(socket, 'DATA', [354]);

        const dateValue = new Date().toUTCString();
        const body = [
            `From: ${from}`,
            `To: ${toList.join(', ')}`,
            `Subject: ${subject}`,
            'MIME-Version: 1.0',
            'Content-Type: text/html; charset=UTF-8',
            `Date: ${dateValue}`,
            '',
            html,
            '.'
        ].join('\r\n');

        await smtpSend(socket, body, [250]);
        await smtpSend(socket, 'QUIT', [221]);
    } finally {
        socket.end();
    }
}

async function sendCriticalAlertEmail(alertItems, latestSnapshot) {
    if (!RESEND_API_KEY) {
        console.warn('⚠️ RESEND_API_KEY belum dikonfigurasi. Email alert critical tidak akan dikirim.');
        return;
    }

    const recipients = (await User.find({}, { email: 1, _id: 0 }).lean())
        .map((u) => String(u.email || '').trim().toLowerCase())
        .filter(Boolean);

    if (recipients.length === 0) return;

    const uniqueRecipients = [...new Set(recipients)];
    const rows = alertItems
        .map((a) => `<li><b>${a.parameter?.toUpperCase() || '-'}</b>: ${a.value} (${a.message})</li>`)
        .join('');

    await sendViaResend({
        from: EMAIL_NOTIF_FROM,
        to: uniqueRecipients,
        subject: `[CRITICAL ALERT] ${latestSnapshot?.deviceId || 'Generator'}`,
        html: `<p>Terdeteksi alert <b>CRITICAL</b> pada generator.</p><ul>${rows}</ul><p>Waktu: ${new Date().toISOString()}</p>`
    });
}

// --- DYNAMIC THRESHOLDS ---
// Default values (jika db kosong)
let ACTIVE_THRESHOLDS = {
    rpm: { max: 3800 },
    temp: { max: 95 },
    volt: { min: 180, max: 250 },
    fuel: { min: 20 },
    amp: { max: 100 },
    freq: { min: 48, max: 52 },
    batt: { min: 11.8, max: 14.8 }
};

// Fungsi Load dari DB ke Memory Server
async function loadThresholdsFromDB() {
    try {
        let conf = await Config.findOne({ key: 'engine_thresholds' });
        if (conf) {
            ACTIVE_THRESHOLDS = { ...ACTIVE_THRESHOLDS, ...conf.value };
            console.log('⚙️ Thresholds Loaded from DB:', ACTIVE_THRESHOLDS);
        } else {
            // Jika belum ada, buat default
            await new Config({ key: 'engine_thresholds', value: ACTIVE_THRESHOLDS }).save();
            console.log('⚙️ Default Thresholds Created');
        }
    } catch (e) { console.error('Config Load Error:', e); }
}

// --- MQTT LOGIC ---
// [FIX 1] Broker disamakan dengan ESP32 → shiftr.io cloud
const mqttClient = mqtt
    ? mqtt.connect(process.env.MQTT_BROKER || 'mqtt://generatorta20.cloud.shiftr.io:1883', {
        clientId:        'server-' + Math.random().toString(16).slice(2, 8),
        username:        process.env.MQTT_USERNAME || 'generatorta20',
        password:        process.env.MQTT_PASSWORD || 'TA252601020',
        keepalive:       60,
        reconnectPeriod: 3000,
        connectTimeout:  10000
    })
    : createDisabledMqttClient();

let latestData = {
    deviceId: 'ESP32_GENERATOR_01', timestamp: new Date(),
    rpm: 0, volt: 0, amp: 0, power: 0, freq: 0, temp: 0, coolant: 0,
    fuel: 0, sync: 'OFF-GRID', status: 'STOPPED', oil: 0, iat: 0, map: 0, batt: 0, afr: 0, tps: 0
};
let activeSessions = new Map();

async function syncActiveTimeHistory(data) {
    const status = String(data?.status || '').toUpperCase();
    const rpm = Number(data?.rpm || 0);
    const isRunning = status === 'RUNNING' || rpm > 0;
    const deviceId = data?.deviceId || latestData.deviceId || 'GENERATOR #1';
    const eventTime = data?.timestamp ? new Date(data.timestamp) : new Date();
    const key = `${deviceId}`;
    const startedAt = activeSessions.get(key);

    if (isRunning && !startedAt) {
        activeSessions.set(key, eventTime);
        await ActiveTimeHistory.create({ deviceId, startedAt: eventTime, source: 'mqtt' });
        return;
    }

    if (!isRunning && startedAt) {
        const durationMs = Math.max(0, eventTime.getTime() - startedAt.getTime());
        await ActiveTimeHistory.findOneAndUpdate(
            { deviceId, startedAt, endedAt: null },
            { endedAt: eventTime, durationMs },
            { sort: { createdAt: -1 } }
        );
        activeSessions.delete(key);
    }
}

mqttClient.on('connect', () => {
    console.log('✅ Connected to MQTT Broker (shiftr.io)');
    mqttClient.subscribe('gen/#', (err) => {
        if (err) console.error('❌ Subscribe error:', err.message);
        else console.log('📡 Subscribed to gen/#');
    });
});

mqttClient.on('reconnect', () => console.log('🔄 MQTT Reconnecting...'));
mqttClient.on('offline',   () => console.warn('⚠️  MQTT Offline'));

mqttClient.on('error', (error) => {
    console.warn('⚠️ MQTT Error:', error.message);
});

// [FIX 2] Auto-save ke DB setiap 10 detik dari data terbaru yang sudah terkumpul
//          Sebelumnya hanya trigger saat gen/status masuk — topik yang tidak pernah
//          dikirim ESP32, sehingga data tidak pernah tersimpan.
let lastSaveAt = 0;
const SAVE_INTERVAL_MS = 10_000; // simpan tiap 10 detik

async function autoSaveLatestData() {
    if (!isDbReady()) return;
    const now = Date.now();
    if (now - lastSaveAt < SAVE_INTERVAL_MS) return;
    lastSaveAt = now;

    try {
        const snapshot = { ...latestData, timestamp: new Date() };

        // Tentukan status dari RPM
        if (snapshot.rpm > 0) {
            snapshot.status = snapshot.sync === 'ON-GRID' ? 'ON-GRID' : 'RUNNING';
        } else {
            snapshot.status = 'STOPPED';
        }

        await new GeneratorData(snapshot).save();
        await syncActiveTimeHistory(snapshot);
        await checkAndSaveAlerts(snapshot);
        console.log(`💾 Auto-saved | rpm=${snapshot.rpm} volt=${snapshot.volt} sync=${snapshot.sync}`);
    } catch (saveErr) {
        console.error('❌ Auto-save Error:', saveErr.message);
    }
}

// LOGIC ALARM DINAMIS (Menggunakan ACTIVE_THRESHOLDS)
// --- LOGIC ALARM DINAMIS (UPDATED) ---
// --- LOGIC ALARM DINAMIS (DIPERBAIKI) ---
async function checkAndSaveAlerts(data) {
    const alertsToSave = [];
    const T = ACTIVE_THRESHOLDS; 
    const criticalOnMinViolation = new Set(['volt', 'batt', 'freq']);
    const criticalOnMaxViolation = new Set(['amp', 'volt', 'batt', 'temp', 'coolant']);

    // Helper check function
    const check = (param, val) => {
        if (!T[param]) return; // Skip jika tidak ada threshold
        
        // Cek Batas Atas
        if (T[param].max !== undefined && val > T[param].max) {
            const severity = criticalOnMaxViolation.has(param) ? 'critical' : 'high';
            alertsToSave.push({ 
                parameter: param, 
                value: val, 
                message: `${param.toUpperCase()} Too High (> ${T[param].max})`, 
                severity
            });
        }
        // Cek Batas Bawah
        if (T[param].min !== undefined && val < T[param].min) {
            const severity = criticalOnMinViolation.has(param) ? 'critical' : 'medium';
            alertsToSave.push({ 
                parameter: param, 
                value: val, 
                message: `${param.toUpperCase()} Too Low (< ${T[param].min})`, 
                severity
            });
        }
    };

    // --- TAMBAHKAN SEMUA PARAMETER DI SINI ---
    check('rpm', data.rpm);
    check('volt', data.volt);
    check('amp', data.amp);     // <-- DITAMBAHKAN
    check('freq', data.freq);   // <-- DITAMBAHKAN
    check('power', data.power); // <-- DITAMBAHKAN
    check('coolant', data.coolant); 
    check('temp', data.temp);
    check('fuel', data.fuel);
    check('iat', data.iat);
        check('afr', data.afr);
    check('tps', data.tps);
    check('batt', data.batt);

    // Simpan Alert ke Database
    if (alertsToSave.length > 0) {
        // Cek alert terakhir untuk menghindari spam (optional, debounce 10 detik)
        const lastAlert = await Alert.findOne().sort({ timestamp: -1 });
        const timeDiff = lastAlert ? (new Date() - lastAlert.timestamp) : 999999;

        if (timeDiff > 10000) {
            for (const a of alertsToSave) {
                await new Alert({ ...a, deviceId: data.deviceId }).save();
                console.log(`⚠️ Alert Saved: ${a.message}`);
            }
        }

        // const criticalAlerts = alertsToSave.filter((a) => a.severity === 'critical');
        // const now = Date.now();
        // if (criticalAlerts.length > 0 && (now - lastCriticalEmailAt) > ALERT_EMAIL_COOLDOWN_MS) {
        //     try {
        //         await sendCriticalAlertEmail(criticalAlerts, data);
        //         lastCriticalEmailAt = now;
        //         console.log(`📧 Critical alert email sent (${criticalAlerts.length} alert)`);
        //     } catch (emailError) {
        //         console.error('❌ Gagal mengirim email alert critical:', emailError.message);
        //     }
        // }
    }
}
// --- TAMBAHAN API UNTUK HALAMAN ALARM ---

// 1. Acknowledge (Konfirmasi) Alarm - Mengubah Status jadi "Resolved"
app.put('/api/alerts/:id/ack', async (req, res) => {
    try {
        await Alert.findByIdAndUpdate(req.params.id, { resolved: true });
        res.json({ success: true, message: 'Alert Acknowledged' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. Hapus Alarm dari Database
app.delete('/api/alerts/:id', async (req, res) => {
    try {
        await Alert.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'Alert Deleted' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

mqttClient.on('message', async (topic, message) => {
    try {
        const value = message.toString();
        switch(topic) {
            case 'gen/rpm':       latestData.rpm      = parseInt(value)   || 0; break;
            case 'gen/volt':      latestData.volt      = parseFloat(value) || 0; break;
            case 'gen/volt_grid': latestData.volt_grid = parseFloat(value) || 0; break;
            case 'gen/amp':       latestData.amp       = parseFloat(value) || 0; break;
            case 'gen/power':     latestData.power     = parseFloat(value) || 0; break;
            case 'gen/freq':      latestData.freq      = parseFloat(value) || 0; break;
            case 'gen/freq_grid': latestData.freq_grid = parseFloat(value) || 0; break;
            // [FIX 3] gen/coolant — topik yang dikirim ESP32 tapi tidak ada handler-nya
            case 'gen/coolant':   latestData.coolant   = parseFloat(value) || 0;
                                  latestData.temp      = latestData.coolant; break;
            case 'gen/temp':      latestData.temp      = parseFloat(value) || 0;
                                  latestData.coolant   = latestData.temp; break;
            case 'gen/fuel':      latestData.fuel      = parseFloat(value) || 0; break;
            case 'gen/sync':      latestData.sync      = value; break;
            case 'gen/oil':       latestData.oil       = parseFloat(value) || 0; break;
            case 'gen/iat':       latestData.iat       = parseFloat(value) || 0; break;
            case 'gen/map':       latestData.map       = parseFloat(value) || 0; break;
            case 'gen/batt':      latestData.batt      = parseFloat(value) || 0; break;
            case 'gen/afr':       latestData.afr       = parseFloat(value) || 0; break;
            case 'gen/tps':       latestData.tps       = parseFloat(value) || 0; break;

            // gen/status tetap dipertahankan jika ada publisher lain yang mengirimnya
            case 'gen/status':
                latestData.status    = value;
                latestData.timestamp = new Date();
                lastSaveAt = 0; // paksa save segera
                break;
        }

        // [FIX 2] Trigger auto-save setiap kali ada pesan masuk (throttle 10 detik)
        await autoSaveLatestData();

    } catch (error) { console.error('❌ MQTT Message Error:', error); }
});

// --- API ENDPOINTS ---

app.get('/api/engine-data/latest', async (req, res) => {
    try {
        // Selalu kirim data memory terbaru dari MQTT terlebih dahulu
        // Tambahkan timestamp agar frontend tahu kapan data terakhir diterima
        const realtimeData = {
            ...latestData,
            _realtime: true,
            lastMqttUpdate: new Date().toISOString()
        };
        
        // Opsional: jika ingin tetap simpan ke database, tapi tidak untuk tampilan realtime
        // return langsung tanpa query DB
        return res.json({ success: true, data: realtimeData, source: 'realtime-memory' });
        
    } catch (error) {
        // Fallback jika terjadi error
        res.json({ success: true, data: latestData, source: 'memory-fallback', warning: error.message });
    }
});

app.get('/api/public-status', async (req, res) => {
    try {
        if (!isDbReady()) {
            return res.status(503).json({ success: false, error: 'Database not ready' });
        }

        const { deviceId } = req.query;
        const query = deviceId ? { deviceId } : {};

        const latestDocs = await GeneratorData.find(query)
            .sort({ timestamp: -1 })
            .limit(2)
            .lean();

        if (!latestDocs.length) {
            return res.status(404).json({ success: false, error: 'No generator data found' });
        }

        const [latestDoc, previousDoc] = latestDocs;
        const payload = transformPublicStatus(latestDoc, previousDoc || null);

        res.json({ success: true, data: payload });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. GET History Data (Updated for Date Filter)
app.get('/api/engine-data/history', async (req, res) => {
    try {
        const { limit = 1000, hours, startDate, endDate } = req.query;
        let query = {};

        // Jika ada filter tanggal spesifik dari Frontend
        if (startDate && endDate) {
            // ── FIX: frontend mengirim ISO string UTC (Date.UTC) — cukup parse langsung,
            //    JANGAN setHours() karena itu mengubah ke local timezone server
            const start = new Date(startDate);
            const end   = new Date(endDate);

            query.timestamp = {
                $gte: start,
                $lte: end
            };
        } 
        // Fallback ke filter jam (default logic)
        else {
            const h = parseInt(hours) || 24;
            const cutoff = new Date(Date.now() - (h * 60 * 60 * 1000));
            query.timestamp = { $gte: cutoff };
        }

        if (!isDbReady()) {
            return res.json({ success: true, count: 0, data: [], source: 'memory' });
        }

        const data = await GeneratorData.find(query)
            .sort({ timestamp: -1 })
            .limit(parseInt(limit));
            
        res.json({ success: true, count: data.length, data, source: 'database' });
    } catch (error) {
        res.json({ success: true, count: 0, data: [], source: 'memory', warning: error.message });
    }
});

app.get('/api/alerts', async (req, res) => {
    try {
        const { limit = 50 } = req.query;
        const alerts = await Alert.find().sort({ timestamp: -1 }).limit(parseInt(limit));
        res.json({ success: true, data: alerts });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/engine-data/stats', async (req, res) => {
    try {
        const last24Hours = new Date(Date.now() - (24 * 60 * 60 * 1000));
        const stats = await GeneratorData.aggregate([
            { $match: { timestamp: { $gte: last24Hours } } },
            { $group: { _id: null, avgRPM: { $avg: "$rpm" }, avgVoltage: { $avg: "$volt" }, avgPower: { $avg: "$power" }, avgTemp: { $avg: "$temp" }, maxTemp: { $max: "$temp" }, minFuel: { $min: "$fuel" }, totalRecords: { $sum: 1 } } },
            { $project: { _id: 0, avgRPM: 1, avgVoltage: 1, avgPower: 1, avgTemp: 1, maxTemp: 1, minFuel: 1, totalHours: { $divide: [{ $multiply: ["$totalRecords", 5] }, 3600] } } }
        ]);
        res.json({ success: true, data: stats[0] || { avgPower: 0, totalHours: 0 } });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/generator-active-time/history', async (req, res) => {
    try {
        const { limit = 100, startDate, endDate } = req.query;
        const requestedDeviceId = req.query.deviceId;
        const effectiveDeviceId = requestedDeviceId || process.env.DEFAULT_REPORT_DEVICE_ID || 'ESP32_GENERATOR_01';
        const query = {};

        if (effectiveDeviceId) query.deviceId = effectiveDeviceId;
        if (startDate || endDate) {
            query.startedAt = {};
            if (startDate) query.startedAt.$gte = new Date(startDate);
            if (endDate) query.startedAt.$lte = new Date(endDate);
        }

        const rows = await ActiveTimeHistory.find(query).sort({ startedAt: -1 }).limit(parseInt(limit, 10));
        res.json({ success: true, count: rows.length, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/generator-active-time/stats', async (req, res) => {
    try {
        const requestedDeviceId = req.query.deviceId;
        const effectiveDeviceId = requestedDeviceId || process.env.DEFAULT_REPORT_DEVICE_ID || 'ESP32_GENERATOR_01';
        const hours = parseInt(req.query.hours || '24', 10);
        const since = new Date(Date.now() - hours * 3600000);
        const query = { startedAt: { $gte: since } };
        if (effectiveDeviceId) query.deviceId = effectiveDeviceId;

        const rows = await ActiveTimeHistory.find(query).lean();
        const now = Date.now();
        const totalDurationMs = rows.reduce((sum, row) => {
            const started = new Date(row.startedAt).getTime();
            const ended = row.endedAt ? new Date(row.endedAt).getTime() : now;
            return sum + Math.max(0, ended - started);
        }, 0);

        res.json({
            success: true,
            data: {
                hoursWindow: hours,
                totalDurationMs,
                totalDurationHours: +(totalDurationMs / 3600000).toFixed(2),
                totalSessions: rows.length
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- API UNTUK CONFIG THRESHOLD ---

// 1. GET Thresholds (Untuk ditampilkan di Modal Frontend)
app.get('/api/thresholds', (req, res) => {
    res.json({ success: true, data: ACTIVE_THRESHOLDS });
});

// 2. UPDATE Thresholds (Saat user klik Save di Frontend)
app.post('/api/thresholds', async (req, res) => {
    try {
        const newThresholds = req.body; // Expect { param: { min: x, max: y } }
        
        // Merge dengan existing
        ACTIVE_THRESHOLDS = { ...ACTIVE_THRESHOLDS, ...newThresholds };
        
        // Simpan Permanen ke DB
        await Config.findOneAndUpdate(
            { key: 'engine_thresholds' },
            { value: ACTIVE_THRESHOLDS },
            { upsert: true, new: true }
        );
        
        console.log('⚙️ Thresholds Updated:', ACTIVE_THRESHOLDS);
        res.json({ success: true, message: 'Thresholds updated successfully', data: ACTIVE_THRESHOLDS });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
// --- TAMBAHAN API UNTUK ALARM (ACKNOWLEDGE & REMOVE) ---

// 1. API untuk tombol ACKNOWLEDGE (Ubah status jadi resolved)
app.put('/api/alerts/:id/ack', async (req, res) => {
    try {
        // Cari alarm berdasarkan ID dan ubah 'resolved' jadi true
        const updatedAlert = await Alert.findByIdAndUpdate(
            req.params.id, 
            { resolved: true },
            { new: true } // Opsi ini agar data yang dikembalikan adalah yang terbaru
        );
        
        if (!updatedAlert) {
            return res.status(404).json({ success: false, message: "Alarm not found" });
        }

        console.log(`✅ Alarm Acknowledged: ${req.params.id}`);
        res.json({ success: true, data: updatedAlert });
    } catch (error) {
        console.error("Ack Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. API untuk tombol REMOVE (Hapus permanen dari database)
app.delete('/api/alerts/:id', async (req, res) => {
    try {
        await Alert.findByIdAndDelete(req.params.id);
        console.log(`🗑️ Alarm Deleted: ${req.params.id}`);
        res.json({ success: true, message: 'Alarm deleted successfully' });
    } catch (error) {
        console.error("Delete Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- 1. UPDATE SCHEMA MAINTENANCE ---
// ==========================================
//  TAMBAHAN: MAINTENANCE API (LOGIC BARU)
// ==========================================

// 1. Buat Schema untuk Database Maintenance
const maintenanceSchema = new mongoose.Schema({
    task: { type: String, required: true },       // Nama Tugas
    type: String,                                 // Tipe: Preventive/Corrective
    priority: String,                             // Priority: High/Med/Low
    cost: { type: Number, default: 0, min: 0 },  // Estimasi biaya maintenance
    status: { type: String, default: 'scheduled' }, // scheduled, completed, etc.
    dueDate: Date,
    assignedTo: String,
    source: String,
    suggestionId: String,
    createdAt: { type: Date, default: Date.now }, // Tanggal dibuat
    completedAt: Date                             // Tanggal selesai
});
const Maintenance = mongoose.model('Maintenance', maintenanceSchema);

const maintenanceSuggestionSchema = new mongoose.Schema({
    source: { type: String, default: 'system' },
    status: { type: String, default: 'pending', enum: ['pending', 'approved', 'consumed'] },
    decisionStatus: { type: String, enum: ['AMAN', 'WASPADA', 'BAHAYA'], required: true },
    message: { type: String, required: true },
    recommendation: { type: String, required: true },
    priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    suggestedDate: Date,
    createdAt: { type: Date, default: Date.now },
    approvedAt: Date
});
const MaintenanceSuggestion = mongoose.model('MaintenanceSuggestion', maintenanceSuggestionSchema);

// 2. API: Ambil Data Maintenance (Untuk Dashboard & Halaman Maintenance)
app.get('/api/maintenance', async (req, res) => {
    try {
        // Ambil semua data, urutkan dari yang paling baru dibuat
        const logs = await Maintenance.find().sort({ createdAt: -1 });
        res.json({ success: true, data: logs });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. API: Simpan Data Baru (Dari tombol "Save" di Halaman Maintenance)
app.post('/api/maintenance', async (req, res) => {
    try {
        const newTask = new Maintenance(req.body);
        await newTask.save();
        console.log('🔧 New Maintenance Task:', newTask.task);
        res.json({ success: true, data: newTask });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. API: Update Status (Contoh: Klik tombol Complete/Checklist)
app.put('/api/maintenance/:id', async (req, res) => {
    try {
        const updated = await Maintenance.findByIdAndUpdate(
            req.params.id, 
            req.body, 
            { new: true }
        );
        res.json({ success: true, data: updated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 5. API: Hapus Data (Tombol Delete)
app.delete('/api/maintenance/:id', async (req, res) => {
    try {
        await Maintenance.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

async function buildMaintenanceDecisionPayload() {
    const latestSensor = await GeneratorData.findOne().sort({ timestamp: -1 }).lean();
    const alertCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentAlerts = await Alert.find({ timestamp: { $gte: alertCutoff } })
        .sort({ timestamp: -1 })
        .limit(100)
        .lean();

    const decision = generateMaintenanceDecision(latestSensor || {}, recentAlerts);
    const pendingSuggestion = await MaintenanceSuggestion.findOne({ status: 'pending' })
        .sort({ createdAt: -1 })
        .lean();

    return {
        ...decision,
        suggestion: pendingSuggestion || null
    };
}

app.get('/api/maintenance/suggestion', async (req, res) => {
    try {
        const payload = await buildMaintenanceDecisionPayload();
        res.json({ success: true, data: payload });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/maintenance/suggestion', async (req, res) => {
    try {
        const payload = await buildMaintenanceDecisionPayload();
        res.json({ success: true, data: payload });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/maintenance/suggestion', async (req, res) => {
    try {
        const { decisionStatus, status, message, recommendation, suggestedDate, source } = req.body || {};
        if (!decisionStatus || !message || !recommendation) {
            return res.status(400).json({ success: false, error: 'decisionStatus, message, recommendation are required' });
        }

        const suggestion = await new MaintenanceSuggestion({
            source: source || 'system',
            status: status || 'pending',
            decisionStatus,
            message,
            recommendation,
            suggestedDate: suggestedDate ? new Date(suggestedDate) : null,
            approvedAt: new Date()
        }).save();

        res.json({ success: true, data: suggestion });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/maintenance/suggestion', async (req, res) => {
    try {
        const { decisionStatus, status, message, recommendation, suggestedDate, source } = req.body || {};
        if (!decisionStatus || !message || !recommendation) {
            return res.status(400).json({ success: false, error: 'decisionStatus, message, recommendation are required' });
        }

        const suggestion = await new MaintenanceSuggestion({
            source: source || 'system',
            status: status || 'pending',
            decisionStatus,
            message,
            recommendation,
            suggestedDate: suggestedDate ? new Date(suggestedDate) : null,
            approvedAt: new Date()
        }).save();

        res.json({ success: true, data: suggestion });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/maintenance/suggestion/:id/status', async (req, res) => {
    try {
        const updated = await MaintenanceSuggestion.findByIdAndUpdate(
            req.params.id,
            { status: req.body?.status || 'scheduled' },
            { new: true }
        );
        res.json({ success: true, data: updated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
// Tambahkan kode ini di dalam server.js (sebelum app.listen)





async function getCurrentMaintenanceDecision(deviceId) {
    const effectiveDeviceId = deviceId || process.env.DEFAULT_REPORT_DEVICE_ID || null;
    const sensorQuery = effectiveDeviceId ? { deviceId: effectiveDeviceId } : {};
    const [sensorData, alertHistory] = await Promise.all([
        GeneratorData.find(sensorQuery).sort({ timestamp: -1 }).limit(10).lean(),
        Alert.find(sensorQuery).sort({ timestamp: -1 }).limit(30).lean()
    ]);

    return generateMaintenanceDecision(sensorData, alertHistory);
}

app.get('/maintenance/suggestion', async (req, res) => {
    try {
        const { deviceId } = req.query;
        const decision = await getCurrentMaintenanceDecision(deviceId);
        const latestSuggestion = await MaintenanceSuggestion.findOne({ source: 'system' }).sort({ createdAt: -1 }).lean();

        res.json({ success: true, data: decision, suggestion: latestSuggestion || null });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/maintenance/suggestion', async (req, res) => {
    try {
        const { deviceId } = req.query;
        const decision = await getCurrentMaintenanceDecision(deviceId);
        const latestSuggestion = await MaintenanceSuggestion.findOne({ source: 'system' }).sort({ createdAt: -1 }).lean();

        res.json({ success: true, data: decision, suggestion: latestSuggestion || null });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/maintenance/suggestion', async (req, res) => {
    try {
        const { action = 'approve', decision: clientDecision, deviceId } = req.body || {};
        if (action !== 'approve') {
            return res.status(400).json({ success: false, error: 'Unsupported action' });
        }

        const decision = clientDecision || await getCurrentMaintenanceDecision(deviceId);
        const suggestionPayload = toSuggestionDocument(decision);
        suggestionPayload.approvedAt = new Date();

        const saved = await new MaintenanceSuggestion(suggestionPayload).save();

        res.json({ success: true, data: saved });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/maintenance/suggestion', async (req, res) => {
    try {
        const { action = 'approve', decision: clientDecision, deviceId } = req.body || {};
        if (action !== 'approve') {
            return res.status(400).json({ success: false, error: 'Unsupported action' });
        }

        const decision = clientDecision || await getCurrentMaintenanceDecision(deviceId);
        const suggestionPayload = toSuggestionDocument(decision);
        suggestionPayload.approvedAt = new Date();

        const saved = await new MaintenanceSuggestion(suggestionPayload).save();

        res.json({ success: true, data: saved });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/reports/analysis', async (req, res) => {
    try {
        const { rows, sensor, maxPoints } = req.body || {};
        const parsed = analyzeReportRows(
            Array.isArray(rows) ? rows : [],
            sensor || 'rpm',
            Number.isFinite(Number(maxPoints)) ? Number(maxPoints) : 300
        );

        res.json({ success: parsed.ok !== false, data: parsed });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── Helper: build MongoDB aggregation stats (bySensor) ──────────────────────
//  Runs a single $group pipeline over the given query and returns the same
//  { totalMatched, bySensor } shape expected by the frontend.
const SENSOR_KEYS_FOR_STATS = ['rpm','volt','amp','power','freq','temp','coolant','fuel','iat','afr','tps','batt'];

async function buildSensorStats(collection, matchQuery) {
    const groupStage = { _id: null, totalMatched: { $sum: 1 } };
    SENSOR_KEYS_FOR_STATS.forEach((key) => {
        groupStage[`${key}Count`] = { $sum: { $cond: [{ $ne: [`$${key}`, null] }, 1, 0] } };
        groupStage[`${key}Avg`]   = { $avg: `$${key}` };
        groupStage[`${key}Min`]   = { $min: `$${key}` };
        groupStage[`${key}Max`]   = { $max: `$${key}` };
    });

    const [summary] = await collection.aggregate([
        { $match: matchQuery },
        { $group: groupStage }
    ]).toArray();

    if (!summary) return { totalMatched: 0, bySensor: {} };

    const bySensor = {};
    SENSOR_KEYS_FOR_STATS.forEach((key) => {
        const avg = summary[`${key}Avg`];
        const min = summary[`${key}Min`];
        const max = summary[`${key}Max`];
        if ([avg, min, max].some((v) => Number.isFinite(Number(v)))) {
            bySensor[key] = {
                count: Number(summary[`${key}Count`]) || 0,
                avg:   Number.isFinite(Number(avg)) ? +Number(avg).toFixed(4)  : null,
                min:   Number.isFinite(Number(min)) ? Number(min) : null,
                max:   Number.isFinite(Number(max)) ? Number(max) : null
            };
        }
    });

    return { totalMatched: Number(summary.totalMatched) || 0, bySensor };
}

// API Endpoint untuk mengambil data report dari collection MongoDB yang ditetapkan
app.get('/api/reports', async (req, res) => {
    try {
        // ── FIX: tunggu DB benar-benar siap; jika gagal setelah retry, return error
        //    jelas (bukan diam-diam fallback ke 1 data dari memory).
        try {
            await ensureDbReady();
        } catch (dbErr) {
            return res.status(503).json({
                success: false,
                error: 'Database not ready. Please retry in a moment.',
                data: [], count: 0, stats: { totalMatched: 0, bySensor: {} }
            });
        }

        if (!isDbReady()) {
            return res.status(503).json({
                success: false,
                error: 'Database connection unavailable.',
                data: [], count: 0, stats: { totalMatched: 0, bySensor: {} }
            });
        }
        const parsedLimit = parseInt(req.query.limit, 10);
        const limit = Number.isNaN(parsedLimit) ? 5000 : Math.max(1, Math.min(parsedLimit, 100000));
        // ── FIX: extract deviceId so both data and stats are filtered per device
        const { hours, startDate, endDate, deviceId } = req.query;

        const normalizeNumeric = (value) => {
            if (value === null || value === undefined || value === '') return null;
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        };

        const normalizeRow = (row) => {
            const timestamp = row.timestamp || row.createdAt || row.date || row.waktu || null;
            if (!timestamp) return null;

            return {
                ...row,
                timestamp,
                rpm:     normalizeNumeric(row.rpm),
                volt:    normalizeNumeric(row.volt    ?? row.voltage),
                amp:     normalizeNumeric(row.amp     ?? row.current),
                power:   normalizeNumeric(row.power   ?? row.kw ?? row.kW),
                freq:    normalizeNumeric(row.freq    ?? row.frequency),
                temp:    normalizeNumeric(row.temp    ?? row.temperature),
                coolant: normalizeNumeric(row.coolant ?? row.temp ?? row.temperature),
                fuel:    normalizeNumeric(row.fuel),
                iat:     normalizeNumeric(row.iat),
                batt:    normalizeNumeric(row.batt ?? row.battery ?? row.battVolt),
                afr:     normalizeNumeric(row.afr),
                tps:     normalizeNumeric(row.tps)
            };
        };

        // ── FIX: parse dates as UTC (not local time) so the range matches
        //    MongoDB's UTC-stored timestamps exactly
        const timeFilter = {};
        if (startDate && endDate) {
            const start = new Date(startDate);   // ISO string from frontend → already UTC
            const end   = new Date(endDate);
            if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
                timeFilter.$gte = start;
                timeFilter.$lte = end;
            }
        } else if (hours) {
            const h = Number(hours);
            if (!Number.isNaN(h) && h > 0) {
                timeFilter.$gte = new Date(Date.now() - h * 3600 * 1000);
            }
        }

        // ── FIX: always include deviceId when provided
        const buildMatchQuery = (timestampField = 'timestamp') => {
            const q = {};
            if (Object.keys(timeFilter).length) q[timestampField] = timeFilter;
            if (deviceId) q.deviceId = deviceId;
            return q;
        };

        const buildFieldCondition = (fieldName) =>
            Object.keys(timeFilter).length ? { [fieldName]: timeFilter } : { [fieldName]: { $exists: true } };

        const mergeUniqueRows = (rows) => {
            const seen = new Set();
            const out  = [];
            for (const row of rows) {
                const ts  = row.timestamp || row.createdAt || row.date || row.waktu || '';
                const key = `${row._id || ''}|${ts}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(row);
            }
            return out;
        };

        let reports     = [];
        let statsResult = { totalMatched: 0, bySensor: {} };
        let usedCollection = null;

        const candidateCollections = ['reports', 'generatordatas', 'generator_data'];

        if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
            const existingCollections = await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
            const existingNames = new Set(existingCollections.map((c) => c.name));

            for (const collectionName of candidateCollections) {
                if (!existingNames.has(collectionName)) continue;

                const collection = mongoose.connection.db.collection(collectionName);

                // Build $or with optional deviceId for raw find()
                // SESUDAH (✅ sort & limit langsung di MongoDB)
                const matchQuery = buildMatchQuery('timestamp');

                const count = await collection.countDocuments(matchQuery);
                if (!count) continue;

                const docs = await collection
                    .find(matchQuery)
                    .sort({ timestamp: -1 })
                    .limit(limit)
                    .toArray();

                if (docs.length) {
                    reports = docs;
                    usedCollection = collection;
                    break;
                }
            }

            // ── Run MongoDB aggregation on the same collection that provided data ──
            if (usedCollection) {
                const statsMatch = buildMatchQuery('timestamp');
                statsResult = await buildSensorStats(usedCollection, statsMatch);
            }
        }

        if (!reports.length && isDbReady()) {
            const fallbackQuery = buildMatchQuery('timestamp');
            reports = await GeneratorData.find(fallbackQuery)
                .sort({ timestamp: -1, createdAt: -1, date: -1 })
                .limit(limit)
                .lean();

            // Run aggregation via Mongoose model as fallback
            if (reports.length) {
                const rawCollection = mongoose.connection.db.collection('generatordatas');
                statsResult = await buildSensorStats(rawCollection, fallbackQuery);
            }
        }

        const normalizedReports = reports
            .map(normalizeRow)
            .filter(Boolean)
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        res.json({
            success: true,
            count:   normalizedReports.length,
            data:    normalizedReports,
            // ── FIX: include MongoDB aggregation stats so frontend never needs
            //    to recompute min/max/avg from a limited/cleaned subset ──
            stats:   statsResult,
            source:  isDbReady() ? 'database' : 'memory'
        });
    } catch (err) {
        res.json({ success: true, count: 0, data: [], stats: { totalMatched: 0, bySensor: {} }, source: 'memory', warning: err.message });
    }
});

// ── Dedicated stats-only endpoint (called in parallel by frontend) ──────────
//  Same aggregation as above but returns only stats — no row data payload.
//  This ensures the frontend always has authoritative MongoDB stats even when
//  the main /api/reports response is slow or partially cached.
app.get('/api/reports/stats', async (req, res) => {
    try {
        await ensureDbReady().catch(() => undefined);
        const { hours, startDate, endDate, deviceId } = req.query;

        const timeFilter = {};
        if (startDate && endDate) {
            const start = new Date(startDate);
            const end   = new Date(endDate);
            if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
                timeFilter.$gte = start;
                timeFilter.$lte = end;
            }
        } else if (hours) {
            const h = Number(hours);
            if (!Number.isNaN(h) && h > 0) timeFilter.$gte = new Date(Date.now() - h * 3600 * 1000);
        }

        const matchQuery = {};
        if (Object.keys(timeFilter).length) matchQuery.timestamp = timeFilter;
        if (deviceId) matchQuery.deviceId = deviceId;

        if (!isDbReady()) {
            return res.json({ success: false, error: 'Database not ready' });
        }

        // Use the same collection-discovery logic so stats always come from the
        // same collection that /api/reports serves data from.
        const candidateCollections = ['reports', 'generatordatas', 'generator_data'];
        const existingCollections  = await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
        const existingNames        = new Set(existingCollections.map((c) => c.name));

        let statsResult = null;
        for (const collectionName of candidateCollections) {
            if (!existingNames.has(collectionName)) continue;
            const collection = mongoose.connection.db.collection(collectionName);
            // Quick check: does this collection have matching docs?
            const sample = await collection.findOne(matchQuery);
            if (!sample) continue;
            statsResult = await buildSensorStats(collection, matchQuery);
            break;
        }

        if (!statsResult) {
            // Last resort: GeneratorData model
            const rawCollection = mongoose.connection.db.collection('generatordatas');
            statsResult = await buildSensorStats(rawCollection, matchQuery);
        }

        res.json({ success: true, stats: statsResult });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// const maintenanceSchema = new mongoose.Schema({
//     task: { type: String, required: true },
//     type: String,
//     priority: String,
//     status: { type: String, default: 'scheduled' },
//     dueDate: Date,
//     assignedTo: String,
//     createdAt: { type: Date, default: Date.now },
//     completedAt: Date
// });
// const Maintenance = mongoose.model('Maintenance', maintenanceSchema);

// // --- 2. UPDATE API ENDPOINTS ---

// // GET: Ambil semua data (Bisa filter lewat query)
// app.get('/api/maintenance', async (req, res) => {
//     try {
//         const logs = await Maintenance.find().sort({ dueDate: 1 }); // Urutkan berdasarkan tenggat waktu
//         res.json({ success: true, data: logs });
//     } catch (error) {
//         res.status(500).json({ success: false, error: error.message });
//     }
// });

// // POST: Tambah data baru dari halaman Maintenance
// app.post('/api/maintenance', async (req, res) => {
//     try {
//         const newTask = new Maintenance(req.body);
//         await newTask.save();
//         res.json({ success: true, data: newTask });
//     } catch (error) {
//         res.status(500).json({ success: false, error: error.message });
//     }
// });

// // PUT: Update status (misal: Complete task)
// app.put('/api/maintenance/:id', async (req, res) => {
//     try {
//         const updated = await Maintenance.findByIdAndUpdate(req.params.id, req.body, { new: true });
//         res.json({ success: true, data: updated });
//     } catch (error) {
//         res.status(500).json({ success: false, error: error.message });
//     }
// });

// // DELETE: Hapus task
// app.delete('/api/maintenance/:id', async (req, res) => {
//     try {
//         await Maintenance.findByIdAndDelete(req.params.id);
//         res.json({ success: true });
//     } catch (error) {
//         res.status(500).json({ success: false, error: error.message });
//     }
// });


app.post('/api/auth/login', async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim().toLowerCase();
        const password = String(req.body?.password || '');

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email dan password wajib diisi.' });
        }

        const user = await User.findOne({ email }).lean();
        if (!user || user.password !== password) {
            return res.status(401).json({ success: false, message: 'Email atau password tidak valid.' });
        }

        const role = String(user.role || '').toLowerCase();
        const isMasyarakat = role === 'masyarakat' || role === 'user' || role === 'viewer';
        const redirectTo = isMasyarakat ? 'public.html' : 'index.html';

        return res.json({
            success: true,
            user: {
                name: user.name || user.email.split('@')[0],
                email: user.email,
                role: user.role || (isMasyarakat ? 'Masyarakat' : 'Teknisi'),
                redirectTo
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server login.', error: error.message });
    }
});


app.get('/api/health', (req, res) => res.json({ status: 'healthy', mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' }));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ── CRITICAL: Semua route /api/* yang tidak cocok harus return JSON, BUKAN HTML.
// Tanpa ini, catch-all di bawah akan mengembalikan login.html untuk endpoint
// yang tidak ditemukan, menyebabkan error "Unexpected token '<'" di frontend.
app.use('/api', (req, res) => {
    res.status(404).json({ success: false, error: `API endpoint not found: ${req.method} ${req.originalUrl}` });
});

// Catch-all untuk halaman frontend — HARUS di bawah semua route API
app.get(/(.*)/, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'login.html')); });

const PORT = process.env.PORT || 3000;

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 Server running: http://localhost:${PORT}`);
    });
}

module.exports = app;