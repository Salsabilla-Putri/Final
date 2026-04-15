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

    const latestSync = String(latestDoc?.sync || '').toUpperCase();
    const previousSync = String(previousDoc?.sync || '').toUpperCase();
    if (previousSync && latestSync && latestSync !== previousSync) {
        alerts.push({
            type: 'info',
            message: 'Power source switched',
            action: 'System adjusted automatically'
        });
    }

    return alerts;
}

function transformPublicStatus(latestDoc, previousDoc = null) {
    const powerStatus = normalizeSync(latestDoc?.sync);
    const generatorCondition = normalizeStatus(latestDoc?.status);
    const fuelStatus = getFuelStatus(latestDoc?.fuel);
    const engineActivity = getEngineActivity(latestDoc?.rpm);
    const dailyUsage = getDailyUsage(latestDoc?.power);
    const estimatedCost = getEstimatedCost(dailyUsage);

    return {
        power_status: powerStatus,
        generator_condition: generatorCondition,
        fuel_status: fuelStatus,
        engine_activity: engineActivity,
        daily_usage: dailyUsage,
        estimated_cost: estimatedCost,
        alerts: generateAlerts(latestDoc, previousDoc),
        last_updated: latestDoc?.timestamp || new Date().toISOString()
    };
}

module.exports = {
    transformPublicStatus
};
