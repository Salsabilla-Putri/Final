/**
 * lib_cbm_analysis.js
 * ============================================================
 * Condition-Based Maintenance (CBM) Analysis Engine
 *
 * Menganalisis data histori sensor untuk mendeteksi degradasi
 * komponen dan memberikan rekomendasi maintenance berbasis
 * kondisi aktual — bukan jadwal tetap.
 *
 * Algoritma yang digunakan:
 *  1. Linear Regression (deteksi tren degradasi)
 *  2. Coefficient of Variation (stabilitas sinyal)
 *  3. FFT Peak Mapping (anomali frekuensi → komponen mekanik)
 *  4. Threshold Proximity Score (seberapa dekat ke batas kritis)
 *  5. Operating Hours Schedule (preventive berbasis jam operasi)
 * ============================================================
 */

'use strict';

// ─── MATH HELPERS ─────────────────────────────────────────────────────────────

/**
 * Linear regression sederhana.
 * @returns {{ slope, intercept, r2 }}  slope dalam satuan unit/ms
 */
function linearRegression(xArr, yArr) {
    const n = xArr.length;
    if (n < 2) return { slope: 0, intercept: yArr[0] ?? 0, r2: 0 };

    const xMean = xArr.reduce((a, b) => a + b, 0) / n;
    const yMean = yArr.reduce((a, b) => a + b, 0) / n;

    let ssxy = 0, ssxx = 0, ssyy = 0;
    for (let i = 0; i < n; i++) {
        const dx = xArr[i] - xMean;
        const dy = yArr[i] - yMean;
        ssxy += dx * dy;
        ssxx += dx * dx;
        ssyy += dy * dy;
    }

    const slope     = ssxx === 0 ? 0 : ssxy / ssxx;
    const intercept = yMean - slope * xMean;
    const r2        = ssyy === 0 ? 0 : (ssxy * ssxy) / (ssxx * ssyy);
    return { slope, intercept, r2: Math.max(0, Math.min(1, r2)) };
}

/** Hitung statistik deskriptif dari array angka */
function statistics(values) {
    if (!values.length) return { mean: 0, std: 0, min: 0, max: 0, p5: 0, p95: 0 };

    const sorted = [...values].sort((a, b) => a - b);
    const n    = sorted.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
    const std  = Math.sqrt(variance);
    const p5   = sorted[Math.max(0, Math.floor(n * 0.05))];
    const p95  = sorted[Math.min(n - 1, Math.floor(n * 0.95))];

    return { mean, std, min: sorted[0], max: sorted[n - 1], p5, p95, count: n };
}

/** Extract series {t, v} dari array row dokumen sensor */
function extractSeries(rows, sensorKey, minValue = -Infinity) {
    const result = [];
    for (const row of rows) {
        const t = new Date(row.timestamp ?? row.createdAt).getTime();
        const v = Number(row[sensorKey] ?? row[sensorKey.toLowerCase()]);
        if (Number.isFinite(t) && Number.isFinite(v) && v > minValue) {
            result.push({ t, v });
        }
    }
    return result.sort((a, b) => a.t - b.t);
}

/** Thinning: ambil maksimal maxPts poin terdistribusi merata */
function thinSeries(series, maxPts = 500) {
    if (series.length <= maxPts) return series;
    const step = Math.ceil(series.length / maxPts);
    return series.filter((_, i) => i % step === 0);
}

// ─── TREND ANALYSIS ────────────────────────────────────────────────────────────

/**
 * Analisis tren satu sensor.
 * @returns {{ slopePerHour, r2, mean, std, latest, thresholdProximity, cv }}
 */
