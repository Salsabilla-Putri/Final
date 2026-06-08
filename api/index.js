const express = require('express');
const mongoose = require('mongoose');
const mqtt = require('mqtt');
const cors = require('cors');
const https = require('https');
const {
    transformPublicStatus,
    generateAlerts,
    getMaintenanceStatus,
    getPublicLabels
} = require('../public_status');
const { analyzeCBM } = require('../lib_cbm_analysis');


const app = express();

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'self' * 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'self' * ws: wss:;");
    next();
});
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── DATABASE (cached connection untuk serverless) ────────────────────────────
let connectionPromise = null;

async function connectDB() {
    // readyState: 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
    if (mongoose.connection.readyState === 1) return; // sudah konek

    // Kalau sedang dalam proses connecting, tunggu promise yang sama
    // jangan buat koneksi baru (ini fix untuk race condition di serverless)
    if (connectionPromise) return await connectionPromise;

    if (!process.env.MONGODB_URI) {
        throw new Error('MONGODB_URI environment variable is not set');
    }

    connectionPromise = mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10000, // naikkan timeout jadi 10s
        socketTimeoutMS: 20000,
        // bufferCommands default true — jangan set false agar tidak error sebelum connect selesai
    }).then(async () => {
        console.log('✅ MongoDB Connected');
        connectionPromise = null;
        await loadThresholdsFromDB();
        await cleanupGeneratorDataFieldsFromDB();
    }).catch((err) => {
        connectionPromise = null; // reset agar bisa retry di request berikutnya
        throw err;
    });

    await connectionPromise;
}

// ─── SCHEMAS ──────────────────────────────────────────────────────────────────
const generatorDataSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now },
    deviceId: { type: String, required: true },
    recordId: { type: String, index: true, unique: true, sparse: true },
    localSeq: Number,
    source: String,
    rpm: Number, volt: Number, amp: Number, power: Number,
    freq: Number, temp: Number, coolant: Number, fuel: Number,
    sync: String, synced: Boolean, status: String, oil: Number, iat: Number,
    map: Number, batt: Number, afr: Number, tps: Number, phaseAngle: Number
}, { versionKey: false });
const GeneratorData = mongoose.models.GeneratorData || mongoose.model('GeneratorData', generatorDataSchema, 'generatordatas');

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
    deviceId: String, parameter: String, value: Number,
    message: String,
    severity: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
    resolved: { type: Boolean, default: false }
});
const Alert = mongoose.models.Alert || mongoose.model('Alert', alertSchema, 'alert');

const configSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    value: Object
});
const Config = mongoose.models.Config || mongoose.model('Config', configSchema, 'configs');


