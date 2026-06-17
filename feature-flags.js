/**
 * feature-flags.js
 * ================================================================
 * Centralized feature flag management untuk GENSYS backend.
 *
 * Semua fitur analisis bisa di-enable/disable dari:
 *   1. Environment variable (.env atau terminal)
 *   2. Runtime toggle via API  POST /api/features/:flag
 *   3. Startup banner menampilkan status semua flag
 *
 * Cara pakai dari terminal:
 *   ENABLE_CBM=false node server.js
 *   ENABLE_CBM=false ENABLE_COMPONENT_LIFE=false node server.js
 *
 * Atau dengan dotenv di .env:
 *   ENABLE_CBM=false
 *   ENABLE_COMPONENT_LIFE=false
 * ================================================================
 */

'use strict';

// ── DEFINISI SEMUA FLAG ───────────────────────────────────────────────────────

/**
 * Setiap flag memiliki:
 *   envKey      : nama environment variable
 *   defaultOn   : nilai default jika env tidak diset
 *   description : keterangan singkat
 *   group       : kelompok fungsional
 *   refs        : standar/referensi ilmiah yang mendasari
 */
const FLAG_DEFINITIONS = {

    // ── ANALISIS CBM ──────────────────────────────────────────────
    cbm: {
        envKey:      'ENABLE_CBM',
        defaultOn:   true,
        description: 'Condition-Based Maintenance analysis (linear regression, threshold proximity, CV)',
        group:       'analysis',
        refs:        ['ISO 13374', 'IEC 61511', 'IEC 61000-4-30']
    },

    cbm_worker: {
        envKey:      'ENABLE_CBM_WORKER',
        defaultOn:   true,
        description: 'Background worker: simpan hasil CBM ke MongoDB setiap interval',
        group:       'worker',
        refs:        ['ISO 13374']
    },

    fft_mapping: {
        envKey:      'ENABLE_FFT_MAPPING',
        defaultOn:   true,
        description: 'FFT peak mapping ke komponen mekanik (unbalance, bearing, misfire)',
        group:       'analysis',
        refs:        ['ISO 10816', 'ISO 20816', 'Scheffer & Girdhar 2004']
    },

    // ── ESTIMASI UMUR KOMPONEN ────────────────────────────────────
    component_life: {
        envKey:      'ENABLE_COMPONENT_LIFE',
        defaultOn:   true,
        description: 'Component lifespan estimation (Arrhenius degradation + Miner\'s Rule)',
        group:       'analysis',
        refs:        ['Miner 1945', 'Arrhenius', 'MIL-HDBK-217F']
    },

    component_life_worker: {
        envKey:      'ENABLE_COMPONENT_LIFE_WORKER',
        defaultOn:   true,
        description: 'Background worker: cek early warning komponen & buat MaintenanceSuggestion',
        group:       'worker',
        refs:        ['ISO 55000', 'NFPA 110']
    },

    // ── MAINTENANCE SUGGESTION WORKER ────────────────────────────
    maintenance_worker: {
        envKey:      'ENABLE_MAINTENANCE_WORKER',
        defaultOn:   true,
        description: 'Background worker: generate MaintenanceSuggestion dari data sensor terbaru',
        group:       'worker',
        refs:        ['IEC 60812 (FMEA)', 'ISO 14224']
    },

    // ── PREVENTIVE SCHEDULE ───────────────────────────────────────
    preventive_schedule: {
        envKey:      'ENABLE_PREVENTIVE_SCHEDULE',
        defaultOn:   true,
        description: 'Time-based preventive maintenance schedule (interval jam operasi)',
        group:       'analysis',
        refs:        ['ISO 55000', 'NFPA 110', 'Moubray RCM II']
    },

    // ── MONTHLY REPORT WORKER ─────────────────────────────────────
    report_worker: {
        envKey:      'ENABLE_REPORT_WORKER',
        defaultOn:   true,
        description: 'Background worker: generate laporan bulanan ke WorkerState',
        group:       'worker',
        refs:        []
    },

    // ── HEALTH SCORE ─────────────────────────────────────────────
    health_score: {
        envKey:      'ENABLE_HEALTH_SCORE',
        defaultOn:   true,
        description: 'Health score computation (penalty-based, 0-100)',
        group:       'analysis',
        refs:        ['IEC 60812', 'ISO 14224', 'Moubray RCM II']
    },

    // ── ALERT EMAIL ──────────────────────────────────────────────
    alert_email: {
        envKey:      'ENABLE_ALERT_EMAIL',
        defaultOn:   true,
        description: 'Kirim email saat ada alert critical via SendGrid',
        group:       'notification',
        refs:        []
    }
};