function analyzeTrend(series, thresholds = {}) {
    if (series.length < 3) {
        return { slopePerHour: 0, r2: 0, mean: 0, std: 0, latest: 0,
                 thresholdProximity: 1, cv: 0, insufficient: true };
    }

    const thin   = thinSeries(series, 400);
    const xArr   = thin.map(p => p.t);
    const yArr   = thin.map(p => p.v);
    const { slope, r2 } = linearRegression(xArr, yArr);
    const stats  = statistics(yArr);
    const slopePerHour = slope * 3_600_000; // ms → hour
    const latest = series[series.length - 1].v;

    // Proximity: 1.0 = jauh dari threshold, 0.0 = di batas kritis
    let prox = 1.0;
    if (thresholds.max !== undefined) {
        const gap = (thresholds.max - latest) / (thresholds.max * 0.15 || 1);
        prox = Math.min(prox, gap);
    }
    if (thresholds.min !== undefined && thresholds.min > 0) {
        const gap = (latest - thresholds.min) / (thresholds.min * 0.15 || 1);
        prox = Math.min(prox, gap);
    }

    const cv = stats.mean !== 0 ? (stats.std / Math.abs(stats.mean)) * 100 : 0;

    return {
        slopePerHour,
        r2,
        mean:    stats.mean,
        std:     stats.std,
        min:     stats.min,
        max:     stats.max,
        p5:      stats.p5,
        p95:     stats.p95,
        count:   stats.count,
        latest,
        thresholdProximity: Math.max(0, Math.min(1, prox)),
        cv
    };
}

// ─── FFT PEAK MAPPER ───────────────────────────────────────────────────────────

/**
 * Peta frekuensi FFT ke komponen mekanik.
 * Periksa apakah peaks mencurigakan ada di RPM spectrum.
 */
function mapFftPeaksToComponents(peaks = [], rpmMean = 0) {
    const findings = [];
    if (!peaks.length || !rpmMean) return findings;

    const rpmHz = rpmMean / 60; // konversi RPM ke Hz (frekuensi putar)

    for (const peak of peaks) {
        const ratio = rpmHz > 0 ? peak.freq / rpmHz : 0;

        // Misfire: sinyal pada 0.5× frekuensi putar (firing interval tidak merata)
        if (ratio > 0.4 && ratio < 0.6 && peak.amp > 0.01) {
            findings.push({
                freq: peak.freq, ratio: ratio.toFixed(2),
                component: 'Sistem Pembakaran',
                hint: 'Kemungkinan misfire atau timing tidak merata (0.5× RPM freq).',
                severity: 'warn'
            });
        }
        // Imbalance: sinyal pada 1× frekuensi putar
        else if (ratio > 0.85 && ratio < 1.15 && peak.amp > 0.05) {
            findings.push({
                freq: peak.freq, ratio: ratio.toFixed(2),
                component: 'Rotor / Crankshaft Balance',
                hint: 'Kemungkinan unbalance pada rotor atau crankshaft (1× RPM freq).',
                severity: 'warn'
            });
        }
        // Bearing: sinyal pada 2× atau lebih
        else if (ratio > 1.8 && ratio < 2.2 && peak.amp > 0.03) {
            findings.push({
                freq: peak.freq, ratio: ratio.toFixed(2),
                component: 'Bearing / Piston',
                hint: 'Kemungkinan keausan bearing atau pin piston (2× RPM freq).',
                severity: 'watch'
            });
        }
    }

    return findings;
}

// ─── CBM RULE ENGINE ──────────────────────────────────────────────────────────

/**
 * Rule definitions.
 * Setiap rule: { id, component, sensor, minSamples, check(trend, stats) → null | {level, confidence},
 *                action(level, trend, stats) → { action, details, priority, type } }
 */