const userSchema = new mongoose.Schema({
    name: { type: String, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    role: { type: String, required: true, default: 'Masyarakat' }
});
const User = mongoose.models.User || mongoose.model('User', userSchema, 'users');

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

const maintenanceSchema = new mongoose.Schema({
    task: { type: String, required: true },
    type: String, priority: String,
    status: { type: String, default: 'scheduled' },
    dueDate: Date, assignedTo: String,
    createdAt: { type: Date, default: Date.now },
    completedAt: Date
});
const Maintenance = mongoose.models.Maintenance || mongoose.model('Maintenance', maintenanceSchema, 'maintenance');

const maintenanceSuggestionSchema = new mongoose.Schema({
    source: { type: String, default: 'system' },
    status: { type: String, default: 'pending', enum: ['pending', 'approved', 'scheduled', 'consumed'] },
    decisionStatus: { type: String, enum: ['AMAN', 'WASPADA', 'BAHAYA'], required: true },
    message: { type: String, required: true },
    recommendation: { type: String, required: true },
    priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    estimatedCost: { type: Number, default: 0 },
    suggestedDate: Date,
    createdAt: { type: Date, default: Date.now },
    approvedAt: Date
});
const MaintenanceSuggestion = mongoose.models.MaintenanceSuggestion || mongoose.model('MaintenanceSuggestion', maintenanceSuggestionSchema, 'maintenancesuggestions');

const activeTimeHistorySchema = new mongoose.Schema({
    deviceId: { type: String, required: true, index: true },
    startedAt: { type: Date, required: true, index: true },
    endedAt: { type: Date, default: null, index: true },
    durationMs: { type: Number, default: 0 },
    source: { type: String, enum: ['mqtt', 'manual'], default: 'mqtt' },
    calc: {
        rpmThreshold: { type: Number, default: 0 },
        rule: { type: String, default: 'status=RUNNING OR rpm>threshold' },
        sampledAt: { type: Date, default: Date.now }
    }
}, { timestamps: true });
const ActiveTimeHistory = mongoose.models.ActiveTimeHistory || mongoose.model('ActiveTimeHistory', activeTimeHistorySchema, 'activetimehistories');

// ─── THRESHOLDS ───────────────────────────────────────────────────────────────
let ACTIVE_THRESHOLDS = {
    rpm: { max: 3800 }, temp: { max: 95 },
    volt: { min: 180, max: 250 }, fuel: { min: 20 },
    amp: { max: 100 },
    freq: { min: 48, max: 52 },
    batt: { min: 11.8, max: 14.8 },
    map: { min: 20, max: 250 }
};

async function loadThresholdsFromDB() {
    try {
        const conf = await Config.findOne({ key: 'engine_thresholds' });
        if (conf) {
            ACTIVE_THRESHOLDS = { ...ACTIVE_THRESHOLDS, ...conf.value };
        } else {
            await new Config({ key: 'engine_thresholds', value: ACTIVE_THRESHOLDS }).save();
        }
    } catch (e) { console.error('Config Load Error:', e); }
}

// ─── MQTT (best-effort, non-blocking) ────────────────────────────────────────
let latestData = {
    deviceId: 'ESP32_GENERATOR_01', timestamp: new Date(),
    rpm: 0, volt: 0, amp: 0, power: 0, freq: 0, temp: 0, coolant: 0,
    fuel: 0, sync: 'OFF-GRID', status: 'STOPPED', oil: 0, iat: 0, map: 0, batt: 0, afr: 0, tps: 0
};
let lastPersistAt = 0;

let activeSessions = new Map();
const ACTIVE_SESSION_TIMEOUT_MS = parseInt(process.env.ECU_DISCONNECT_THRESHOLD_MS || '30000', 10);

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

async function closeStaleActiveSessions(requestedDeviceId = null) {
    const closed = [];
    const now = new Date();

    for (const [deviceId, session] of activeSessions.entries()) {
        if (requestedDeviceId && deviceId !== requestedDeviceId) continue;
        if (now.getTime() - session.lastSeenAt.getTime() <= ACTIVE_SESSION_TIMEOUT_MS) continue;
        const row = await finalizeOpenActiveSession(deviceId, session.startedAt, session.lastSeenAt, 'esp32_disconnect');
        if (row) closed.push(row);
        activeSessions.delete(deviceId);
    }

    const query = { endedAt: null };
    if (requestedDeviceId) query.deviceId = requestedDeviceId;
    const openRows = await ActiveTimeHistory.find(query).lean();
    for (const row of openRows) {
        const sampledAt = getSessionSampledAt(row);
        if (now.getTime() - sampledAt.getTime() <= ACTIVE_SESSION_TIMEOUT_MS) continue;
        const updated = await finalizeOpenActiveSession(row.deviceId, row.startedAt, sampledAt, 'esp32_disconnect');
        if (updated) closed.push(updated);
    }

    return closed;
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

function parseFiniteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeGeneratorSnapshot(rawPayload = {}, defaults = latestData) {
    const snapshot = pickEffectivePayload(rawPayload);
    if (!snapshot || typeof snapshot !== 'object') return null;

    const nextData = { ...defaults };
    const eventTimestamp = snapshot.timestamp ? new Date(snapshot.timestamp) : new Date();
    nextData.timestamp = Number.isNaN(eventTimestamp.getTime()) ? new Date() : eventTimestamp;
    nextData.deviceId = snapshot.deviceId || nextData.deviceId || 'ESP32_GENERATOR_01';
    nextData.recordId = snapshot.recordId || undefined;
    const localSeq = parseFiniteNumber(snapshot.localSeq);
    if (localSeq !== undefined) nextData.localSeq = localSeq;

    nextData.sync = normalizeSyncStatus(snapshot, nextData.sync);
    nextData.synced = nextData.sync === 'ON-GRID';
    nextData.status = snapshot.status || (Number(snapshot.rpm || 0) > 0 ? 'RUNNING' : nextData.status);

    const numericKeys = ['rpm', 'volt', 'freq', 'temp', 'coolant', 'fuel', 'oil', 'iat', 'map', 'batt', 'afr', 'tps'];
    for (const key of numericKeys) {
        if (snapshot[key] !== undefined && snapshot[key] !== null && snapshot[key] !== '') {
            const parsed = parseFiniteNumber(snapshot[key]);
            if (parsed !== undefined) nextData[key] = parsed;
        }
    }

    const phaseValue = firstDefined(snapshot.phaseAngle, snapshot.phase_angle, snapshot.phaseDiff, snapshot.phase_diff, snapshot.phase);
    if (phaseValue !== undefined) {
        const parsedPhase = parseFiniteNumber(phaseValue);
        if (parsedPhase !== undefined) nextData.phaseAngle = parsedPhase;
    }

    const coolantValue = readCoolantValue(snapshot);
    if (coolantValue !== undefined) {
        const parsedCoolant = parseFiniteNumber(coolantValue);
        if (parsedCoolant !== undefined) nextData.coolant = parsedCoolant;
    }

    const ampValue = readAmpValue(snapshot);
    if (ampValue !== undefined) {
        const parsedAmp = parseFiniteNumber(ampValue);
        if (parsedAmp !== undefined) nextData.amp = parsedAmp;
    }

    const powerValue = readPowerValue(snapshot);
    if (powerValue !== undefined) {
        const parsedPower = parseFiniteNumber(powerValue);
        if (parsedPower !== undefined) nextData.power = parsedPower;
    } else if (nextData.volt && nextData.amp) {
        nextData.power = (nextData.volt * nextData.amp) / 1000;
    }

    const tempValue = firstDefined(snapshot.temp, snapshot.temperature);
    if (tempValue !== undefined) {
        const parsedTemp = parseFiniteNumber(tempValue);
        if (parsedTemp !== undefined) nextData.temp = parsedTemp;
    }

    return nextData;
}

async function persistGeneratorSnapshot(rawPayload = {}, { source = 'http_ingest' } = {}) {
    const normalized = normalizeGeneratorSnapshot(rawPayload);
    if (!normalized) return null;

    latestData = { ...latestData, ...normalized };
    const docPayload = { ...normalized, source };

    if (normalized.recordId) {
        return await GeneratorData.findOneAndUpdate(
            { recordId: normalized.recordId },
            { $set: docPayload },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );
    }

    return await GeneratorData.create(docPayload);
}

async function syncActiveTimeHistory(data) {
    const status = String(data?.status || '').toUpperCase();
    const rpm = Number(data?.rpm || 0);
    const rpmThreshold = 0;
    const isRunning = status === 'RUNNING' || rpm > rpmThreshold;
    const deviceId = data?.deviceId || latestData.deviceId || 'GENERATOR #1';
    const eventTime = data?.timestamp ? new Date(data.timestamp) : new Date();
    const activeKey = `${deviceId}`;
    const session = activeSessions.get(activeKey);

    if (isRunning && !session) {
        activeSessions.set(activeKey, { startedAt: eventTime, lastSeenAt: eventTime });
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
            const endedAt = new Date(session.lastSeenAt.getTime() + ACTIVE_SESSION_TIMEOUT_MS);
            const durationMs = Math.max(0, endedAt.getTime() - session.startedAt.getTime());
            await ActiveTimeHistory.findOneAndUpdate(
                { deviceId, startedAt: session.startedAt, endedAt: null },
                { endedAt, durationMs, calc: { rpmThreshold, sampledAt: session.lastSeenAt } },
                { sort: { createdAt: -1 } }
            );

            activeSessions.set(activeKey, { startedAt: eventTime, lastSeenAt: eventTime });
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
        const endedAt = eventTime;
        const durationMs = Math.max(0, endedAt.getTime() - session.startedAt.getTime());
        await ActiveTimeHistory.findOneAndUpdate(
            { deviceId, startedAt: session.startedAt, endedAt: null },
            { endedAt, durationMs, calc: { rpmThreshold, sampledAt: eventTime } },
            { sort: { createdAt: -1 } }
        );
        activeSessions.delete(activeKey);
    }
}

function initMQTT() {
    const brokerUrl = process.env.MQTT_BROKER || 'mqtt://generatorta20.cloud.shiftr.io:1883';

    // FIX: Jangan init MQTT jika broker masih placeholder
    if (brokerUrl.includes('<host>')) {
        console.warn('MQTT_BROKER masih placeholder, skip MQTT init');
        return;
    }

    try {
        const mqttClient = mqtt.connect(brokerUrl, {
            clientId: 'api-' + Math.random().toString(16).slice(2, 8),
            username: process.env.MQTT_USERNAME || 'generatorta20',
            password: process.env.MQTT_PASSWORD || 'TA252601020',
            keepalive: 60,
            connectTimeout: 10000,
            reconnectPeriod: 3000
        });

        const persistLatestSnapshot = async (rawSnapshot, eventTimestamp = new Date()) => {
            const nowMs = eventTimestamp.getTime();
            if (nowMs - lastPersistAt < 1000 && !Array.isArray(rawSnapshot?.records)) return;
            lastPersistAt = nowMs;

            try {
                await connectDB();

                const records = Array.isArray(rawSnapshot?.records) ? rawSnapshot.records : [rawSnapshot];
                const source = rawSnapshot?.source || 'mqtt_gen_data';
                const docs = [];

                for (const record of records) {
                    if (!record || typeof record !== 'object') continue;

                    const normalized = normalizeGeneratorSnapshot({
                        ...record,
                        deviceId: record.deviceId || rawSnapshot?.deviceId,
                        source: record.source || source,
                        timestamp: record.timestamp || rawSnapshot?.timestamp
                    });

                    if (normalized) docs.push({ ...normalized, source });
                }

                if (!docs.length) {
                    console.warn(`⚠️ MQTT gen/data ignored: no valid records | received=${records.length}`);
                    return;
                }

                const operations = docs.map((doc) => {
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
                latestData = { ...latestData, ...docs[docs.length - 1] };

                await syncActiveTimeHistory(latestData);
                await checkAndSaveAlerts(latestData);

                const inserted = (result.insertedCount || 0) + (result.upsertedCount || 0);
                const duplicate = result.matchedCount || 0;
                console.log(`💾 MQTT gen/data saved | received=${records.length} | accepted=${docs.length} | inserted=${inserted} | duplicate=${duplicate}`);
            } catch (e) {
                console.error('DB Save Error:', e.message);
            }
        };

        mqttClient.on('connect', () => {
            console.log(`✅ MQTT Connected: ${brokerUrl}`);
            mqttClient.subscribe('gen/data', (err) => {
                if (err) console.error('❌ Subscribe error (gen/data):', err.message);
                else console.log('📡 Subscribed to gen/data');
            });
        });
        mqttClient.on('message', async (topic, message) => {
            if (topic !== 'gen/data') return;

            const raw = message.toString();
            try {
                const snapshot = JSON.parse(raw);
                await persistLatestSnapshot(snapshot, new Date());
            } catch (err) {
                console.warn('Invalid JSON on gen/data:', raw);
            }
        });
        mqttClient.on('error', (err) => console.warn('MQTT Error (non-fatal):', err.message));
    } catch (e) {
        console.warn('MQTT init failed (non-fatal):', e.message);
    }
}

// ─── ALERT LOGIC ─────────────────────────────────────────────────────────────
async function checkAndSaveAlerts(data) {
    const alertsToSave = [];
    const T = ACTIVE_THRESHOLDS;
    const criticalOnMinViolation = new Set(['volt', 'batt', 'freq']);
    const criticalOnMaxViolation = new Set(['amp', 'volt', 'batt', 'temp', 'coolant']);
    const check = (param, val) => {
        if (!T[param]) return;
        if (T[param].max !== undefined && val > T[param].max) {
            const severity = criticalOnMaxViolation.has(param) ? 'critical' : 'high';
            alertsToSave.push({ parameter: param, value: val, message: `${param.toUpperCase()} Too High (> ${T[param].max})`, severity });
        }
        if (T[param].min !== undefined && val < T[param].min) {
            const severity = criticalOnMinViolation.has(param) ? 'critical' : 'medium';
            alertsToSave.push({ parameter: param, value: val, message: `${param.toUpperCase()} Too Low (< ${T[param].min})`, severity });
        }
    };
    ['rpm','volt','amp','freq','power','coolant','temp','fuel','iat','map','afr','tps','batt']
        .forEach(p => check(p, data[p]));

    if (alertsToSave.length > 0) {
        const lastAlert = await Alert.findOne().sort({ timestamp: -1 });
        const timeDiff = lastAlert ? (new Date() - lastAlert.timestamp) : 999999;
        if (timeDiff > 10000) {
            for (const a of alertsToSave)
                await new Alert({ ...a, deviceId: data.deviceId }).save();
        }

        const criticalAlerts = alertsToSave.filter((a) => a.severity === 'critical');
        const now = Date.now();
        if (criticalAlerts.length > 0 && (now - lastCriticalEmailAt) > ALERT_EMAIL_COOLDOWN_MS) {
            try {
                await sendCriticalAlertEmail(criticalAlerts, data);
                lastCriticalEmailAt = now;
            } catch (emailError) {
                console.error('❌ Gagal mengirim email alert critical:', emailError.message);
            }
        }
    }
}

// ─── CONNECT DB sebelum setiap request ───────────────────────────────────────
app.use(async (req, res, next) => {
    try {
        if (req.method === 'GET' && req.path === '/api/ingest/batch') return next();
        await connectDB();
        next();
    } catch (err) {
        console.error('DB connection error:', err.message);
        res.status(503).json({ success: false, error: 'Database connection failed', detail: err.message });
    }
});

// ─── API ROUTES ───────────────────────────────────────────────────────────────

app.get('/api/ingest/batch', (req, res) => {
    res.json({
        success: true,
        message: 'Endpoint aktif. Browser memakai GET hanya untuk cek status; ESP32 harus mengirim data dengan HTTP POST.',
        method: 'POST',
        path: '/api/ingest/batch',
        contentType: 'application/json',
        acceptedBody: {
            deviceId: 'ESP32_GENERATOR_01',
            source: 'esp32_sd_backup_10min',
            intervalMs: 600000,
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
                    freq: 50.0,
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

app.post('/api/ingest/batch', async (req, res) => {
    try {
        const body = req.body || {};
        const records = Array.isArray(body.records)
            ? body.records
            : (body.record && typeof body.record === 'object')
                ? [body.record]
                : [];

        if (!records.length) {
            return res.status(400).json({
                success: false,
                error: 'Body harus berisi records[] atau record object.'
            });
        }

        const maxBatch = Math.min(records.length, 1000);
        const source = body.source || 'esp32_sd_backup_10min';
        const docs = [];

        for (let i = 0; i < maxBatch; i++) {
            const record = records[i];
            if (!record || typeof record !== 'object') continue;

            const normalized = normalizeGeneratorSnapshot({
                ...record,
                deviceId: record.deviceId || body.deviceId,
                source: record.source || body.source,
                timestamp: record.timestamp || body.timestamp
            });

            if (!normalized) continue;
            docs.push({ ...normalized, source });
        }

        if (!docs.length) {
            return res.status(400).json({ success: false, error: 'Tidak ada record valid untuk disimpan.' });
        }

        const operations = docs.map((doc) => {
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
        const lastSaved = docs[docs.length - 1];
        latestData = { ...latestData, ...lastSaved };

        const inserted = (result.insertedCount || 0) + (result.upsertedCount || 0);
        const matchedExisting = result.matchedCount || 0;

        try {
            await syncActiveTimeHistory(latestData);
            await checkAndSaveAlerts(latestData);
        } catch (sideEffectError) {
            console.warn('Post-ingest side effect warning:', sideEffectError.message);
        }

        res.status(201).json({
            success: true,
            ackedRecords: docs.length,
            accepted: docs.length,
            receivedRecords: records.length,
            processedRecords: maxBatch,
            truncated: records.length > maxBatch,
            inserted,
            matchedExisting,
            duplicate: matchedExisting,
            lastRecordId: lastSaved?.recordId || null,
            lastTimestamp: latestData.timestamp
        });
    } catch (err) {
        console.error('Batch ingest error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

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
        const isMasyarakat = ['warga', 'masyarakat', 'user', 'viewer'].includes(role);
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



app.post('/api/auth/register', async (req, res) => {
    try {
        const name = String(req.body?.name || '').trim();
        const email = String(req.body?.email || '').trim().toLowerCase();
        const password = String(req.body?.password || '');
        const productToken = String(req.body?.productToken || '').trim();

        if (!name || !email || !password || !productToken) {
            return res.status(400).json({ success: false, message: 'Nama, email, password, dan token produk wajib diisi.' });
        }

        const expectedToken = process.env.PRODUCT_TOKEN || 'TA252601020';
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

app.get('/api/health', (req, res) => res.json({
    status: 'healthy',
    mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    mongoUri: process.env.MONGODB_URI ? '✅ set' : '❌ missing'
}));

app.get('/api/engine-data/latest', async (req, res) => {
    try {
        const requestedDeviceId = req.query.deviceId;
        const effectiveDeviceId = requestedDeviceId || process.env.DEFAULT_REPORT_DEVICE_ID || 'ESP32_GENERATOR_01';
        const filter = effectiveDeviceId ? { deviceId: effectiveDeviceId } : {};
        const latestDocs = await GeneratorData.find(filter).sort({ timestamp: -1 }).limit(5).lean();
        const dbData = latestDocs[0] || null;
        const isDbFresh = dbData && (new Date() - dbData.timestamp < 15000);
        const baseData = isDbFresh ? dbData : latestData;
        const previousDoc = latestDocs[1] || null;

        // NEW CODE
        // EXTENSION ONLY: add non-breaking enrichment fields to existing payload
        const enrichedData = {
            ...baseData,
            alerts: generateAlerts(baseData, previousDoc),
            maintenance: getMaintenanceStatus(baseData, latestDocs.slice(1)),
            ...getPublicLabels(baseData)
        };

        res.json({ success: true, data: enrichedData });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/public-status', async (req, res) => {
    try {
        const { deviceId } = req.query;
        const effectiveDeviceId = deviceId || process.env.DEFAULT_REPORT_DEVICE_ID || 'ESP32_GENERATOR_01';
        const query = effectiveDeviceId ? { deviceId: effectiveDeviceId } : {};

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

app.get('/api/engine-data/history', async (req, res) => {
    try {
        const { limit = 1000, hours, startDate, endDate } = req.query;
        const requestedDeviceId = req.query.deviceId;
        const effectiveDeviceId = requestedDeviceId || process.env.DEFAULT_REPORT_DEVICE_ID || 'ESP32_GENERATOR_01';
        let query = {};
        if (startDate && endDate) {
            const start = new Date(startDate); start.setHours(0, 0, 0, 0);
            const end = new Date(endDate); end.setHours(23, 59, 59, 999);
            query.timestamp = { $gte: start, $lte: end };
        } else {
            const h = parseInt(hours) || 24;
            query.timestamp = { $gte: new Date(Date.now() - h * 3600000) };
        }
        if (effectiveDeviceId) query.deviceId = effectiveDeviceId;
        const data = await GeneratorData.find(query).sort({ timestamp: -1 }).limit(parseInt(limit));
        res.json({ success: true, count: data.length, data });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/engine-data/stats', async (req, res) => {
    try {
        const last24Hours = new Date(Date.now() - 86400000);
        const stats = await GeneratorData.aggregate([
            { $match: { timestamp: { $gte: last24Hours } } },
            { $group: { _id: null, avgRPM: { $avg: '$rpm' }, avgVoltage: { $avg: '$volt' }, avgPower: { $avg: '$power' }, avgTemp: { $avg: '$temp' }, maxTemp: { $max: '$temp' }, minFuel: { $min: '$fuel' }, totalRecords: { $sum: 1 } } },
            { $project: { _id: 0, avgRPM: 1, avgVoltage: 1, avgPower: 1, avgTemp: 1, maxTemp: 1, minFuel: 1, totalHours: { $divide: [{ $multiply: ['$totalRecords', 5] }, 3600] } } }
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
        const rows = await ActiveTimeHistory.find(query)
            .sort({ startedAt: -1 })
            .limit(parseInt(limit, 10))
            .lean();
        const data = rows.map((row) => decorateActiveTimeRow(row, now));

        res.json({ success: true, count: data.length, data });
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

app.get('/api/alerts', async (req, res) => {
    try {
        const { limit = 50, startDate, endDate, deviceId } = req.query;
        const query = {};
        if (startDate || endDate) {
            query.timestamp = {};
            if (startDate) query.timestamp.$gte = new Date(startDate);
            if (endDate) query.timestamp.$lte = new Date(endDate);
        }
        if (deviceId) query.deviceId = deviceId;
        const alerts = await Alert.find(query).sort({ timestamp: -1 }).limit(parseInt(limit));
        res.json({ success: true, data: alerts });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/alerts/count', async (req, res) => {
    try {
        const { startDate, endDate, deviceId } = req.query;
        const query = {};
        if (startDate || endDate) {
            query.timestamp = {};
            if (startDate) query.timestamp.$gte = new Date(startDate);
            if (endDate) query.timestamp.$lte = new Date(endDate);
        }
        if (deviceId) query.deviceId = deviceId;
        const count = await Alert.countDocuments(query);
        res.json({ success: true, count });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.put('/api/alerts/:id/ack', async (req, res) => {
    try {
        const updated = await Alert.findByIdAndUpdate(req.params.id, { resolved: true }, { new: true });
        if (!updated) return res.status(404).json({ success: false, message: 'Alert not found' });
        res.json({ success: true, data: updated });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.delete('/api/alerts/:id', async (req, res) => {
    try {
        await Alert.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'Alert deleted' });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/thresholds', (req, res) => res.json({ success: true, data: ACTIVE_THRESHOLDS }));

app.post('/api/thresholds', async (req, res) => {
    try {
        ACTIVE_THRESHOLDS = { ...ACTIVE_THRESHOLDS, ...req.body };
        await Config.findOneAndUpdate({ key: 'engine_thresholds' }, { value: ACTIVE_THRESHOLDS }, { upsert: true, new: true });
        res.json({ success: true, data: ACTIVE_THRESHOLDS });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/maintenance', async (req, res) => {
    try {
        const logs = await Maintenance.find().sort({ createdAt: -1 });
        res.json({ success: true, data: logs });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/maintenance', async (req, res) => {
    try {
        const newTask = new Maintenance(req.body);
        await newTask.save();
        res.json({ success: true, data: newTask });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.put('/api/maintenance/:id', async (req, res) => {
    try {
        const updated = await Maintenance.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json({ success: true, data: updated });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.delete('/api/maintenance/:id', async (req, res) => {
    try {
        await Maintenance.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

function median(values = []) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

function estimateSampleRateHz(rows = []) {
    if (!Array.isArray(rows) || rows.length < 2) return 1;
    const deltas = [];
    const sorted = [...rows].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    for (let i = 1; i < sorted.length; i++) {
        const prev = new Date(sorted[i - 1].timestamp).getTime();
        const curr = new Date(sorted[i].timestamp).getTime();
        const dtSec = (curr - prev) / 1000;
        if (Number.isFinite(dtSec) && dtSec > 0) deltas.push(dtSec);
    }

    const dt = median(deltas);
    return dt > 0 ? 1 / dt : 1;
}

function dft(values = [], sampleRateHz = 1) {
    const n = Math.min(values.length, 512);
    if (n < 16) return [];

    const signal = values.slice(values.length - n);
    const mean = signal.reduce((a, b) => a + b, 0) / signal.length;
    const centered = signal.map((v, i) => {
        const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (signal.length - 1)));
        return (v - mean) * hann;
    });

    const half = Math.floor(centered.length / 2);
    const spectrum = [];

    for (let k = 1; k <= half; k++) {
        let real = 0;
        let imag = 0;
        for (let t = 0; t < centered.length; t++) {
            const angle = (2 * Math.PI * k * t) / centered.length;
            real += centered[t] * Math.cos(angle);
            imag -= centered[t] * Math.sin(angle);
        }
        const amp = Math.sqrt(real * real + imag * imag) / centered.length;
        const freq = (k * sampleRateHz) / centered.length;
        if (Number.isFinite(freq) && Number.isFinite(amp)) {
            spectrum.push({ freq, amp });
        }
    }

    return spectrum;
}

function findPeaks(spectrum = [], limit = 3) {
    const peaks = [];
    for (let i = 1; i < spectrum.length - 1; i++) {
        const left = spectrum[i - 1].amp;
        const mid = spectrum[i].amp;
        const right = spectrum[i + 1].amp;
        if (mid >= left && mid >= right) peaks.push(spectrum[i]);
    }
    return peaks.sort((a, b) => b.amp - a.amp).slice(0, limit);
}

app.post('/api/reports/analysis', async (req, res) => {
    try {
        const { rows = [], sensor = 'rpm', maxPoints = 300 } = req.body || {};

        if (!Array.isArray(rows) || rows.length === 0)
            return res.json({ success: true, data: { ok: true, values: [], labels: [], avg: 0, min: 0, max: 0, trend: 'stable' } });

        const values = rows.map(r => parseFloat(r[sensor])).filter(v => Number.isFinite(v));

        if (values.length === 0)
            return res.json({ success: true, data: { ok: true, values: [], labels: [], avg: 0, min: 0, max: 0, trend: 'stable' } });

        const step = Math.max(1, Math.floor(values.length / maxPoints));
        const sampled = values.filter((_, i) => i % step === 0).slice(0, maxPoints);
        const sampledRows = rows.filter((_, i) => i % step === 0).slice(0, maxPoints);
        const labels = sampledRows.map(r => r.timestamp || r.createdAt || '');

        const avg = sampled.reduce((a, b) => a + b, 0) / sampled.length;
        const min = Math.min(...sampled);
        const max = Math.max(...sampled);

        const half = Math.floor(sampled.length / 2);
        const firstHalf = sampled.slice(0, half).reduce((a, b) => a + b, 0) / (half || 1);
        const secondHalf = sampled.slice(half).reduce((a, b) => a + b, 0) / ((sampled.length - half) || 1);
        const diff = secondHalf - firstHalf;
        const trend = Math.abs(diff) < avg * 0.03 ? 'stable' : diff > 0 ? 'increasing' : 'decreasing';

        const sampleRateHz = estimateSampleRateHz(sampledRows);
        const spectrum = dft(sampled, sampleRateHz);
        const peaks = findPeaks(spectrum, 3);
        const peakLabel = peaks.length
            ? peaks.map((p) => `${p.freq.toFixed(3)} Hz`).join(', ')
            : 'tidak ditemukan puncak dominan';

        res.json({
            success: true,
            data: {
                ok: true,
                values: sampled,
                labels,
                avg: +avg.toFixed(2),
                min,
                max,
                trend,
                count: sampled.length,
                stats: { count: sampled.length, mean: +avg.toFixed(2), trend, min, max },
                spectrum,
                peaks,
                summary: `FFT dihitung dari ${sampled.length} sampel (fs ${sampleRateHz.toFixed(3)} Hz). Frekuensi dominan: ${peakLabel}.`
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/reports', async (req, res) => {
    try {
        const parsedLimit = parseInt(req.query.limit, 10);
        const limit = Number.isNaN(parsedLimit) ? 5000 : Math.max(1, Math.min(parsedLimit, 100000));
        const { hours, startDate, endDate } = req.query;
        const requestedDeviceId = req.query.deviceId;
        const effectiveDeviceId = requestedDeviceId || process.env.DEFAULT_REPORT_DEVICE_ID || 'ESP32_GENERATOR_01';

        const normalizeNumeric = (v) => { const p = Number(v); return Number.isFinite(p) ? p : null; };
        const normalizeRow = (row) => {
            const timestamp = row.timestamp || row.createdAt || row.date || null;
            if (!timestamp) return null;
            return {
                ...row, timestamp,
                rpm: normalizeNumeric(row.rpm), volt: normalizeNumeric(row.volt ?? row.voltage),
                amp: normalizeNumeric(row.amp ?? row.current), power: normalizeNumeric(row.power ?? row.kw),
                freq: normalizeNumeric(row.freq ?? row.frequency), temp: normalizeNumeric(row.temp ?? row.temperature),
                coolant: normalizeNumeric(row.coolant ?? row.temp), fuel: normalizeNumeric(row.fuel),
                iat: normalizeNumeric(row.iat), map: normalizeNumeric(row.map ?? row.mapPressure ?? row.manifoldPressure), batt: normalizeNumeric(row.batt ?? row.battery ?? row.battVolt),
                afr: normalizeNumeric(row.afr), tps: normalizeNumeric(row.tps)
            };
        };

        const timeFilter = {};
        if (startDate && endDate) {
            const start = new Date(startDate), end = new Date(endDate);
            if (!isNaN(start) && !isNaN(end)) { timeFilter.$gte = start; timeFilter.$lte = end; }
        } else if (hours) {
            const h = Number(hours);
            if (!isNaN(h) && h > 0) timeFilter.$gte = new Date(Date.now() - h * 3600000);
        }

        const dbQuery = {};
        if (Object.keys(timeFilter).length) dbQuery.timestamp = timeFilter;
        if (effectiveDeviceId) dbQuery.deviceId = effectiveDeviceId;

        const reports = await GeneratorData
            .find(dbQuery)
            .sort({ timestamp: -1 }).limit(limit).lean();

        const normalized = reports.map(normalizeRow).filter(Boolean);

        const summaryPipeline = [
            { $match: dbQuery },
            {
                $group: {
                    _id: null,
                    count: { $sum: 1 },
                    rpmCount: { $sum: { $cond: [{ $ne: ['$rpm', null] }, 1, 0] } },
                    rpmAvg: { $avg: '$rpm' }, rpmMin: { $min: '$rpm' }, rpmMax: { $max: '$rpm' },
                    voltCount: { $sum: { $cond: [{ $ne: ['$volt', null] }, 1, 0] } },
                    voltAvg: { $avg: '$volt' }, voltMin: { $min: '$volt' }, voltMax: { $max: '$volt' },
                    ampCount: { $sum: { $cond: [{ $ne: ['$amp', null] }, 1, 0] } },
                    ampAvg: { $avg: '$amp' }, ampMin: { $min: '$amp' }, ampMax: { $max: '$amp' },
                    powerCount: { $sum: { $cond: [{ $ne: ['$power', null] }, 1, 0] } },
                    powerAvg: { $avg: '$power' }, powerMin: { $min: '$power' }, powerMax: { $max: '$power' },
                    freqCount: { $sum: { $cond: [{ $ne: ['$freq', null] }, 1, 0] } },
                    freqAvg: { $avg: '$freq' }, freqMin: { $min: '$freq' }, freqMax: { $max: '$freq' },
                    tempCount: { $sum: { $cond: [{ $ne: ['$temp', null] }, 1, 0] } },
                    tempAvg: { $avg: '$temp' }, tempMin: { $min: '$temp' }, tempMax: { $max: '$temp' },
                    coolantCount: { $sum: { $cond: [{ $ne: ['$coolant', null] }, 1, 0] } },
                    coolantAvg: { $avg: '$coolant' }, coolantMin: { $min: '$coolant' }, coolantMax: { $max: '$coolant' },
                    fuelCount: { $sum: { $cond: [{ $ne: ['$fuel', null] }, 1, 0] } },
                    fuelAvg: { $avg: '$fuel' }, fuelMin: { $min: '$fuel' }, fuelMax: { $max: '$fuel' },
                    iatCount: { $sum: { $cond: [{ $ne: ['$iat', null] }, 1, 0] } },
                    iatAvg: { $avg: '$iat' }, iatMin: { $min: '$iat' }, iatMax: { $max: '$iat' },
                    mapCount: { $sum: { $cond: [{ $ne: ['$map', null] }, 1, 0] } },
                    mapAvg: { $avg: '$map' }, mapMin: { $min: '$map' }, mapMax: { $max: '$map' },
                    battCount: { $sum: { $cond: [{ $ne: ['$batt', null] }, 1, 0] } },
                    battAvg: { $avg: '$batt' }, battMin: { $min: '$batt' }, battMax: { $max: '$batt' },
                    afrCount: { $sum: { $cond: [{ $ne: ['$afr', null] }, 1, 0] } },
                    afrAvg: { $avg: '$afr' }, afrMin: { $min: '$afr' }, afrMax: { $max: '$afr' }
                }
            }
        ];

        const summary = (await GeneratorData.aggregate(summaryPipeline))[0] || {};
        const sensorKeys = ['rpm','volt','amp','power','freq','temp','coolant','fuel','iat','map','batt','afr','tps'];
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

        res.json({
            success: true,
            count: normalized.length,
            data: normalized,
            stats: {
                totalMatched: Number(summary.count) || 0,
                bySensor
            },
            deviceIdUsed: effectiveDeviceId || null
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});



function normalizeReportStatsNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function buildReportStatsQuery(query = {}) {
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
        const parsedHours = normalizeReportStatsNumber(hours);
        if (parsedHours && parsedHours > 0) {
            timeFilter.$gte = new Date(Date.now() - parsedHours * 60 * 60 * 1000);
        }
    }

    const dbQuery = {};
    if (Object.keys(timeFilter).length) dbQuery.timestamp = timeFilter;
    if (effectiveDeviceId) dbQuery.deviceId = effectiveDeviceId;
    return { dbQuery, effectiveDeviceId };
}

async function getReportStatsFromMongo(dbQuery) {
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

app.get('/api/reports/stats', async (req, res) => {
    try {
        const { dbQuery, effectiveDeviceId } = buildReportStatsQuery(req.query);
        const stats = await getReportStatsFromMongo(dbQuery);
        res.json({ success: true, stats, deviceIdUsed: effectiveDeviceId || null });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/users/profile', async (req, res) => {
    try {
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
        if (body.email) user.email = String(body.email).trim().toLowerCase();
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
    await connectDB();
    const deviceId = options.deviceId || process.env.DEFAULT_REPORT_DEVICE_ID || null;
    const query = {};
    if (deviceId) query.deviceId = deviceId;
    const dateFilter = buildCbmDateFilter(options);
    if (dateFilter) query.timestamp = dateFilter;

    let rows = await GeneratorData.find(query).sort({ timestamp: 1 }).limit(10000).lean();
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
    return MaintenanceSuggestion.create(payload);
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
        await connectDB();
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

app.get('/favicon.ico', (req, res) => res.status(204).end());

// ─── INIT MQTT (non-blocking) ─────────────────────────────────────────────────
initMQTT();

// ─── EXPORT untuk Vercel — JANGAN pakai app.listen() di sini ─────────────────
module.exports = app;
