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

const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
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
const { analyzeCBM } = require('./lib_cbm_analysis');

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
    rpm: Number, volt: Number, volt_grid: Number, amp: Number, power: Number,
    freq: Number, freq_grid: Number, temp: Number, coolant: Number, fuel: Number,
    sync: String, status: String, iat: Number, map: Number, batt: Number, afr: Number, tps: Number
});
const GeneratorData = mongoose.model('GeneratorData', generatorDataSchema);

const fftDataSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now, index: true },
    deviceId: { type: String, required: true, index: true },
    source: { type: String, default: '' },
    sampleRateHz: Number,
    samples: Number,
    resolutionHz: Number,
    peakHz: Number,
    peakMagnitude: Number,
    rms: Number,
    freqBins: [Number],
    magBins: [Number]
});
const FFTData = mongoose.models.FFTData || mongoose.model('FFTData', fftDataSchema, 'fftdata');

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
    closeReason: { type: String, default: null },
    source: { type: String, enum: ['mqtt', 'manual'], default: 'mqtt' },
    calc: {
        rpmThreshold: { type: Number, default: 0 },
        rule: { type: String, default: 'status=RUNNING OR rpm>threshold' },
        sampledAt: { type: Date, default: Date.now }
    }
}, { timestamps: true });
const ActiveTimeHistory = mongoose.models.ActiveTimeHistory || mongoose.model('ActiveTimeHistory', activeTimeHistorySchema, 'activetimehistories');


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