const CBM_RULES = [

    // ── COOLING SYSTEM ───────────────────────────────────────────────────────
    {
        id: 'cooling_temp_rising',
        component: 'Sistem Pendingin',
        sensor: 'coolant',
        minSamples: 10,
        check(trend) {
            if (trend.slopePerHour > 0.5  && trend.r2 > 0.55) return { level: 'critical', confidence: trend.r2 };
            if (trend.slopePerHour > 0.15 && trend.r2 > 0.40) return { level: 'warn',     confidence: trend.r2 };
            if (trend.latest > 88 || trend.thresholdProximity < 0.25)
                return { level: 'watch', confidence: 0.85 };
            return null;
        },
        action(level, trend) {
            const rateText = trend.slopePerHour > 0
                ? `(naik ${trend.slopePerHour.toFixed(2)}°C/jam)`
                : '';
            return {
                action: level === 'critical'
                    ? 'Hentikan mesin & periksa sistem pendingin segera'
                    : 'Jadwalkan inspeksi sistem pendingin',
                details: `Suhu coolant tren meningkat ${rateText}. Periksa level coolant, radiator, thermostat, dan water pump.`,
                priority: level === 'critical' ? 'high' : 'medium',
                type: level === 'critical' ? 'Corrective' : 'Preventive'
            };
        }
    },

    // ── FUEL SYSTEM ──────────────────────────────────────────────────────────
    {
        id: 'fuel_consumption_anomaly',
        component: 'Sistem Bahan Bakar',
        sensor: 'fuel',
        minSamples: 5,
        check(trend) {
            // Fuel seharusnya menurun; penurunan cepat = konsumsi tinggi / kebocoran
            if (trend.slopePerHour < -5 && trend.r2 > 0.5) return { level: 'critical', confidence: trend.r2 };
            if (trend.slopePerHour < -2 && trend.r2 > 0.4) return { level: 'warn',     confidence: trend.r2 };
            if (trend.latest < 15)                          return { level: 'critical', confidence: 0.95 };
            if (trend.latest < 25)                          return { level: 'watch',    confidence: 0.9  };
            return null;
        },
        action(level, trend) {
            return {
                action: level === 'critical'
                    ? 'Periksa kebocoran & hentikan operasi jika level < 15%'
                    : 'Jadwalkan pengisian & pantau konsumsi',
                details: trend.slopePerHour < -2
                    ? `Konsumsi bahan bakar abnormal (${Math.abs(trend.slopePerHour).toFixed(1)}%/jam). Cek injektor dan saluran bahan bakar.`
                    : `Level bahan bakar rendah (${trend.latest?.toFixed(0)}%). Segera isi.`,
                priority: level === 'critical' ? 'high' : 'low',
                type: 'Preventive'
            };
        }
    },

    // ── VOLTAGE STABILITY (AVR / Electrical) ─────────────────────────────────
    {
        id: 'voltage_instability',
        component: 'AVR & Sistem Kelistrikan',
        sensor: 'volt',
        minSamples: 10,
        check(trend, stats) {
            if (stats.std > 15)  return { level: 'critical', confidence: 0.92 };
            if (stats.std > 8)   return { level: 'warn',     confidence: 0.85 };
            if (stats.cv  > 6)   return { level: 'watch',    confidence: 0.78 };
            if (trend.thresholdProximity < 0.2)
                return { level: 'warn', confidence: 0.88 };
            return null;
        },
        action(level, _, stats) {
            return {
                action: 'Periksa AVR dan distribusi beban',
                details: level === 'critical'
                    ? `Fluktuasi tegangan sangat tinggi (σ=${stats.std?.toFixed(1)}V). AVR kemungkinan rusak atau beban sangat tidak merata.`
                    : `Tegangan tidak stabil (σ=${stats.std?.toFixed(1)}V, CV=${stats.cv?.toFixed(1)}%). Lakukan kalibrasi AVR.`,
                priority: level === 'critical' ? 'high' : 'medium',
                type: 'Corrective'
            };
        }
    },

    // ── RPM GOVERNOR / CARBURETOR ─────────────────────────────────────────────
    {
        id: 'rpm_governor_issue',
        component: 'Gubernur / Karburator',
        sensor: 'rpm',
        minSamples: 15,
        check(trend, stats) {
            const cv = stats.cv || 0;
            if (cv > 12) return { level: 'critical', confidence: 0.88 };
            if (cv > 6)  return { level: 'warn',     confidence: 0.82 };
            // RPM drift (tren naik/turun padahal seharusnya stabil)
            if (Math.abs(trend.slopePerHour) > 50 && trend.r2 > 0.5)
                return { level: 'watch', confidence: trend.r2 };
            return null;
        },
        action(level, trend, stats) {
            const cv = stats.cv?.toFixed(1) ?? '?';
            return {
                action: 'Servis gubernur & filter udara',
                details: level === 'critical'
                    ? `RPM sangat tidak stabil (CV=${cv}%). Gubernur kemungkinan aus/kotor. Cek juga karburator dan filter udara.`
                    : `RPM berfluktuasi (CV=${cv}%). Bersihkan karburator dan periksa penyetelan gubernur.`,
                priority: level === 'critical' ? 'high' : 'medium',
                type: 'Preventive'
            };
        }
    },

    // ── FREQUENCY STABILITY ───────────────────────────────────────────────────
    {
        id: 'frequency_instability',
        component: 'Frekuensi Output',
        sensor: 'freq',
        minSamples: 10,
        check(trend, stats) {
            // Ideal 50 Hz ±0.5 Hz; std > 1 Hz = masalah
            if (stats.std > 2.0) return { level: 'critical', confidence: 0.9 };
            if (stats.std > 1.0) return { level: 'warn',     confidence: 0.85 };
            if (Math.abs(stats.mean - 50) > 1.5)
                return { level: 'watch', confidence: 0.8 };
            return null;
        },
        action(level, _, stats) {
            return {
                action: 'Kalibrasi frekuensi & periksa governor',
                details: `Frekuensi output tidak stabil (rata-rata ${stats.mean?.toFixed(2)} Hz, σ=${stats.std?.toFixed(2)} Hz). Setel ulang putaran idle mesin dan governor.`,
                priority: level === 'critical' ? 'high' : 'medium',
                type: level === 'critical' ? 'Corrective' : 'Preventive'
            };
        }
    },

    // ── BATTERY ──────────────────────────────────────────────────────────────
    {
        id: 'battery_degradation',
        component: 'Baterai',
        sensor: 'batt',
        minSamples: 5,
        check(trend) {
            if (trend.latest < 11.8)                        return { level: 'critical', confidence: 0.95 };
            if (trend.latest < 12.2)                        return { level: 'warn',     confidence: 0.88 };
            if (trend.slopePerHour < -0.04 && trend.r2 > 0.45) return { level: 'watch', confidence: trend.r2 };
            return null;
        },
        action(level, trend) {
            return {
                action: level === 'critical' ? 'Ganti baterai' : 'Periksa & charge baterai',
                details: level === 'critical'
                    ? `Tegangan baterai kritis (${trend.latest?.toFixed(2)}V). Baterai tidak mampu menstarting mesin. Ganti segera.`
                    : `Tegangan baterai menurun (${trend.latest?.toFixed(2)}V, tren ${(trend.slopePerHour * 24).toFixed(3)}V/hari). Cek kondisi dan charger.`,
                priority: level === 'critical' ? 'high' : 'low',
                type: 'Preventive'
            };
        }
    },

    // ── AFR (Engine Efficiency) ───────────────────────────────────────────────
    {
        id: 'afr_abnormal',
        component: 'Sistem Injeksi / Karburator',
        sensor: 'afr',
        minSamples: 8,
        check(trend, stats) {
            // Ideal stoichiometric: petrol ~14.7, diesel ~14.5–18
            if (stats.mean > 0 && (stats.mean < 12.5 || stats.mean > 19))
                return { level: 'warn', confidence: 0.82 };
            if (stats.std > 2.5)
                return { level: 'watch', confidence: 0.75 };
            return null;
        },
        action(level, _, stats) {
            const isRich = stats.mean < 14;
            return {
                action: isRich
                    ? 'Periksa filter udara & sistem injeksi (campuran kaya)'
                    : 'Periksa injektor & pompa bahan bakar (campuran miskin)',
                details: `AFR rata-rata ${stats.mean?.toFixed(1)} (ideal ~14.7). ${isRich ? 'Campuran terlalu kaya' : 'Campuran terlalu miskin'} — cek filter udara, injektor, dan sensor MAP.`,
                priority: 'medium',
                type: 'Preventive'
            };
        }
    }
];

