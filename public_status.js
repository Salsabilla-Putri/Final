'use strict';

const SYNC_MAP = {
    'OFF-GRID': 'Using Generator',
    'ON-GRID': 'Using PLN',
    HYBRID: 'Using Both'
};

const STATUS_MAP = {
    RUNNING: 'Generator Running',
    OFF: 'Generator Off'
};

const COST_PER_KWH = 13150;

function normalizeSync(syncValue) {
    const key = String(syncValue || '').toUpperCase();
    return SYNC_MAP[key] || 'Power Source Unknown';
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
    const syncValue = String(latestDoc?.sync || '').toUpperCase();
    const statusValue = String(latestDoc?.status || '').toUpperCase();

    return {
        sync_label: syncValue === 'ON-GRID' ? 'Terhubung PLN' : 'Generator Aktif',
        status_label: statusValue === 'RUNNING' ? 'Generator Menyala' : 'Generator Tidak Aktif'
    };
}

function transformPublicStatus(latestDoc, previousDoc = null) {
    const powerStatus = normalizeSync(latestDoc?.sync);
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
