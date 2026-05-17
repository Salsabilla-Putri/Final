/*
 * Realtime performance logger for GENSYS generator monitoring.
 *
 * Purpose:
 * - Measure server receive latency from ESP32 MQTT payload to backend.
 * - Measure MongoDB database write time.
 * - Provide timing fields for frontend delivery measurement.
 * - Keep recent metrics in memory so they can be inspected from an API endpoint.
 *
 * Recommended ESP32 payload fields for valid server receive latency:
 *   espSendEpochMs: current epoch time in milliseconds from NTP
 * or
 *   timestampEpochMs: current epoch time in milliseconds from NTP
 *
 * If ESP32 only sends millis(), server receive latency cannot be compared directly
 * against Date.now() because ESP32 millis() and server epoch time use different bases.
 */

const MAX_PERFORMANCE_LOGS = Number(process.env.PERFORMANCE_LOG_LIMIT || 300);
const realtimePerformanceLogs = [];

function nowHr() {
    return process.hrtime.bigint();
}

function diffMs(startHr, endHr = process.hrtime.bigint()) {
    if (!startHr) return null;
    return Number(endHr - startHr) / 1e6;
}

function toFiniteNumber(value, fallback = null) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function readEspSendEpochMs(payload = {}) {
    const directEpoch = toFiniteNumber(
        payload.espSendEpochMs ??
        payload.timestampEpochMs ??
        payload.sentAtEpochMs ??
        payload.epochMs,
        null
    );
    if (directEpoch && directEpoch > 1_000_000_000_000) return directEpoch;

    const isoTimestamp = payload.espSendAt || payload.sentAt || payload.timestamp;
    if (isoTimestamp) {
        const parsed = new Date(isoTimestamp).getTime();
        if (Number.isFinite(parsed) && parsed > 1_000_000_000_000) return parsed;
    }

    return null;
}

function calculateServerReceiveLatencyMs(payload = {}, serverReceiveMs = Date.now()) {
    const espSendEpochMs = readEspSendEpochMs(payload);
    if (!espSendEpochMs) return null;
    return serverReceiveMs - espSendEpochMs;
}

async function measureDatabaseWrite(writeOperation) {
    const dbWriteStartHr = nowHr();
    const result = await writeOperation();
    const dbWriteTimeMs = diffMs(dbWriteStartHr);
    return { result, dbWriteTimeMs };
}

function buildPerformanceSnapshot({
    topic,
    payload,
    serverReceiveMs,
    dbWriteTimeMs = null,
    serverProcessingTimeMs = null,
    savedDocumentId = null,
    frontendEmitMs = null,
    frontendDeliveryTimeMs = null,
    source = 'mqtt'
}) {
    const serverReceiveLatencyMs = calculateServerReceiveLatencyMs(payload, serverReceiveMs);
    const espSendEpochMs = readEspSendEpochMs(payload);

    return {
        timestamp: new Date().toISOString(),
        source,
        topic,
        deviceId: payload?.deviceId || null,
        rpm: toFiniteNumber(payload?.rpm, null),
        volt: toFiniteNumber(payload?.volt, null),
        freq: toFiniteNumber(payload?.freq, null),
        serverReceiveAt: new Date(serverReceiveMs).toISOString(),
        serverReceiveMs,
        espSendEpochMs,
        serverReceiveLatencyMs,
        dbWriteTimeMs,
        serverProcessingTimeMs,
        frontendEmitMs,
        frontendDeliveryTimeMs,
        savedDocumentId,
        note: espSendEpochMs ? null : 'ESP32 belum mengirim epoch timestamp. Tambahkan espSendEpochMs agar server receive latency valid.'
    };
}

function pushPerformanceLog(snapshot) {
    realtimePerformanceLogs.push(snapshot);
    while (realtimePerformanceLogs.length > MAX_PERFORMANCE_LOGS) realtimePerformanceLogs.shift();
    return snapshot;
}

function printPerformanceLog(snapshot) {
    const fmt = (value, digits = 2) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)} ms` : 'N/A';
    console.log('════════ REALTIME SERVER PERFORMANCE ════════');
    console.log('Topic                       :', snapshot.topic || '-');
    console.log('Device ID                   :', snapshot.deviceId || '-');
    console.log('RPM / Volt / Freq           :', `${snapshot.rpm ?? '-'} rpm | ${snapshot.volt ?? '-'} V | ${snapshot.freq ?? '-'} Hz`);
    console.log('Server receive latency      :', fmt(snapshot.serverReceiveLatencyMs));
    console.log('Database write time         :', fmt(snapshot.dbWriteTimeMs));
    console.log('Server processing time      :', fmt(snapshot.serverProcessingTimeMs));
    console.log('Frontend emit timestamp     :', snapshot.frontendEmitMs || 'N/A');
    console.log('Saved document ID           :', snapshot.savedDocumentId || 'N/A');
    if (snapshot.note) console.log('Note                        :', snapshot.note);
    console.log('═════════════════════════════════════════════');
}

function createFrontendPerformancePayload(data, performanceSnapshot = {}) {
    const frontendEmitMs = Date.now();
    return {
        ...data,
        performance: {
            ...(data?.performance || {}),
            ...performanceSnapshot,
            frontendEmitMs,
            serverToFrontendHint: 'Hitung di browser: Date.now() - data.performance.frontendEmitMs'
        }
    };
}

function getRecentPerformanceLogs(limit = 50) {
    const n = Math.max(1, Math.min(Number(limit) || 50, MAX_PERFORMANCE_LOGS));
    return realtimePerformanceLogs.slice(-n).reverse();
}

function getPerformanceSummary() {
    const rows = realtimePerformanceLogs;
    const avg = (key) => {
        const vals = rows.map((r) => Number(r[key])).filter(Number.isFinite);
        if (!vals.length) return null;
        return +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
    };

    return {
        count: rows.length,
        latest: rows[rows.length - 1] || null,
        average: {
            serverReceiveLatencyMs: avg('serverReceiveLatencyMs'),
            dbWriteTimeMs: avg('dbWriteTimeMs'),
            serverProcessingTimeMs: avg('serverProcessingTimeMs'),
            frontendDeliveryTimeMs: avg('frontendDeliveryTimeMs')
        }
    };
}

module.exports = {
    nowHr,
    diffMs,
    readEspSendEpochMs,
    calculateServerReceiveLatencyMs,
    measureDatabaseWrite,
    buildPerformanceSnapshot,
    pushPerformanceLog,
    printPerformanceLog,
    createFrontendPerformancePayload,
    getRecentPerformanceLogs,
    getPerformanceSummary
};