// Tambahkan parameter targetEmail
async function sendCriticalAlertEmail(alertItems, latestSnapshot, targetEmail) {
    const apiKey = process.env.SENDGRID_API_KEY;
    const senderEmail = process.env.SENDER_EMAIL;

    if (!apiKey) {
        console.warn('⚠️ SENDGRID_API_KEY tidak ditemukan.');
        return;
    }

    // Penentuan Penerima (Hanya user login atau semua user)
    let uniqueRecipients = [];
    if (targetEmail) {
        uniqueRecipients = [targetEmail.trim().toLowerCase()];
    } else {
        const users = await User.find({}, { email: 1, _id: 0 }).lean();
        uniqueRecipients = [...new Set(users.map(u => u.email.trim().toLowerCase()))];
    }

    if (uniqueRecipients.length === 0) return;

    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(apiKey);

    // LOGIKA GRUP: Membuat ringkasan untuk Subjek Email
    // Contoh Subjek: [CRITICAL] Masalah pada RPM, VOLT, TEMP
    const parameterNames = alertItems.map(a => a.parameter.toUpperCase()).join(', ');
    const subjectTitle = alertItems.length > 1 
        ? `🚨 MULTI-ALERT: Masalah pada ${parameterNames}`
        : `🚨 ALERT KRITIS: ${parameterNames}`;

    // Membuat Baris Tabel untuk isi Email agar lebih profesional
    const rowsHtml = alertItems.map(a => `
        <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 10px; font-weight: bold; color: #d9534f;">${a.parameter.toUpperCase()}</td>
            <td style="padding: 10px;">${a.value}</td>
            <td style="padding: 10px; font-style: italic;">${a.message}</td>
        </tr>
    `).join('');

    const msg = {
        to: uniqueRecipients,
        from: senderEmail,
        subject: subjectTitle,
        html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #d9534f; border-radius: 10px; overflow: hidden;">
                <div style="background-color: #d9534f; color: white; padding: 20px; text-align: center;">
                    <h2 style="margin: 0;">Laporan Anomali Generator</h2>
                    <p style="margin: 5px 0 0 0;">ID Mesin: ${latestSnapshot?.deviceId || 'GEN-TRACK'}</p>
                </div>
                <div style="padding: 20px;">
                    <p>Halo, sistem mendeteksi <b>${alertItems.length} parameter</b> dalam kondisi kritis:</p>
                    <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                        <thead>
                            <tr style="background-color: #f8f9fa; text-align: left;">
                                <th style="padding: 10px;">Parameter</th>
                                <th style="padding: 10px;">Nilai</th>
                                <th style="padding: 10px;">Keterangan</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rowsHtml}
                        </tbody>
                    </table>
                    <p style="font-size: 14px; color: #666;">
                        <b>Waktu Kejadian:</b> ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB
                    </p>
                    <div style="text-align: center; margin-top: 30px;">
                        <a href="https://generator-monitoring-system.onrender.com" 
                           style="background-color: #0275d8; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">
                           Buka Dashboard Monitoring
                        </a>
                    </div>
                </div>
                <div style="background-color: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #999;">
                    Pesan otomatis - Harap tidak membalas email ini.
                </div>
            </div>
        `
    };

    try {
        await sgMail.sendMultiple(msg);
        console.log(`✅ Grup Alert terkirim (${alertItems.length} parameter) ke: ${uniqueRecipients}`);
    } catch (error) {
        console.error('❌ SendGrid Error:', error.message);
    }
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
    batt: { min: 11.8, max: 14.8 },
    map: { min: 20, max: 250 }
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
    rpm: 0, volt: 0, volt_grid: 0, amp: 0, power: 0, freq: 0, freq_grid: 0, temp: 0, coolant: 0,
    fuel: 0, sync: 'OFF-GRID', status: 'STOPPED', oil: 0, iat: 0, map: 0, batt: 0, afr: 0, tps: 0
};
let activeSessions = new Map();
const ECU_DISCONNECT_THRESHOLD_MS = parseInt(process.env.ECU_DISCONNECT_THRESHOLD_MS || '30000', 10);
const ACTIVE_SESSION_TIMEOUT_MS = ECU_DISCONNECT_THRESHOLD_MS;

function isEngineRunning(data) {
    const status = String(data?.status || '').toUpperCase();
    const rpm = Number(data?.rpm || 0);
    return status === 'RUNNING' || status === 'ON-GRID' || rpm > 0;
}

function safeEventTime(value) {
    const dt = value ? new Date(value) : new Date();
    return Number.isNaN(dt.getTime()) ? new Date() : dt;
}

function getSessionSampledAt(row) {
    const sampledAt = row?.calc?.sampledAt ? new Date(row.calc.sampledAt) : null;
    if (sampledAt && !Number.isNaN(sampledAt.getTime())) return sampledAt;
    const startedAt = row?.startedAt ? new Date(row.startedAt) : null;
    return startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : new Date();
}

function getEffectiveSessionEnd(row, referenceTime = new Date()) {
    const endedAt = row?.endedAt ? new Date(row.endedAt) : null;
    if (endedAt && !Number.isNaN(endedAt.getTime())) return endedAt;

    const sampledAt = getSessionSampledAt(row);
    const reference = safeEventTime(referenceTime);
    const elapsedSinceSample = reference.getTime() - sampledAt.getTime();
    return elapsedSinceSample > ACTIVE_SESSION_TIMEOUT_MS ? sampledAt : reference;
}

function decorateActiveTimeRow(row, referenceTime = new Date()) {
    const plain = typeof row?.toObject === 'function' ? row.toObject() : { ...row };
    const startedAt = safeEventTime(plain.startedAt);
    const effectiveEndedAt = getEffectiveSessionEnd(plain, referenceTime);
    const effectiveDurationMs = Math.max(0, effectiveEndedAt.getTime() - startedAt.getTime());

    return {
        ...plain,
        effectiveEndedAt,
        effectiveDurationMs,
        isOpen: !plain.endedAt && effectiveEndedAt.getTime() >= referenceTime.getTime() - 1000
    };
}

async function finalizeOpenActiveSession(deviceId, startedAt, endedAt, reason = 'esp32_disconnect') {
    const start = safeEventTime(startedAt);
    const end = safeEventTime(endedAt);
    const durationMs = Math.max(0, end.getTime() - start.getTime());

    return ActiveTimeHistory.findOneAndUpdate(
        { deviceId, startedAt: start, endedAt: null },
        {
            endedAt: end,
            durationMs,
            closeReason: reason,
            calc: { rpmThreshold: 0, sampledAt: end }
        },
        { sort: { createdAt: -1 }, new: true }
    );
}

async function closeActiveSessions(reason = 'esp32_disconnect', requestedDeviceId = null) {
    const closed = [];

    for (const [key, session] of activeSessions.entries()) {
        const [deviceId] = key.split('|');
        if (requestedDeviceId && deviceId !== requestedDeviceId) continue;
        const endedAt = session.lastSeenAt || new Date();
        try {
            const row = await finalizeOpenActiveSession(deviceId, session.startedAt, endedAt, reason);
            if (row) closed.push(row);
        } catch (e) {
            console.error('Failed closing active session:', e.message);
        }
        activeSessions.delete(key);
    }

    const query = { endedAt: null };
    if (requestedDeviceId) query.deviceId = requestedDeviceId;
    const openRows = await ActiveTimeHistory.find(query).lean();
    for (const row of openRows) {
        const endedAt = getEffectiveSessionEnd(row, new Date());
        try {
            const updated = await finalizeOpenActiveSession(row.deviceId, row.startedAt, endedAt, reason);
            if (updated) closed.push(updated);
        } catch (e) {
            console.error('Failed closing DB active session:', e.message);
        }
    }

    return closed;
}

async function closeStaleActiveSessions(requestedDeviceId = null) {
    const closed = [];
    const now = new Date();

    for (const [key, session] of activeSessions.entries()) {
        const [deviceId] = key.split('|');
        if (requestedDeviceId && deviceId !== requestedDeviceId) continue;
        if (now.getTime() - session.lastSeenAt.getTime() <= ACTIVE_SESSION_TIMEOUT_MS) continue;
        try {
            const row = await finalizeOpenActiveSession(deviceId, session.startedAt, session.lastSeenAt, 'esp32_disconnect');
            if (row) closed.push(row);
        } catch (e) {
            console.error('Failed closing stale active session:', e.message);
        }
        activeSessions.delete(key);
    }

    const query = { endedAt: null };
    if (requestedDeviceId) query.deviceId = requestedDeviceId;
    const openRows = await ActiveTimeHistory.find(query).lean();
    for (const row of openRows) {
        const sampledAt = getSessionSampledAt(row);
        if (now.getTime() - sampledAt.getTime() <= ACTIVE_SESSION_TIMEOUT_MS) continue;
        try {
            const updated = await finalizeOpenActiveSession(row.deviceId, row.startedAt, sampledAt, 'esp32_disconnect');
            if (updated) closed.push(updated);
        } catch (e) {
            console.error('Failed closing stale DB active session:', e.message);
        }
    }

    return closed;
}

async function syncActiveTimeHistory(data) {
    const rpmThreshold = 0;
    const eventTime = safeEventTime(data?.timestamp);
    const dataAgeMs = Math.abs(Date.now() - eventTime.getTime());
    const isEcuConnected = dataAgeMs <= ECU_DISCONNECT_THRESHOLD_MS;
    const isRunning = isEcuConnected && isEngineRunning(data);
    const deviceId = data?.deviceId || latestData.deviceId || 'GENERATOR #1';
    const key = `${deviceId}`;
    let session = activeSessions.get(key);

    if (!session) {
        const openRow = await ActiveTimeHistory.findOne({ deviceId, endedAt: null }).sort({ startedAt: -1 }).lean();
        if (openRow) {
            const sampledAt = getSessionSampledAt(openRow);
            const gapMs = eventTime.getTime() - sampledAt.getTime();
            if (isRunning && gapMs >= 0 && gapMs <= ACTIVE_SESSION_TIMEOUT_MS) {
                session = { startedAt: safeEventTime(openRow.startedAt), lastSeenAt: sampledAt };
                activeSessions.set(key, session);
            } else {
                await finalizeOpenActiveSession(deviceId, openRow.startedAt, sampledAt, 'esp32_disconnect');
            }
        }
    }

    if (isRunning && !session) {
        activeSessions.set(key, { startedAt: eventTime, lastSeenAt: eventTime });
        await ActiveTimeHistory.create({
            deviceId,
            startedAt: eventTime,
            source: 'mqtt',
            calc: { rpmThreshold, sampledAt: eventTime }
        });
        return;
    }

    if (isRunning && session) {
        const gapMs = eventTime.getTime() - session.lastSeenAt.getTime();
        if (gapMs > ACTIVE_SESSION_TIMEOUT_MS) {
            await finalizeOpenActiveSession(deviceId, session.startedAt, session.lastSeenAt, 'esp32_disconnect');

            activeSessions.set(key, { startedAt: eventTime, lastSeenAt: eventTime });
            await ActiveTimeHistory.create({
                deviceId,
                startedAt: eventTime,
                source: 'mqtt',
                calc: { rpmThreshold, sampledAt: eventTime }
            });
            return;
        }

        session.lastSeenAt = eventTime;
        await ActiveTimeHistory.findOneAndUpdate(
            { deviceId, startedAt: session.startedAt, endedAt: null },
            { calc: { rpmThreshold, sampledAt: eventTime } },
            { sort: { createdAt: -1 } }
        );
        return;
    }

    if (!isRunning && session) {
        await finalizeOpenActiveSession(deviceId, session.startedAt, eventTime, 'engine_stopped');
        activeSessions.delete(key);
        return;
    }

    if (!isRunning) {
        await closeActiveSessions(isEcuConnected ? 'engine_stopped' : 'esp32_disconnect', deviceId);
    }
}


setInterval(async () => {
    const now = new Date();
    for (const [key, session] of activeSessions.entries()) {
        const idleMs = now.getTime() - session.lastSeenAt.getTime();
        if (idleMs <= ACTIVE_SESSION_TIMEOUT_MS) continue;

        const [deviceId] = key.split('|');
        const endedAt = session.lastSeenAt;

        try {
            await finalizeOpenActiveSession(deviceId, session.startedAt, endedAt, 'esp32_disconnect');
        } catch (e) {
            console.error('Failed closing stale active session:', e.message);
        }

        activeSessions.delete(key);
    }
}, 10000);

mqttClient.on('connect', () => {
    console.log('✅ Connected to MQTT Broker (shiftr.io)');
    mqttClient.subscribe('gen/realtime', (err) => {
        if (err) console.error('❌ Subscribe error (gen/realtime):', err.message);
        else console.log('📡 Subscribed to gen/realtime');
    });
    mqttClient.subscribe('gen/data', (err) => {
        if (err) console.error('❌ Subscribe error (gen/data):', err.message);
        else console.log('📡 Subscribed to gen/data');
    });
});

mqttClient.on('reconnect', () => console.log('🔄 MQTT Reconnecting...'));
mqttClient.on('offline',   () => console.warn('⚠️  MQTT Offline'));

mqttClient.on('error', (error) => {
    console.warn('⚠️ MQTT Error:', error.message);
});

// Auto-save ke DB setiap 1 detik dari snapshot gen/data.
// ESP32 mengirim semua variabel sebagai satu JSON ke topik gen/data.
let lastSaveAt = 0;
const SAVE_INTERVAL_MS = 1_000; // simpan tiap 1 detik

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
    check('map', data.map);
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

        const criticalAlerts = alertsToSave.filter((a) => a.severity === 'critical');
        const now = Date.now();
        if (criticalAlerts.length > 0 && (now - lastCriticalEmailAt) > ALERT_EMAIL_COOLDOWN_MS) {
            try {
                await sendCriticalAlertEmail(criticalAlerts, data);
                lastCriticalEmailAt = now;
                console.log(`📧 Critical alert email sent (${criticalAlerts.length} alert)`);
            } catch (emailError) {
                console.error('❌ Gagal mengirim email alert critical:', emailError.message);
            }
        }
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

function toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function pickEffectivePayload(rawPayload) {
    const payload = typeof rawPayload === 'object' && rawPayload !== null ? rawPayload : {};
    const records = Array.isArray(payload.records) ? payload.records : [];
    const latestRecord = records.length ? records[records.length - 1] : null;
    if (!latestRecord || typeof latestRecord !== 'object') return payload;

    return {
        ...payload,
        ...latestRecord,
        deviceId: latestRecord.deviceId || payload.deviceId,
        fft: latestRecord.fft ?? payload.fft
    };
}

function normalizeGeneratorPayload(rawPayload) {
    const payload = pickEffectivePayload(rawPayload);
    const eventTimestamp = payload.timestamp ? new Date(payload.timestamp) : new Date();
    const timestamp = Number.isNaN(eventTimestamp.getTime()) ? new Date() : eventTimestamp;

    const snapshot = {
        ...latestData,
        deviceId: payload.deviceId || latestData.deviceId || 'ESP32_GENERATOR_01',
        timestamp,
        rpm: toNumber(payload.rpm, latestData.rpm),
        volt: toNumber(payload.volt, latestData.volt),
        volt_grid: toNumber(payload.volt_grid ?? payload.voltGrid, latestData.volt_grid),
        amp: toNumber(payload.amp, latestData.amp),
        power: toNumber(payload.power, latestData.power),
        freq: toNumber(payload.freq, latestData.freq),
        freq_grid: toNumber(payload.freq_grid ?? payload.freqGrid, latestData.freq_grid),
        temp: toNumber(payload.temp ?? payload.coolant, latestData.temp),
        coolant: toNumber(payload.coolant ?? payload.temp, latestData.coolant),
        fuel: toNumber(payload.fuel, latestData.fuel),
        sync: String(payload.sync || latestData.sync || 'OFF-GRID'),
        status: String(payload.status || latestData.status || 'STOPPED'),
        oil: toNumber(payload.oil, latestData.oil),
        iat: toNumber(payload.iat, latestData.iat),
        map: toNumber(payload.map, latestData.map),
        batt: toNumber(payload.batt ?? payload.battery ?? payload.battVolt, latestData.batt),
        afr: toNumber(payload.afr, latestData.afr),
        tps: toNumber(payload.tps, latestData.tps),
        phaseAngle: toNumber(payload.phaseAngle ?? payload.phase_angle, latestData.phaseAngle ?? 0),
        _realtime: true
    };

    if (!payload.power && snapshot.volt && snapshot.amp) {
        snapshot.power = snapshot.volt * snapshot.amp;
    }

    if (!payload.status) {
        snapshot.status = snapshot.rpm > 0
            ? (snapshot.sync === 'ON-GRID' ? 'ON-GRID' : 'RUNNING')
            : 'STOPPED';
    }

    return snapshot;
}

function normalizeFftPayload(rawPayload, fallbackDeviceId) {
    const payload = pickEffectivePayload(rawPayload);
    const fft = payload.fft && typeof payload.fft === 'object' ? payload.fft : null;
    if (!fft || fft.valid !== true) return null;

    const freqBins = Array.isArray(fft.freqBins) ? fft.freqBins.map((v) => Number(v)).filter(Number.isFinite) : [];
    const magBins = Array.isArray(fft.magBins) ? fft.magBins.map((v) => Number(v)).filter(Number.isFinite) : [];
    const len = Math.min(freqBins.length, magBins.length);
    if (!len) return null;

    return {
        timestamp: (() => {
            const ts = payload.timestamp ? new Date(payload.timestamp) : new Date();
            return Number.isNaN(ts.getTime()) ? new Date() : ts;
        })(),
        deviceId: payload.deviceId || fallbackDeviceId || 'ESP32_GENERATOR_01',
        source: String(fft.source || ''),
        sampleRateHz: toNumber(fft.sampleRateHz, 0),
        samples: toNumber(fft.samples, len),
        resolutionHz: toNumber(fft.resolutionHz, 0),
        peakHz: toNumber(fft.peakHz, 0),
        peakMagnitude: toNumber(fft.peakMagnitude, 0),
        rms: toNumber(fft.rms, 0),
        freqBins: freqBins.slice(0, len),
        magBins: magBins.slice(0, len)
    };
}

mqttClient.on('message', async (topic, message) => {
    try {
        if (topic !== 'gen/realtime' && topic !== 'gen/data') return;

        const raw = message.toString();
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (parseError) {
            console.warn('⚠️ Invalid JSON on gen/data:', raw);
            return;
        }

        if (topic === 'gen/realtime') {
            latestData = normalizeGeneratorPayload(parsed);
            const fftDoc = normalizeFftPayload(parsed, latestData.deviceId);
            if (fftDoc) {
                latestData.fft = {
                    valid: true,
                    source: fftDoc.source,
                    sampleRateHz: fftDoc.sampleRateHz,
                    samples: fftDoc.samples,
                    resolutionHz: fftDoc.resolutionHz,
                    peakHz: fftDoc.peakHz,
                    peakMagnitude: fftDoc.peakMagnitude,
                    rms: fftDoc.rms,
                    freqBins: fftDoc.freqBins,
                    magBins: fftDoc.magBins
                };
            }
            return;
        }

        if (topic === 'gen/data') {
            latestData = normalizeGeneratorPayload(parsed);
            const fftDoc = normalizeFftPayload(parsed, latestData.deviceId);
            if (fftDoc) {
                await new FFTData(fftDoc).save();
                latestData.fft = {
                    valid: true,
                    source: fftDoc.source,
                    sampleRateHz: fftDoc.sampleRateHz,
                    samples: fftDoc.samples,
                    resolutionHz: fftDoc.resolutionHz,
                    peakHz: fftDoc.peakHz,
                    peakMagnitude: fftDoc.peakMagnitude,
                    rms: fftDoc.rms,
                    freqBins: fftDoc.freqBins,
                    magBins: fftDoc.magBins
                };
            }
            await autoSaveLatestData();
        }
    } catch (error) {
        console.error('❌ MQTT Message Error:', error);
    }
});

// --- API ENDPOINTS ---


app.get('/api/engine-data/last-running', async (req, res) => {
    try {
        const requestedDeviceId = req.query.deviceId;
        const effectiveDeviceId = requestedDeviceId || process.env.DEFAULT_REPORT_DEVICE_ID || 'ESP32_GENERATOR_01';
        const query = {
            ...(effectiveDeviceId ? { deviceId: effectiveDeviceId } : {}),
            $or: [
                { status: { $in: ['RUNNING', 'ON', 'ACTIVE'] } },
                { rpm: { $gt: 0 } }
            ]
        };

        const lastRunning = await GeneratorData.findOne(query).sort({ timestamp: -1 }).lean();
        if (!lastRunning) {
            return res.status(404).json({ success: false, error: 'No running engine data found' });
        }

        const dataAgeMs = Date.now() - new Date(lastRunning.timestamp || 0).getTime();
        const ecuConnected = dataAgeMs <= ECU_DISCONNECT_THRESHOLD_MS;
        res.json({ success: true, data: { ...lastRunning, ecuConnected } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/engine-data/latest', async (req, res) => {
    try {
        let totalEngineHours = 0;
        try {
            const statsRes = await fetch(`http://localhost:${PORT}/api/generator-active-time/stats?hours=8760`);
            const statsJson = await statsRes.json();
            if (statsJson.success && statsJson.data?.totalDurationHours) {
                totalEngineHours = statsJson.data.totalDurationHours;
            }
        } catch(e) {
            console.warn('Gagal ambil total jam operasi:', e.message);
        }

        const realtimeData = {
            ...latestData,
            engineHours: totalEngineHours,
            lastMqttUpdate: new Date().toISOString()
        };
        return res.json({ success: true, data: realtimeData, source: 'realtime-memory' });
    } catch (error) {
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
// Endpoint untuk data publik (spesifikasi, health index, maintenance prediction)
app.get('/api/public/dashboard', async (req, res) => {
    try {
        // Ambil data sensor terbaru
        const latest = await GeneratorData.findOne().sort({ timestamp: -1 }).lean();
        if (!latest) {
            return res.status(404).json({ success: false, error: 'No data' });
        }

        // Hitung health index (sederhana: 0-100%)
        let health = 100;
        const temp = latest.temp || latest.coolant || 0;
        const fuel = latest.fuel || 0;
        const volt = latest.volt || 0;
        const rpm = latest.rpm || 0;
        if (temp > 95) health -= 30;
        else if (temp > 85) health -= 10;
        if (fuel < 15) health -= 30;
        else if (fuel < 25) health -= 15;
        if (rpm > 0 && volt < 190) health -= 20;
        health = Math.max(0, Math.min(100, health));

        // Maintenance prediction (berdasarkan jam operasi total & suhu)
        const totalHours = await ActiveTimeHistory.aggregate([
            { $match: { deviceId: latest.deviceId } },
            { $group: { _id: null, totalMs: { $sum: "$durationMs" } } }
        ]);
        const totalHoursVal = totalHours[0] ? totalHours[0].totalMs / 3600000 : 0;
        let maintenanceMessage = "Mesin dalam kondisi prima. Perawatan rutin sesuai jadwal.";
        let maintenanceUrgency = "good";
        if (totalHoursVal > 200) {
            maintenanceMessage = "Segera lakukan servis berkala (oli & filter) dalam 50 jam ke depan.";
            maintenanceUrgency = "warning";
        }
        if (temp > 90) {
            maintenanceMessage = "Suhu mesin tinggi. Periksa sistem pendingin segera.";
            maintenanceUrgency = "danger";
        }

        // Spesifikasi mesin (hardcoded sederhana, bisa juga dari database)
        const specs = {
            generator: {
                type: "Generator Sinkron 3 Fasa",
                power: "20 kVA / 16 kW",
                voltage: "220V - 380V",
                frequency: "50 Hz",
                brand: "FIRMAN / Generic"
            },
            engine: {
                type: "Diesel 4 langkah, pendingin air",
                cylinders: "4 silinder inline",
                displacement: "2500 cc",
                maxRpm: "3000 RPM",
                fuelType: "Solar"
            }
        };

        // Parameter yang disederhanakan untuk masyarakat
        const powerKw = (latest.volt * (latest.amp || 0)) / 1000;
        const fuelPercent = latest.fuel || 0;
        const fuelHoursLeft = latest.rpm > 0 ? ((fuelPercent / 100) * 50) / 2.5 : 0; // asumsi tangki 50L, konsumsi 2.5 L/jam
        const equivalentLamps = Math.floor(powerKw / 0.1); // 1 lampu LED ~100W
        const tempStatus = temp > 85 ? "Panas" : (temp > 70 ? "Normal" : "Dingin");

        res.json({
            success: true,
            data: {
                health: { score: health, message: health >= 80 ? "Sistem Sehat" : (health >= 50 ? "Perlu Perhatian" : "Segera Tindak Lanjut") },
                maintenance: { message: maintenanceMessage, urgency: maintenanceUrgency, totalHours: totalHoursVal.toFixed(0) },
                specs: specs,
                parameters: {
                    fuel: { percent: fuelPercent, hoursLeft: fuelHoursLeft.toFixed(1), description: fuelPercent > 50 ? "Cukup" : (fuelPercent > 20 ? "Mulai Menipis" : "Segera Isi") },
                    power: { kw: powerKw.toFixed(1), lamps: equivalentLamps, description: powerKw > 15 ? "Beban Tinggi" : (powerKw > 5 ? "Beban Normal" : "Beban Ringan") },
                    temperature: { value: temp, status: tempStatus },
                    map: { value: latest.map || 0, status: latest.map >= 20 && latest.map <= 250 ? 'Normal' : 'Perlu Dicek' },
                    voltage: { value: latest.volt, status: latest.volt > 210 ? "Stabil" : (latest.volt > 190 ? "Terganggu" : "Tidak Stabil") }
                }
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. GET History Data (Updated for Date Filter)
app.get('/api/engine-data/history', async (req, res) => {
    try {
        const { hours, startDate, endDate } = req.query;
        const parsedLimit = parseInt(req.query.limit, 10);
        const limit = Number.isNaN(parsedLimit) ? 10000 : Math.max(1, Math.min(parsedLimit, 100000));
        let query = {};

        if (startDate && endDate) {
            let start = new Date(startDate);
            let end   = new Date(endDate);
            if (startDate.length === 10) start = new Date(startDate + 'T00:00:00.000+07:00');
            if (endDate.length === 10)   end   = new Date(endDate   + 'T23:59:59.999+07:00');
            if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
                query.timestamp = { $gte: start, $lte: end };
            }
        } else {
            const h = parseInt(hours) || 24;
            query.timestamp = { $gte: new Date(Date.now() - h * 60 * 60 * 1000) };
        }

        if (!isDbReady()) {
            return res.json({ success: true, count: 0, data: [], source: 'memory' });
        }

        const data = await GeneratorData.find(query).sort({ timestamp: -1 }).limit(limit);
        res.json({ success: true, count: data.length, data, source: 'database' });
    } catch (error) {
        res.json({ success: true, count: 0, data: [], source: 'memory', warning: error.message });
    }
});

function normalizeFftApiDoc(doc) {
    if (!doc) return null;
    const freqBins = Array.isArray(doc.freqBins) ? doc.freqBins.map(Number).filter(Number.isFinite) : [];
    const magBins = Array.isArray(doc.magBins) ? doc.magBins.map(Number).filter(Number.isFinite) : [];
    const len = Math.min(freqBins.length, magBins.length);
    return {
        ...doc,
        valid: len > 0,
        freqBins: freqBins.slice(0, len),
        magBins: magBins.slice(0, len),
        samples: Number(doc.samples) || len,
        sampleRateHz: Number(doc.sampleRateHz) || 0,
        resolutionHz: Number(doc.resolutionHz) || 0,
        peakHz: Number(doc.peakHz) || 0,
        peakMagnitude: Number(doc.peakMagnitude) || 0,
        rms: Number(doc.rms) || 0
    };
}

function buildFftSourceAliases(source) {
    const key = String(source || '').toLowerCase();
    const aliases = {
        rpm: ['rpm', 'rpm_fft', 'speed', 'rotation'],
        freq: ['freq', 'freq_fft', 'frequency', 'hz'],
        volt: ['volt', 'volt_fft', 'voltage', 'v']
    };
    return aliases[key] || (key ? [key] : []);
}

app.get('/api/fft/latest', async (req, res) => {
    try {
        const { deviceId, startDate, endDate, source } = req.query;
        const query = {};
        if (deviceId) query.deviceId = deviceId;
        if (startDate || endDate) {
            query.timestamp = {};
            if (startDate) query.timestamp.$gte = new Date(startDate);
            if (endDate) query.timestamp.$lte = new Date(endDate);
        }

        const aliases = buildFftSourceAliases(source);
        const sourcePatterns = aliases.map((alias) => new RegExp(`^${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'));
        const sourceQuery = sourcePatterns.length ? { ...query, source: { $in: sourcePatterns } } : query;
        let latest = await FFTData.findOne(sourceQuery).sort({ timestamp: -1 }).lean();
        if (!latest && aliases.length) latest = await FFTData.findOne(query).sort({ timestamp: -1 }).lean();

        res.json({ success: true, data: normalizeFftApiDoc(latest) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
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

        await closeStaleActiveSessions(effectiveDeviceId);
        const now = new Date();
        const rows = await ActiveTimeHistory.find(query).sort({ startedAt: -1 }).limit(parseInt(limit, 10)).lean();
        const data = rows.map((row) => decorateActiveTimeRow(row, now));
        res.json({ success: true, count: data.length, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


app.post('/api/active-session/close', async (req, res) => {
    try {
        const requestedDeviceId = req.body?.deviceId || req.query.deviceId || null;
        const reason = req.body?.reason || req.query.reason || 'esp32_disconnect';
        const closed = await closeActiveSessions(reason, requestedDeviceId);
        res.json({ success: true, closed: closed.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/daily-active-time/recalculate', async (req, res) => {
    try {
        const requestedDeviceId = req.body?.deviceId || req.query.deviceId || process.env.DEFAULT_REPORT_DEVICE_ID || 'ESP32_GENERATOR_01';
        const closed = await closeStaleActiveSessions(requestedDeviceId);
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const rows = await ActiveTimeHistory.find({ deviceId: requestedDeviceId, startedAt: { $gte: startOfToday } }).lean();
        const now = new Date();
        const totalDurationMs = rows.reduce((sum, row) => sum + decorateActiveTimeRow(row, now).effectiveDurationMs, 0);
        res.json({ success: true, closed: closed.length, totalDurationMs, totalDurationHours: +(totalDurationMs / 3600000).toFixed(2) });
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

        await closeStaleActiveSessions(effectiveDeviceId);
        const now = new Date();
        const rows = await ActiveTimeHistory.find(query).lean();
        const totalDurationMs = rows.reduce((sum, row) => {
            return sum + decorateActiveTimeRow(row, now).effectiveDurationMs;
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
    status: { type: String, default: 'pending', enum: ['pending', 'approved', 'scheduled', 'consumed'] },
    decisionStatus: { type: String, enum: ['AMAN', 'WASPADA', 'BAHAYA'], required: true },
    message: { type: String, required: true },
    recommendation: { type: String, required: true },
    priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    estimatedCost: { type: Number, default: 0 },          // <-- TAMBAHKAN
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

// Spesifikasi mesin generator dan motor bakar
const GENERATOR_SPECS = {
    merk: "Honda",
    tipe: "EG6500CXS",
    dayaMaks: 5.5, // kW
    tegangan: 220, // Volt
    frekuensi: 50, // Hz
    tipeMesin: "4-tak, OHV, berpendingin udara",
    kapasitasMesin: "389 cc",
    kapasitasTangki: 25, // Liter
    konsumsiBbm: 2.5, // Liter per jam (beban 50%)
    oliMesin: "SAE 10W-30",
    sistemStart: "Elektrik & Recoil"
};

app.get('/api/generator-specs', (req, res) => {
    res.json({ success: true, data: GENERATOR_SPECS });
});



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
const SENSOR_KEYS_FOR_STATS = ['rpm','volt','amp','power','freq','temp','coolant','fuel','iat','map','afr','tps','batt'];

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
        // Tunggu DB siap; jika gagal, return JSON error (bukan diam-diam lanjut)
        try { await ensureDbReady(); } catch (_) {}
        if (!isDbReady()) {
            return res.status(503).json({
                success: false, error: 'Database not ready, please retry.',
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
                map:     normalizeNumeric(row.map ?? row.mapPressure ?? row.manifoldPressure),
                batt:    normalizeNumeric(row.batt ?? row.battery ?? row.battVolt),
                afr:     normalizeNumeric(row.afr),
                tps:     normalizeNumeric(row.tps)
            };
        };

        // ── FIX: parse dates dengan tepat.
        // Frontend mengirim ISO string yang sudah digeser ke WIB, atau "YYYY-MM-DD".
        // Jika string date-only, paksa ke WIB full-day range (+07:00).
        const timeFilter = {};
        if (startDate && endDate) {
            let start = new Date(startDate);
            let end   = new Date(endDate);
            if (startDate.length === 10) start = new Date(startDate + 'T00:00:00.000+07:00');
            if (endDate.length === 10)   end   = new Date(endDate   + 'T23:59:59.999+07:00');
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
            let start = new Date(startDate);
            let end   = new Date(endDate);
            if (startDate.length === 10) start = new Date(startDate + 'T00:00:00.000+07:00');
            if (endDate.length === 10)   end   = new Date(endDate   + 'T23:59:59.999+07:00');
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
        if (!user) {
            return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'User belum terdaftar. Silakan register terlebih dahulu.' });
        }
        if (user.password !== password) {
            return res.status(401).json({ success: false, code: 'INVALID_PASSWORD', message: 'Email atau password tidak valid.' });
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

// Di server.js, tambahkan middleware untuk public.html
app.get('/public.html', (req, res) => {
    // Hanya serve file, autentikasi dilakukan di client-side
    res.sendFile(path.join(__dirname, 'public', 'public.html'));
});

// Modifikasi login response untuk memastikan role 'warg' bisa akses
// app.post('/api/auth/login', async (req, res) => {
//     try {
//         const email = String(req.body?.email || '').trim().toLowerCase();
//         const password = String(req.body?.password || '');

//         if (!email || !password) {
//             return res.status(400).json({ success: false, message: 'Email dan password wajib diisi.' });
//         }

//         const user = await User.findOne({ email }).lean();
//         if (!user) {
//             return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'User belum terdaftar. Silakan register terlebih dahulu.' });
//         }
//         if (user.password !== password) {
//             return res.status(401).json({ success: false, code: 'INVALID_PASSWORD', message: 'Email atau password tidak valid.' });
//         }

//         const role = String(user.role || '').toLowerCase();
//         // Allow both 'masyarakat' and 'warg' to access public.html
//         const isPublic = role === 'masyarakat' || role === 'warg' || role === 'user' || role === 'viewer';
//         const redirectTo = isPublic ? 'public.html' : 'index.html';

//         return res.json({
//             success: true,
//             user: {
//                 name: user.name || user.email.split('@')[0],
//                 email: user.email,
//                 role: user.role,
//                 redirectTo
//             }
//         });
//     } catch (error) {
//         return res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server login.', error: error.message });
//     }
// });





app.post('/api/auth/register', async (req, res) => {
    try {
        const name = String(req.body?.name || '').trim();
        const email = String(req.body?.email || '').trim().toLowerCase();
        const password = String(req.body?.password || '');
        const productToken = String(req.body?.productToken || '').trim();

        if (!name || !email || !password || !productToken) {
            return res.status(400).json({ success: false, message: 'Nama, email, password, dan token produk wajib diisi.' });
        }

        const expectedToken = 'TA252601020';
        if (productToken !== expectedToken) {
            return res.status(403).json({ success: false, message: 'Token produk tidak valid.' });
        }

        const existingUser = await User.findOne({ email }).lean();
        if (existingUser) {
            return res.status(409).json({ success: false, message: 'Email sudah terdaftar. Silakan login.' });
        }

        const newUser = await User.create({ name, email, password, role: 'warga' });
        return res.status(201).json({
            success: true,
            message: 'Registrasi berhasil. Silakan login.',
            user: { name: newUser.name, email: newUser.email, role: newUser.role }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Terjadi kesalahan saat registrasi.', error: error.message });
    }
});

app.get('/api/health', (req, res) => res.json({ status: 'healthy', mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' }));
app.get('/favicon.ico', (req, res) => res.status(204).end());

/**
 * ================================================================
 * TAMBAHAN UNTUK server.js — CBM Endpoints
 * ================================================================
 *
 * LANGKAH INTEGRASI:
 *
 * 1. Di BAGIAN PALING ATAS server.js, tambahkan setelah baris
 *    require('./maintenance_decision'):
 *
 *       const { analyzeCBM } = require('./lib_cbm_analysis');
 *
 * 2. Paste seluruh kode di bawah ini ke server.js SEBELUM baris:
 *       app.use('/api', (req, res) => { ... });   // ← catch-all /api
 *
 * ================================================================
 */

// ─── HELPER: Total Jam Operasi ────────────────────────────────────────────────
async function getTotalOperatingHours(deviceId) {
    const query = {};
    if (deviceId) query.deviceId = deviceId;

    const agg = await ActiveTimeHistory.aggregate([
        { $match: query },
        { $group: { _id: null, totalMs: { $sum: '$durationMs' } } }
    ]);

    return agg[0] ? agg[0].totalMs / 3_600_000 : 0;
}

// ─── CBM ANALYSIS  (GET) ──────────────────────────────────────────────────────
// Dipanggil oleh cbm_panel.js sebagai fallback jika POST gagal
app.get('/api/cbm/analysis', async (req, res) => {
    try {
        await ensureDbReady().catch(() => undefined);
        if (!isDbReady()) {
            return res.status(503).json({ success: false, error: 'Database not ready' });
        }

        const { deviceId, hours, startDate, endDate } = req.query;
        const effectiveDeviceId = deviceId
            || process.env.DEFAULT_REPORT_DEVICE_ID
            || null;

        const timeQuery = {};
        if (startDate && endDate) {
            let start = new Date(startDate);
            let end   = new Date(endDate);
            if (startDate.length === 10) start = new Date(startDate + 'T00:00:00.000+07:00');
            if (endDate.length   === 10) end   = new Date(endDate   + 'T23:59:59.999+07:00');
            if (Number.isFinite(start.getTime()) && Number.isFinite(end.getTime())) {
                timeQuery.timestamp = { $gte: start, $lte: end };
            }
        } else {
            const h = parseInt(hours || '168', 10);
            timeQuery.timestamp = { $gte: new Date(Date.now() - h * 3_600_000) };
        }

        const matchQuery = { ...timeQuery };
        if (effectiveDeviceId) matchQuery.deviceId = effectiveDeviceId;

        const historicalRows = await GeneratorData.find(matchQuery)
            .sort({ timestamp: -1 }).limit(10_000).lean();

        const totalOpHours = await getTotalOperatingHours(effectiveDeviceId);

        const result = analyzeCBM(
            historicalRows,
            ACTIVE_THRESHOLDS,
            totalOpHours
        );

        res.json({ success: true, data: result });
    } catch (error) {
        console.error('CBM GET Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── CBM ANALYSIS  (POST) ─────────────────────────────────────────────────────
// Menerima { deviceId, hours, startDate, endDate, fftPeaks, rpmMean }
// fftPeaks dikirim dari cbm_panel.js tombol "+ FFT Peaks"
app.post('/api/cbm/analysis', async (req, res) => {
    try {
        await ensureDbReady().catch(() => undefined);
        if (!isDbReady()) {
            return res.status(503).json({ success: false, error: 'Database not ready' });
        }

        const {
            deviceId,
            hours    = 168,
            startDate,
            endDate,
            fftPeaks = [],
            rpmMean  = 0
        } = req.body || {};

        const effectiveDeviceId = deviceId
            || process.env.DEFAULT_REPORT_DEVICE_ID
            || null;

        const matchQuery = {};
        if (startDate && endDate) {
            let start = new Date(startDate);
            let end   = new Date(endDate);
            if (String(startDate).length === 10) start = new Date(startDate + 'T00:00:00.000+07:00');
            if (String(endDate).length   === 10) end   = new Date(endDate   + 'T23:59:59.999+07:00');
            if (Number.isFinite(start.getTime()) && Number.isFinite(end.getTime())) {
                matchQuery.timestamp = { $gte: start, $lte: end };
            }
        } else {
            const h = parseInt(hours, 10) || 168;
            matchQuery.timestamp = { $gte: new Date(Date.now() - h * 3_600_000) };
        }
        if (effectiveDeviceId) matchQuery.deviceId = effectiveDeviceId;

        const historicalRows = await GeneratorData.find(matchQuery)
            .sort({ timestamp: -1 }).limit(10_000).lean();

        const totalOpHours = await getTotalOperatingHours(effectiveDeviceId);

        const result = analyzeCBM(
            historicalRows,
            ACTIVE_THRESHOLDS,
            totalOpHours,
            Array.isArray(fftPeaks) ? fftPeaks : [],
            Number(rpmMean) || 0
        );

        res.json({ success: true, data: result });
    } catch (error) {
        console.error('CBM POST Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── CBM CONVERT TO TASK ─────────────────────────────────────────────────────
// Dipanggil saat user klik "+ Buat Task" di panel CBM
// Body: { finding: { action, details, priority, type, component }, dueDate? }
app.post('/api/cbm/convert-to-task', async (req, res) => {
    try {
        const { finding, dueDate, assignedTo } = req.body || {};
        if (!finding?.action) {
            return res.status(400).json({ success: false, error: 'finding.action is required' });
        }

        const task = await new Maintenance({
            task:       finding.action,
            type:       finding.type     || 'Corrective',
            priority:   finding.priority || 'medium',
            status:     'scheduled',
            source:     'cbm',
            dueDate:    dueDate ? new Date(dueDate) : new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
            assignedTo: assignedTo || null
        }).save();

        console.log(`🔧 CBM Task created: ${task.task}`);
        res.json({ success: true, data: task });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Letakkan setelah blok “TAMBAHAN UNTUK server.js — CBM Endpoints”
// di dalam server.js (sebelum app.use('/api', ...) catch‑all)

app.post('/api/cbm/suggestion', async (req, res) => {
    try {
        const { finding, dueDate } = req.body || {};
        if (!finding?.action) {
            return res.status(400).json({ success: false, error: 'finding.action diperlukan' });
        }

        // Konversi level CBM ke decisionStatus
        const level = finding.level || 'watch';
        let decisionStatus = 'WASPADA';
        if (level === 'critical') decisionStatus = 'BAHAYA';
        else if (level === 'ok') decisionStatus = 'AMAN';

        const suggestion = await new MaintenanceSuggestion({
            source: 'cbm',
            status: 'pending',
            decisionStatus,
            message: finding.details || finding.action,
            recommendation: finding.action,
            priority: finding.priority || 'medium',
            estimatedCost: finding.estimatedCost || 0,
            suggestedDate: dueDate ? new Date(dueDate) : new Date(Date.now() + 3 * 24 * 3600000),
            createdAt: new Date()
        }).save();

        res.json({ success: true, data: suggestion });
    } catch (error) {
        console.error('CBM Suggestion Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
app.get('/api/maintenance/cost-summary', async (req, res) => {
    try {
        const { deviceId } = req.query;
        const match = deviceId ? { deviceId } : {};
        const summary = await Maintenance.aggregate([
            { $match: { ...match, status: { $ne: 'cancelled' } } },
            { $group: { _id: '$deviceId', totalCost: { $sum: '$cost' }, count: { $sum: 1 } } }
        ]);
        res.json({ success: true, data: summary });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
app.get('/api/alerts/count', async (req, res) => {
    try {
        const { deviceId, startDate, endDate, resolved } = req.query;
        let query = {};
        
        if (deviceId) query.deviceId = deviceId;
        
        // Filter berdasarkan status resolved jika dikirim frontend
        if (resolved !== undefined) {
            query.resolved = resolved === 'true'; 
        }

        if (startDate && endDate) {
            query.timestamp = { $gte: new Date(startDate), $lte: new Date(endDate) };
        }

        // Gunakan countDocuments agar lebih ringan dibanding mengambil datanya
        const count = await Alert.countDocuments(query);
        res.json({ success: true, count });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
// --- API UNTUK PROFIL USER ---

// Ambil data profil berdasarkan nama/username (karena session menyimpan username)
app.get('/api/users/profile', async (req, res) => {
    try {
        const { username } = req.query;
        const user = await User.findOne({ name: username }).lean();
        if (!user) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
        
        // Asumsi Device ID default jika tidak diikat spesifik ke user
        const deviceId = process.env.DEFAULT_REPORT_DEVICE_ID || 'ESP32_GENERATOR_01';
        
        res.json({ success: true, data: { name: user.name, email: user.email, role: user.role, deviceId } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update data profil (Nama, Email, Password)
// server.js - API Update Profil dengan Verifikasi Password
app.put('/api/users/profile', async (req, res) => {
    try {
        const { currentName, name, email, oldPassword, newPassword } = req.body;
        
        if (!currentName) return res.status(400).json({ success: false, message: 'Identitas saat ini diperlukan.' });

        const user = await User.findOne({ name: currentName });
        if (!user) return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });

        // VERIFIKASI KEAMANAN (Jika user ingin ganti password)
        if (newPassword) {
            if (!oldPassword) {
                return res.status(400).json({ success: false, message: 'Password lama wajib diisi untuk verifikasi keamanan.' });
            }
            // Bandingkan password lama dengan yang di DB
            if (user.password !== oldPassword) {
                return res.status(401).json({ success: false, message: 'Password lama salah.' });
            }
            user.password = newPassword;
        }

        // Update data lainnya
        if (name) user.name = name;
        if (email) user.email = email;

        await user.save();
        res.json({ 
            success: true, 
            message: 'Profil diperbarui.', 
            user: { name: user.name, email: user.email, role: user.role } 
        });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ success: false, message: 'Email sudah digunakan akun lain.' });
        }
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── CRITICAL: Semua /api/* yang tidak cocok harus return JSON, BUKAN HTML.
// Tanpa ini, catch-all di bawah mengembalikan login.html → error "Unexpected token '<'"
app.use('/api', (req, res) => {
    res.status(404).json({ success: false, error: `API endpoint not found: ${req.method} ${req.path}` });
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
