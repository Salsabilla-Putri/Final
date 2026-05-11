/**
 * activeTimeService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Melacak berapa lama mesin generator aktif per hari berdasarkan data ESP32.
 *
 * Logika inti:
 *  • Setiap kali ESP32 mengirim data dengan status RUNNING → buka sesi (jika belum ada).
 *  • Jika status STOPPED / mesin off → tutup sesi yang sedang berjalan.
 *  • Jika tidak ada data selama DISCONNECT_TIMEOUT_MS → anggap ESP32 terputus
 *    dan tutup sesi secara otomatis (via watchdog timer internal).
 *
 * Integrasi:
 *  1. Panggil `sessionService.onEngineData(data)` setiap kali endpoint
 *     POST /api/engine-data menerima payload dari ESP32.
 *  2. Mount router `activeTimeRouter` ke Express app:
 *     app.use('/api', activeTimeRouter);
 *
 * Dependensi: mongoose, express
 */

'use strict';

const mongoose = require('mongoose');
const express  = require('express');

// ─────────────────────────────────────────────────────────────────────────────
//  SCHEMA / MODEL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Setiap dokumen mewakili satu "sesi aktif" mesin.
 * endedAt = null  →  sesi masih berjalan
 * endedAt = Date  →  sesi sudah selesai
 * closeReason     →  'engine_stopped' | 'esp32_disconnect' | 'server_restart' | 'manual'
 */
const activeSessionSchema = new mongoose.Schema({
    startedAt   : { type: Date, required: true, default: Date.now },
    endedAt     : { type: Date, default: null },
    durationSec : { type: Number, default: 0 },   // diisi saat tutup
    closeReason : { type: String, default: null }
}, { collection: 'active_sessions' });

// Index untuk query history
activeSessionSchema.index({ startedAt: -1 });
activeSessionSchema.index({ endedAt: 1 });

const ActiveSession = mongoose.models.ActiveSession
    || mongoose.model('ActiveSession', activeSessionSchema);

// ─────────────────────────────────────────────────────────────────────────────
//  SESSION SERVICE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Jika tidak ada data masuk selama DISCONNECT_TIMEOUT_MS milidetik,
 * sesi aktif ditutup otomatis (dianggap mesin mati / ESP32 putus).
 */
const DISCONNECT_TIMEOUT_MS = 30_000; // 30 detik

let _watchdogTimer  = null;   // NodeJS Timeout untuk deteksi disconnect
let _currentSession = null;   // Cache ID sesi yang sedang berjalan

/**
 * Dipanggil setiap kali server menerima data dari ESP32.
 * @param {{ status: string, rpm?: number, ... }} engineData
 */
async function onEngineData(engineData) {
    const isRunning = (engineData.status || '').toUpperCase() === 'RUNNING';

    _resetWatchdog(); // Reset timer disconnect setiap kali data masuk

    if (isRunning) {
        await _openSession();
    } else {
        await _closeSession('engine_stopped');
    }
}

/** Buka sesi baru jika belum ada sesi yang sedang berjalan. */
async function _openSession() {
    // Cek apakah sudah ada sesi terbuka di cache
    if (_currentSession) return;

    // Double-check ke DB (misal setelah restart server)
    const existing = await ActiveSession.findOne({ endedAt: null }).sort({ startedAt: -1 });
    if (existing) {
        _currentSession = existing._id;
        console.log('[ActiveTime] Resumed existing session:', existing._id);
        return;
    }

    // Buat sesi baru
    const sess = await ActiveSession.create({ startedAt: new Date() });
    _currentSession = sess._id;
    console.log('[ActiveTime] Session opened:', sess._id, 'at', sess.startedAt.toISOString());
}

/**
 * Tutup sesi yang sedang berjalan.
 * @param {'engine_stopped'|'esp32_disconnect'|'server_restart'|'manual'} reason
 */
async function _closeSession(reason) {
    _clearWatchdog();

    // Tutup lewat cache ID dulu
    if (_currentSession) {
        await _finalizeSession(_currentSession, reason);
        _currentSession = null;
        return;
    }

    // Fallback: tutup semua sesi terbuka yang masih ada di DB
    const open = await ActiveSession.find({ endedAt: null });
    for (const s of open) {
        await _finalizeSession(s._id, reason);
    }
}

