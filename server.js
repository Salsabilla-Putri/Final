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

function cleanEnvValue(value) {
    if (value === undefined || value === null) return '';
    let cleaned = String(value).trim();

    while (cleaned.length >= 2) {
        const first = cleaned[0];
        const last = cleaned[cleaned.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            cleaned = cleaned.slice(1, -1).trim();
        } else {
            break;
        }
    }

    return cleaned;
}

function envValue(name, fallback = '') {
    const cleaned = cleanEnvValue(process.env[name]);
    return cleaned || fallback;
}

function firstEnvValue(...names) {
    for (const name of names) {
        const value = envValue(name);
        if (value) return value;
    }
    return '';
}

function firstEmailEnvValue(...names) {
    for (const name of names) {
        const value = envValue(name);
        if (value && value.includes('@')) return value;
    }
    return '';
}

const sgMail = require('@sendgrid/mail');
const sendGridApiKey = envValue('SENDGRID_API_KEY');
if (sendGridApiKey) sgMail.setApiKey(sendGridApiKey);
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
const { estimateComponentLife } = require('./lib_component_life');
const FF = require('./feature-flags');

const app = express();
const isVercelRuntime = Boolean(process.env.VERCEL || process.env.NOW_REGION || process.env.AWS_LAMBDA_FUNCTION_NAME);
const enableServerlessMqtt = process.env.ENABLE_SERVERLESS_MQTT === 'true';
let shouldStartMqtt = !isVercelRuntime || enableServerlessMqtt;
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

function buildMongoUri(uri) {
    const normalizedUri = /^mongodb(\+srv)?:\/\//i.test(uri) ? uri : `mongodb://${uri}`;
    const isSrvUri = /^mongodb\+srv:\/\//i.test(normalizedUri);

    if (isSrvUri && /[?&]directConnection=/i.test(normalizedUri)) {
        const parsedUri = new URL(normalizedUri);
        parsedUri.searchParams.delete('directConnection');
        return parsedUri.toString();
    }

    return normalizedUri;
}

function getMongoUriDiagnostics(uri) {
    try {
        const parsedUri = new URL(uri);
        return {
            protocol: parsedUri.protocol.replace(':', ''),
            host: parsedUri.host,
            database: parsedUri.pathname.replace(/^\//, '') || '(default)',
            authSource: parsedUri.searchParams.get('authSource') || '(not set)',
            directConnection: parsedUri.searchParams.get('directConnection') || '(not set)'
        };
    } catch (error) {
        return { protocol: '(invalid)', host: '(invalid)', database: '(invalid)', authSource: '(unknown)', directConnection: '(unknown)' };
    }
}

function getMongoConnectionHint(error) {
    const message = error?.message || String(error);

    if (/ECONNREFUSED/i.test(message)) {
        return 'TCP connection was refused by the MongoDB host/port. Check that mongod is listening on the public interface, port 27017 is open, and Render outbound IPs are allowed by the database firewall/allowlist.';
    }

    if (/SRV URI does not support directConnection/i.test(message)) {
        return 'Remove directConnection=true from mongodb+srv:// URIs, or use a standard mongodb:// host URI when directConnection is required.';
    }

    if (/authentication failed|auth failed/i.test(message)) {
        return 'MongoDB reached the server but authentication failed. Check username, password, database name, and authSource.';
    }

    if (/ENOTFOUND|querySrv|ETIMEOUT|server selection/i.test(message)) {
        return 'MongoDB driver could not select/reach a server. Check DNS, firewall, database availability, and network access from Render.';
    }

    return null;
}

function logMongoConnectionError(context, error, includeStack = false) {
    const hint = getMongoConnectionHint(error);
    console.error(context, includeStack ? error : error?.message || error);
    if (hint) console.error('MongoDB connection hint:', hint);
}

async function ensureDbReady() {
    if (isDbReady()) return true;

    if (dbConnectPromise) {
        await dbConnectPromise;
        return isDbReady();
    }

    // Normalisasi URI MongoDB: pastikan ada protokol tanpa mengubah opsi koneksi
    // yang sudah diset di environment Render/local. Satu-satunya opsi yang dihapus
    // adalah directConnection pada URI mongodb+srv:// karena driver MongoDB menolaknya.
    const rawMongoUri = envValue('MONGODB_URI');

    if (!rawMongoUri) {
        throw new Error('MONGODB_URI is required. Set it in .env or environment variables.');
    }

    const mongoUri = buildMongoUri(rawMongoUri);
    console.info('MongoDB connection target:', getMongoUriDiagnostics(mongoUri));

    dbConnectPromise = mongoose.connect(mongoUri, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: parseInt(envValue('MONGODB_SERVER_SELECTION_TIMEOUT_MS', '30000'), 10),
        socketTimeoutMS: parseInt(envValue('MONGODB_SOCKET_TIMEOUT_MS', '45000'), 10),
        connectTimeoutMS: parseInt(envValue('MONGODB_CONNECT_TIMEOUT_MS', '30000'), 10),
        heartbeatFrequencyMS: 10000
    })
    .then(async () => {
        console.log('✅ MongoDB Connected');
        await loadThresholdsFromDB(); // Load threshold saat server nyala/reconnect
        await cleanupGeneratorDataFieldsFromDB();
    })
    .catch((err) => {
        logMongoConnectionError('❌ MongoDB Connection Error:', err, true);
        throw err;
    })
    .finally(() => {
        dbConnectPromise = null;
    });

    await dbConnectPromise;
    return isDbReady();
}

setInterval(async () => {
    if (isDbReady()) {
        try {
            // Mengirim query super ringan agar koneksi tidak dianggap "Idle" oleh Firewall
            await mongoose.connection.db.admin().ping();
            // console.log('💓 Database ping OK'); // Aktifkan baris ini jika ingin melihat log ping di terminal
        } catch (err) {
            console.error('⚠️ Database ping gagal (Koneksi mungkin terputus):', err.message);
        }
    }
}, 3 * 60 * 1000); // Lakukan ping setiap 3 Menit

