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
const {
    transformPublicStatus,
    generateAlerts,
    getMaintenanceStatus,
    getPublicLabels
} = require('./public_status');

mongoose.set('bufferCommands', false);

const mqttModulePath = path.join(__dirname, 'node_modules', 'mqtt', 'build', 'index.js');
const mqtt = fs.existsSync(mqttModulePath) ? require('mqtt') : null;

function createDisabledMqttClient(message = 'MQTT disabled; running without live broker connection.', emitError = false) {
    const client = new EventEmitter();
    client.connected = false;
    client.subscribe = () => undefined;
    client.publish = () => undefined;
    client.end = () => undefined;

    if (emitError) {
        process.nextTick(() => {
            client.emit('error', new Error(message));
        });
    }

    return client;
}

const { analyzeReportRows } = require('./lib_report_analysis');
const { generateMaintenanceDecision, toSuggestionDocument } = require('./maintenance_decision');
const { analyzeCBM } = require('./lib_cbm_analysis');

const app = express();
const isVercelRuntime = Boolean(process.env.VERCEL || process.env.NOW_REGION || process.env.AWS_LAMBDA_FUNCTION_NAME);
const enableServerlessMqtt = process.env.ENABLE_SERVERLESS_MQTT === 'true';
const shouldStartMqtt = !isVercelRuntime || enableServerlessMqtt;
const shouldWarmDbOnStartup = !isVercelRuntime || process.env.ENABLE_SERVERLESS_DB_WARMUP === 'true';

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
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: parseInt(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || '5000', 10),
        socketTimeoutMS: parseInt(process.env.MONGODB_SOCKET_TIMEOUT_MS || '10000', 10)
    })
    .then(async () => {
        console.log('✅ MongoDB Connected');
        await loadThresholdsFromDB(); // Load threshold saat server nyala/reconnect
        await cleanupGeneratorDataFieldsFromDB();
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

// --- SCHEMAS ---
const generatorDataSchema = new mongoose.Schema({
    // recordId berasal dari ESP32 SD backup. Field ini menjadi kunci deduplikasi
    // agar retry pengiriman backup tidak membuat data dobel di MongoDB.
    recordId: String,
    localSeq: Number,

    timestamp: { type: Date, default: Date.now },
    deviceId: { type: String, required: true },
    rpm: Number,
    volt: Number,
    amp: Number,
    power: Number,
    freq: Number,
    temp: Number,
    coolant: Number,
    fuel: Number,
    sync: String,
    synced: Boolean,
    powerSource: String,
    status: String,
    iat: Number,
    map: Number,
    batt: Number,
    afr: Number,
    tps: Number,
    phaseAngle: Number
}, { versionKey: false });

generatorDataSchema.index({ recordId: 1 }, { unique: true, sparse: true });
generatorDataSchema.index({ deviceId: 1, timestamp: -1 });
generatorDataSchema.index({ deviceId: 1, localSeq: 1 });

const GeneratorData = mongoose.model('GeneratorData', generatorDataSchema);

async function cleanupGeneratorDataFieldsFromDB() {
    try {
        if (!GeneratorData?.collection) return;

        const result = await GeneratorData.collection.updateMany(
            {
                $or: [
                    { __v: { $exists: true } },
                    { volt_grid: { $exists: true } },
                    { freq_grid: { $exists: true } }
                ]
            },
            { $unset: { __v: '', volt_grid: '', freq_grid: '' } }
        );

        if (result.modifiedCount > 0) {
            console.log(`🧹 Cleaned ${result.modifiedCount} generator data docs: removed __v, volt_grid, freq_grid`);
        }
    } catch (error) {
        console.error('Generator data cleanup error:', error.message);
    }
}

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
    acknowledged: { type: Boolean, default: false },
    acknowledgedAt: Date,
    confirmedAt: Date,
    resolved: { type: Boolean, default: false }
});
const Alert = mongoose.models.Alert || mongoose.model('Alert', alertSchema, 'alerts');

// NEW: Schema untuk menyimpan Konfigurasi Threshold
const configSchema = new mongoose.Schema({
    key: { type: String, unique: true }, // e.g. "engine_thresholds"
    value: Object // Menyimpan object JSON threshold
});
const Config = mongoose.model('Config', configSchema);

// DATABASE (startup connect + auto retry via ensureDbReady saat endpoint dipanggil)
// Di Vercel, jangan membuka koneksi MongoDB saat module di-import agar cold start
// tidak berubah menjadi 502. Koneksi dibuat saat request API pertama yang butuh DB.
if (shouldWarmDbOnStartup) {
    ensureDbReady().catch(() => undefined);
}