/** Tulis endedAt + durasi ke dokumen sesi. */
async function _finalizeSession(sessionId, reason) {
    const now  = new Date();
    const sess = await ActiveSession.findById(sessionId);
    if (!sess || sess.endedAt) return;   // sudah ditutup sebelumnya

    const durationSec = Math.round((now - sess.startedAt) / 1000);
    await ActiveSession.findByIdAndUpdate(sessionId, {
        endedAt    : now,
        durationSec,
        closeReason: reason
    });

    console.log(
        `[ActiveTime] Session closed (${reason}):`,
        sessionId,
        `| Duration: ${Math.floor(durationSec / 60)}m ${durationSec % 60}s`
    );
}

// ─── WATCHDOG TIMER ──────────────────────────────────────────────────────────

function _resetWatchdog() {
    _clearWatchdog();
    _watchdogTimer = setTimeout(() => {
        console.warn('[ActiveTime] Watchdog fired — ESP32 disconnect');
        _closeSession('esp32_disconnect').catch(console.error);
    }, DISCONNECT_TIMEOUT_MS);
}

function _clearWatchdog() {
    if (_watchdogTimer) {
        clearTimeout(_watchdogTimer);
        _watchdogTimer = null;
    }
}

// Saat server restart, tutup semua sesi yang masih terbuka
async function closeOrphanedSessions() {
    const open = await ActiveSession.find({ endedAt: null });
    if (!open.length) return;

    console.log(`[ActiveTime] Closing ${open.length} orphaned session(s) from previous run`);
    for (const s of open) {
        await _finalizeSession(s._id, 'server_restart');
    }
    _currentSession = null;
}

const sessionService = { onEngineData, closeOrphanedSessions };

// ─────────────────────────────────────────────────────────────────────────────
//  ROUTER
// ─────────────────────────────────────────────────────────────────────────────

const activeTimeRouter = express.Router();

/**
 * GET /api/generator-active-time/history?limit=200
 *
 * Kembalikan daftar sesi dari DB, terbaru lebih dulu.
 * Response: { success: true, data: [{ startedAt, endedAt, durationSec }, ...] }
 */
activeTimeRouter.get('/generator-active-time/history', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const cutoff = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 hari ke belakang

        const sessions = await ActiveSession
            .find({ startedAt: { $gte: cutoff } })
            .sort({ startedAt: -1 })
            .limit(limit)
            .lean();

        res.json({ success: true, data: sessions });
    } catch (err) {
        console.error('[ActiveTime] GET history error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * POST /api/active-session/close
 *
 * Dipanggil dari frontend ketika mendeteksi ESP32 disconnect.
 * Body: { reason?: string }
 */
activeTimeRouter.post('/active-session/close', async (req, res) => {
    try {
        const reason = req.body?.reason || 'esp32_disconnect';
        await _closeSession(reason);
        res.json({ success: true });
    } catch (err) {
        console.error('[ActiveTime] POST close error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * POST /api/daily-active-time/recalculate
 *
 * Digunakan dashboard untuk memperbarui perhitungan sesi hari ini.
 * Endpoint ini opsional — hanya merespons agar tidak 404.
 * Kalkulasi sebenarnya sudah real-time lewat sesi terbuka.
 */
activeTimeRouter.post('/daily-active-time/recalculate', async (req, res) => {
    // Tidak perlu kalkulasi ulang karena sesi disimpan secara real-time.
    // Cukup pastikan watchdog masih berjalan jika sesi sedang aktif.
    res.json({ success: true, message: 'Sessions are tracked in real-time' });
});

// ─────────────────────────────────────────────────────────────────────────────
//  INTEGRASI KE APP UTAMA
// ─────────────────────────────────────────────────────────────────────────────
//
//  Di file server.js / app.js Anda, tambahkan:
//
//  const { activeTimeRouter, sessionService } = require('./activeTimeService');
//
//  // Tutup sesi yatim saat server start
//  sessionService.closeOrphanedSessions();
//
//  // Mount router
//  app.use('/api', activeTimeRouter);
//
//  // Panggil onEngineData setiap kali ESP32 POST data
//  app.post('/api/engine-data', async (req, res) => {
//      const data = req.body;
//
//      // ... simpan ke DB seperti biasa ...
//      await EngineData.create(data);
//
//      // Trigger session tracker
//      await sessionService.onEngineData(data);
//
//      res.json({ success: true });
//  });

module.exports = { activeTimeRouter, sessionService, ActiveSession };