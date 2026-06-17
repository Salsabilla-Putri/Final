/**
 * lib_component_life.js
 * Estimasi umur pakai komponen generator berbasis tren data historis.
 *
 * Fitur:
 *   - Estimasi sisa umur (Remaining Useful Life) tiap komponen
 *   - Faktor degradasi berdasarkan suhu, RPM, dan beban historis
 *   - Notifikasi dini jika komponen mendekati batas servis
 *
 * [FT4] Component lifespan estimation from historical sensor trends
 * [SS6] Early maintenance notification for minimizing downtime
 */

'use strict';

// ================================================================
// DEFINISI KOMPONEN & UMUR DESAIN
// ================================================================
// intervalHours : interval servis/penggantian dalam jam operasi ideal
// maxTempNormal : suhu normal yang dipakai sebagai baseline degradasi
// maxRpmNormal  : RPM normal sebagai baseline degradasi
// loadFactor    : sensitivitas terhadap beban (0-1, makin tinggi makin cepat aus)
const COMPONENT_SPECS = {
    'Oli Mesin': {
        intervalHours: 250,
        maxTempNormal: 90,
        maxRpmNormal: 3000,
        loadFactor: 0.6,
        degradationParams: { temp: 0.4, rpm: 0.3, load: 0.3 },
        unit: 'jam',
        icon: '🛢️',
        task: 'Ganti oli mesin & filter oli'
    },
    'Filter Udara': {
        intervalHours: 500,
        maxTempNormal: 90,
        maxRpmNormal: 3000,
        loadFactor: 0.4,
        degradationParams: { temp: 0.2, rpm: 0.4, load: 0.4 },
        unit: 'jam',
        icon: '🌬️',
        task: 'Bersihkan / ganti filter udara'
    },
    'Busi / Spark Plug': {
        intervalHours: 400,
        maxTempNormal: 90,
        maxRpmNormal: 3000,
        loadFactor: 0.5,
        degradationParams: { temp: 0.5, rpm: 0.3, load: 0.2 },
        unit: 'jam',
        icon: '⚡',
        task: 'Periksa / ganti busi'
    },
    'Sistem Pendingin': {
        intervalHours: 1000,
        maxTempNormal: 85,
        maxRpmNormal: 3000,
        loadFactor: 0.3,
        degradationParams: { temp: 0.7, rpm: 0.1, load: 0.2 },
        unit: 'jam',
        icon: '🌡️',
        task: 'Flush coolant & periksa radiator'
    },
    'Belt / V-Belt': {
        intervalHours: 800,
        maxTempNormal: 90,
        maxRpmNormal: 3000,
        loadFactor: 0.7,
        degradationParams: { temp: 0.3, rpm: 0.3, load: 0.4 },
        unit: 'jam',
        icon: '🔗',
        task: 'Periksa & ganti V-belt'
    },
    'Filter Bahan Bakar': {
        intervalHours: 500,
        maxTempNormal: 90,
        maxRpmNormal: 3000,
        loadFactor: 0.3,
        degradationParams: { temp: 0.1, rpm: 0.3, load: 0.6 },
        unit: 'jam',
        icon: '⛽',
        task: 'Ganti filter bahan bakar'
    }
};

// ================================================================
// HELPERS
// ================================================================
function clamp(v, min = 0, max = 1) {
    return Math.max(min, Math.min(max, v));
}

