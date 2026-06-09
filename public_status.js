'use strict';

const POWER_SOURCE_MAP = {
    OFF: 'ECU Disconnected',
    GRID: 'Using PLN',
    GENSET: 'Using Generator',
    SYNC: 'Grid and Generator Synchronized'
};

const SYNC_MAP = {
    OFF: POWER_SOURCE_MAP.OFF,
    'OFF-GRID': POWER_SOURCE_MAP.GENSET,
    'ON-GRID': POWER_SOURCE_MAP.SYNC,
    GENSET: POWER_SOURCE_MAP.GENSET,
    GRID: POWER_SOURCE_MAP.GRID,
    SYNC: POWER_SOURCE_MAP.SYNC,
    HYBRID: POWER_SOURCE_MAP.SYNC
};

const STATUS_MAP = {
    RUNNING: 'Generator Running',
    OFF: 'Generator Off'
};

const COST_PER_KWH = 13150;

function normalizePowerSource(latestDoc = {}) {
    const rawSource = String(latestDoc?.powerSource || latestDoc?.power_source || '').trim().toUpperCase().replace(/[\s_-]+/g, '-');
    if (POWER_SOURCE_MAP[rawSource]) return POWER_SOURCE_MAP[rawSource];

    const syncKey = String(latestDoc?.sync || '').toUpperCase();
    return SYNC_MAP[syncKey] || 'Power Source Unknown';
}

function getPowerSourceLabel(latestDoc = {}) {
    const rawSource = String(latestDoc?.powerSource || latestDoc?.power_source || '').trim().toUpperCase().replace(/[\s_-]+/g, '-');
    if (['OFF', 'ECU-OFF', 'ECU-DISCONNECTED', 'DISCONNECTED', 'OFFLINE'].includes(rawSource) || latestDoc?.ecuConnected === false) return 'OFF';
    if (['GRID', 'PLN', 'UTILITY', 'MAINS'].includes(rawSource)) return 'GRID';
    if (['GENSET', 'GENERATOR', 'GEN', 'OFF-GRID', 'OFFGRID'].includes(rawSource)) return 'GENSET';
    if (['SYNC', 'SYNCHRONIZED', 'SINKRON', 'SINKRONISASI', 'ON-GRID', 'ONGRID'].includes(rawSource)) return 'SYNC';
    const sync = String(latestDoc?.sync || '').toUpperCase().replace(/[\s_-]+/g, '-');
    if (sync === 'OFF') return 'OFF';
    if (sync === 'GRID') return 'GRID';
    if (sync === 'SYNC' || sync === 'ON-GRID' || sync === 'ONGRID') return 'SYNC';
    return 'GENSET';
}

function normalizeStatus(statusValue) {
    const key = String(statusValue || '').toUpperCase();
    return STATUS_MAP[key] || 'Generator Status Unknown';
}

function getFuelStatus(fuelValue) {
    const fuel = Number(fuelValue || 0);
    if (fuel > 70) return 'Full';
    if (fuel >= 30) return 'Enough';
    return 'Low';
}

function getEngineActivity(rpmValue) {
    const rpm = Number(rpmValue || 0);
    return rpm > 0 ? 'Engine Active' : 'Engine Idle';
}

function getDailyUsage(powerValue) {
    const power = Number(powerValue || 0);
    return Number.isFinite(power) ? +power.toFixed(2) : 0;
}

function getEstimatedCost(dailyUsage) {
    const usage = Number(dailyUsage || 0);
    if (!Number.isFinite(usage) || usage <= 0) return 0;

    const rawCost = usage * COST_PER_KWH;
    return Math.max(0, Math.round(rawCost / 1000) * 1000);
}

