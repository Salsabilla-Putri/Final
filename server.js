const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
require('dotenv').config();

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

// DATABASE
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/generator_monitoring', {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => {
    console.log('✅ MongoDB Connected');
    loadThresholdsFromDB(); // Load threshold saat server nyala
})
.catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- SCHEMAS ---
const generatorDataSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now },
    deviceId: { type: String, required: true },
    rpm: Number, volt: Number, amp: Number, power: Number,
    freq: Number, temp: Number, coolant: Number, fuel: Number,
    sync: String, status: String, oil: Number, iat: Number,
    map: Number, afr: Number, tps: Number
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

// --- DYNAMIC THRESHOLDS ---
// Default values (jika db kosong)
let ACTIVE_THRESHOLDS = {
    rpm: { max: 3800 },
    temp: { max: 95 },
    volt: { min: 180, max: 250 },
    fuel: { min: 20 },
    oil: { min: 20 },
    amp: { max: 100 },
    freq: { min: 48, max: 52 }
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
const mqttClient = mqtt
    ? mqtt.connect(process.env.MQTT_BROKER || 'mqtt://10.21.107.16:1883', {
        username: process.env.MQTT_USERNAME || '/TA20:TA20',
        password: process.env.MQTT_PASSWORD || 'TA242501020'
    })
    : createDisabledMqttClient();

let latestData = {
    deviceId: 'GENERATOR #1', timestamp: new Date(),
    rpm: 0, volt: 0, amp: 0, power: 0, freq: 0, temp: 0, coolant: 0,
    fuel: 0, sync: 'OFF-GRID', status: 'STOPPED', oil: 0, iat: 0, map: 0, afr: 0, tps: 0
};

mqttClient.on('connect', () => {
    console.log('✅ Connected to MQTT Broker');
    mqttClient.subscribe('gen/#');
});

mqttClient.on('error', (error) => {
    console.warn('⚠️ MQTT unavailable:', error.message);
});

// LOGIC ALARM DINAMIS (Menggunakan ACTIVE_THRESHOLDS)
// --- LOGIC ALARM DINAMIS (UPDATED) ---
// --- LOGIC ALARM DINAMIS (DIPERBAIKI) ---
async function checkAndSaveAlerts(data) {
    const alertsToSave = [];
    const T = ACTIVE_THRESHOLDS; 

    // Helper check function
    const check = (param, val) => {
        if (!T[param]) return; // Skip jika tidak ada threshold
        
        // Cek Batas Atas
        if (T[param].max !== undefined && val > T[param].max) {
            alertsToSave.push({ 
                parameter: param, 
                value: val, 
                message: `${param.toUpperCase()} Too High (> ${T[param].max})`, 
                severity: 'critical' 
            });
        }
        // Cek Batas Bawah
        if (T[param].min !== undefined && val < T[param].min) {
            alertsToSave.push({ 
                parameter: param, 
                value: val, 
                message: `${param.toUpperCase()} Too Low (< ${T[param].min})`, 
                severity: 'medium' 
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
    check('oil', data.oil);
    check('iat', data.iat);
    check('map', data.map);
    check('afr', data.afr);
    check('tps', data.tps);

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
                } catch (saveErr) { console.error('❌ DB Save Error:', saveErr.message); }
                break;
        }
    } catch (error) { console.error('❌ MQTT Error:', error); }
});

// --- API ENDPOINTS ---

app.get('/api/engine-data/latest', async (req, res) => {
    try {
        if (!isDbReady()) {
            return res.json({ success: true, data: latestData, source: 'memory' });
        }

        const dbData = await GeneratorData.findOne().sort({ timestamp: -1 });
        const isDbFresh = dbData && (new Date() - dbData.timestamp < 15000);
        res.json({ success: true, data: isDbFresh ? dbData : latestData, source: isDbFresh ? 'database' : 'memory' });
    } catch (error) {
        res.json({ success: true, data: latestData, source: 'memory', warning: error.message });
    }
});

// 2. GET History Data (Updated for Date Filter)
app.get('/api/engine-data/history', async (req, res) => {
    try {
        const { limit = 1000, hours, startDate, endDate } = req.query;
        let query = {};

        // Jika ada filter tanggal spesifik dari Frontend
        if (startDate && endDate) {
            // Set start date ke 00:00:00 dan end date ke 23:59:59
            const start = new Date(startDate);
            start.setHours(0,0,0,0);
            
            const end = new Date(endDate);
            end.setHours(23,59,59,999);

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
    status: { type: String, default: 'scheduled' }, // scheduled, completed, etc.
    dueDate: Date,
    assignedTo: String,
    createdAt: { type: Date, default: Date.now }, // Tanggal dibuat
    completedAt: Date                             // Tanggal selesai
});
const Maintenance = mongoose.model('Maintenance', maintenanceSchema);

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
// Tambahkan kode ini di dalam server.js (sebelum app.listen)



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

// API Endpoint untuk mengambil data report dari collection MongoDB yang ditetapkan
app.get('/api/reports', async (req, res) => {
    try {
        const parsedLimit = parseInt(req.query.limit, 10);
        const limit = Number.isNaN(parsedLimit) ? 5000 : Math.max(1, Math.min(parsedLimit, 100000));
        const { hours, startDate, endDate } = req.query;

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
                rpm: normalizeNumeric(row.rpm),
                volt: normalizeNumeric(row.volt ?? row.voltage),
                amp: normalizeNumeric(row.amp ?? row.current),
                power: normalizeNumeric(row.power ?? row.kw ?? row.kW),
                freq: normalizeNumeric(row.freq ?? row.frequency),
                temp: normalizeNumeric(row.temp ?? row.temperature),
                coolant: normalizeNumeric(row.coolant ?? row.temp ?? row.temperature),
                fuel: normalizeNumeric(row.fuel),
                oil: normalizeNumeric(row.oil),
                iat: normalizeNumeric(row.iat),
                map: normalizeNumeric(row.map),
                afr: normalizeNumeric(row.afr),
                tps: normalizeNumeric(row.tps)
            };
        };

        const timeFilter = {};
        if (startDate && endDate) {
            const start = new Date(startDate);
            const end = new Date(endDate);
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

        const buildFieldCondition = (fieldName) =>
            Object.keys(timeFilter).length ? { [fieldName]: timeFilter } : { [fieldName]: { $exists: true } };

        const mergeUniqueRows = (rows) => {
            const seen = new Set();
            const out = [];
            for (const row of rows) {
                const ts = row.timestamp || row.createdAt || row.date || row.waktu || '';
                const key = `${row._id || ''}|${ts}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(row);
            }
            return out;
        };

        let reports = [];
        const candidateCollections = ['reports', 'generatordatas', 'generator_data'];

        if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
            const existingCollections = await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
            const existingNames = new Set(existingCollections.map((c) => c.name));

            for (const collectionName of candidateCollections) {
                if (!existingNames.has(collectionName)) continue;

                const collection = mongoose.connection.db.collection(collectionName);
                const orConditions = [
                    buildFieldCondition('timestamp'),
                    buildFieldCondition('createdAt'),
                    buildFieldCondition('date')
                ];

                const docs = await collection.find({ $or: orConditions }).limit(limit * 3).toArray();
                const merged = mergeUniqueRows(docs)
                    .sort((a, b) => new Date(b.timestamp || b.createdAt || b.date || 0) - new Date(a.timestamp || a.createdAt || a.date || 0))
                    .slice(0, limit);

                if (merged.length) {
                    reports = merged;
                    break;
                }
            }
        }

        if (!reports.length && isDbReady()) {
            const orConditions = Object.keys(timeFilter).length
                ? [{ timestamp: timeFilter }, { createdAt: timeFilter }, { date: timeFilter }]
                : [];

            const fallbackQuery = orConditions.length ? { $or: orConditions } : {};
            reports = await GeneratorData.find(fallbackQuery)
                .sort({ timestamp: -1, createdAt: -1, date: -1 })
                .limit(limit)
                .lean();
        }

        const normalizedReports = reports
            .map(normalizeRow)
            .filter(Boolean)
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        res.json({ success: true, count: normalizedReports.length, data: normalizedReports, source: isDbReady() ? 'database' : 'memory' });
    } catch (err) {
        res.json({ success: true, count: 0, data: [], source: 'memory', warning: err.message });
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

app.get('/api/health', (req, res) => res.json({ status: 'healthy', mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' }));
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get(/(.*)/, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'login.html')); });

const PORT = process.env.PORT || 3000;

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 Server running: http://localhost:${PORT}`);
    });
}

module.exports = app;
