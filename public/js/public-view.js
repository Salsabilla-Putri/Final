'use strict';

const DEVICE_ID = 'ESP32_GENERATOR_01';

const el = {
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    content: document.getElementById('content'),
    powerStatus: document.getElementById('powerStatus'),
    generatorCondition: document.getElementById('generatorCondition'),
    fuelStatus: document.getElementById('fuelStatus'),
    engineActivity: document.getElementById('engineActivity'),
    dailyUsage: document.getElementById('dailyUsage'),
    estimatedCost: document.getElementById('estimatedCost'),
    lastUpdated: document.getElementById('lastUpdated'),
    alerts: document.getElementById('alerts'),
    refreshBtn: document.getElementById('refreshBtn')
};

function setState({ loading = false, error = '', hasContent = false }) {
    el.loading.classList.toggle('hidden', !loading);
    el.error.classList.toggle('hidden', !error);
    el.content.classList.toggle('hidden', !hasContent);
    el.error.textContent = error;
}

function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';

    return date.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function formatCurrency(value) {
    const amount = Number(value || 0);
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        maximumFractionDigits: 0
    }).format(amount);
}

function renderAlerts(alerts = []) {
    if (!alerts.length) {
        el.alerts.innerHTML = '<article class="alert info">No active alerts.</article>';
        return;
    }

    el.alerts.innerHTML = alerts.map((alert) => `
        <article class="alert ${alert.type}">
            <div>
                <strong>${alert.message}</strong>
                ${alert.action ? `<p>${alert.action}</p>` : ''}
            </div>
        </article>
    `).join('');
}

function renderData(data) {
    el.powerStatus.textContent = data.power_status;
    el.generatorCondition.textContent = data.generator_condition;
    el.fuelStatus.textContent = data.fuel_status;
    el.engineActivity.textContent = data.engine_activity;
    el.dailyUsage.textContent = `${Number(data.daily_usage || 0).toFixed(2)} kWh`;
    el.estimatedCost.textContent = formatCurrency(data.estimated_cost);
    el.lastUpdated.textContent = formatDate(data.last_updated);
    renderAlerts(data.alerts || []);
}

async function loadPublicStatus() {
    setState({ loading: true, error: '', hasContent: false });

    try {
        const response = await fetch(`/api/public-status?deviceId=${encodeURIComponent(DEVICE_ID)}`);
        const payload = await response.json();

        if (!response.ok || !payload?.success || !payload?.data) {
            throw new Error(payload?.error || 'Failed to load data from server.');
        }

        renderData(payload.data);
        setState({ loading: false, error: '', hasContent: true });
    } catch (error) {
        setState({ loading: false, error: error.message, hasContent: false });
    }
}

el.refreshBtn.addEventListener('click', loadPublicStatus);

loadPublicStatus();
setInterval(loadPublicStatus, 10000);