function generateAlerts(latestDoc, previousDoc) {
    const alerts = [];
    const fuel = Number(latestDoc?.fuel || 0);
    const temp = Number(latestDoc?.temp || 0);

    if (fuel < 30) {
        alerts.push({
            type: 'warning',
            message: 'Fuel is getting low',
            action: 'Refill soon'
        });
    }

    if (temp > 90) {
        alerts.push({
            type: 'critical',
            message: 'Generator needs attention',
            action: 'Contact technician'
        });
    }

    // NEW CODE
    // EXTENSION ONLY: add inactive generator info alert
    const status = String(latestDoc?.status || '').toUpperCase();
    if (status !== 'RUNNING') {
        alerts.push({
            type: 'info',
            message: 'Generator is not active',
            action: 'Monitoring standby mode'
        });
    }

    const latestSync = String(latestDoc?.sync || '').toUpperCase();
    const previousSync = String(previousDoc?.sync || '').toUpperCase();
    if (previousSync && latestSync && latestSync !== previousSync) {
        alerts.push({
            type: 'info',
            message: 'Power source changed',
            action: 'System adjusted automatically'
        });
    }

    return alerts;
}

// NEW CODE
// EXTENSION ONLY: maintenance helper based on current + recent sensor data
function getMaintenanceStatus(latestDoc, recentDocs = []) {
    const latestTemp = Number(latestDoc?.temp || 0);
    const latestFuel = Number(latestDoc?.fuel || 0);
    const latestRpm = Number(latestDoc?.rpm || 0);

    const rpmValues = [latestRpm, ...recentDocs.map((doc) => Number(doc?.rpm || 0))]
        .filter((rpm) => Number.isFinite(rpm) && rpm > 0);
    const maxRpm = rpmValues.length ? Math.max(...rpmValues) : 0;
    const minRpm = rpmValues.length ? Math.min(...rpmValues) : 0;
    const rpmUnstable = rpmValues.length >= 2 && (maxRpm - minRpm > 300);

    const fuelValues = [latestFuel, ...recentDocs.map((doc) => Number(doc?.fuel || 0))]
        .filter((fuel) => Number.isFinite(fuel));
    const lowFuelCount = fuelValues.filter((fuel) => fuel < 30).length;
    const fuelConsistentlyLow = fuelValues.length >= 2 && lowFuelCount >= 2;

    if (latestTemp > 90 || rpmUnstable) {
        return {
            status: 'Service recommended',
            recommendation: 'Please schedule a technician inspection soon.'
        };
    }

    if (fuelConsistentlyLow) {
        return {
            status: 'Check fuel system',
            recommendation: 'Inspect fuel lines and refill planning for stable operation.'
        };
    }

    return {
        status: 'Good condition',
        recommendation: 'No immediate maintenance action required.'
    };
}

// NEW CODE
// EXTENSION ONLY: simple public labels without removing raw data
function getPublicLabels(latestDoc) {
    const powerSourceLabel = getPowerSourceLabel(latestDoc);
    const statusValue = String(latestDoc?.status || '').toUpperCase();

    return {
        power_source_label: powerSourceLabel,
        sync_label: powerSourceLabel,
        status_label: statusValue === 'RUNNING' ? 'Generator Menyala' : 'Generator Tidak Aktif'
    };
}

function transformPublicStatus(latestDoc, previousDoc = null) {
    const powerStatus = normalizePowerSource(latestDoc);
    const generatorCondition = normalizeStatus(latestDoc?.status);
    const fuelStatus = getFuelStatus(latestDoc?.fuel);
    const engineActivity = getEngineActivity(latestDoc?.rpm);
    const dailyUsage = getDailyUsage(latestDoc?.power);
    const estimatedCost = getEstimatedCost(dailyUsage);
    const maintenance = getMaintenanceStatus(latestDoc, previousDoc ? [previousDoc] : []);
    const labels = getPublicLabels(latestDoc);

    return {
        power_status: powerStatus,
        generator_condition: generatorCondition,
        fuel_status: fuelStatus,
        engine_activity: engineActivity,
        daily_usage: dailyUsage,
        estimated_cost: estimatedCost,
        alerts: generateAlerts(latestDoc, previousDoc),
        maintenance,
        ...labels,
        last_updated: latestDoc?.timestamp || new Date().toISOString()
    };
}

module.exports = {
    transformPublicStatus,
    generateAlerts,
    getMaintenanceStatus,
    getPublicLabels
};