const userSchema = new mongoose.Schema({
    name: { type: String, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    role: { type: String, required: true, default: 'Masyarakat' }
});
const User = mongoose.model('User', userSchema);

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function getAuthRedirect(role) {
    const normalizedRole = String(role || '').trim().toLowerCase();
    const isCitizenRole = ['warga', 'masyarakat', 'user', 'viewer'].includes(normalizedRole);
    return isCitizenRole ? 'public.html' : 'index.html';
}

function serializeAuthUser(user) {
    const email = user.email || '';
    return {
        name: user.name || email.split('@')[0],
        email,
        role: user.role || 'Masyarakat',
        redirectTo: getAuthRedirect(user.role)
    };
}

async function loginUserByEmailPassword(email, password) {
    if (!email || !password) {
        return { status: 400, body: { success: false, message: 'Email dan password wajib diisi.' } };
    }

    await ensureDbReady();

    const user = await User.findOne({ email }).lean();
    if (!user) {
        return {
            status: 404,
            body: { success: false, code: 'USER_NOT_FOUND', message: 'User belum terdaftar. Silakan register terlebih dahulu.' }
        };
    }

    if (user.password !== password) {
        return {
            status: 401,
            body: { success: false, code: 'INVALID_PASSWORD', message: 'Email atau password tidak valid.' }
        };
    }

    return { status: 200, body: { success: true, user: serializeAuthUser(user) } };
}

async function registerUser({ name, email, password, productToken, role, requireProductToken = false }) {
    if (!name || !email || !password || (requireProductToken && !productToken)) {
        return {
            status: 400,
            body: {
                success: false,
                message: requireProductToken
                    ? 'Nama, email, password, dan token produk wajib diisi.'
                    : 'Nama, email, dan password wajib diisi.'
            }
        };
    }

    const expectedToken = process.env.PRODUCT_TOKEN || 'TA252601020';
    if (requireProductToken && productToken !== expectedToken) {
        return { status: 403, body: { success: false, message: 'Token produk tidak valid.' } };
    }

    await ensureDbReady();

    const existingUser = await User.findOne({ email }).lean();
    if (existingUser) {
        return { status: 409, body: { success: false, message: 'Email sudah terdaftar. Silakan login.' } };
    }

    const user = await User.create({ name, email, password, role: role || 'warga' });
    return {
        status: 201,
        body: {
            success: true,
            message: 'Registrasi berhasil. Silakan login.',
            user: { name: user.name, email: user.email, role: user.role }
        }
    };
}

const activeTimeHistorySchema = new mongoose.Schema({
    deviceId: { type: String, required: true, index: true },
    startedAt: { type: Date, required: true, index: true },
    endedAt: { type: Date, default: null, index: true },
    durationMs: { type: Number, default: 0 },
    closeReason: { type: String, default: null },
    source: { type: String, enum: ['mqtt', 'manual'], default: 'mqtt' },
    calc: {
        rpmThreshold: { type: Number, default: 0 },
        rule: { type: String, default: 'ECU connected' },
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
const mqttClient = mqtt && shouldStartMqtt
    ? mqtt.connect(process.env.MQTT_BROKER || 'mqtt://generatorta20.cloud.shiftr.io:1883', {
        clientId:        'server-' + Math.random().toString(16).slice(2, 8),
        username:        process.env.MQTT_USERNAME || 'generatorta20',
        password:        process.env.MQTT_PASSWORD || 'TA252601020',
        keepalive:       60,
        reconnectPeriod: 3000,
        connectTimeout:  10000
    })
    : createDisabledMqttClient(
        shouldStartMqtt
            ? 'MQTT module unavailable; running without live broker connection.'
            : 'MQTT disabled in Vercel serverless runtime.',
        shouldStartMqtt && !mqtt
    );

if (isVercelRuntime && !enableServerlessMqtt) {
    console.log('ℹ️ MQTT disabled in Vercel serverless runtime. Set ENABLE_SERVERLESS_MQTT=true to enable it explicitly.');
}

const mqttIngestStats = {
    connectedAt: null,
    lastMessageAt: null,
    lastTopic: null,
    lastPayloadBytes: 0,
    lastRecordCount: 0,
    receivedMessages: 0,
    invalidJsonMessages: 0,
    ignoredMessages: 0,
    savedMessages: 0,
    insertedRecords: 0,
    duplicateRecords: 0,
    lastInsertedRecords: 0,
    lastDuplicateRecords: 0,
    lastErrorAt: null,
    lastError: null
};

function updateMqttIngestError(error) {
    mqttIngestStats.lastErrorAt = new Date();
    mqttIngestStats.lastError = error?.message || String(error);
}

function shouldSkipApiDbWarmup(req) {
    if (req.method !== 'GET') return false;
    return [
        '/api/health',
        '/api/ingest/status',
        '/api/ingest/batch',
        '/api/mqtt-ingest/status'
    ].includes(req.path);
}

app.get('/api/health', (req, res) => {
    const mongodbState = mongoose.connection.readyState;
    const mongodbStatus = ['disconnected', 'connected', 'connecting', 'disconnecting'][mongodbState] || 'unknown';
    const mqttConnected = typeof mqttClient.connected === 'boolean' ? mqttClient.connected : false;
    const checks = {
        mongodb: { status: mongodbStatus, connected: mongodbState === 1 },
        mqtt: { enabled: shouldStartMqtt, connected: mqttConnected },
        env: {
            mongodbUri: Boolean(process.env.MONGODB_URI),
            vercel: isVercelRuntime
        }
    };
    const healthy = checks.mongodb.connected || isVercelRuntime;
    res.status(healthy ? 200 : 503).json({
        success: true,
        status: healthy && checks.mongodb.connected ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        checks
    });
});

app.use('/api', async (req, res, next) => {
    if (shouldSkipApiDbWarmup(req)) return next();

    try {
        await ensureDbReady();
        next();
    } catch (error) {
        console.error('API DB connection error:', error.message);
        res.status(503).json({
            success: false,
            error: 'Database connection unavailable',
            details: process.env.NODE_ENV === 'production' ? undefined : error.message
        });
    }
});

let latestData = {
    deviceId: 'ESP32_GENERATOR_01', timestamp: null,
    rpm: 0, volt: 0, amp: 0, power: 0, freq: 0, temp: 0, coolant: 0,
    fuel: 0, sync: 'OFF-GRID', synced: false, powerSource: 'GENSET', status: 'STOPPED', oil: 0, iat: 0, map: 0, batt: 0, afr: 0, tps: 0
};
let activeSessions = new Map();
const ECU_DISCONNECT_THRESHOLD_MS = parseInt(process.env.ECU_DISCONNECT_THRESHOLD_MS || '30000', 10);
const ACTIVE_SESSION_TIMEOUT_MS = ECU_DISCONNECT_THRESHOLD_MS;
let latestRealtimeReceivedAt = null;

function getValidDate(value) {
    const dt = value ? new Date(value) : null;
    return dt && Number.isFinite(dt.getTime()) ? dt : null;
}

function getLatestRealtimeSnapshot() {
    const timestamp = getValidDate(latestData?.timestamp);
    if (!timestamp || latestData?._realtime !== true) return null;
    return { ...latestData, timestamp };
}

function pickLatestEngineSnapshot(dbData) {
    const dbTimestamp = getValidDate(dbData?.timestamp);
    const realtimeData = getLatestRealtimeSnapshot();
    const realtimeTimestamp = getValidDate(realtimeData?.timestamp);

    if (dbData && realtimeData && realtimeTimestamp >= dbTimestamp) return realtimeData;
    if (dbData) return { ...dbData, timestamp: dbTimestamp || dbData.timestamp };
    if (realtimeData) return realtimeData;
    return null;
}

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


function toWibDateKey(date, wibOffset = 7 * 60 * 60 * 1000) {
    return new Date(date.getTime() + wibOffset).toISOString().slice(0, 10);
}

function splitSessionByDay(start, end, wibOffset = 7 * 60 * 60 * 1000) {
    const result = [];
    let cursor = new Date(start);
    const endDate = new Date(end);
    if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(endDate.getTime()) || endDate <= cursor) return result;

    while (cursor < endDate) {
        const cursorWib = new Date(cursor.getTime() + wibOffset);
        const nextMidnightWib = new Date(Date.UTC(
            cursorWib.getUTCFullYear(), cursorWib.getUTCMonth(), cursorWib.getUTCDate() + 1
        ));
        const nextMidnightUtc = new Date(nextMidnightWib.getTime() - wibOffset);
        const sliceEnd = nextMidnightUtc < endDate ? nextMidnightUtc : endDate;
        const hours = Math.max(0, sliceEnd - cursor) / 3600000;
        const dateKey = toWibDateKey(cursor, wibOffset);
        if (dateKey && hours > 0) result.push({ dateKey, hours });
        cursor = sliceEnd;
    }

    return result;
}

function buildDailyActiveTimeSummary(rows = [], days = 7, referenceTime = new Date()) {
    const wibOffset = 7 * 60 * 60 * 1000;
    const safeDays = Math.max(1, Math.min(parseInt(days, 10) || 7, 31));
    const now = safeEventTime(referenceTime);
    const dayMap = new Map();

    for (let i = safeDays - 1; i >= 0; i--) {
        const key = toWibDateKey(new Date(now.getTime() - i * 86400000), wibOffset);
        dayMap.set(key, 0);
    }

    for (const row of rows || []) {
        const start = safeEventTime(row.startedAt);
        const end = getEffectiveSessionEnd(row, now);
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) continue;

        splitSessionByDay(start, end, wibOffset).forEach(({ dateKey, hours }) => {
            if (dayMap.has(dateKey)) dayMap.set(dateKey, dayMap.get(dateKey) + hours);
        });
    }

    return Array.from(dayMap.entries()).map(([date, hours]) => ({
        date,
        label: new Date(`${date}T12:00:00+07:00`).toLocaleDateString('id-ID', { weekday: 'short' }),
        hours: +Math.min(24, hours).toFixed(2),
        durationMs: Math.round(Math.min(24, hours) * 3600000)
    }));
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
            calc: { rpmThreshold: 0, rule: 'ECU connected', sampledAt: end }
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
    const isRunning = isEcuConnected;
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
            calc: { rpmThreshold, rule: 'ECU connected', sampledAt: eventTime }
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
                calc: { rpmThreshold, rule: 'ECU connected', sampledAt: eventTime }
            });
            return;
        }

        session.lastSeenAt = eventTime;
        await ActiveTimeHistory.findOneAndUpdate(
            { deviceId, startedAt: session.startedAt, endedAt: null },
            { calc: { rpmThreshold, rule: 'ECU connected', sampledAt: eventTime } },
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
    mqttIngestStats.connectedAt = new Date();
    console.log(`✅ Connected to MQTT Broker: ${process.env.MQTT_BROKER || 'mqtt://generatorta20.cloud.shiftr.io:1883'}`);
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

// gen/realtime memperbarui dashboard/alert secara langsung.
// gen/data menyimpan record history realtime dari ESP32 ke MongoDB.
// ============================================================
// MONGODB BATCH SAVE
// Realtime data tetap diterima setiap 1 detik dari MQTT,
// tetapi penyimpanan GeneratorData ke MongoDB dilakukan batch
// Buffer server internal tetap dipakai untuk sumber realtime lain, tetapi gen/data ESP32 disimpan langsung.
// ============================================================

const DB_BATCH_INTERVAL_MS = parseInt(process.env.DB_BATCH_INTERVAL_MS || '600000', 10); // 10 menit
const DB_BATCH_MAX_RECORDS = parseInt(process.env.DB_BATCH_MAX_RECORDS || '600', 10);

let generatorBatchBuffer = [];
let fftBatchBuffer = [];
let isFlushingGeneratorBatch = false;

function buildGeneratorDbDocument(data) {
    const snapshot = { ...data };

    if (snapshot.rpm > 0) {
        snapshot.status = snapshot.sync === 'ON-GRID' ? 'ON-GRID' : 'RUNNING';
    } else {
        snapshot.status = 'STOPPED';
    }

    const ts = snapshot.timestamp ? new Date(snapshot.timestamp) : new Date();
    const localSeq = snapshot.localSeq !== undefined && snapshot.localSeq !== null && snapshot.localSeq !== ''
        ? toNumber(snapshot.localSeq, 0)
        : undefined;

    return {
        recordId: snapshot.recordId || undefined,
        localSeq,

        timestamp: Number.isNaN(ts.getTime()) ? new Date() : ts,
        deviceId: snapshot.deviceId || 'ESP32_GENERATOR_01',
        rpm: toNumber(snapshot.rpm, 0),
        volt: toNumber(snapshot.volt, 0),
        amp: toNumber(snapshot.amp ?? snapshot.currentA, 0),
        power: toNumber(snapshot.power ?? snapshot.powerKW, 0),
        freq: toNumber(snapshot.freq, 0),
        temp: toNumber(snapshot.temp, 0),
        coolant: toNumber(snapshot.coolant ?? snapshot.clt, 0),
        fuel: toNumber(snapshot.fuel, 0),
        sync: snapshot.sync || 'OFF-GRID',
        synced: snapshot.sync === 'ON-GRID' || snapshot.synced === true,
        powerSource: snapshot.powerSource || (snapshot.sync === 'ON-GRID' || snapshot.synced === true ? 'GRID' : 'GENSET'),
        status: snapshot.status,
        iat: toNumber(snapshot.iat, 0),
        map: toNumber(snapshot.map, 0),
        batt: toNumber(snapshot.batt, 0),
        afr: toNumber(snapshot.afr, 0),
        tps: toNumber(snapshot.tps, 0),
        phaseAngle: toNumber(snapshot.phaseAngle ?? snapshot.phase_diff ?? snapshot.phase_angle, 0)
    };
}

function addGeneratorDataToBatch(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;

    const doc = buildGeneratorDbDocument(snapshot);
    generatorBatchBuffer.push(doc);

    if (generatorBatchBuffer.length >= DB_BATCH_MAX_RECORDS) {
        flushGeneratorBatch('max-records').catch((err) => {
            console.error('❌ Batch flush error:', err.message);
        });
    }
}

function addFftDataToBatch(fftDoc) {
    if (!fftDoc || typeof fftDoc !== 'object') return;

    fftBatchBuffer.push(fftDoc);
}

async function flushGeneratorBatch(reason = 'interval') {
    if (isFlushingGeneratorBatch) return;
    if (!generatorBatchBuffer.length && !fftBatchBuffer.length) return;

    if (!isDbReady()) {
        console.warn(`⚠️ MongoDB not ready, batch retained | generator=${generatorBatchBuffer.length} fft=${fftBatchBuffer.length}`);
        return;
    }

    isFlushingGeneratorBatch = true;

    const generatorBatch = generatorBatchBuffer.splice(0, generatorBatchBuffer.length);
    const fftBatch = fftBatchBuffer.splice(0, fftBatchBuffer.length);

    try {
        if (generatorBatch.length > 0) {
            const operations = generatorBatch.map((doc) => {
                if (doc.recordId) {
                    return {
                        updateOne: {
                            filter: { recordId: doc.recordId },
                            update: { $setOnInsert: doc },
                            upsert: true
                        }
                    };
                }

                return { insertOne: { document: doc } };
            });

            await GeneratorData.bulkWrite(operations, { ordered: false });
        }

        if (fftBatch.length > 0) {
            await FFTData.insertMany(fftBatch, { ordered: false });
        }

        console.log(
            `💾 MongoDB batch saved | reason=${reason} | generator=${generatorBatch.length} records | fft=${fftBatch.length} records`
        );
    } catch (err) {
        console.error('❌ MongoDB batch save error:', err.message);

        // Jika gagal, masukkan kembali ke depan buffer agar tidak hilang.
        generatorBatchBuffer = generatorBatch.concat(generatorBatchBuffer);
        fftBatchBuffer = fftBatch.concat(fftBatchBuffer);
    } finally {
        isFlushingGeneratorBatch = false;
    }
}

setInterval(() => {
    flushGeneratorBatch('interval-10min').catch((err) => {
        console.error('❌ Scheduled batch flush error:', err.message);
    });
}, DB_BATCH_INTERVAL_MS);

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

app.put('/api/alerts/ack-all', async (req, res) => {
    try {
        const filter = { resolved: { $ne: true }, acknowledged: { $ne: true } };
        if (req.body?.deviceId) filter.deviceId = req.body.deviceId;
        const result = await Alert.updateMany(filter, { $set: { acknowledged: true, acknowledgedAt: new Date() } });
        res.json({ success: true, modifiedCount: result.modifiedCount || 0 });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.put('/api/alerts/confirm-all', async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
        const filter = { resolved: { $ne: true } };
        if (ids.length) filter._id = { $in: ids };
        if (req.body?.deviceId) filter.deviceId = req.body.deviceId;
        const now = new Date();
        const result = await Alert.updateMany(filter, { $set: { resolved: true, acknowledged: true, acknowledgedAt: now, confirmedAt: now } });
        res.json({ success: true, modifiedCount: result.modifiedCount || 0 });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.put('/api/alerts/:id/confirm', async (req, res) => {
    try {
        const now = new Date();
        const updated = await Alert.findByIdAndUpdate(req.params.id, { resolved: true, acknowledged: true, acknowledgedAt: now, confirmedAt: now }, { new: true });
        if (!updated) return res.status(404).json({ success: false, message: 'Alert not found' });
        res.json({ success: true, data: updated });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.put('/api/alerts/:id/ack', async (req, res) => {
    try {
        await Alert.findByIdAndUpdate(req.params.id, { acknowledged: true, acknowledgedAt: new Date() });
        res.json({ success: true, message: 'Alert acknowledged' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. Hapus Alarm dari Database

app.delete('/api/alerts/confirmed', async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
        const filter = { resolved: true };
        if (ids.length) filter._id = { $in: ids };
        if (req.body?.deviceId) filter.deviceId = req.body.deviceId;
        const result = await Alert.deleteMany(filter);
        res.json({ success: true, deletedCount: result.deletedCount || 0 });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.delete('/api/alerts/:id', async (req, res) => {
    try {
        const alert = await Alert.findById(req.params.id);
        if (!alert) return res.status(404).json({ success: false, message: 'Alert not found' });
        if (!alert.resolved) return res.status(409).json({ success: false, message: 'Confirm alert before deleting it' });
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

function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== '');
}

function readCoolantValue(payload = {}) {
    return firstDefined(
        payload.coolant,
        payload.clt,
        payload.cltAvg,
        payload.coolantTemp,
        payload.coolant_temp,
        payload.engineCoolant,
        payload.engine_coolant,
        payload.ect
    );
}

function readAmpValue(payload = {}) {
    return firstDefined(
        payload.amp,
        payload.current,
        payload.currentA,
        payload.current_a,
        payload.generatorCurrent,
        payload.generator_current,
        payload.arus
    );
}

function readPowerValue(payload = {}) {
    const powerKw = firstDefined(
        payload.power,
        payload.powerKW,
        payload.powerKw,
        payload.power_kW,
        payload.power_kw,
        payload.kw,
        payload.kW,
        payload.daya
    );
    if (powerKw !== undefined) return powerKw;

    const powerWatt = firstDefined(payload.watt, payload.watts, payload.powerW, payload.power_w);
    const parsedWatt = Number(powerWatt);
    return Number.isFinite(parsedWatt) ? parsedWatt / 1000 : undefined;
}

function normalizeSyncStatus(payload = {}, fallbackSync = 'OFF-GRID') {
    if (payload.synced !== undefined && payload.synced !== null && payload.synced !== '') {
        const value = typeof payload.synced === 'string' ? payload.synced.trim().toLowerCase() : payload.synced;
        if (value === true || value === 1 || value === 'true' || value === '1' || value === 'on-grid' || value === 'ongrid') return 'ON-GRID';
        if (value === false || value === 0 || value === 'false' || value === '0' || value === 'off-grid' || value === 'offgrid') return 'OFF-GRID';
    }

    const rawSync = firstDefined(payload.sync, payload.syncStatus, payload.gridStatus, fallbackSync, 'OFF-GRID');
    const key = String(rawSync).trim().toUpperCase().replace(/\s+/g, '-');
    if (['ON-GRID', 'ONGRID', 'SYNC', 'SYNCHRONIZED'].includes(key)) return 'ON-GRID';
    if (['OFF-GRID', 'OFFGRID', 'UNSYNC', 'UNSYNCHRONIZED'].includes(key)) return 'OFF-GRID';
    return key || 'OFF-GRID';
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

    const syncStatus = normalizeSyncStatus(payload, latestData.sync);

    const snapshot = {
        ...latestData,
        deviceId: payload.deviceId || latestData.deviceId || 'ESP32_GENERATOR_01',
        timestamp,
        rpm: toNumber(payload.rpm, latestData.rpm),
        volt: toNumber(payload.volt, latestData.volt),
        amp: toNumber(readAmpValue(payload), latestData.amp),
        power: toNumber(readPowerValue(payload), latestData.power),
        freq: toNumber(payload.freq, latestData.freq),
        temp: toNumber(firstDefined(payload.temp, payload.temperature), latestData.temp),
        coolant: toNumber(readCoolantValue(payload), latestData.coolant),
        fuel: toNumber(payload.fuel, latestData.fuel),
        sync: syncStatus,
        synced: syncStatus === 'ON-GRID',
        powerSource: String(payload.powerSource || payload.power_source || (syncStatus === 'ON-GRID' ? 'GRID' : 'GENSET')).toUpperCase(),
        status: String(payload.status || latestData.status || 'STOPPED'),
        oil: toNumber(payload.oil, latestData.oil),
        iat: toNumber(payload.iat, latestData.iat),
        map: toNumber(payload.map, latestData.map),
        batt: toNumber(payload.batt ?? payload.battery ?? payload.battVolt, latestData.batt),
        afr: toNumber(payload.afr, latestData.afr),
        tps: toNumber(payload.tps, latestData.tps),
        phaseAngle: toNumber(payload.phaseAngle ?? payload.phase_angle ?? payload.phase_diff, latestData.phaseAngle ?? 0),
        recordId: payload.recordId || latestData.recordId,
        localSeq: payload.localSeq ?? latestData.localSeq,
        _realtime: true
    };

    if (readPowerValue(payload) === undefined && snapshot.volt && snapshot.amp) {
        snapshot.power = (snapshot.volt * snapshot.amp) / 1000;
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


app.get('/api/ingest/status', (req, res) => {
    res.json({
        success: true,
        dbReady: isDbReady(),
        dbBatchIntervalMs: DB_BATCH_INTERVAL_MS,
        dbBatchIntervalMinutes: DB_BATCH_INTERVAL_MS / 60000,
        dbBatchMaxRecords: DB_BATCH_MAX_RECORDS,
        bufferedGeneratorRecords: generatorBatchBuffer.length,
        bufferedFftRecords: fftBatchBuffer.length,
        isFlushingGeneratorBatch
    });
});

app.get('/api/ingest/batch', (req, res) => {
    res.json({
        success: true,
        message: 'Endpoint aktif. Browser GET hanya untuk cek status; ESP32 mengirim data backup dengan POST JSON.',
        method: 'POST',
        path: '/api/ingest/batch',
        dbReady: isDbReady(),
        mqttHistoryTopic: 'gen/data',
        realtimeTopic: 'gen/realtime',
        dbBatchIntervalMs: DB_BATCH_INTERVAL_MS,
        dbBatchIntervalMinutes: DB_BATCH_INTERVAL_MS / 60000,
        dbBatchMaxRecords: DB_BATCH_MAX_RECORDS,
        acceptedBody: {
            deviceId: 'ESP32_GENERATOR_01',
            source: 'esp32_sd_backup_10min',
            records: [
                {
                    recordId: 'ESP32_GENERATOR_01-1-123456',
                    localSeq: 1,
                    timestamp: new Date().toISOString(),
                    rpm: 1500,
                    tps: 25,
                    map: 80,
                    iat: 35,
                    clt: 75,
                    afr: 14.7,
                    batt: 12.8,
                    fuel: 70,
                    freq: 50,
                    volt: 220,
                    currentA: 10,
                    powerKW: 2.2,
                    phase_diff: 0,
                    synced: false
                }
            ]
        }
    });
});

// ============================================================
// BACKUP INGEST ENDPOINT
// Data dari SD card ESP32 dikirim ke endpoint ini sebagai batch/chunk.
// Endpoint ini hanya menyimpan data historis ke MongoDB, tidak menjalankan alert,
// karena alert realtime diproses dari MQTT gen/realtime.
// ============================================================
app.post('/api/ingest/batch', async (req, res) => {
    try {
        if (!isDbReady()) {
            await ensureDbReady();
        }

        const payload = req.body || {};
        const records = Array.isArray(payload.records) ? payload.records : [];

        if (!records.length) {
            return res.status(400).json({
                success: false,
                error: 'records[] is required'
            });
        }

        const docs = records
            .filter((row) => row && typeof row === 'object')
            .map((row) => {
                const normalized = normalizeGeneratorPayload({
                    ...row,
                    deviceId: row.deviceId || payload.deviceId || latestData.deviceId,
                    recordId: row.recordId,
                    localSeq: row.localSeq
                });

                return buildGeneratorDbDocument({
                    ...normalized,
                    recordId: row.recordId,
                    localSeq: row.localSeq
                });
            })
            .filter((doc) => doc.recordId);

        if (!docs.length) {
            return res.status(400).json({
                success: false,
                error: 'No valid records with recordId'
            });
        }

        const operations = docs.map((doc) => ({
            updateOne: {
                filter: { recordId: doc.recordId },
                update: { $setOnInsert: doc },
                upsert: true
            }
        }));

        const result = await GeneratorData.bulkWrite(operations, { ordered: false });

        const seqList = docs
            .map((doc) => Number(doc.localSeq))
            .filter(Number.isFinite);
        const lastAcceptedSeq = seqList.length ? Math.max(...seqList) : null;

        console.log(
            `💾 SD backup ingest | device=${payload.deviceId || 'unknown'} | received=${records.length} | accepted=${docs.length} | inserted=${result.upsertedCount || 0} | duplicate=${result.matchedCount || 0} | lastSeq=${lastAcceptedSeq}`
        );

        return res.json({
            success: true,
            batchId: payload.batchId || null,
            source: payload.source || 'esp32_sd_backup',
            received: records.length,
            accepted: docs.length,
            ackedRecords: docs.length,
            processedRecords: docs.length,
            inserted: result.upsertedCount || 0,
            matchedExisting: result.matchedCount || 0,
            duplicate: result.matchedCount || 0,
            lastAcceptedSeq
        });

    } catch (error) {
        console.error('Batch ingest error:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

mqttClient.on('message', async (topic, message) => {
    try {
        if (topic !== 'gen/realtime' && topic !== 'gen/data') return;

        const raw = message.toString();
        mqttIngestStats.receivedMessages++;
        mqttIngestStats.lastMessageAt = new Date();
        mqttIngestStats.lastTopic = topic;
        mqttIngestStats.lastPayloadBytes = Buffer.byteLength(raw);

        let parsed;

        try {
            parsed = JSON.parse(raw);
        } catch (parseError) {
            mqttIngestStats.invalidJsonMessages++;
            updateMqttIngestError(parseError);
            console.warn(`⚠️ Invalid JSON on ${topic}:`, raw.slice(0, 500));
            return;
        }

        // Semua pesan MQTT tetap memperbarui latestData agar dashboard memory selalu aktual.
        latestData = normalizeGeneratorPayload(parsed);
        latestRealtimeReceivedAt = getValidDate(latestData.timestamp) || new Date();

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

        // gen/realtime: jalur dashboard + alert + active time.
        // Alert tidak menunggu batch MongoDB.
        if (topic === 'gen/realtime') {
            await checkAndSaveAlerts(latestData);
            await syncActiveTimeHistory(latestData);
            return;
        }

        // gen/data: jalur historis/database. ESP32 sekarang mengirim 1 record realtime tiap 1 detik.
        // Bentuk lama { records: [...] } tetap diterima untuk kompatibilitas.
        if (topic === 'gen/data') {
            const records = Array.isArray(parsed.records) ? parsed.records : [parsed];
            mqttIngestStats.lastRecordCount = records.length;
            console.log(`📥 MQTT gen/data received | bytes=${mqttIngestStats.lastPayloadBytes} | records=${records.length}`);

            if (!records.length) {
                mqttIngestStats.ignoredMessages++;
                console.warn('⚠️ gen/data ignored: empty payload');
                return;
            }

            const generatorDocs = [];
            const fftDocs = [];

            for (const record of records) {
                if (!record || typeof record !== 'object') continue;

                const snapshot = normalizeGeneratorPayload({
                    ...record,
                    deviceId: record.deviceId || parsed.deviceId,
                    source: record.source || parsed.source,
                    timestamp: record.timestamp || parsed.timestamp
                });

                generatorDocs.push(buildGeneratorDbDocument({
                    ...snapshot,
                    recordId: record.recordId,
                    localSeq: record.localSeq
                }));

                const recordFftDoc = normalizeFftPayload(record, snapshot.deviceId);
                if (recordFftDoc) fftDocs.push(recordFftDoc);
            }

            if (!generatorDocs.length && !fftDocs.length) {
                mqttIngestStats.ignoredMessages++;
                console.warn(`⚠️ gen/data ignored: no valid records in payload.records[] | received=${records.length}`);
                return;
            }

            if (!isDbReady()) {
                await ensureDbReady();
            }

            let insertedGenerator = 0;
            let matchedGenerator = 0;

            if (generatorDocs.length > 0) {
                const operations = generatorDocs.map((doc) => {
                    if (doc.recordId) {
                        return {
                            updateOne: {
                                filter: { recordId: doc.recordId },
                                update: { $setOnInsert: doc },
                                upsert: true
                            }
                        };
                    }

                    return { insertOne: { document: doc } };
                });

                const result = await GeneratorData.bulkWrite(operations, { ordered: false });
                insertedGenerator = (result.insertedCount || 0) + (result.upsertedCount || 0);
                matchedGenerator = result.matchedCount || 0;
                mqttIngestStats.savedMessages++;
                mqttIngestStats.insertedRecords += insertedGenerator;
                mqttIngestStats.duplicateRecords += matchedGenerator;
                mqttIngestStats.lastInsertedRecords = insertedGenerator;
                mqttIngestStats.lastDuplicateRecords = matchedGenerator;
                mqttIngestStats.lastError = null;
                mqttIngestStats.lastErrorAt = null;
            }

            if (fftDocs.length > 0) {
                await FFTData.insertMany(fftDocs, { ordered: false });
            }

            console.log(
                `💾 MQTT gen/data bulkWrite saved | received=${records.length} | generator=${generatorDocs.length} records | inserted=${insertedGenerator} | duplicate=${matchedGenerator} | fft=${fftDocs.length} records`
            );
        }

    } catch (error) {
        updateMqttIngestError(error);
        console.error('❌ MQTT Message Error:', error);
    }
});

app.get('/api/mqtt-ingest/status', (req, res) => {
    res.json({
        success: true,
        mqttAvailable: Boolean(mqtt),
        mqttConnected: typeof mqttClient.connected === 'boolean' ? mqttClient.connected : false,
        broker: process.env.MQTT_BROKER || 'mqtt://generatorta20.cloud.shiftr.io:1883',
        subscribedTopics: ['gen/realtime', 'gen/data'],
        dbReady: isDbReady(),
        stats: mqttIngestStats
    });
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
        const requestedDeviceId = req.query.deviceId;
        const effectiveDeviceId = requestedDeviceId || process.env.DEFAULT_REPORT_DEVICE_ID || 'ESP32_GENERATOR_01';
        const filter = effectiveDeviceId ? { deviceId: effectiveDeviceId } : {};
        const latestDocs = await GeneratorData.find(filter).sort({ timestamp: -1 }).limit(5).lean();
        const dbData = latestDocs[0] || null;
        const baseData = pickLatestEngineSnapshot(dbData);
        if (!baseData) {
            return res.status(404).json({ success: false, error: 'No generator data found' });
        }

        const baseTimestamp = getValidDate(baseData.timestamp);
        const lastDataAt = baseTimestamp || getValidDate(dbData?.timestamp) || latestRealtimeReceivedAt;
        const ecuConnected = lastDataAt ? (Date.now() - lastDataAt.getTime()) <= ECU_DISCONNECT_THRESHOLD_MS : false;
        const previousDoc = latestDocs.find((doc) => String(doc._id) !== String(baseData._id)) || latestDocs[1] || null;
        const totalEngineHours = await getTotalOperatingHours(effectiveDeviceId);
        const enrichedData = {
            ...baseData,
            timestamp: lastDataAt || baseData.timestamp,
            ecuConnected,
            engineHours: totalEngineHours,
            lastMqttUpdate: lastDataAt || baseData.timestamp,
            lastUpdated: lastDataAt || baseData.timestamp,
            alerts: generateAlerts(baseData, previousDoc),
            maintenance: getMaintenanceStatus(baseData, latestDocs.slice(1)),
            ...getPublicLabels(baseData)
        };
        const source = baseData._realtime ? 'realtime-memory' : 'database';
        res.json({ success: true, data: enrichedData, source });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
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


app.get('/api/generator-active-time/daily', async (req, res) => {
    try {
        const requestedDeviceId = req.query.deviceId;
        const effectiveDeviceId = requestedDeviceId || process.env.DEFAULT_REPORT_DEVICE_ID || 'ESP32_GENERATOR_01';
        const days = Math.max(1, Math.min(parseInt(req.query.days || '7', 10) || 7, 31));
        const now = new Date();
        const since = new Date(now.getTime() - days * 86400000);
        const query = {
            startedAt: { $lte: now },
            $or: [
                { endedAt: null },
                { endedAt: { $gte: since } }
            ]
        };
        if (effectiveDeviceId) query.deviceId = effectiveDeviceId;

        await closeStaleActiveSessions(effectiveDeviceId);
        const rows = await ActiveTimeHistory.find(query).lean();
        const data = buildDailyActiveTimeSummary(rows, days, now);
        const totalHours = +data.reduce((sum, row) => sum + row.hours, 0).toFixed(2);
        res.json({ success: true, count: data.length, data, totalHours });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
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
        const newThresholds = req.body; // Expect { param: { min: x, max: x } }
        
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
            { acknowledged: true, acknowledgedAt: new Date() },
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
        const alert = await Alert.findById(req.params.id);
        if (!alert) return res.status(404).json({ success: false, message: 'Alarm not found' });
        if (!alert.resolved) return res.status(409).json({ success: false, message: 'Confirm alert before deleting it' });
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
        const decision = await getCurrentMaintenanceDecision(req.query.deviceId);
        res.json({ success: true, data: decision });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/maintenance/suggestion', async (req, res) => {
    try {
        const decision = await getCurrentMaintenanceDecision(req.query.deviceId);
        res.json({ success: true, data: decision });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

function normalizeMaintenanceSuggestionInput(body = {}) {
    const status = String(body.decisionStatus || body.status || body.level || 'WASPADA').toUpperCase();
    const message = body.message || body.reason || body.description || 'Maintenance suggestion generated by system';
    const recommendation = body.recommendation || body.action || message;
    const priority = String(body.priority || (status === 'BAHAYA' ? 'high' : status === 'WASPADA' ? 'medium' : 'low')).toLowerCase();
    return {
        source: body.source || 'system',
        status: body.status === 'approved' ? 'approved' : 'pending',
        decisionStatus: ['AMAN', 'WASPADA', 'BAHAYA'].includes(status) ? status : 'WASPADA',
        message,
        recommendation,
        priority: ['low', 'medium', 'high'].includes(priority) ? priority : 'medium',
        estimatedCost: Math.max(0, Number(body.estimatedCost ?? body.cost ?? 0) || 0),
        suggestedDate: body.suggestedDate ? new Date(body.suggestedDate) : null,
        approvedAt: body.status === 'approved' ? new Date() : undefined
    };
}

async function saveMaintenanceSuggestion(body = {}) {
    const payload = normalizeMaintenanceSuggestionInput(body);
    const suggestion = await MaintenanceSuggestion.create(payload);
    return suggestion;
}

app.post('/maintenance/suggestion', async (req, res) => {
    try {
        const suggestion = await saveMaintenanceSuggestion(req.body || {});
        res.json({ success: true, data: suggestion });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/maintenance/suggestion', async (req, res) => {
    try {
        const suggestion = await saveMaintenanceSuggestion(req.body || {});
        res.json({ success: true, data: suggestion });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/maintenance/suggestion/:id/approve', async (req, res) => {
    try {
        const suggestion = await MaintenanceSuggestion.findById(req.params.id);
        if (!suggestion) return res.status(404).json({ success: false, error: 'Suggestion not found' });

        suggestion.status = 'approved';
        suggestion.approvedAt = new Date();
        await suggestion.save();

        const task = await Maintenance.create({
            task: suggestion.recommendation,
            type: suggestion.decisionStatus === 'BAHAYA' ? 'Corrective' : 'Preventive',
            priority: suggestion.priority,
            cost: suggestion.estimatedCost || 0,
            status: 'scheduled',
            dueDate: suggestion.suggestedDate || new Date(),
            assignedTo: req.body?.assignedTo || 'Operator',
            source: suggestion.source,
            suggestionId: String(suggestion._id)
        });

        suggestion.status = 'scheduled';
        await suggestion.save();

        res.json({ success: true, data: { suggestion, task } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


function normalizeReportNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeReportRow(row) {
    const timestamp = row.timestamp || row.createdAt || row.date || null;
    if (!timestamp) return null;
    return {
        ...row,
        timestamp,
        rpm: normalizeReportNumber(row.rpm),
        volt: normalizeReportNumber(row.volt ?? row.voltage),
        amp: normalizeReportNumber(row.amp ?? row.current),
        power: normalizeReportNumber(row.power ?? row.kw),
        freq: normalizeReportNumber(row.freq ?? row.frequency),
        temp: normalizeReportNumber(row.temp ?? row.temperature),
        coolant: normalizeReportNumber(row.coolant ?? row.temp),
        fuel: normalizeReportNumber(row.fuel),
        iat: normalizeReportNumber(row.iat),
        map: normalizeReportNumber(row.map ?? row.mapPressure ?? row.manifoldPressure),
        batt: normalizeReportNumber(row.batt ?? row.battery ?? row.battVolt),
        afr: normalizeReportNumber(row.afr),
        tps: normalizeReportNumber(row.tps),
        phase: normalizeReportNumber(row.phase ?? row.phaseAngle ?? row.phase_angle ?? row.phaseDiff)
    };
}

function buildReportQuery(query = {}) {
    const { hours, startDate, endDate } = query;
    const requestedDeviceId = query.deviceId;
    const effectiveDeviceId = requestedDeviceId || process.env.DEFAULT_REPORT_DEVICE_ID || 'ESP32_GENERATOR_01';
    const timeFilter = {};

    if (startDate || endDate) {
        const start = startDate ? new Date(startDate) : null;
        const end = endDate ? new Date(endDate) : null;
        if (start && !Number.isNaN(start.getTime())) timeFilter.$gte = start;
        if (end && !Number.isNaN(end.getTime())) timeFilter.$lte = end;
    } else if (hours) {
        const parsedHours = Number(hours);
        if (Number.isFinite(parsedHours) && parsedHours > 0) {
            timeFilter.$gte = new Date(Date.now() - parsedHours * 60 * 60 * 1000);
        }
    }

    const dbQuery = {};
    if (Object.keys(timeFilter).length) dbQuery.timestamp = timeFilter;
    if (effectiveDeviceId) dbQuery.deviceId = effectiveDeviceId;
    return { dbQuery, effectiveDeviceId };
}

async function getReportStats(dbQuery) {
    const sensorKeys = ['rpm', 'volt', 'amp', 'power', 'freq', 'temp', 'coolant', 'fuel', 'iat', 'map', 'batt', 'afr', 'tps', 'phase'];
    const groupStage = { _id: null, count: { $sum: 1 } };

    sensorKeys.forEach((key) => {
        const dbField = key === 'phase' ? 'phaseAngle' : key;
        groupStage[`${key}Count`] = { $sum: { $cond: [{ $ne: [`$${dbField}`, null] }, 1, 0] } };
        groupStage[`${key}Avg`] = { $avg: `$${dbField}` };
        groupStage[`${key}Min`] = { $min: `$${dbField}` };
        groupStage[`${key}Max`] = { $max: `$${dbField}` };
    });

    const summary = (await GeneratorData.aggregate([{ $match: dbQuery }, { $group: groupStage }]))[0] || {};
    const bySensor = {};

    sensorKeys.forEach((key) => {
        const avg = summary[`${key}Avg`];
        const min = summary[`${key}Min`];
        const max = summary[`${key}Max`];
        if ([avg, min, max].some((v) => Number.isFinite(Number(v)))) {
            bySensor[key] = {
                count: Number(summary[`${key}Count`]) || 0,
                avg: Number.isFinite(Number(avg)) ? Number(avg) : null,
                min: Number.isFinite(Number(min)) ? Number(min) : null,
                max: Number.isFinite(Number(max)) ? Number(max) : null
            };
        }
    });

    return { totalMatched: Number(summary.count) || 0, bySensor };
}

function buildUserProfileQuery({ username, email, name } = {}) {
    const profileKey = String(username || email || name || '').trim();
    if (!profileKey) return null;
    const escaped = profileKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
        $or: [
            { email: profileKey.toLowerCase() },
            { name: profileKey },
            { name: { $regex: `^${escaped}$`, $options: 'i' } }
        ]
    };
}

function serializeUserProfile(user) {
    const email = user.email || '';
    const name = user.name || email.split('@')[0] || 'Pengguna';
    return {
        _id: user._id,
        id: user._id,
        name,
        username: name,
        email,
        role: user.role || 'Masyarakat',
        employeeID: user.employeeID || user.employeeId || user.idEmployee || 'EMP-2025-001',
        employeeId: user.employeeID || user.employeeId || user.idEmployee || 'EMP-2025-001',
        location: user.location || 'WS Bandung',
        shift: user.shift || '07.00-16.00',
        deviceId: user.deviceId || process.env.DEFAULT_REPORT_DEVICE_ID || 'GEN-TRACK-01'
    };
}

app.get('/api/reports', async (req, res) => {
    try {
        await ensureDbReady();
        const parsedLimit = parseInt(req.query.limit, 10);
        const limit = Number.isNaN(parsedLimit) ? 5000 : Math.max(1, Math.min(parsedLimit, 100000));
        const { dbQuery, effectiveDeviceId } = buildReportQuery(req.query);

        const reports = await GeneratorData.find(dbQuery).sort({ timestamp: -1 }).limit(limit).lean();
        const normalized = reports.map(normalizeReportRow).filter(Boolean);
        const stats = await getReportStats(dbQuery);

        res.json({
            success: true,
            count: normalized.length,
            data: normalized,
            stats,
            deviceIdUsed: effectiveDeviceId || null
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/reports/stats', async (req, res) => {
    try {
        await ensureDbReady();
        const { dbQuery, effectiveDeviceId } = buildReportQuery(req.query);
        const stats = await getReportStats(dbQuery);
        res.json({ success: true, stats, deviceIdUsed: effectiveDeviceId || null });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/alerts/count', async (req, res) => {
    try {
        await ensureDbReady();
        const { startDate, endDate, deviceId, status, severity } = req.query;
        const query = {};
        if (startDate || endDate) {
            query.timestamp = {};
            if (startDate) query.timestamp.$gte = new Date(startDate);
            if (endDate) query.timestamp.$lte = new Date(endDate);
        }
        if (deviceId) query.deviceId = deviceId;
        if (status === 'unresolved') query.resolved = false;
        if (severity) query.severity = severity;
        const count = await Alert.countDocuments(query);
        res.json({ success: true, count });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/users/profile', async (req, res) => {
    try {
        await ensureDbReady();
        const profileQuery = buildUserProfileQuery(req.query);
        if (!profileQuery) return res.status(400).json({ success: false, message: 'Parameter username atau email wajib diisi.' });
        const user = await User.findOne(profileQuery).lean();
        if (!user) return res.status(404).json({ success: false, message: 'Data profil tidak ditemukan.' });
        const profile = serializeUserProfile(user);
        res.json({ success: true, data: profile, user: profile });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal mengambil profil user.', error: error.message });
    }
});

app.put('/api/users/profile', async (req, res) => {
    try {
        await ensureDbReady();
        const body = req.body || {};
        const profileQuery = buildUserProfileQuery({ username: body.currentName || body.username, email: body.currentEmail || body.email });
        if (!profileQuery) return res.status(400).json({ success: false, message: 'currentName atau email wajib diisi.' });

        const user = await User.findOne(profileQuery);
        if (!user) return res.status(404).json({ success: false, message: 'Data profil tidak ditemukan.' });
        if (body.newPassword) {
            if (!body.oldPassword || user.password !== body.oldPassword) {
                return res.status(401).json({ success: false, message: 'Password lama tidak sesuai.' });
            }
            user.password = String(body.newPassword);
        }
        if (body.name) user.name = String(body.name).trim();
        if (body.email) user.email = normalizeEmail(body.email);
        if (body.location) user.location = String(body.location).trim();
        if (body.shift) user.shift = String(body.shift).trim();
        if (body.deviceId) user.deviceId = String(body.deviceId).trim();
        await user.save();
        const profile = serializeUserProfile(user.toObject());
        res.json({ success: true, message: 'Profil berhasil diperbarui.', data: profile, user: profile });
    } catch (error) {
        const status = error.code === 11000 ? 409 : 500;
        res.status(status).json({ success: false, message: status === 409 ? 'Email sudah digunakan.' : 'Gagal memperbarui profil user.', error: error.message });
    }
});

app.get('/api/reports/monthly', async (req, res) => {
    try {
        const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);
        const year = parseInt(req.query.year, 10) || new Date().getFullYear();
        const start = new Date(year, month - 1, 1);
        const end = new Date(year, month, 1);
        const rows = await GeneratorData.find({ timestamp: { $gte: start, $lt: end } }).sort({ timestamp: 1 }).lean();
        const analysis = analyzeReportRows(rows, { month, year });
        res.json({ success: true, count: rows.length, data: analysis });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// =========================
// AUTH ROUTES
// =========================
app.post('/api/auth/login', async (req, res) => {
    try {
        const email = normalizeEmail(req.body?.email);
        const password = String(req.body?.password || '');
        const result = await loginUserByEmailPassword(email, password);
        return res.status(result.status).json(result.body);
    } catch (error) {
        console.error('Login API error:', error.message);
        return res.status(503).json({
            success: false,
            message: 'Server login belum siap atau database tidak dapat dihubungi.',
            error: error.message
        });
    }
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const result = await registerUser({
            name: String(req.body?.name || '').trim(),
            email: normalizeEmail(req.body?.email),
            password: String(req.body?.password || ''),
            productToken: String(req.body?.productToken || '').trim(),
            role: 'warga',
            requireProductToken: true
        });
        return res.status(result.status).json(result.body);
    } catch (error) {
        console.error('Register API error:', error.message);
        return res.status(503).json({
            success: false,
            message: 'Server registrasi belum siap atau database tidak dapat dihubungi.',
            error: error.message
        });
    }
});

app.post('/register', async (req, res) => {
    try {
        const result = await registerUser({
            name: String(req.body?.name || '').trim(),
            email: normalizeEmail(req.body?.email),
            password: String(req.body?.password || ''),
            role: req.body?.role || 'Masyarakat',
            requireProductToken: false
        });
        return res.status(result.status).json(result.body);
    } catch (error) {
        return res.status(503).json({ success: false, message: 'Server error', error: error.message });
    }
});

app.post('/login', async (req, res) => {
    try {
        const email = normalizeEmail(req.body?.email);
        const password = String(req.body?.password || '');
        const result = await loginUserByEmailPassword(email, password);
        if (!result.body.success) return res.status(result.status).json(result.body);

        return res.json({
            success: true,
            message: 'Login berhasil',
            user: result.body.user
        });
    } catch (error) {
        return res.status(503).json({ success: false, message: 'Server error', error: error.message });
    }
});

app.post('/api/alerts/:id/email', async (req, res) => {
    try {
        const alert = await Alert.findById(req.params.id).lean();
        if (!alert) return res.status(404).json({ success: false, error: 'Alert not found' });
        const latest = await GeneratorData.findOne({ deviceId: alert.deviceId }).sort({ timestamp: -1 }).lean();
        await sendCriticalAlertEmail([alert], latest || { deviceId: alert.deviceId }, req.body?.email);
        res.json({ success: true, message: 'Alert email sent' });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ============================================================
// RECOMMENDATION + REPORT WORKERS
// ============================================================
const workerStateSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    value: Object,
    updatedAt: { type: Date, default: Date.now }
});
const WorkerState = mongoose.models.WorkerState || mongoose.model('WorkerState', workerStateSchema, 'workerstates');

function startMaintenanceSuggestionWorker() {
    const intervalMs = parseInt(process.env.MAINTENANCE_WORKER_INTERVAL_MS || '3600000', 10);
    const staleMs = parseInt(process.env.MAINTENANCE_SUGGESTION_STALE_MS || String(24 * 60 * 60 * 1000), 10);

    async function runOnce() {
        try {
            if (!isDbReady()) return;
            const latest = await GeneratorData.findOne().sort({ timestamp: -1 }).lean();
            if (!latest) return;
            const existing = await MaintenanceSuggestion.findOne({ status: { $in: ['pending', 'approved'] } }).sort({ createdAt: -1 }).lean();
            if (existing && Date.now() - new Date(existing.createdAt).getTime() < staleMs) return;

            const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const recentAlerts = await Alert.find({ timestamp: { $gte: cutoff } }).sort({ timestamp: -1 }).limit(100).lean();
            const decision = generateMaintenanceDecision(latest, recentAlerts);
            if (!decision || decision.status === 'AMAN') return;

            await MaintenanceSuggestion.create(toSuggestionDocument(decision));
            console.log('🔧 Maintenance suggestion generated:', decision.status);
        } catch (error) {
            console.error('Maintenance worker error:', error.message);
        }
    }

    setInterval(runOnce, intervalMs);
    setTimeout(runOnce, 30000);
}

function startMonthlyReportWorker() {
    const intervalMs = parseInt(process.env.REPORT_WORKER_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);
    async function runOnce() {
        try {
            if (!isDbReady()) return;
            const now = new Date();
            const month = now.getMonth() + 1;
            const year = now.getFullYear();
            const key = `monthly-report-${year}-${String(month).padStart(2, '0')}`;
            const existing = await WorkerState.findOne({ key }).lean();
            const todayKey = now.toISOString().slice(0, 10);
            if (existing?.value?.lastRunDate === todayKey) return;

            const start = new Date(year, month - 1, 1);
            const end = new Date(year, month, 1);
            const rows = await GeneratorData.find({ timestamp: { $gte: start, $lt: end } }).sort({ timestamp: 1 }).lean();
            const analysis = analyzeReportRows(rows, { month, year });
            await WorkerState.findOneAndUpdate(
                { key },
                { value: { month, year, lastRunDate: todayKey, analysis }, updatedAt: new Date() },
                { upsert: true, new: true }
            );
            console.log(`📄 Monthly report worker updated ${key} (${rows.length} rows)`);
        } catch (error) {
            console.error('Monthly report worker error:', error.message);
        }
    }
    setInterval(runOnce, intervalMs);
    setTimeout(runOnce, 45000);
}

// ============================================================
// CBM WORKER + API
// ============================================================
const cbmAnalysisSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now, index: true },
    deviceId: { type: String, index: true },
    status: String,
    healthIndex: Number,
    riskScore: Number,
    recommendations: [String],
    indicators: Object,
    sourceData: Object
});
const CBMAnalysis = mongoose.models.CBMAnalysis || mongoose.model('CBMAnalysis', cbmAnalysisSchema, 'cbmanalyses');


function normalizeCbmNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function buildCbmDateFilter({ hours, startDate, endDate } = {}) {
    const timestamp = {};

    if (startDate || endDate) {
        const start = startDate ? new Date(startDate) : null;
        const end = endDate ? new Date(endDate) : null;
        if (start && !Number.isNaN(start.getTime())) timestamp.$gte = start;
        if (end && !Number.isNaN(end.getTime())) {
            end.setHours(23, 59, 59, 999);
            timestamp.$lte = end;
        }
    } else {
        const parsedHours = normalizeCbmNumber(hours, 168);
        const safeHours = Math.max(1, Math.min(parsedHours, 24 * 365));
        timestamp.$gte = new Date(Date.now() - safeHours * 60 * 60 * 1000);
    }

    return Object.keys(timestamp).length ? timestamp : null;
}

async function getTotalOperatingHours(deviceId) {
    const match = {};
    if (deviceId) match.deviceId = deviceId;

    const [summary] = await ActiveTimeHistory.aggregate([
        { $match: match },
        { $group: { _id: null, totalMs: { $sum: '$durationMs' } } }
    ]);

    return ((summary?.totalMs || 0) / 3600000);
}

async function createCbmAnalysisPayload(options = {}) {
    await ensureDbReady();

    const deviceId = options.deviceId || process.env.DEFAULT_REPORT_DEVICE_ID || null;
    const query = {};
    if (deviceId) query.deviceId = deviceId;

    const dateFilter = buildCbmDateFilter(options);
    if (dateFilter) query.timestamp = dateFilter;

    let rows = await GeneratorData.find(query).sort({ timestamp: 1 }).limit(10000).lean();

    // Jika filter device/date terlalu sempit, tetap berikan hasil dari data terbaru
    // agar panel CBM tidak kosong total.
    if (!rows.length) {
        const fallbackQuery = deviceId ? { deviceId } : {};
        rows = await GeneratorData.find(fallbackQuery).sort({ timestamp: -1 }).limit(1000).lean();
        rows.reverse();
    }

    const totalOperatingHours = await getTotalOperatingHours(deviceId);
    const fftPeaks = Array.isArray(options.fftPeaks) ? options.fftPeaks : [];
    const rpmMean = normalizeCbmNumber(options.rpmMean, 0);
    return analyzeCBM(rows, ACTIVE_THRESHOLDS, totalOperatingHours, fftPeaks, rpmMean);
}

async function runCbmAnalysisOnce() {
    if (!isDbReady()) return null;
    const latest = await GeneratorData.findOne().sort({ timestamp: -1 }).lean();
    if (!latest) return null;
    const analysis = await createCbmAnalysisPayload({ deviceId: latest.deviceId, hours: 168 });
    const doc = await CBMAnalysis.create({
        deviceId: latest.deviceId,
        ...analysis,
        sourceData: {
            rpm: latest.rpm,
            volt: latest.volt,
            freq: latest.freq,
            coolant: latest.coolant,
            fuel: latest.fuel,
            amp: latest.amp,
            batt: latest.batt,
            map: latest.map
        }
    });
    return doc;
}

function startCbmWorker() {
    const intervalMs = parseInt(process.env.CBM_WORKER_INTERVAL_MS || '3600000', 10);
    async function run() {
        try {
            const doc = await runCbmAnalysisOnce();
            if (doc) console.log('🧠 CBM worker saved analysis:', doc.status, doc.healthIndex);
        } catch (error) {
            console.error('CBM worker error:', error.message);
        }
    }
    setInterval(run, intervalMs);
    setTimeout(run, 60000);
}


app.all('/api/cbm/analysis', async (req, res) => {
    try {
        if (!['GET', 'POST'].includes(req.method)) {
            return res.status(405).json({ success: false, error: 'Method not allowed' });
        }
        const options = req.method === 'POST' ? (req.body || {}) : (req.query || {});
        const data = await createCbmAnalysisPayload(options);
        res.json({ success: true, data });
    } catch (error) {
        console.error('CBM analysis error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/cbm/suggestion', async (req, res) => {
    try {
        await ensureDbReady();
        const finding = req.body?.finding || req.body || {};
        const level = String(finding.level || finding.priority || '').toLowerCase();
        const decisionStatus = level === 'critical' || level === 'high'
            ? 'BAHAYA'
            : level === 'warn' || level === 'medium'
                ? 'WASPADA'
                : 'AMAN';

        const suggestion = await saveMaintenanceSuggestion({
            source: 'cbm',
            decisionStatus,
            message: finding.details || finding.message || finding.action || 'Saran dari analisis CBM',
            recommendation: finding.action || finding.recommendation || finding.details || 'Lakukan inspeksi berdasarkan rekomendasi CBM',
            priority: decisionStatus === 'BAHAYA' ? 'high' : decisionStatus === 'WASPADA' ? 'medium' : 'low',
            estimatedCost: finding.estimatedCost || finding.cost || 0,
            suggestedDate: finding.suggestedDate || null
        });

        res.json({ success: true, data: suggestion });
    } catch (error) {
        console.error('CBM suggestion error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/cbm/latest', async (req, res) => {
    try {
        const query = req.query.deviceId ? { deviceId: req.query.deviceId } : {};
        const latest = await CBMAnalysis.findOne(query).sort({ timestamp: -1 }).lean();
        res.json({ success: true, data: latest });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/cbm/run', async (req, res) => {
    try {
        const doc = await runCbmAnalysisOnce();
        res.json({ success: true, data: doc });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// =========================
// START SERVER
// =========================
function startBackgroundWorkers() {
    startMaintenanceSuggestionWorker();
    startMonthlyReportWorker();
    startCbmWorker();
}

const PORT = process.env.PORT || 3023;

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running at http://0.0.0.0:${PORT}`);
        startBackgroundWorkers();
    });
}

module.exports = app;