// ─── PREVENTIVE SCHEDULE (BERBASIS JAM OPERASI) ────────────────────────────────

/** Jadwal perawatan berkala berdasarkan interval jam operasi */
const PREVENTIVE_INTERVALS = [
    { hours: 50,   component: 'Pelumasan',              task: 'Ganti oli mesin & filter oli' },
    { hours: 100,  component: 'Sistem Udara',            task: 'Bersihkan / ganti filter udara' },
    { hours: 150,  component: 'Sistem Pendingin',        task: 'Periksa level & kondisi coolant' },
    { hours: 200,  component: 'Pengapian / Injeksi',     task: 'Cek busi (bensin) / nozzle injektor (diesel)' },
    { hours: 250,  component: 'Sistem Pendingin',        task: 'Flush & ganti coolant' },
    { hours: 300,  component: 'Pelumasan',               task: 'Ganti oli & filter (second cycle)' },
    { hours: 500,  component: 'Sistem Bahan Bakar',      task: 'Ganti filter bahan bakar' },
    { hours: 500,  component: 'Mesin',                   task: 'Cek & kalibrasi valve clearance' },
    { hours: 500,  component: 'Kelistrikan',             task: 'Periksa & kencangkan semua konektor listrik' },
    { hours: 1000, component: 'Mesin',                   task: 'Overhaul minor: ring piston, gasket head, bearing' },
    { hours: 2000, component: 'Mesin',                   task: 'Overhaul mayor: rebore silinder, crankshaft grinding' }
];