function safeNum(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Hitung faktor degradasi akselerasi dari kondisi sensor.
 * Nilai 1.0 = degradasi normal, > 1.0 = lebih cepat aus.
 *
 * Formula: weighted sum dari stress faktor tiap parameter.
 * Stress suhu  : (temp / maxTempNormal)^2  — non-linear karena suhu tinggi merusak lebih cepat
 * Stress RPM   : (rpm  / maxRpmNormal)     — linear
 * Stress beban : (amp  / maxAmpRef)        — linear (amp sebagai proxy beban)
 */
function computeDegradationFactor(spec, avgTemp, avgRpm, avgAmp, maxAmpRef = 20) {
    const tempStress = Math.pow(clamp(avgTemp / spec.maxTempNormal, 0, 2), 2);
    const rpmStress  = clamp(avgRpm  / spec.maxRpmNormal, 0.1, 2);
    const loadStress = clamp(avgAmp  / Math.max(maxAmpRef, 1), 0, 2) * spec.loadFactor;

    const w = spec.degradationParams;
    const factor = (w.temp * tempStress) + (w.rpm * rpmStress) + (w.load * (1 + loadStress));

    // Normalkan ke range 0.5 – 3.0
    return clamp(factor, 0.5, 3.0);
}

/**
 * Hitung statistik dari array data rows.
 * Hanya baris aktif (rpm > 100) yang dihitung.
 */
function computeSensorStats(rows) {
    const active = rows.filter(r => safeNum(r.rpm) > 100);
    if (!active.length) return { avgTemp: 0, avgRpm: 0, avgAmp: 0, maxTemp: 0, maxRpm: 0, count: 0 };

    let sumTemp = 0, sumRpm = 0, sumAmp = 0;
    let maxTemp = 0, maxRpm = 0;

    for (const r of active) {
        const temp = safeNum(r.coolant ?? r.clt ?? r.temp, 0);
        const rpm  = safeNum(r.rpm, 0);
        const amp  = safeNum(r.amp ?? r.currentA, 0);

        sumTemp += temp;
        sumRpm  += rpm;
        sumAmp  += amp;
        if (temp > maxTemp) maxTemp = temp;
        if (rpm  > maxRpm)  maxRpm  = rpm;
    }

    return {
        avgTemp: sumTemp / active.length,
        avgRpm:  sumRpm  / active.length,
        avgAmp:  sumAmp  / active.length,
        maxTemp,
        maxRpm,
        count: active.length
    };
}

// ================================================================
// FUNGSI UTAMA: estimasiUmurKomponen
// ================================================================
/**
 * Estimasi sisa umur komponen berdasarkan total jam operasi dan tren data.
 *
 * @param {Object[]} rows          - Array data historis dari GeneratorData
 * @param {number}   totalOpHours  - Total jam operasi akumulatif dari ActiveTimeHistory
 * @param {Object}   lastMaintenance - Map { namaKomponen: lastServiceHours } (opsional)
 * @returns {Object}               - Hasil estimasi semua komponen
 */
function estimateComponentLife(rows, totalOpHours, lastMaintenance = {}) {
    const stats = computeSensorStats(rows);
    const opHours = safeNum(totalOpHours, 0);

    // Estimasi max amp dari data untuk referensi beban
    const maxAmpRef = Math.max(
        20,
        ...rows.map(r => safeNum(r.amp ?? r.currentA, 0))
    );

    const components = {};

    for (const [name, spec] of Object.entries(COMPONENT_SPECS)) {
        const lastService = safeNum(lastMaintenance[name], 0);
        const hoursSinceService = opHours - lastService;

        // Hitung faktor degradasi dari kondisi aktual
        const degradFactor = stats.count > 0
            ? computeDegradationFactor(spec, stats.avgTemp, stats.avgRpm, stats.avgAmp, maxAmpRef)
            : 1.0;

        // Jam efektif yang telah dipakai (dengan akselerasi degradasi)
        const effectiveHoursUsed = hoursSinceService * degradFactor;

        // Sisa umur berdasarkan interval desain
        const remainingHours = Math.max(0, spec.intervalHours - effectiveHoursUsed);
        const percentUsed    = clamp(effectiveHoursUsed / spec.intervalHours);

        // Tentukan urgency
        let urgency;
        if (remainingHours <= 0)                         urgency = 'overdue';
        else if (remainingHours <= spec.intervalHours * 0.1) urgency = 'due-now';   // < 10% sisa
        else if (remainingHours <= spec.intervalHours * 0.20) urgency = 'due-soon'; // < 20% sisa
        else                                              urgency = 'ok';

        // Estimasi tanggal jatuh tempo berdasarkan rata-rata pemakaian per hari
        // Asumsikan data yang tersedia mencerminkan pola pemakaian harian
        let estimatedDueDate = null;
        if (rows.length >= 2 && remainingHours > 0) {
            const spans = rows.map(r => new Date(r.timestamp).getTime()).filter(t => Number.isFinite(t));
            if (spans.length >= 2) {
                const totalSpanMs = Math.max(...spans) - Math.min(...spans);
                const totalSpanHours = totalSpanMs / 3600000;
                if (totalSpanHours > 0) {
                    const activeCount = rows.filter(r => safeNum(r.rpm) > 100).length;
                    // Interval sampling ~2 detik (asumsi MQTT 2s)
                    const activeHoursInSpan = (activeCount * 2) / 3600;
                    const dailyUsageHours = totalSpanHours > 0
                        ? (activeHoursInSpan / totalSpanHours) * 24
                        : 0;

                    if (dailyUsageHours > 0.01) {
                        const daysUntilDue = remainingHours / dailyUsageHours;
                        estimatedDueDate = new Date(Date.now() + daysUntilDue * 86400000);
                    }
                }
            }
        }

        components[name] = {
            name,
            icon:                spec.icon,
            task:                spec.task,
            intervalHours:       spec.intervalHours,
            hoursSinceService:   Math.round(hoursSinceService),
            effectiveHoursUsed:  Math.round(effectiveHoursUsed),
            remainingHours:      Math.round(remainingHours),
            percentUsed:         Math.round(percentUsed * 100),
            degradationFactor:   parseFloat(degradFactor.toFixed(2)),
            urgency,
            estimatedDueDate:    estimatedDueDate ? estimatedDueDate.toISOString() : null,
            lastServiceHours:    lastService,
            // Konteks kondisi mesin saat analisis
            conditionContext: {
                avgTemp:  parseFloat(stats.avgTemp.toFixed(1)),
                avgRpm:   Math.round(stats.avgRpm),
                avgAmp:   parseFloat(stats.avgAmp.toFixed(1)),
                maxTemp:  parseFloat(stats.maxTemp.toFixed(1))
            }
        };
    }

    // Buat daftar notifikasi dini (komponen yang perlu perhatian)
    const earlyWarnings = Object.values(components)
        .filter(c => c.urgency !== 'ok')
        .sort((a, b) => {
            const order = { overdue: 0, 'due-now': 1, 'due-soon': 2 };
            return (order[a.urgency] ?? 3) - (order[b.urgency] ?? 3);
        });

    return {
        components,
        earlyWarnings,
        totalOperatingHours: opHours,
        analyzedAt: new Date().toISOString(),
        dataPoints: rows.length,
        activeDataPoints: stats.count,
        sensorStats: {
            avgTemp: parseFloat(stats.avgTemp.toFixed(1)),
            avgRpm:  Math.round(stats.avgRpm),
            avgAmp:  parseFloat(stats.avgAmp.toFixed(1)),
            maxTemp: parseFloat(stats.maxTemp.toFixed(1)),
            maxRpm:  Math.round(stats.maxRpm)
        }
    };
}

module.exports = {
    estimateComponentLife,
    COMPONENT_SPECS
};
