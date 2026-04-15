// Dummy JSON Data Simulation
const dashboardData = {
  powerSource: "HYBRID", // Can be "PLN", "GENERATOR", or "HYBRID"
  generator: {
    status: "ON",
    activityPercent: 65, // Replaces raw RPM
    fuelPercent: 42
  },
  energy: {
    currentWatts: 1450,
    dailyKwh: 12.4
  },
  cost: {
    dailyRp: 18500
  },
  notifications: [
    { type: "warning", message: "Fuel level is below 50%. Consider scheduling a refill.", time: "10 mins ago" },
    { type: "info", message: "Switched to Hybrid Mode to handle peak power demand.", time: "2 hours ago" },
    { type: "info", message: "Routine automated engine check completed successfully.", time: "Yesterday" }
  ]
};

// DOM Elements
const sidebar = document.getElementById('sidebar');
const menuToggle = document.getElementById('menuToggle');
const nodePln = document.getElementById('node-pln');
const flowLine = document.getElementById('flow-line');
const powerStatusText = document.getElementById('powerStatusText');

// UI Update Function
function updateDashboard(data) {
  // 1. Power Source Visuals
  if (data.powerSource === "PLN") {
    nodePln.classList.add('active-source');
    flowLine.style.display = 'block';
    flowLine.style.background = 'linear-gradient(90deg, transparent, var(--success), transparent)';
    powerStatusText.innerText = "Running cleanly on City Grid. Generator is on standby.";
  } else if (data.powerSource === "GENERATOR") {
    nodePln.classList.remove('active-source');
    flowLine.style.display = 'block';
    flowLine.style.background = 'linear-gradient(90deg, transparent, var(--warning), transparent)';
    powerStatusText.innerText = "Grid offline. Generator is actively powering your home.";
  } else if (data.powerSource === "HYBRID") {
    nodePln.classList.add('active-source');
    flowLine.style.display = 'block';
    flowLine.style.background = 'linear-gradient(90deg, transparent, var(--primary), transparent)';
    powerStatusText.innerText = "Hybrid Mode: Grid and Generator working together for maximum stability.";
  }

  // 2. Generator Status
  document.getElementById('engineState').innerText = data.generator.status === "ON" ? "Active / Running" : "Standby";
  document.getElementById('engineSpeed').innerText = data.generator.status === "ON" ? `${data.generator.activityPercent}% Capacity` : "0%";
  
  const fuelBar = document.getElementById('fuelBar');
  document.getElementById('fuelText').innerText = `${data.generator.fuelPercent}%`;
  fuelBar.style.width = `${data.generator.fuelPercent}%`;
  
  if (data.generator.fuelPercent < 25) {
    fuelBar.className = "progress-bar fill-amber";
  } else {
    fuelBar.className = "progress-bar fill-blue";
  }

  // 3. Energy & Cost
  document.getElementById('dailyCost').innerText = data.cost.dailyRp.toLocaleString('en-US');
  document.getElementById('currentLoad').innerText = data.energy.currentWatts.toLocaleString('en-US');
  document.getElementById('dailyEnergy').innerText = data.energy.dailyKwh.toFixed(1);

  // 4. Notifications
  const notifList = document.getElementById('notificationList');
  notifList.innerHTML = '';
  data.notifications.forEach(notif => {
    const iconClass = notif.type === 'warning' ? 'fas fa-exclamation-triangle warning' : 'fas fa-info-circle info';
    const li = document.createElement('li');
    li.className = 'notification-item';
    li.innerHTML = `
      <i class="${iconClass} notif-icon"></i>
      <div class="notif-content">
        <span class="notif-text">${notif.message}</span>
        <span class="notif-time">${notif.time}</span>
      </div>
    `;
    notifList.appendChild(li);
  });
}

// Sidebar Toggle Logic for Mobile
menuToggle.addEventListener('click', () => {
  sidebar.classList.toggle('open');
});

// Initialize Dashboard
document.addEventListener('DOMContentLoaded', () => {
  updateDashboard(dashboardData);
});