function generatePreventiveSchedule(totalHours) {
    const schedule = [];

    for (const interval of PREVENTIVE_INTERVALS) {
        const lastAt        = Math.floor(totalHours / interval.hours) * interval.hours;
        const nextAt        = lastAt + interval.hours;
        const hoursRemaining = parseFloat((nextAt - totalHours).toFixed(1));
        const pctDue        = 1 - (hoursRemaining / interval.hours);

        // Hanya tampilkan jika dalam 20% dari interval berikutnya atau sudah overdue
        if (pctDue < 0.8) continue;

        let urgency = 'scheduled';
        if (hoursRemaining <= 0)                              urgency = 'overdue';
        else if (hoursRemaining <= interval.hours * 0.05)    urgency = 'due-now';
        else if (hoursRemaining <= interval.hours * 0.15)    urgency = 'due-soon';

        schedule.push({
            component:      interval.component,
            task:           interval.task,
            intervalHours:  interval.hours,
            lastAt,
            nextAt,
            hoursRemaining,
            urgency,
            percentDue:     parseFloat((pctDue * 100).toFixed(1))
        });
    }

    return schedule.sort((a, b) => a.hoursRemaining - b.hoursRemaining);
}

// ─── HEALTH SCORE ──────────────────────────────────────────────────────────────

const LEVEL_PENALTY  = { critical: 25, warn: 12, watch: 5 };
const LEVEL_ORDER    = { ok: 0, watch: 1, warn: 2, critical: 3 };

function computeHealthScore(findings, preventiveOverdue) {
    let score = 100;
    for (const f of findings) {
        score -= (LEVEL_PENALTY[f.level] ?? 0);
    }
    score -= (preventiveOverdue * 5); // setiap task overdue kurangi 5 poin
    return Math.max(0, Math.min(100, Math.round(score)));
}

// ─── MAIN ENTRY POINT ─────────────────────────────────────────────────────────

/**
 * Fungsi utama — jalankan seluruh CBM analysis.
 *
 * @param {Object[]} historicalRows   - Array dokumen sensor dari MongoDB
 * @param {Object}   thresholds       - ACTIVE_THRESHOLDS dari server
 * @param {number}   totalOpHours     - Total jam operasi mesin
 * @param {Object[]} fftPeaks         - Array peak dari FFT analysis (opsional)
 * @param {number}   rpmMean          - Rata-rata RPM untuk FFT mapping (opsional)
 * @returns {Object} CBM result payload
 */
