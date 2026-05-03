'use strict';

const TOPICS = [
  'genset/voltage',
  'genset/current',
  'genset/power',
  'genset/temp',
  'genset/fuel',
  'genset/status'
];

const BROKER_URL = 'wss://broker.shiftr.io';
const MAINTENANCE_INTERVAL_HOURS = 250;
const COST_PER_KWH = 0.14;
const COST_PER_LITER = 1.15;
const FUEL_BURN_LPH_FACTOR = 0.28;

const state = {
  voltage: 0,
  current: 0,
  power: 0,
  temp: 0,
  fuel: 0,
  status: 'OFF',
  runtimeHours: Number(localStorage.getItem('public_runtime_hours') || 0),
  lastRuntimeTick: Date.now(),
  runtimeSeries: [],
  powerSeries: []
};

const el = id => document.getElementById(id);
const money = v => `$${v.toFixed(2)}`;

let runtimeChart;
let powerChart;

function initCharts() {
  runtimeChart = new Chart(el('runtimeChart'), {
    type: 'line',
    data: { labels: [], datasets: [{ label: 'Runtime (h)', data: [], borderColor: '#1f4191', tension: .3 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });

  powerChart = new Chart(el('powerChart'), {
    type: 'line',
    data: { labels: [], datasets: [{ label: 'Power (kW)', data: [], borderColor: '#d97706', tension: .3 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });
}

function pushSeries() {
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  state.runtimeSeries.push({ t, v: Number(state.runtimeHours.toFixed(2)) });
  state.powerSeries.push({ t, v: Number(state.power.toFixed(2)) });

  if (state.runtimeSeries.length > 20) state.runtimeSeries.shift();
  if (state.powerSeries.length > 20) state.powerSeries.shift();

  runtimeChart.data.labels = state.runtimeSeries.map(p => p.t);
  runtimeChart.data.datasets[0].data = state.runtimeSeries.map(p => p.v);
  powerChart.data.labels = state.powerSeries.map(p => p.t);
  powerChart.data.datasets[0].data = state.powerSeries.map(p => p.v);

  runtimeChart.update('none');
  powerChart.update('none');
}

function updateRuntime() {
  const now = Date.now();
  if (state.status === 'ON') {
    const deltaH = (now - state.lastRuntimeTick) / 3600000;
    state.runtimeHours += deltaH;
    localStorage.setItem('public_runtime_hours', state.runtimeHours.toString());
  }
  state.lastRuntimeTick = now;
}

function updateAlerts() {
  const alerts = [];

  if (state.temp > 95) alerts.push({ lvl: 'err', txt: `High temperature (${state.temp.toFixed(1)}°C)` });
  else if (state.temp > 85) alerts.push({ lvl: 'warn', txt: `Temperature warning (${state.temp.toFixed(1)}°C)` });

  if (state.fuel < 15) alerts.push({ lvl: 'err', txt: `Low fuel (${state.fuel.toFixed(1)}%)` });
  else if (state.fuel < 30) alerts.push({ lvl: 'warn', txt: `Fuel getting low (${state.fuel.toFixed(1)}%)` });

  if (state.voltage < 210 || state.voltage > 240) alerts.push({ lvl: 'warn', txt: `Abnormal voltage (${state.voltage.toFixed(1)}V)` });

  if (!alerts.length) alerts.push({ lvl: 'ok', txt: 'All parameters are in safe range.' });

  el('alerts').innerHTML = alerts.map(a => `<div class="alert-item ${a.lvl}">${a.txt}</div>`).join('');
}

function updateMaintenance() {
  const remaining = Math.max(0, MAINTENANCE_INTERVAL_HOURS - state.runtimeHours);
  el('runtimeHours').textContent = `${state.runtimeHours.toFixed(2)} h`;
  el('remainingHours').textContent = `${remaining.toFixed(2)} h`;

  const maintState = el('maintState');
  const warning = el('maintWarning');

  if (remaining <= 0) {
    maintState.className = 'status-pill err';
    maintState.textContent = 'Overdue';
    warning.textContent = 'Maintenance is overdue. Please service immediately.';
  } else if (remaining <= 25) {
    maintState.className = 'status-pill warn';
    maintState.textContent = 'Due Soon';
    warning.textContent = 'Maintenance is approaching soon.';
  } else {
    maintState.className = 'status-pill ok';
    maintState.textContent = 'Healthy';
    warning.textContent = 'No maintenance warning.';
  }
}

function updateCost() {
  const fuelLph = state.power * FUEL_BURN_LPH_FACTOR;
  const perHour = (state.power * COST_PER_KWH) + (fuelLph * COST_PER_LITER);
  const daily = perHour * 24;

  el('costPerHour').textContent = money(perHour);
  el('dailyCost').textContent = money(daily);
}

function render() {
  el('voltageValue').textContent = `${state.voltage.toFixed(1)} V`;
  el('currentValue').textContent = `${state.current.toFixed(1)} A`;
  el('powerValue').textContent = `${state.power.toFixed(2)} kW`;
  el('tempValue').textContent = `${state.temp.toFixed(1)} °C`;
  el('fuelValue').textContent = `${state.fuel.toFixed(1)} %`;

  const statusBadge = el('statusBadge');
  statusBadge.textContent = state.status;
  statusBadge.className = `status-badge ${state.status === 'ON' ? 'status-on' : 'status-off'}`;

  el('lastUpdate').textContent = `Updated: ${new Date().toLocaleString()}`;

  updateMaintenance();
  updateCost();
  updateAlerts();
}

function onMessage(topic, payload) {
  const num = Number(payload);
  if (topic.endsWith('voltage') && !Number.isNaN(num)) state.voltage = num;
  if (topic.endsWith('current') && !Number.isNaN(num)) state.current = num;
  if (topic.endsWith('power') && !Number.isNaN(num)) state.power = num;
  if (topic.endsWith('temp') && !Number.isNaN(num)) state.temp = num;
  if (topic.endsWith('fuel') && !Number.isNaN(num)) state.fuel = num;
  if (topic.endsWith('status')) state.status = String(payload).trim().toUpperCase() === 'ON' ? 'ON' : 'OFF';

  updateRuntime();
  render();
}

function connectMqtt() {
  const client = mqtt.connect(BROKER_URL, {
    clientId: `public_view_${Math.random().toString(16).slice(2, 9)}`,
    username: 'public',
    password: 'public',
    clean: true,
    reconnectPeriod: 3000
  });

  client.on('connect', () => {
    el('mqttState').textContent = 'MQTT: Connected';
    el('mqttState').className = 'status-pill ok';
    TOPICS.forEach(topic => client.subscribe(topic));
  });

  client.on('reconnect', () => {
    el('mqttState').textContent = 'MQTT: Reconnecting';
    el('mqttState').className = 'status-pill warn';
  });

  client.on('error', () => {
    el('mqttState').textContent = 'MQTT: Error';
    el('mqttState').className = 'status-pill err';
  });

  client.on('message', (topic, buffer) => onMessage(topic, buffer.toString()));
}

document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  render();
  connectMqtt();

  setInterval(() => {
    updateRuntime();
    render();
    pushSeries();
  }, 5000);
});