// --- SCHEMAS ---
const generatorDataSchema = new mongoose.Schema({
    // recordId opsional untuk deduplikasi bila payload memilikinya.
    recordId: String,
    localSeq: Number,

    timestamp: { type: Date, default: Date.now },
    deviceId: { type: String, required: true },
    rpm: Number,
    volt: Number,
    voltGrid: Number,
    amp: Number,
    power: Number,
    freq: Number,
    freqGrid: Number,
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
    phaseAngle: Number,
    serverReceivedAt: Date,
    transportLatencyMs: Number
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

const alertSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now },
    deviceId: String,
    parameter: String,
    value: Number,
    message: String,
    severity: { type: String, enum: ['low', 'medium', 'high', 'warning', 'critical'], default: 'medium' },
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

// Di Vercel, jangan membuka koneksi MongoDB saat module di-import agar cold start
// tidak berubah menjadi 502. Koneksi dibuka saat pertama kali request API butuh DB.
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


function normalizeHttpUrl(raw) {
    const url = (raw || '').trim();
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url.replace(/\/+$/, '');
    return `https://${url}`.replace(/\/+$/, '');
}

const BACKEND_URL = normalizeHttpUrl(firstEnvValue('BACKEND_URL', 'APP_BASE_URL', 'PUBLIC_BASE_URL'));
const EMAIL_NOTIF_FROM = firstEmailEnvValue('ALERT_EMAIL_FROM', 'SENDER_EMAIL', 'EMAIL_USER') || 'onboarding@resend.dev';
const ALERT_EMAIL_COOLDOWN_MS = parseInt(envValue('ALERT_EMAIL_COOLDOWN_MS', '60000'), 10);
const RESEND_API_KEY = envValue('RESEND_API_KEY');
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
    const apiKey = envValue('SENDGRID_API_KEY');
    const senderEmail = firstEmailEnvValue('SENDER_EMAIL', 'EMAIL_USER', 'ALERT_EMAIL_FROM');

    if (!apiKey) {
        console.warn('⚠️ SENDGRID_API_KEY tidak ditemukan.');
        return;
    }

    if (!senderEmail) {
        console.warn('⚠️ Sender email tidak ditemukan. Set SENDER_EMAIL atau EMAIL_USER.');
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
                    ${BACKEND_URL ? `
                    <div style="text-align: center; margin-top: 30px;">
                        <a href="${BACKEND_URL}"
                           style="background-color: #0275d8; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">
                           Buka Dashboard Monitoring
                        </a>
                    </div>` : ''}
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
// Normalisasi URL broker: tambah protokol default jika tidak ada
function normalizeBrokerUrl(raw, defaultProtocol = 'mqtt') {
    const url = (raw || '').trim();
    if (!url) return null;
    if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(url)) return url;
    return `${defaultProtocol}://${url}`;
}

// MQTT credentials: bisa dioverride melalui .env / environment variables
const MQTT_BROKER_URL = normalizeBrokerUrl(envValue('MQTT_BROKER', 'mqtt://generatorta20.cloud.shiftr.io'));
const MQTT_VHOST = envValue('MQTT_VHOST');
const MQTT_USERNAME = envValue('MQTT_USERNAME', 'generatorta20');
const MQTT_PASSWORD = envValue('MQTT_PASSWORD', 'TA252601020');
const isMqttConfigured = Boolean(MQTT_BROKER_URL && MQTT_USERNAME && MQTT_PASSWORD);

if (!isMqttConfigured) {
    shouldStartMqtt = false;
    console.warn('⚠️ MQTT disabled: set MQTT_BROKER, MQTT_USERNAME, and MQTT_PASSWORD in .env.');
}

// RabbitMQ MQTT plugin: set MQTT_AUTH_USERNAME jika broker membutuhkan format username khusus.
const MQTT_AUTH_USERNAME = envValue('MQTT_AUTH_USERNAME')
    || (MQTT_VHOST ? `${MQTT_VHOST}:${MQTT_USERNAME}` : MQTT_USERNAME);

const mqttClient = mqtt && shouldStartMqtt
    ? mqtt.connect(MQTT_BROKER_URL, {
        clientId: 'server-' + Math.random().toString(16).slice(2, 8),
        username: MQTT_AUTH_USERNAME,
        password: MQTT_PASSWORD,
        keepalive: parseInt(envValue('MQTT_KEEPALIVE_SEC', '120'), 10),
        reconnectPeriod: parseInt(envValue('MQTT_RECONNECT_PERIOD_MS', '10000'), 10),
        connectTimeout: parseInt(envValue('MQTT_CONNECT_TIMEOUT_MS', '10000'), 10),
        reschedulePings: true,
        reconnectOnConnackError: true,
        clean: true
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
    serverStartTime: Date.now(),
    connectedAt: null,
    lastMessageAt: null,
    lastTopic: null,
    lastPayloadBytes: 0,
    lastRecordCount: 0,
    esp32SentRecords: 0,
    lastEsp32SentRecords: 0,
    lastEsp32RecordId: null,
    lastEsp32LocalSeq: null,
    receivedMessages: 0,
    invalidJsonMessages: 0,
    ignoredMessages: 0,
    savedMessages: 0,
    insertedRecords: 0,
    duplicateRecords: 0,
    lastInsertedRecords: 0,
    lastDuplicateRecords: 0,
    bufferedRecords: 0,
    lastBufferedAt: null,
    nextFlushAt: null,
    lastFlushAt: null,
    lastFlushReason: null,
    lastFlushedRecords: 0,
    lastErrorAt: null,
    lastError: null, 
    totalBatchAttempts: 0,
    failedBatches: 0
};

function updateMqttIngestError(error) {
    mqttIngestStats.lastErrorAt = new Date();
    mqttIngestStats.lastError = error?.message || String(error);
}

function getMqttPayloadRecordCount(payload) {
    if (Array.isArray(payload)) return payload.length;
    if (Array.isArray(payload?.records)) return payload.records.length;
    if (payload && typeof payload === 'object') return 1;
    return 0;
}

function getLatestMqttPayloadRecord(payload) {
    if (Array.isArray(payload) && payload.length) return payload[payload.length - 1];
    if (Array.isArray(payload?.records) && payload.records.length) return payload.records[payload.records.length - 1];
    return payload && typeof payload === 'object' ? payload : null;
}

function logEsp32SentRecordCount(topic, payload, payloadBytes) {
    const recordCount = getMqttPayloadRecordCount(payload);
    const latestRecord = getLatestMqttPayloadRecord(payload) || {};

    mqttIngestStats.lastRecordCount = recordCount;
    mqttIngestStats.lastEsp32SentRecords = recordCount;
    mqttIngestStats.esp32SentRecords += recordCount;
    mqttIngestStats.lastEsp32RecordId = latestRecord.recordId || null;
    mqttIngestStats.lastEsp32LocalSeq = latestRecord.localSeq ?? null;

    console.log(
        `📥 ESP32 sent record(s) received | topic=${topic} | records=${recordCount} | totalFromEsp32=${mqttIngestStats.esp32SentRecords} | bytes=${payloadBytes} | recordId=${mqttIngestStats.lastEsp32RecordId || '-'} | localSeq=${mqttIngestStats.lastEsp32LocalSeq ?? '-'}`
    );
}


function shouldSkipApiDbWarmup(req) {
    if (req.method !== 'GET') return false;
    return [
        '/api/health',
        '/api/ingest/status',
        '/api/ingest/batch',
        '/api/mqtt-ingest/status',
        '/api/engine-data/latest',
        '/api/engine-data/stream'
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
        logMongoConnectionError('API DB connection error:', error);
        res.status(503).json({
            success: false,
            error: 'Database connection unavailable',
            details: process.env.NODE_ENV === 'production' ? undefined : error.message
        });
    }
});

let latestData = {
    deviceId: 'ESP32_GENERATOR_01', timestamp: null,
    rpm: 0, volt: 0, voltGrid: 0, amp: 0, power: 0, freq: 0, freqGrid: 0, temp: 0, coolant: 0,
    fuel: 0, sync: 'OFF-GRID', synced: false, powerSource: 'OFF', status: 'STOPPED', oil: 0, iat: 0, map: 0, batt: 0, afr: 0, tps: 0, ecuConnected: undefined
};
let activeSessions = new Map();
const ECU_DISCONNECT_THRESHOLD_MS = parseInt(process.env.ECU_DISCONNECT_THRESHOLD_MS || '10000', 10);
const ACTIVE_TIME_INACTIVE_THRESHOLD_MS = parseInt(process.env.ACTIVE_TIME_INACTIVE_THRESHOLD_MS || String(2.5 * 60 * 1000), 10);
const ACTIVE_TIME_INCREMENT_MS = parseInt(process.env.ACTIVE_TIME_INCREMENT_MS || String(2 * 60 * 1000), 10);
const ACTIVE_SESSION_TIMEOUT_MS = Math.max(ACTIVE_TIME_INACTIVE_THRESHOLD_MS, parseInt(process.env.ACTIVE_SESSION_TIMEOUT_MS || String(ACTIVE_TIME_INACTIVE_THRESHOLD_MS), 10));
let latestRealtimeReceivedAt = null;
const engineStreamClients = new Set();

function getRealtimeLastSeenAt(data = latestData, receivedAt = latestRealtimeReceivedAt) {
    return getValidDate(data?.realtimeReceivedAt || data?.lastMqttUpdate) || getValidDate(receivedAt);
}

function isFreshRealtimeConnection(data = latestData, receivedAt = latestRealtimeReceivedAt) {
    const lastSeenAt = getRealtimeLastSeenAt(data, receivedAt);
    return Boolean(lastSeenAt && (Date.now() - lastSeenAt.getTime()) <= ECU_DISCONNECT_THRESHOLD_MS);
}


function applyDisconnectedPowerSource(data = {}, ecuConnected = data?.ecuConnected) {
    if (ecuConnected !== false) return data;

    return {
        ...data,
        ecuConnected: false,
        powerSource: 'OFF',
        sync: 'OFF',
        synced: false
    };
}

function buildEngineRealtimeStreamPayload() {
    const realtimeLastSeenAt = getRealtimeLastSeenAt();
    const displayTimestamp = realtimeLastSeenAt || getValidDate(latestData?.timestamp) || null;
    const ecuConnected = isFreshRealtimeConnection();
    const streamData = applyDisconnectedPowerSource({
        ...latestData,
        timestamp: displayTimestamp || latestData?.timestamp,
        lastUpdated: displayTimestamp || latestData?.timestamp,
        lastMqttUpdate: realtimeLastSeenAt,
        realtimeReceivedAt: realtimeLastSeenAt,
        ecuConnected
    }, ecuConnected);

    return {
        success: true,
        source: 'realtime-stream',
        data: {
            ...streamData,
            alerts: generateAlerts(streamData, null),
            ...getPublicLabels(streamData)
        }
    };
}

function sendEngineStreamEvent(res, payload = buildEngineRealtimeStreamPayload()) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastEngineRealtimeUpdate() {
    if (!engineStreamClients.size) return;
    const payload = buildEngineRealtimeStreamPayload();
    for (const client of engineStreamClients) {
        try { sendEngineStreamEvent(client, payload); }
        catch (error) { engineStreamClients.delete(client); }
    }
}

function isRealtimeSnapshotFresh(data = latestData, receivedAt = latestRealtimeReceivedAt) {
    if (!data || data._realtime !== true) return false;
    return isFreshRealtimeConnection(data, receivedAt);
}

function getValidDate(value) {
    const dt = value ? new Date(value) : null;
    return dt && Number.isFinite(dt.getTime()) ? dt : null;
}

function getSaneTimestamp(value, fallback = null) {
    const dt = getValidDate(value);
    if (!dt) return fallback;

    const year = dt.getUTCFullYear();
    const tooOld = year < 2020;
    const tooFuture = dt.getTime() - Date.now() > 24 * 60 * 60 * 1000;
    const absurdYear = year > 2100;
    return (tooOld || tooFuture || absurdYear) ? fallback : dt;
}

function getLatestRealtimeSnapshot() {
    if (!isRealtimeSnapshotFresh()) return null;

    const timestamp = getValidDate(latestData?.timestamp) || getValidDate(latestRealtimeReceivedAt) || new Date();
    return {
        ...latestData,
        timestamp,
        lastMqttUpdate: latestRealtimeReceivedAt,
        realtimeReceivedAt: latestRealtimeReceivedAt
    };
}

function pickLatestEngineSnapshot(dbData, deviceId) {
    const dbTimestamp = getValidDate(dbData?.timestamp);
    const realtimeData = getLatestRealtimeSnapshot();

    // Page engine harus menampilkan data MQTT yang baru diterima secara real-time.
    // Timestamp dari ESP32/backup kadang lebih tua/lebih baru dari dokumen MongoDB,
    // jadi snapshot realtime yang masih fresh lebih diprioritaskan berdasarkan waktu diterima server.
    if (realtimeData && (!deviceId || realtimeData.deviceId === deviceId)) return realtimeData;
    if (dbData) return { ...dbData, timestamp: dbTimestamp || dbData.timestamp };
    return realtimeData;
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
    if (endedAt && !Number.isNaN(endedAt.getTime())) {
        return endedAt;
    }

    const sampledAt = getSessionSampledAt(row);
    const reference = safeEventTime(referenceTime);
    const elapsedSinceSample = reference.getTime() - sampledAt.getTime();
    const incrementEnd = new Date(sampledAt.getTime() + ACTIVE_TIME_INCREMENT_MS);
    if (elapsedSinceSample > ACTIVE_SESSION_TIMEOUT_MS) return incrementEnd;
    return incrementEnd < reference ? incrementEnd : reference;
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
            calc: { rpmThreshold: 0, rule: 'ECU connected via MQTT', sampledAt: end }
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
    const eventTime = safeEventTime(data?.timestamp || data?.realtimeReceivedAt || data?.serverReceivedAt || latestRealtimeReceivedAt || new Date());
    const currentTime = new Date();
    const timeSinceLatestData = currentTime.getTime() - eventTime.getTime();
    const isRunning = timeSinceLatestData >= 0 && timeSinceLatestData <= ACTIVE_TIME_INACTIVE_THRESHOLD_MS;
    const deviceId = data?.deviceId || latestData.deviceId || 'GENERATOR #1';
    const key = `${deviceId}`;
    let session = activeSessions.get(key);

    if (!session) {
        const openRow = await ActiveTimeHistory.findOne({ deviceId, endedAt: null }).sort({ startedAt: -1 }).lean();
        if (openRow) {
            const sampledAt = getSessionSampledAt(openRow);
            if (eventTime.getTime() <= sampledAt.getTime()) return;

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
            calc: { rpmThreshold, rule: 'ECU connected via MQTT', sampledAt: eventTime }
        });
        return;
    }

    if (isRunning && session) {
        if (eventTime.getTime() <= session.lastSeenAt.getTime()) return;

        const gapMs = eventTime.getTime() - session.lastSeenAt.getTime();
        if (gapMs > ACTIVE_SESSION_TIMEOUT_MS) {
            await finalizeOpenActiveSession(deviceId, session.startedAt, session.lastSeenAt, 'esp32_disconnect');

            activeSessions.set(key, { startedAt: eventTime, lastSeenAt: eventTime });
            await ActiveTimeHistory.create({
                deviceId,
                startedAt: eventTime,
                source: 'mqtt',
                calc: { rpmThreshold, rule: 'ECU connected via MQTT', sampledAt: eventTime }
            });
            return;
        }

        session.lastSeenAt = eventTime;
        await ActiveTimeHistory.findOneAndUpdate(
            { deviceId, startedAt: session.startedAt, endedAt: null },
            { calc: { rpmThreshold, rule: 'ECU connected via MQTT', sampledAt: eventTime } },
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
        await closeActiveSessions('esp32_disconnect', deviceId);
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
    console.log(`✅ Connected to MQTT broker | broker: ${MQTT_BROKER_URL} | vhost: ${MQTT_VHOST || '-'} | user: ${MQTT_USERNAME}`);
    mqttClient.subscribe('gen/realtime', (err) => {
        if (err) console.error('❌ Subscribe error (gen/realtime):', err.message);
        else console.log('📡 Subscribed to gen/realtime');
    });
});

mqttClient.on('reconnect', () => console.log('🔄 MQTT Reconnecting...'));
mqttClient.on('offline',   () => console.warn('⚠️  MQTT Offline'));

mqttClient.on('error', (error) => {
    console.warn('⚠️ MQTT Error:', error.message);
});

// gen/realtime memperbarui dashboard/alert secara langsung.
// History MongoDB hanya disimpan dari buffer server gen/realtime (buffermongo).
// ============================================================
// MONGODB BATCH SAVE
// Realtime data diterima setiap 1 detik dari MQTT,
// tetapi penyimpanan GeneratorData ke MongoDB dilakukan batch
// Buffer server internal menahan tepat 600 data sebelum dikirim ke MongoDB.
// ============================================================

const DB_BATCH_INTERVAL_MS = parseInt(process.env.DB_BATCH_INTERVAL_MS || '600000', 10); // retry timer saat buffer belum penuh/DB belum ready
const DB_BATCH_RECORDS = 600; // 10 menit x 60 data/menit
const DATA_SEND_MODE = 'buffermongo';
const REALTIME_BUFFER_BACKEND_TO_MONGO = true;

let generatorBatchBuffer = [];
let activeTimeBatchBuffer = [];
let isFlushingGeneratorBatch = false;
let generatorBatchTimerStartedAt = null;
let generatorBatchFlushTimer = null;

function buildGeneratorDbDocument(data) {
    const snapshot = { ...data };
    const powerSource = normalizePowerSourceStatus(snapshot, snapshot.powerSource || 'OFF');
    const sync = snapshot.sync || getSyncStatusFromPowerSource(powerSource);

    if (snapshot.rpm > 0) {
        snapshot.status = sync === 'ON-GRID' ? 'ON-GRID' : 'RUNNING';
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
        sync,
        powerSource,
        iat: toNumber(snapshot.iat, 0),
        map: toNumber(snapshot.map, 0),
        batt: toNumber(snapshot.batt, 0),
        afr: toNumber(snapshot.afr, 0),
        tps: toNumber(snapshot.tps, 0),
        phaseAngle: toNumber(snapshot.phaseAngle ?? snapshot.phase_diff ?? snapshot.phase_angle, 0)
    };
}


function getNextGeneratorBatchFlushAt(now = new Date()) {
    const baseTime = generatorBatchTimerStartedAt || now;
    return new Date(baseTime.getTime() + DB_BATCH_INTERVAL_MS);
}

function updateGeneratorBatchStats() {
    mqttIngestStats.bufferedRecords = generatorBatchBuffer.length;
    mqttIngestStats.nextFlushAt = generatorBatchBuffer.length
        ? getNextGeneratorBatchFlushAt().toISOString()
        : null;
}

function logGeneratorBatchStatus(prefix = '📦 buffermongo buffer') {
    updateGeneratorBatchStats();
    
    let timerInfo = '';
    // Menghitung target interval (misal 10:00)
    const targetMins = Math.floor(DB_BATCH_INTERVAL_MS / 60000);
    const targetSecs = Math.floor((DB_BATCH_INTERVAL_MS % 60000) / 1000);
    const targetStr = `${String(targetMins).padStart(2, '0')}:${String(targetSecs).padStart(2, '0')}`;

    // Menghitung waktu yang sudah berjalan sejak buffer dimulai
    if (generatorBatchTimerStartedAt) {
        const elapsedMs = Math.max(0, Date.now() - generatorBatchTimerStartedAt.getTime());
        const elapsedSec = Math.floor(elapsedMs / 1000);
        const m = Math.floor(elapsedSec / 60);
        const s = elapsedSec % 60;
        const elapsedStr = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        
        timerInfo = `${elapsedStr} / ${targetStr}`;
    } else {
        timerInfo = `00:00 / ${targetStr}`;
    }

    // Menampilkan log ke terminal
    console.log(`${prefix} | buffered=${generatorBatchBuffer.length} records | timer=[${timerInfo}] | sentToMongo=${mqttIngestStats.insertedRecords} records`);
}

function scheduleGeneratorBatchFlush() {
    if (!generatorBatchTimerStartedAt || generatorBatchFlushTimer) return;

    generatorBatchFlushTimer = setTimeout(() => {
        generatorBatchFlushTimer = null;
        flushGeneratorBatch('retry-10min').catch((err) => {
            console.error('❌ Scheduled batch flush error:', err.message);
        });
    }, DB_BATCH_INTERVAL_MS);

    if (typeof generatorBatchFlushTimer.unref === 'function') {
        generatorBatchFlushTimer.unref();
    }
}


function addGeneratorDataToBatch(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;

    const now = new Date();
    if (!generatorBatchTimerStartedAt) {
        generatorBatchTimerStartedAt = now;
        // scheduleGeneratorBatchFlush();
    }

    const doc = buildGeneratorDbDocument(snapshot);
    generatorBatchBuffer.push(doc);
    activeTimeBatchBuffer.push(snapshot);
    mqttIngestStats.lastBufferedAt = now;
    updateGeneratorBatchStats();

    if (generatorBatchBuffer.length >= DB_BATCH_RECORDS) {
        setImmediate(() => {
            flushGeneratorBatch('buffer-full-600').catch((err) => {
                console.error('❌ Full buffer flush error:', err.message);
            });
        });
    }
}

function printMongoReliabilityReport() {
    const uptimeSec = Math.max(1, (Date.now() - mqttIngestStats.serverStartTime) / 1000);
    const sent = mqttIngestStats.insertedRecords || 0;
    const rateSec = sent / uptimeSec; // Rata-rata record per detik sejak server nyala
    
    const batches = mqttIngestStats.savedMessages || 0;
    const avgBatch = batches > 0 ? (sent / batches).toFixed(1) : 0;
    
    const recordSizeEst = 350; // Estimasi ukuran 1 dokumen BSON (Bytes)
    const est10YearsBytes = rateSec * 60 * 60 * 24 * 365.25 * 10 * recordSizeEst;
    
    // Fungsi format Bytes ke KB/MB/GB/TB
    const formatBytes = (bytes) => {
        if (bytes === 0) return '0 B';
        const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const mqttState = (mqttClient && mqttClient.connected) ? 'CONNECTED ✅' : 'DISCONNECTED ❌';
    const intervalMin = (DB_BATCH_INTERVAL_MS / 60000).toFixed(1);

    // Fungsi helper untuk padding spasi di terminal
    const fill = (text, width = 57) => String(text).padEnd(width) + '║';

  
    console.log('             DATABASE RELIABILITY METRICS                ');
    console.log('═════════════════════════════════════════════════════════');
    console.log(`MongoDB batch interval   : ${DB_BATCH_INTERVAL_MS} ms (${intervalMin} min)`);
    console.log(`MongoDB sent records     : ${sent} records`);
    console.log(`MongoDB failed batch     : ${mqttIngestStats.failedBatches || 0} batches`);
    console.log(`Last MQTT state          : ${mqttState}`);
    console.log(`MongoDB success rate     : ${(mqttIngestStats.savedMessages / sent * 100).toFixed(2)}%`);
    console.log(`MongoDB record size (est): ~${recordSizeEst} Bytes / record`);
    console.log(`MongoDB avg sent record  : ${avgBatch} records / batch`);
    console.log(`MongoDB records rate     : ${rateSec.toFixed(2)} records / second`);
    console.log(`Est. Payload (10 years)  : ${formatBytes(est10YearsBytes)}`);
}

async function flushGeneratorBatch(reason = 'interval') {
    if (isFlushingGeneratorBatch) return;
    mqttIngestStats.totalBatchAttempts++;
    // --- PERBAIKAN RECONNECT MONGODB ---
    // Jika koneksi terputus saat mau mengirim data, paksa untuk menyambung ulang
    if (!isDbReady()) {
        mqttIngestStats.failedBatches++;
        console.log('🔄 Koneksi terputus. Mencoba menyambung kembali ke MongoDB sebelum mengirim batch...');
        try {
            await ensureDbReady(); 
        } catch (err) {
            console.error('❌ Gagal menyambung ulang ke MongoDB:', err.message);
        }
    }

    // Cek lagi setelah dicoba reconnect. Jika memang benar-benar mati, baru tahan datanya.
    if (!isDbReady()) {
        console.warn(`⚠️ MongoDB not ready, batch retained | generator=${generatorBatchBuffer.length}`);
        if (!generatorBatchTimerStartedAt) generatorBatchTimerStartedAt = new Date();
        scheduleGeneratorBatchFlush();
        logGeneratorBatchStatus('📦 buffermongo buffer retained');
        return;
    }
    // ------------------------------------

    isFlushingGeneratorBatch = true;

    const generatorBatch = generatorBatchBuffer.splice(0, DB_BATCH_RECORDS);
    const activeTimeBatch = activeTimeBatchBuffer.splice(0, DB_BATCH_RECORDS);

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

            const result = await GeneratorData.bulkWrite(operations, { ordered: false });
            const insertedGenerator = (result.insertedCount || 0) + (result.upsertedCount || 0);
            const matchedGenerator = result.matchedCount || 0;
            mqttIngestStats.savedMessages++;
            mqttIngestStats.insertedRecords += insertedGenerator;
            mqttIngestStats.duplicateRecords += matchedGenerator;
            mqttIngestStats.lastInsertedRecords = insertedGenerator;
            mqttIngestStats.lastDuplicateRecords = matchedGenerator;
        }


        for (const snapshot of activeTimeBatch) {
            await syncActiveTimeHistory(snapshot);
        }

        mqttIngestStats.lastFlushAt = new Date();
        mqttIngestStats.lastFlushReason = reason;
        mqttIngestStats.lastFlushedRecords = generatorBatch.length;
        mqttIngestStats.lastError = null;
        mqttIngestStats.lastErrorAt = null;
        if (generatorBatchFlushTimer) {
            clearTimeout(generatorBatchFlushTimer);
            generatorBatchFlushTimer = null;
        }
        generatorBatchTimerStartedAt = new Date();
        isFlushingGeneratorBatch = false;
        
        if (generatorBatchBuffer.length >= DB_BATCH_RECORDS) {
            setImmediate(() => flushGeneratorBatch('buffer-full-600-continued').catch((err) => console.error('❌ Continued buffer flush error:', err.message)));
        } else if (generatorBatchTimerStartedAt) {
            scheduleGeneratorBatchFlush();
        }
        updateGeneratorBatchStats();

        console.log(
            `💾 MongoDB batch saved | reason=${reason} | generator=${generatorBatch.length}/${DB_BATCH_RECORDS} records | buffer=${generatorBatchBuffer.length} records | sentToMongo=${mqttIngestStats.insertedRecords} records`
        );
        printMongoReliabilityReport();
    } catch (err) {
        mqttIngestStats.failedBatches++;
        mqttIngestStats.failedBatches = (mqttIngestStats.failedBatches || 0) + 1;
        console.error('❌ MongoDB batch save error:', err.message);

        // Jika gagal, masukkan kembali ke depan buffer agar tidak hilang.
        generatorBatchBuffer = generatorBatch.concat(generatorBatchBuffer);
        activeTimeBatchBuffer = activeTimeBatch.concat(activeTimeBatchBuffer);
        if (!generatorBatchTimerStartedAt) generatorBatchTimerStartedAt = new Date();
        if (!generatorBatchFlushTimer) scheduleGeneratorBatchFlush();
        updateGeneratorBatchStats();
    } finally {
        isFlushingGeneratorBatch = false;
    }
}