function analyzeCBM(historicalRows, thresholds = {}, totalOpHours = 0, fftPeaks = [], rpmMean = 0) {
    const findings       = [];
    const componentHealth = {};

    // ── 1. SENSOR RULE ENGINE ───────────────────────────────────────────────
    for (const rule of CBM_RULES) {
        const series = extractSeries(historicalRows, rule.sensor, rule.sensor === 'rpm' ? 0 : -Infinity);
        if (series.length < (rule.minSamples ?? 5)) continue;

        const yArr  = series.map(p => p.v);
        const stats = statistics(yArr);
        const trend = analyzeTrend(series, thresholds[rule.sensor] ?? {});

        // Inject stats.cv into trend (karena analyzeTrend tidak punya akses stats)
        trend.cv    = stats.cv ?? trend.cv;
        trend.std   = stats.std;
        trend.mean  = stats.mean;
        trend.min   = stats.min;
        trend.max   = stats.max;

        const flagged = rule.check(trend, stats);

        // Update componentHealth (ambil level terburuk)
        const prevLevel  = componentHealth[rule.component] ?? 'ok';
        const nextLevel  = flagged?.level ?? 'ok';
        if ((LEVEL_ORDER[nextLevel] ?? 0) > (LEVEL_ORDER[prevLevel] ?? 0)) {
            componentHealth[rule.component] = nextLevel;
        }

        if (!flagged) continue;

        const actionData = rule.action(flagged.level, trend, stats);
        findings.push({
            ruleId:     rule.id,
            component:  rule.component,
            sensor:     rule.sensor,
            level:      flagged.level,
            confidence: Math.round(flagged.confidence * 100),
            trend: {
                slopePerHour:  parseFloat((trend.slopePerHour ?? 0).toFixed(4)),
                r2:            parseFloat((trend.r2 ?? 0).toFixed(3)),
                mean:          parseFloat((trend.mean ?? 0).toFixed(2)),
                std:           parseFloat((trend.std ?? 0).toFixed(2)),
                cv:            parseFloat((trend.cv  ?? 0).toFixed(1)),
                latest:        parseFloat((trend.latest ?? 0).toFixed(2)),
                min:           parseFloat((trend.min ?? 0).toFixed(2)),
                max:           parseFloat((trend.max ?? 0).toFixed(2))
            },
            ...actionData
        });
    }

    // ── 2. FFT COMPONENT MAPPING ────────────────────────────────────────────
    const fftFindings = mapFftPeaksToComponents(fftPeaks, rpmMean);
    for (const ff of fftFindings) {
        findings.push({
            ruleId:     `fft_${ff.component.replace(/\s/g, '_').toLowerCase()}`,
            component:  ff.component,
            sensor:     'rpm_fft',
            level:      ff.severity,
            confidence: 70,
            trend:      { slopePerHour: 0, r2: 0, mean: rpmMean, std: 0, cv: 0, latest: rpmMean, min: rpmMean, max: rpmMean },
            action:     `Investigasi getaran pada frekuensi ${ff.freq?.toFixed(3)} Hz`,
            details:    ff.hint,
            priority:   'medium',
            type:       'Corrective'
        });
    }

    // ── 3. PREVENTIVE SCHEDULE ──────────────────────────────────────────────
    const preventiveSchedule = generatePreventiveSchedule(totalOpHours);
    const overdueCount = preventiveSchedule.filter(s => s.urgency === 'overdue').length;

    // ── 4. HEALTH SCORE ─────────────────────────────────────────────────────
    const healthScore   = computeHealthScore(findings, overdueCount);
    const overallStatus = healthScore >= 80 ? 'AMAN' : healthScore >= 55 ? 'WASPADA' : 'BAHAYA';

    // Sort findings: critical → warn → watch
    findings.sort((a, b) => (LEVEL_ORDER[b.level] ?? 0) - (LEVEL_ORDER[a.level] ?? 0));

    // ── 5. SUMMARY TEXT ─────────────────────────────────────────────────────
    const criticals = findings.filter(f => f.level === 'critical');
    const warns     = findings.filter(f => f.level === 'warn');
    let summary;
    if (!findings.length && !overdueCount) {
        summary = `Semua sistem dalam kondisi baik (skor ${healthScore}/100). Operasi normal.`;
    } else {
        const parts = [];
        if (criticals.length) parts.push(`${criticals.length} masalah KRITIS (${[...new Set(criticals.map(f => f.component))].join(', ')})`);
        if (warns.length)     parts.push(`${warns.length} peringatan (${[...new Set(warns.map(f => f.component))].join(', ')})`);
        if (overdueCount)     parts.push(`${overdueCount} jadwal perawatan overdue`);
        summary = `Skor ${healthScore}/100 — ${parts.join('; ')}.`;
    }

    return {
        analyzedAt:        new Date().toISOString(),
        dataPoints:        historicalRows.length,
        totalOperatingHours: parseFloat(totalOpHours.toFixed(1)),
        healthScore,
        overallStatus,
        findings,
        componentHealth,
        preventiveSchedule,
        summary
    };
}

module.exports = { analyzeCBM, generatePreventiveSchedule, linearRegression, statistics };