// ── RUNTIME STATE ─────────────────────────────────────────────────────────────
// Nilai runtime bisa diubah via API tanpa restart server.
// Diinisialisasi dari env vars saat module pertama kali di-require.

const _runtimeState = {};

function _readEnvBool(envKey, defaultOn) {
    const raw = (process.env[envKey] || '').trim().toLowerCase();
    if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
    if (raw === 'true'  || raw === '1' || raw === 'on'  || raw === 'yes') return true;
    return defaultOn;
}

// Init semua flag dari environment
for (const [name, def] of Object.entries(FLAG_DEFINITIONS)) {
    _runtimeState[name] = _readEnvBool(def.envKey, def.defaultOn);
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────

/**
 * Cek apakah sebuah flag aktif.
 * @param {string} flagName - nama flag (e.g. 'cbm', 'component_life')
 * @returns {boolean}
 */
function isEnabled(flagName) {
    if (!(flagName in _runtimeState)) {
        console.warn(`[FeatureFlags] Unknown flag: "${flagName}". Default: true.`);
        return true;
    }
    return _runtimeState[flagName];
}

/**
 * Set flag secara runtime (tanpa restart).
 * @param {string}  flagName
 * @param {boolean} value
 * @returns {{ ok: boolean, flag: string, enabled: boolean, message: string }}
 */
function setFlag(flagName, value) {
    if (!(flagName in FLAG_DEFINITIONS)) {
        return { ok: false, flag: flagName, message: `Unknown flag: "${flagName}"` };
    }
    const before = _runtimeState[flagName];
    _runtimeState[flagName] = Boolean(value);
    console.log(`[FeatureFlags] ${flagName}: ${before} → ${_runtimeState[flagName]}`);
    return {
        ok:      true,
        flag:    flagName,
        enabled: _runtimeState[flagName],
        message: `Flag "${flagName}" set to ${_runtimeState[flagName]}`
    };
}

/**
 * Kembalikan snapshot semua flag beserta metadata.
 * @returns {Object[]}
 */
function getAllFlags() {
    return Object.entries(FLAG_DEFINITIONS).map(([name, def]) => ({
        name,
        enabled:     _runtimeState[name],
        envKey:      def.envKey,
        defaultOn:   def.defaultOn,
        description: def.description,
        group:       def.group,
        refs:        def.refs,
        source:      process.env[def.envKey] !== undefined ? 'env' : 'default'
    }));
}

/**
 * Cetak startup banner ke console.
 * Dipanggil sekali saat server start.
 */
function printStartupBanner() {
    const groups = ['analysis', 'worker', 'notification'];
    const groupLabel = { analysis: 'Analysis', worker: 'Background Workers', notification: 'Notifications' };

    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║              GENSYS — FEATURE FLAGS STATUS              ║');
    console.log('╠══════════════════════════════════════════════════════════╣');

    for (const group of groups) {
        const flags = Object.entries(FLAG_DEFINITIONS).filter(([, d]) => d.group === group);
        if (!flags.length) continue;
        console.log(`║  ── ${groupLabel[group].padEnd(53)}║`);
        for (const [name, def] of flags) {
            const enabled = _runtimeState[name];
            const icon    = enabled ? '✅' : '❌';
            const src     = process.env[def.envKey] !== undefined ? '[env]' : '[default]';
            const line    = `${icon}  ${name.padEnd(26)} ${src.padEnd(10)}`.padEnd(57);
            console.log(`║  ${line}║`);
        }
        console.log('║                                                          ║');
    }

    const disabledCount = Object.values(_runtimeState).filter(v => !v).length;
    if (disabledCount > 0) {
        console.log(`║  ⚠  ${String(disabledCount).padStart(2)} flag(s) disabled via environment variable      ║`);
    } else {
        console.log('║  All features enabled. Use env vars to disable.          ║');
    }

    console.log('║                                                          ║');
    console.log('║  Toggle runtime: POST /api/features/:flag                ║');
    console.log('║  View all:       GET  /api/features                      ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
}

module.exports = {
    isEnabled,
    setFlag,
    getAllFlags,
    printStartupBanner,
    FLAG_DEFINITIONS
};