// LOGIC ALARM DINAMIS (Menggunakan ACTIVE_THRESHOLDS)
// --- LOGIC ALARM DINAMIS (UPDATED) ---
// --- LOGIC ALARM DINAMIS (DIPERBAIKI) ---
async function checkAndSaveAlerts(data) {
    const alertsToSave = [];
    const T = ACTIVE_THRESHOLDS;

    const warningBandFor = (param, limit) => {
        if (param === 'freq') return 0.1;
        if (param === 'volt' || param === 'phase') return 5;
        return Math.abs(Number(limit) || 0) * 0.05;
    };
    const warningBandLabelFor = (param) => {
        if (param === 'freq') return '0.1';
        if (param === 'volt' || param === 'phase') return '5';
        return '5%';
    };

    // Critical selalu mengikuti batas threshold yang disimpan dari halaman engine.
    // Warning khusus: frekuensi ±0.1, tegangan/fasa ±5, parameter lain ±5%.
    const check = (param, rawVal) => {
        const th = T[param];
        const val = Number(rawVal);
        if (!th || !Number.isFinite(val)) return;

        if (th.max !== undefined && Number.isFinite(Number(th.max))) {
            const max = Number(th.max);
            const warnFloor = max - warningBandFor(param, max);
            if (val > max) {
                alertsToSave.push({
                    parameter: param,
                    value: val,
                    message: `${param.toUpperCase()} Critical High (> ${max})`,
                    severity: 'critical'
                });
            } else if (val >= warnFloor) {
                alertsToSave.push({
                    parameter: param,
                    value: val,
                    message: `${param.toUpperCase()} Warning High (within ${warningBandLabelFor(param)} of ${max})`,
                    severity: 'warning'
                });
            }
        }

        if (th.min !== undefined && Number.isFinite(Number(th.min))) {
            const min = Number(th.min);
            const warnCeil = min + warningBandFor(param, min);
            if (val < min) {
                alertsToSave.push({
                    parameter: param,
                    value: val,
                    message: `${param.toUpperCase()} Critical Low (< ${min})`,
                    severity: 'critical'
                });
            } else if (val <= warnCeil) {
                alertsToSave.push({
                    parameter: param,
                    value: val,
                    message: `${param.toUpperCase()} Warning Low (within ${warningBandLabelFor(param)} of ${min})`,
                    severity: 'warning'
                });
            }
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
    check('phase', data.phase ?? data.phaseAngle ?? data.phase_angle ?? data.phaseDiff ?? data.phase_diff);

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
        if (FF.isEnabled('alert_email') && criticalAlerts.length > 0 && (now - lastCriticalEmailAt) > ALERT_EMAIL_COOLDOWN_MS) {
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

function toBooleanOrUndefined(value) {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'connected', 'online'].includes(normalized)) return true;
    if (['false', '0', 'no', 'disconnected', 'offline'].includes(normalized)) return false;
    return undefined;
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

function normalizePowerSourceStatus(payload = {}, fallbackSource = 'OFF') {
    const rawSource = firstDefined(
        payload.powerSource,
        payload.power_source,
        payload.supplySource,
        payload.sourceState,
        fallbackSource,
        'OFF'
    );
    const key = String(rawSource).trim().toUpperCase().replace(/[\s_-]+/g, '-');

    if (['OFF', 'ECU-OFF', 'ECU-DISCONNECTED', 'DISCONNECTED', 'OFFLINE', 'NO-DATA'].includes(key)) return 'OFF';
    if (['SYNC', 'SYNCHRONIZED', 'SINKRON', 'SINKRONISASI', 'ON-GRID', 'ONGRID'].includes(key)) return 'SYNC';
    if (['GRID', 'PLN', 'UTILITY', 'MAINS'].includes(key)) return 'GRID';
    if (['GENSET', 'GENERATOR', 'GEN', 'OFF-GRID', 'OFFGRID'].includes(key)) return 'GENSET';
    return 'OFF';
}

function getSyncStatusFromPowerSource(powerSource) {
    return powerSource === 'SYNC' ? 'ON-GRID' : 'OFF-GRID';
}

function isPowerSourceGensetActive(data = {}) {
    const source = normalizePowerSourceStatus(data, data.powerSource || latestData.powerSource || 'OFF');
    const status = String(data?.status || '').toUpperCase();
    const rpm = toNumber(data?.rpm, 0);
    const volt = toNumber(data?.volt, 0);
    const freq = toNumber(data?.freq, 0);
    const hasGeneratorOutput = rpm > 0 || volt > 20 || freq > 5 || ['RUNNING', 'ON', 'ACTIVE', 'ON-GRID'].includes(status);
    return (source === 'GENSET' || source === 'SYNC') && hasGeneratorOutput;
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
    };
}

function normalizeGeneratorPayload(rawPayload) {
    const payload = pickEffectivePayload(rawPayload);
    const receivedAt = new Date();
    const timestamp = getSaneTimestamp(payload.timestamp, receivedAt);

    const powerSource = normalizePowerSourceStatus(payload, latestData.powerSource);
    const syncStatus = normalizeSyncStatus(payload, getSyncStatusFromPowerSource(powerSource));

    const snapshot = {
        ...latestData,
        deviceId: payload.deviceId || latestData.deviceId || 'ESP32_GENERATOR_01',
        timestamp,
        rpm: toNumber(payload.rpm, latestData.rpm),
        volt: toNumber(payload.volt, latestData.volt),
        voltGrid: toNumber(payload.voltGrid ?? payload.volt_grid ?? payload.gridVolt ?? payload.grid_voltage, latestData.voltGrid),
        amp: toNumber(readAmpValue(payload), latestData.amp),
        power: toNumber(readPowerValue(payload), latestData.power),
        freq: toNumber(payload.freq, latestData.freq),
        freqGrid: toNumber(payload.freqGrid ?? payload.freq_grid ?? payload.gridFreq ?? payload.grid_frequency, latestData.freqGrid),
        temp: toNumber(firstDefined(payload.temp, payload.temperature), latestData.temp),
        coolant: toNumber(readCoolantValue(payload), latestData.coolant),
        fuel: toNumber(payload.fuel, latestData.fuel),
        sync: syncStatus,
        synced: powerSource === 'SYNC',
        powerSource,
        status: String(payload.status || latestData.status || 'STOPPED'),
        oil: toNumber(payload.oil, latestData.oil),
        iat: toNumber(payload.iat, latestData.iat),
        map: toNumber(payload.map, latestData.map),
        batt: toNumber(payload.batt ?? payload.battery ?? payload.battVolt, latestData.batt),
        afr: toNumber(payload.afr, latestData.afr),
        tps: toNumber(payload.tps, latestData.tps),
        phaseAngle: toNumber(payload.phaseAngle ?? payload.phase_angle ?? payload.phase_diff, latestData.phaseAngle ?? 0),
        ecuConnected: latestRealtimeReceivedAt ? (Date.now() - latestRealtimeReceivedAt.getTime()) <= ECU_DISCONNECT_THRESHOLD_MS : latestData.ecuConnected,
        recordId: payload.recordId || latestData.recordId,
        localSeq: payload.localSeq ?? latestData.localSeq,
        _realtime: true
    };

    const sentAt = getSaneTimestamp(snapshot.timestamp);
    snapshot.serverReceivedAt = receivedAt;
    snapshot.transportLatencyMs = sentAt ? Math.max(0, receivedAt.getTime() - sentAt.getTime()) : undefined;

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

app.get('/api/ingest/status', (req, res) => {
    updateGeneratorBatchStats();
    res.json({
        success: true,
        dbReady: isDbReady(),
        dbBatchIntervalMs: DB_BATCH_INTERVAL_MS,
        dbBatchIntervalMinutes: DB_BATCH_INTERVAL_MS / 60000,
        nextFlushAt: mqttIngestStats.nextFlushAt,
        dataSendMode: DATA_SEND_MODE,
        realtimeBufferBackendToMongo: REALTIME_BUFFER_BACKEND_TO_MONGO,
        dbBatchRecords: DB_BATCH_RECORDS,
        bufferedGeneratorRecords: generatorBatchBuffer.length,
        isFlushingGeneratorBatch
    });
});

app.get('/api/ingest/batch', (req, res) => {
    res.status(410).json({
        success: false,
        message: 'Endpoint batch backup dinonaktifkan. Server hanya menerima buffermongo dari MQTT gen/realtime.',
        method: 'POST',
        path: '/api/ingest/batch',
        dbReady: isDbReady(),
        realtimeTopic: 'gen/realtime',
        dataSendMode: DATA_SEND_MODE,
        dbBatchRecords: DB_BATCH_RECORDS,
        bufferedGeneratorRecords: generatorBatchBuffer.length
    });
});

// ============================================================
// BACKUP INGEST ENDPOINT DINONAKTIFKAN
// Server hanya memakai mode buffermongo dari MQTT gen/realtime.
// ============================================================
app.post('/api/ingest/batch', async (req, res) => {
    return res.status(410).json({
        success: false,
        error: 'Batch backup ingest is disabled. Use buffermongo via MQTT gen/realtime only.',
        dataSendMode: DATA_SEND_MODE
    });
});

mqttClient.on('message', async (topic, message) => {
    try {
        if (topic !== 'gen/realtime') return;

        const raw = message.toString();
        mqttIngestStats.receivedMessages++;
        mqttIngestStats.lastMessageAt = new Date();
        mqttIngestStats.lastTopic = topic;
        mqttIngestStats.lastPayloadBytes = Buffer.byteLength(raw);

        let parsed;
        const trimmedRaw = raw.trim();

        // Deteksi format: JSON diawali dengan '{' atau '['
        if (trimmedRaw.startsWith('{') || trimmedRaw.startsWith('[')) {
            try {
                parsed = JSON.parse(trimmedRaw);
            } catch (parseError) {
                mqttIngestStats.invalidJsonMessages++;
                updateMqttIngestError(parseError);
                console.warn(`⚠️ Invalid JSON on ${topic}:`, raw.slice(0, 500));
                return;
            }
        } else {
            // Jika bukan JSON, proses sebagai CSV Kompresi Ekstrem
            try {
                const lines = trimmedRaw.split('\n').filter(l => l.trim().length > 0);
                const records = lines.map(line => {
                    const cols = line.split(',');
                    return {
                        deviceId: cols[0],
                        recordId: cols[1],
                        localSeq: parseInt(cols[2], 10),
                        timestamp: cols[3],
                        rpm: parseFloat(cols[4]),
                        tps: parseFloat(cols[5]),
                        map: parseFloat(cols[6]),
                        iat: parseFloat(cols[7]),
                        clt: parseFloat(cols[8]),
                        afr: parseFloat(cols[9]),
                        batt: parseFloat(cols[10]),
                        fuel: parseFloat(cols[11]),
                        freq: parseFloat(cols[12]),
                        freqGrid: parseFloat(cols[13]),
                        volt: parseFloat(cols[14]),
                        voltGrid: parseFloat(cols[15]),
                        currentA: parseFloat(cols[16]),
                        powerKW: parseFloat(cols[17]),
                        phaseAngle: parseFloat(cols[18]),
                        sync: cols[19],
                        powerSource: cols[20]
                    };
                });
                
                // Bungkus array CSV ke format yang dimengerti logika backend lama
                parsed = { 
                    deviceId: records[0].deviceId,
                    records: records 
                };
            } catch (csvError) {
                mqttIngestStats.invalidJsonMessages++;
                updateMqttIngestError(csvError);
                console.warn(`⚠️ Invalid CSV format on ${topic}:`, raw.slice(0, 500));
                return;
            }
        }

        logEsp32SentRecordCount(topic, parsed, mqttIngestStats.lastPayloadBytes);

        // Semua pesan MQTT tetap memperbarui latestData agar dashboard memory selalu aktual.
        const realtimeSourcePayload = parsed;
        latestData = normalizeGeneratorPayload(realtimeSourcePayload);
        latestRealtimeReceivedAt = new Date();
        latestData.lastMqttUpdate = latestRealtimeReceivedAt;
        latestData.realtimeReceivedAt = latestRealtimeReceivedAt;
        latestData.serverReceivedAt = latestRealtimeReceivedAt;
        const espTimestamp = getValidDate(latestData.timestamp);
        latestData.transportLatencyMs = espTimestamp ? Math.max(0, latestRealtimeReceivedAt.getTime() - espTimestamp.getTime()) : latestData.transportLatencyMs;
        broadcastEngineRealtimeUpdate();

        // gen/realtime adalah jalur live untuk LCD/web dashboard. Jangan menunggu pekerjaan
        // database, alert, atau batch MongoDB di handler MQTT karena delay di sini dapat
        // membuat pesan realtime berikutnya antre dan dashboard tampak disconnected.
        if (topic === 'gen/realtime') {
            const realtimeSnapshotForBackend = {
                ...latestData,
                recordId: parsed.recordId || latestData.recordId,
                localSeq: parsed.localSeq || latestData.localSeq
            };
            const payloadMode = String(parsed.dataSendMode || parsed.sendMode || DATA_SEND_MODE || 'auto').toLowerCase();

            setImmediate(async () => {
                try {
                    await checkAndSaveAlerts(realtimeSnapshotForBackend);

                    const shouldBufferRealtimeToMongo = REALTIME_BUFFER_BACKEND_TO_MONGO && payloadMode === DATA_SEND_MODE;

                    if (shouldBufferRealtimeToMongo) {
                        addGeneratorDataToBatch(realtimeSnapshotForBackend);
                        logGeneratorBatchStatus('📦 gen/realtime buffered for MongoDB');
                    }
                } catch (backgroundError) {
                    updateMqttIngestError(backgroundError);
                    console.error('❌ Realtime background processing error:', backgroundError.message);
                }
            });

            return;
        }



    } catch (error) {
        updateMqttIngestError(error);
        if (error?.name === 'MongooseServerSelectionError' || /Mongo|ECONNREFUSED|server selection/i.test(error?.message || '')) {
            logMongoConnectionError('❌ MQTT data persistence DB error:', error, true);
        } else {
            console.error('❌ MQTT Message Error:', error);
        }
    }
});

app.get('/api/mqtt-ingest/status', (req, res) => {
    updateGeneratorBatchStats();
    res.json({
        success: true,
        mqttAvailable: Boolean(mqtt),
        mqttConnected: typeof mqttClient.connected === 'boolean' ? mqttClient.connected : false,
        broker: MQTT_BROKER_URL,
        subscribedTopics: ['gen/realtime'],
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

        const realtimeLastSeenAt = getRealtimeLastSeenAt();
        const realtimeDeviceMatches = !latestData?.deviceId || latestData.deviceId === lastRunning.deviceId;
        const ecuConnected = realtimeDeviceMatches && isFreshRealtimeConnection(latestData, realtimeLastSeenAt);
        res.json({ success: true, data: { ...lastRunning, ecuConnected } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/engine-data/stream', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    engineStreamClients.add(res);
    sendEngineStreamEvent(res);

    const heartbeat = setInterval(() => {
        try { sendEngineStreamEvent(res); }
        catch (error) {
            clearInterval(heartbeat);
            engineStreamClients.delete(res);
        }
    }, 500);

    req.on('close', () => {
        clearInterval(heartbeat);
        engineStreamClients.delete(res);
    });
});

app.get('/api/engine-data/latest', async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    try {
        const requestedDeviceId = req.query.deviceId;
        const effectiveDeviceId = requestedDeviceId || process.env.DEFAULT_REPORT_DEVICE_ID || 'ESP32_GENERATOR_01';
        const preferDatabase = ['database', 'db', '1', 'true'].includes(String(req.query.preferDatabase || req.query.prefer || '').toLowerCase());
        const realtimeData = getLatestRealtimeSnapshot();

        // Untuk dashboard live: jangan tunggu MongoDB bila MQTT baru saja masuk.
        // Engine page bisa meminta preferDatabase agar parameter tetap dari record database terakhir
        // dan hanya status ECU/power yang mengikuti koneksi realtime.
        if (!preferDatabase && realtimeData && (!effectiveDeviceId || realtimeData.deviceId === effectiveDeviceId)) {
            const lastDataAt = getValidDate(realtimeData.realtimeReceivedAt || realtimeData.lastMqttUpdate)
                || getValidDate(realtimeData.timestamp)
                || new Date();
            const serverLastUpdated = getValidDate(realtimeData.serverReceivedAt)
                || getValidDate(realtimeData.realtimeReceivedAt || realtimeData.lastMqttUpdate)
                || new Date();
            let totalEngineHours = 0;
            try {
                if (!isDbReady()) await ensureDbReady();
                totalEngineHours = await getTotalOperatingHours(effectiveDeviceId);
            } catch (hoursError) {
                console.warn('Failed to load active time hours for realtime snapshot:', hoursError.message);
            }
            const realtimeSnapshot = applyDisconnectedPowerSource({
                ...realtimeData,
                timestamp: lastDataAt,
                ecuConnected: true,
                engineHours: totalEngineHours,
                lastMqttUpdate: lastDataAt,
                serverReceivedAt: serverLastUpdated,
                lastUpdated: serverLastUpdated
            }, true);
            const enrichedRealtime = {
                ...realtimeSnapshot,
                alerts: generateAlerts(realtimeSnapshot, null),
                maintenance: getMaintenanceStatus(realtimeSnapshot, []),
                ...getPublicLabels(realtimeSnapshot)
            };
            return res.json({ success: true, data: enrichedRealtime, source: 'realtime-memory' });
        }

        if (!isDbReady()) await ensureDbReady();

        const filter = effectiveDeviceId ? { deviceId: effectiveDeviceId } : {};
        const latestDocs = await GeneratorData.find(filter).sort({ timestamp: -1 }).limit(5).lean();
        const dbData = latestDocs[0] || null;
        const baseData = pickLatestEngineSnapshot(dbData, effectiveDeviceId);
        if (!baseData) {
            const emptySnapshot = applyDisconnectedPowerSource({
                ...latestData,
                deviceId: effectiveDeviceId,
                timestamp: null,
                ecuConnected: false,
                lastMqttUpdate: null,
                realtimeReceivedAt: null,
                serverReceivedAt: null,
                lastUpdated: null
            }, false);

            return res.json({
                success: false,
                error: 'No generator data found',
                data: emptySnapshot,
                source: 'empty'
            });
        }

        const baseTimestamp = getValidDate(baseData.timestamp);
        const realtimeDeviceMatches = realtimeData && (!effectiveDeviceId || realtimeData.deviceId === effectiveDeviceId);
        const realtimeReceivedAt = realtimeDeviceMatches ? getRealtimeLastSeenAt(realtimeData, latestRealtimeReceivedAt) : null;
        const baseIsRealtime = baseData?._realtime === true;
        const lastDataAt = (baseIsRealtime && !preferDatabase ? realtimeReceivedAt : null) || baseTimestamp || getValidDate(dbData?.timestamp) || null;
        const serverLastUpdated = getValidDate(baseData.serverReceivedAt)
            || getValidDate(dbData?.serverReceivedAt)
            || getValidDate(baseData.createdAt)
            || lastDataAt
            || null;
        // Status koneksi ECU hanya boleh berasal dari pesan MQTT realtime yang benar-benar baru.
        // Dokumen MongoDB adalah data historis, sehingga timestamp database tidak boleh membuat UI terlihat Live.
        const ecuConnected = Boolean(realtimeDeviceMatches && isFreshRealtimeConnection(realtimeData, latestRealtimeReceivedAt));
        const powerState = ecuConnected ? realtimeData : null;
        const previousDoc = latestDocs.find((doc) => String(doc._id) !== String(baseData._id)) || latestDocs[1] || null;
        const totalEngineHours = await getTotalOperatingHours(effectiveDeviceId);
        const responseSnapshot = applyDisconnectedPowerSource({
            ...baseData,
            powerSource: powerState?.powerSource ?? baseData.powerSource,
            sync: powerState?.sync ?? baseData.sync,
            synced: powerState?.synced ?? baseData.synced,
            timestamp: lastDataAt || baseData.timestamp,
            ecuConnected,
            engineHours: totalEngineHours,
            lastMqttUpdate: realtimeReceivedAt || null,
            realtimeReceivedAt: realtimeReceivedAt || null,
            serverReceivedAt: serverLastUpdated,
            lastUpdated: serverLastUpdated
        }, ecuConnected);
        const enrichedData = {
            ...responseSnapshot,
            alerts: generateAlerts(responseSnapshot, previousDoc),
            maintenance: getMaintenanceStatus(responseSnapshot, latestDocs.slice(1)),
            ...getPublicLabels(responseSnapshot)
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
        const realtimeData = getLatestRealtimeSnapshot();
        const useRealtime = realtimeData && (!deviceId || realtimeData.deviceId === deviceId);
        const publicSnapshot = useRealtime
            ? applyDisconnectedPowerSource({ ...realtimeData, ecuConnected: true }, true)
            : applyDisconnectedPowerSource({ ...latestDoc, ecuConnected: false }, false);
        const payload = transformPublicStatus(publicSnapshot, previousDoc || null);

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

        // Hitung health index (sederhana: 0-100%) — gated oleh ENABLE_HEALTH_SCORE
        let health = 100;
        if (FF.isEnabled('health_score')) {
            const temp = latest.temp || latest.coolant || 0;
            const fuel = latest.fuel || 0;
            const volt = latest.volt || 0;
            const rpm  = latest.rpm  || 0;
            if (temp > 95) health -= 30;
            else if (temp > 85) health -= 10;
            if (fuel < 15) health -= 30;
            else if (fuel < 25) health -= 15;
            if (rpm > 0 && volt < 190) health -= 20;
            health = Math.max(0, Math.min(100, health));
        }

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

function buildAlertQuery(queryParams = {}) {
    const { startDate, endDate, deviceId, status, severity, parameter } = queryParams;
    const query = {};

    if (startDate || endDate) {
        query.timestamp = {};
        const start = startDate ? new Date(startDate) : null;
        const end = endDate ? new Date(endDate) : null;

        if (start && !Number.isNaN(start.getTime())) query.timestamp.$gte = start;
        if (end && !Number.isNaN(end.getTime())) {
            const inclusiveEnd = new Date(end);
            if (/^\d{4}-\d{2}-\d{2}$/.test(String(endDate))) inclusiveEnd.setHours(23, 59, 59, 999);
            query.timestamp.$lte = inclusiveEnd;
        }

        if (!Object.keys(query.timestamp).length) delete query.timestamp;
    }

    if (deviceId) query.deviceId = deviceId;
    if (parameter) query.parameter = String(parameter).toLowerCase();

    if (status === 'active' || status === 'unresolved') query.resolved = { $ne: true };
    else if (status === 'confirmed' || status === 'resolved') query.resolved = true;
    else if (status === 'acknowledged') query.acknowledged = true;

    if (severity === 'warning') query.severity = { $ne: 'critical' };
    else if (severity && severity !== 'all') query.severity = severity;

    return query;
}

app.get('/api/alerts', async (req, res) => {
    try {
        const rawLimit = parseInt(req.query.limit || '50', 10);
        const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 50, 10000));
        const query = buildAlertQuery(req.query);
        const alerts = await Alert.find(query).sort({ timestamp: -1 }).limit(limit).lean();
        res.json({ success: true, data: alerts, count: alerts.length, filter: query });
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
        const totalHours = await getTotalOperatingHours(effectiveDeviceId);
        res.json({ success: true, count: data.length, data, totalHours: +totalHours.toFixed(2) });
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
        const now = new Date();
        const startOfToday = new Date(now);
        startOfToday.setHours(0, 0, 0, 0);
        const rows = await ActiveTimeHistory.find({
            deviceId: requestedDeviceId,
            startedAt: { $lte: now },
            $or: [
                { endedAt: null },
                { endedAt: { $gte: startOfToday } }
            ]
        }).lean();
        const [today] = buildDailyActiveTimeSummary(rows, 1, now).slice(-1);
        const totalDurationMs = today?.durationMs || 0;
        res.json({
            success: true,
            closed: closed.length,
            date: today?.date,
            totalDurationMs,
            totalDurationHours: +(totalDurationMs / 3600000).toFixed(2)
        });
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
        const query = buildAlertQuery(req.query);
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
    if (!FF.isEnabled('maintenance_worker')) {
        console.log('⏭️  Maintenance Suggestion Worker disabled (ENABLE_MAINTENANCE_WORKER=false)');
        return;
    }
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
    if (!FF.isEnabled('report_worker')) {
        console.log('⏭️  Monthly Report Worker disabled (ENABLE_REPORT_WORKER=false)');
        return;
    }
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

    const rows = await ActiveTimeHistory.find(match).lean();
    const now = new Date();
    const totalMs = rows.reduce((sum, row) => sum + decorateActiveTimeRow(row, now).effectiveDurationMs, 0);

    return totalMs / 3600000;
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
    return FF.isEnabled('cbm')
        ? analyzeCBM(rows, ACTIVE_THRESHOLDS, totalOperatingHours)
        : { healthScore: null, overallStatus: 'DISABLED', findings: [], componentHealth: {},
            preventiveSchedule: [], summary: 'CBM analysis disabled (ENABLE_CBM=false)',
            analyzedAt: new Date().toISOString(), dataPoints: rows.length,
            totalOperatingHours, _disabled: true };
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
    if (!FF.isEnabled('cbm_worker')) {
        console.log('⏭️  CBM Worker disabled (ENABLE_CBM_WORKER=false)');
        return;
    }
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
// =========================
// START SERVER
// =========================

// ================================================================
// COMPONENT LIFESPAN ESTIMATION
// [FT4] Estimasi umur komponen berbasis tren historis
// [SS6] Notifikasi dini kebutuhan perawatan
// Ref: Miner's Rule (1945), Arrhenius, MIL-HDBK-217F, NFPA 110
// ================================================================
const componentServiceSchema = new mongoose.Schema({
    deviceId:      { type: String, default: 'default' },
    componentName: { type: String, required: true },
    serviceHours:  { type: Number, required: true },
    servicedAt:    { type: Date, default: Date.now },
    notes:         String
});
componentServiceSchema.index({ deviceId: 1, componentName: 1 });
const ComponentService = mongoose.models.ComponentService
    || mongoose.model('ComponentService', componentServiceSchema, 'componentservices');

app.get('/api/component-life', async (req, res) => {
    if (!FF.isEnabled('component_life')) {
        return res.json({ success: true, data: { _disabled: true,
            message: 'Component life estimation disabled (ENABLE_COMPONENT_LIFE=false)' } });
    }
    try {
        await ensureDbReady();
        const deviceId = req.query.deviceId || process.env.DEFAULT_REPORT_DEVICE_ID || null;
        const hours    = Math.max(1, Math.min(Number(req.query.hours) || 720, 8760));
        const query    = {};
        if (deviceId) query.deviceId = deviceId;
        if (req.query.startDate || req.query.endDate) {
            query.timestamp = {};
            if (req.query.startDate) query.timestamp.$gte = new Date(req.query.startDate);
            if (req.query.endDate) {
                const end = new Date(req.query.endDate);
                end.setHours(23, 59, 59, 999);
                query.timestamp.$lte = end;
            }
        } else {
            query.timestamp = { $gte: new Date(Date.now() - hours * 3600000) };
        }
        let rows = await GeneratorData.find(query).sort({ timestamp: 1 }).limit(15000).lean();
        if (rows.length < 10) {
            const fbq = deviceId ? { deviceId } : {};
            rows = await GeneratorData.find(fbq).sort({ timestamp: -1 }).limit(1000).lean();
            rows.reverse();
        }
        const totalOpHours = await getTotalOperatingHours(deviceId);
        const serviceRecords = await ComponentService.find(deviceId ? { deviceId } : {}).lean();
        const lastMaintenance = {};
        for (const rec of serviceRecords) {
            if (!lastMaintenance[rec.componentName] ||
                rec.serviceHours > lastMaintenance[rec.componentName]) {
                lastMaintenance[rec.componentName] = rec.serviceHours;
            }
        }
        const result = estimateComponentLife(rows, totalOpHours, lastMaintenance);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Component life error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/component-life/service', async (req, res) => {
    try {
        await ensureDbReady();
        const { componentName, deviceId, notes } = req.body || {};
        if (!componentName) return res.status(400).json({ success: false, error: 'componentName required' });
        const resolvedDeviceId = deviceId || process.env.DEFAULT_REPORT_DEVICE_ID || 'default';
        const totalOpHours = await getTotalOperatingHours(resolvedDeviceId);
        const record = await ComponentService.create({
            deviceId: resolvedDeviceId, componentName,
            serviceHours: totalOpHours, servicedAt: new Date(), notes: notes || ''
        });
        console.log(`🔧 Component serviced: ${componentName} @ ${totalOpHours.toFixed(1)} hrs`);
        res.json({ success: true, data: record });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/component-life/history', async (req, res) => {
    try {
        await ensureDbReady();
        const query = req.query.deviceId ? { deviceId: req.query.deviceId } : {};
        const records = await ComponentService.find(query).sort({ servicedAt: -1 }).limit(100).lean();
        res.json({ success: true, data: records });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

async function runComponentLifeNotifyOnce() {
    if (!isDbReady() || !FF.isEnabled('component_life_worker')) return;
    try {
        const deviceId = process.env.DEFAULT_REPORT_DEVICE_ID || null;
        const query = deviceId ? { deviceId } : {};
        const rows = await GeneratorData.find(query).sort({ timestamp: -1 }).limit(5000).lean();
        if (!rows.length) return;
        const totalOpHours = await getTotalOperatingHours(deviceId);
        const serviceRecords = await ComponentService.find(deviceId ? { deviceId } : {}).lean();
        const lastMaintenance = {};
        for (const rec of serviceRecords) {
            if (!lastMaintenance[rec.componentName] ||
                rec.serviceHours > lastMaintenance[rec.componentName]) {
                lastMaintenance[rec.componentName] = rec.serviceHours;
            }
        }
        const result = estimateComponentLife(rows.reverse(), totalOpHours, lastMaintenance);
        for (const comp of result.earlyWarnings) {
            if (comp.urgency !== 'overdue' && comp.urgency !== 'due-now') continue;
            const existing = await MaintenanceSuggestion.findOne({
                recommendation: { $regex: comp.name, $options: 'i' },
                status: { $in: ['pending', 'approved', 'scheduled'] },
                createdAt: { $gte: new Date(Date.now() - 7 * 24 * 3600000) }
            }).lean();
            if (existing) continue;
            const decisionStatus = comp.urgency === 'overdue' ? 'BAHAYA' : 'WASPADA';
            const message = comp.urgency === 'overdue'
                ? `Komponen ${comp.name} sudah melewati batas servis. Telah dipakai ${comp.effectiveHoursUsed} jam (interval ${comp.intervalHours} jam). Faktor degradasi: ${comp.degradationFactor}x.`
                : `Komponen ${comp.name} mendekati batas servis. Sisa estimasi ${comp.remainingHours} jam operasi.`;
            await MaintenanceSuggestion.create({
                source: 'component-life', decisionStatus, message,
                recommendation: comp.task,
                priority: comp.urgency === 'overdue' ? 'high' : 'medium',
                estimatedCost: 0,
                suggestedDate: comp.estimatedDueDate ? new Date(comp.estimatedDueDate) : new Date(Date.now() + 7 * 86400000),
                status: 'pending'
            });
            console.log(`🔔 Component life warning: ${comp.name} [${comp.urgency}]`);
        }
    } catch (err) {
        console.error('Component life notify error:', err.message);
    }
}

function startComponentLifeWorker() {
    if (!FF.isEnabled('component_life_worker')) {
        console.log('⏭️  Component Life Worker disabled (ENABLE_COMPONENT_LIFE_WORKER=false)');
        return;
    }
    const intervalMs = parseInt(process.env.COMPONENT_LIFE_WORKER_INTERVAL_MS || '3600000', 10);
    setInterval(runComponentLifeNotifyOnce, intervalMs);
    setTimeout(runComponentLifeNotifyOnce, 90000);
    console.log(`🔩 Component Life Worker started (interval: ${intervalMs / 60000} menit)`);
}

// ================================================================
// FEATURE FLAGS API
// GET  /api/features         — lihat semua flag dan statusnya
// POST /api/features/:flag   — toggle flag secara runtime
// ================================================================
app.get('/api/features', (req, res) => {
    res.json({ success: true, data: FF.getAllFlags() });
});

app.post('/api/features/:flag', (req, res) => {
    const { flag } = req.params;
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false,
            error: 'Body harus berisi { "enabled": true } atau { "enabled": false }' });
    }
    const result = FF.setFlag(flag, enabled);
    if (!result.ok) return res.status(404).json({ success: false, error: result.message });
    res.json({ success: true, data: result });
});

function startBackgroundWorkers() {
    startMaintenanceSuggestionWorker();
    startMonthlyReportWorker();
    startCbmWorker();
    startComponentLifeWorker();
}

function readHttpServerPort() {
    let rawPort = envValue('SERVER_PORT') || envValue('WEB_PORT') || envValue('HTTP_PORT') || envValue('PORT') || '3023';
    let port = Number.parseInt(rawPort, 10);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.warn(`⚠️ Invalid HTTP port "${rawPort}", fallback ke 3023.`);
        port = 3023;
    }

    // 1883/8883 adalah port MQTT, bukan HTTP dashboard
    if (port === 1883 || port === 8883) {
        console.warn(`⚠️ PORT ${port} adalah port MQTT. Dashboard HTTP dipindahkan otomatis ke 3023.`);
        port = 3023;
    }

    return port;
}

function getDashboardUrl(port) {
    const rawUrl = firstEnvValue('BACKEND_URL', 'APP_BASE_URL', 'PUBLIC_BASE_URL');

    // Kalau BACKEND_URL salah diarahkan ke MQTT port, jangan dipakai
    if (rawUrl && !rawUrl.includes(':1883') && !rawUrl.includes(':8883')) {
        return rawUrl.replace(/\/+$/, '');
    }

    if (rawUrl.includes(':1883') || rawUrl.includes(':8883')) {
        console.warn('⚠️ BACKEND_URL masih mengarah ke port MQTT. Gunakan BACKEND_URL=http://localhost:3023');
    }

    return `http://localhost:${port}`;
}

const PORT = readHttpServerPort();
const HOST = envValue('HOST', '0.0.0.0');
const DASHBOARD_URL = getDashboardUrl(PORT);

if (require.main === module) {
    app.listen(PORT, HOST, () => {
        console.log(`🚀 HTTP Dashboard Server listening on ${HOST}:${PORT}`);
        console.log(`🌐 Open dashboard at ${DASHBOARD_URL}`);
        console.log(`📡 MQTT Broker URL: ${MQTT_BROKER_URL || 'MQTT disabled/not configured'}`);

        FF.printStartupBanner();
        startBackgroundWorkers();
    });
}
// GANTI LOGIKA TIMER LAMA DENGAN INI
function startRobustFlushTimer() {
    console.log('⏱️ Robust Flush Timer Started (Interval: 10 menit)');
    setInterval(async () => {
        if (generatorBatchBuffer.length > 0) {
            console.log(`⏰ Timer 10 menit tercapai. Memproses ${generatorBatchBuffer.length} records...`);
            await flushGeneratorBatch('timer-10min');
        }
    }, DB_BATCH_INTERVAL_MS); // DB_BATCH_INTERVAL_MS sudah bernilai 600000
}

// Panggil di akhir server.js saat startup
// startBackgroundWorkers(); // fungsi lama
startRobustFlushTimer();
mongoose.connection.on('disconnected', () => console.log('❌ MongoDB Connection Lost! (Terputus)'));
mongoose.connection.on('reconnected', () => console.log('🔄 MongoDB Reconnected! (Tersambung Kembali)'));

setInterval(async () => {
    if (generatorBatchBuffer.length > 0) {
        console.log(`⏰ Timer 10 menit tercapai. Melakukan flush batch...`);
        await flushGeneratorBatch('interval-10min');
    }
}, 600000); // 600.000 ms = 10 menit

module.exports = app;