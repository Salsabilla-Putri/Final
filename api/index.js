const express = require('express');
const mongoose = require('mongoose');
const mqtt = require('mqtt');
const cors = require('cors');
const {
    transformPublicStatus,
    generateAlerts,
    getMaintenanceStatus,
    getPublicLabels
} = require('../public_status');

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
    rpm: Number, volt: Number, amp: Number, power: Number,
    freq: Number, temp: Number, coolant: Number, fuel: Number,
    sync: String, status: String, oil: Number, iat: Number,
    map: Number, afr: Number, tps: Number
});
const GeneratorData = mongoose.models.GeneratorData || mongoose.model('GeneratorData', generatorDataSchema, 'generatordatas');

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

const maintenanceSchema = new mongoose.Schema({
    task: { type: String, required: true },
    type: String, priority: String,
    status: { type: String, default: 'scheduled' },
    dueDate: Date, assignedTo: String,
    createdAt: { type: Date, default: Date.now },
    completedAt: Date
});
const Maintenance = mongoose.models.Maintenance || mongoose.model('Maintenance', maintenanceSchema, 'maintenance');

// ─── THRESHOLDS ───────────────────────────────────────────────────────────────
let ACTIVE_THRESHOLDS = {
    rpm: { max: 3800 }, temp: { max: 95 },
    volt: { min: 180, max: 250 }, fuel: { min: 20 },
    oil: { min: 20 }, amp: { max: 100 },
    freq: { min: 48, max: 52 }
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
    deviceId: 'GENERATOR #1', timestamp: new Date(),
    rpm: 0, volt: 0, amp: 0, power: 0, freq: 0, temp: 0, coolant: 0,
    fuel: 0, sync: 'OFF-GRID', status: 'STOPPED', oil: 0, iat: 0, map: 0, afr: 0, tps: 0
};

function initMQTT() {
    if (!process.env.MQTT_BROKER) return;
    // FIX: Jangan init MQTT jika broker masih placeholder
    if (process.env.MQTT_BROKER.includes('<host>')) {
        console.warn('MQTT_BROKER masih placeholder, skip MQTT init');
        return;
    }
    try {
        const mqttClient = mqtt.connect(process.env.MQTT_BROKER, {
            username: process.env.MQTT_USERNAME,
            password: process.env.MQTT_PASSWORD,
            connectTimeout: 5000,
            reconnectPeriod: 0
        });
        mqttClient.on('connect', () => {
            console.log('✅ MQTT Connected');
            mqttClient.subscribe('gen/#');
        });
        mqttClient.on('message', async (topic, message) => {
            const value = message.toString();
            switch (topic) {
                case 'gen/rpm': latestData.rpm = parseInt(value) || 0; break;
                case 'gen/volt': latestData.volt = parseFloat(value) || 0; break;
                case 'gen/amp': latestData.amp = parseFloat(value) || 0; break;
                case 'gen/power': latestData.power = parseFloat(value) || 0; break;
                case 'gen/freq': latestData.freq = parseFloat(value) || 0; break;
                case 'gen/temp': latestData.temp = parseFloat(value) || 0; latestData.coolant = latestData.temp; break;
                case 'gen/fuel': latestData.fuel = parseFloat(value) || 0; break;
                case 'gen/sync': latestData.sync = value; break;
                case 'gen/oil': latestData.oil = parseFloat(value) || 0; break;
                case 'gen/iat': latestData.iat = parseFloat(value) || 0; break;
                case 'gen/map': latestData.map = parseFloat(value) || 0; break;
                case 'gen/afr': latestData.afr = parseFloat(value) || 0; break;
                case 'gen/tps': latestData.tps = parseFloat(value) || 0; break;
                case 'gen/status':
                    latestData.status = value;
                    latestData.timestamp = new Date();
                    try {
                        await new GeneratorData(latestData).save();
                        await checkAndSaveAlerts(latestData);
                    } catch (e) { console.error('DB Save Error:', e.message); }
                    break;
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
    const check = (param, val) => {
        if (!T[param]) return;
        if (T[param].max !== undefined && val > T[param].max)
            alertsToSave.push({ parameter: param, value: val, message: `${param.toUpperCase()} Too High (> ${T[param].max})`, severity: 'critical' });
        if (T[param].min !== undefined && val < T[param].min)
            alertsToSave.push({ parameter: param, value: val, message: `${param.toUpperCase()} Too Low (< ${T[param].min})`, severity: 'medium' });
    };
    ['rpm','volt','amp','freq','power','coolant','temp','fuel','oil','iat','map','afr','tps']
        .forEach(p => check(p, data[p]));

    if (alertsToSave.length > 0) {
        const lastAlert = await Alert.findOne().sort({ timestamp: -1 });
        const timeDiff = lastAlert ? (new Date() - lastAlert.timestamp) : 999999;
        if (timeDiff > 10000) {
            for (const a of alertsToSave)
                await new Alert({ ...a, deviceId: data.deviceId }).save();
        }
    }
}

// ─── CONNECT DB sebelum setiap request ───────────────────────────────────────
app.use(async (req, res, next) => {
    try {
        await connectDB();
        next();
    } catch (err) {
        console.error('DB connection error:', err.message);
        res.status(503).json({ success: false, error: 'Database connection failed', detail: err.message });
    }
});

// ─── API ROUTES ───────────────────────────────────────────────────────────────

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
                oil: normalizeNumeric(row.oil), iat: normalizeNumeric(row.iat),
                map: normalizeNumeric(row.map), afr: normalizeNumeric(row.afr), tps: normalizeNumeric(row.tps)
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
                    oilCount: { $sum: { $cond: [{ $ne: ['$oil', null] }, 1, 0] } },
                    oilAvg: { $avg: '$oil' }, oilMin: { $min: '$oil' }, oilMax: { $max: '$oil' },
                    iatCount: { $sum: { $cond: [{ $ne: ['$iat', null] }, 1, 0] } },
                    iatAvg: { $avg: '$iat' }, iatMin: { $min: '$iat' }, iatMax: { $max: '$iat' },
                    mapCount: { $sum: { $cond: [{ $ne: ['$map', null] }, 1, 0] } },
                    mapAvg: { $avg: '$map' }, mapMin: { $min: '$map' }, mapMax: { $max: '$map' },
                    afrCount: { $sum: { $cond: [{ $ne: ['$afr', null] }, 1, 0] } },
                    afrAvg: { $avg: '$afr' }, afrMin: { $min: '$afr' }, afrMax: { $max: '$afr' }
                }
            }
        ];

        const summary = (await GeneratorData.aggregate(summaryPipeline))[0] || {};
        const sensorKeys = ['rpm','volt','amp','power','freq','temp','coolant','fuel','oil','iat','map','afr'];
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

app.get('/favicon.ico', (req, res) => res.status(204).end());

// ─── INIT MQTT (non-blocking) ─────────────────────────────────────────────────
initMQTT();

// ─── EXPORT untuk Vercel — JANGAN pakai app.listen() di sini ─────────────────
module.exports = app;
