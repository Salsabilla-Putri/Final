'use strict';

function updateClock() {
    const el = document.getElementById('liveClock');
    if (el) el.innerText = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) + ' WIB';
}
setInterval(updateClock, 1000);
updateClock();

async function fetchPublicData() {
    try {
        const res = await fetch('/api/public/dashboard');
        const json = await res.json();
        if (!json.success) throw new Error(json.error);
        const d = json.data;

        // Health
        document.getElementById('healthScore').innerText = d.health.score + '%';
        document.getElementById('healthMessage').innerText = d.health.message;
        const fillColor = d.health.score >= 80 ? 'var(--secondary)' : (d.health.score >= 50 ? 'var(--warning)' : 'var(--danger)');
        const healthFill = document.getElementById('healthFill');
        healthFill.style.width = d.health.score + '%';
        healthFill.style.background = fillColor;

        // Sumber Listrik
        const srcElem = document.getElementById('powerSource');
        const powerKw = d.parameters.power.kw;
        document.getElementById('powerKw').innerText = powerKw;
        // Detect from parameters maybe, kita bisa set manual dari data
        // Tapi kita ambil dari API lain? kita sudah punya di public/dashboard
        // Sementara kita set berdasarkan tegangan atau sync (tidak dikirim, kita tambah manual via realtime nanti)
        // Untuk sementara kita set statis: "PLN" / "Genset"
        // Lebih baik kita fetch juga dari /api/engine-data/latest
        await updatePowerSource();

        // Fuel
        const fuel = d.parameters.fuel;
        document.getElementById('fuelPercent').innerText = fuel.percent;
        document.getElementById('fuelBar').style.width = fuel.percent + '%';
        document.getElementById('fuelHours').innerText = fuel.hoursLeft;
        document.getElementById('fuelHint').innerText = fuel.description;

        // Temperature
        const temp = d.parameters.temperature;
        document.getElementById('tempValue').innerText = temp.value;
        const tempStatusElem = document.getElementById('tempStatus');
        if (temp.value > 85) { tempStatusElem.innerText = 'Panas'; tempStatusElem.className = 'status-badge status-danger'; }
        else if (temp.value > 70) { tempStatusElem.innerText = 'Normal (hangat)'; tempStatusElem.className = 'status-badge status-warning'; }
        else { tempStatusElem.innerText = 'Normal'; tempStatusElem.className = 'status-badge status-good'; }

        // Maintenance prediction
        document.getElementById('maintenanceMsg').innerHTML = d.maintenance.message;
        document.getElementById('totalHours').innerText = d.maintenance.totalHours;
        let mgmtPercent = Math.min(100, (d.maintenance.totalHours / 250) * 100);
        const mgmtFill = document.getElementById('maintenanceMeter');
        mgmtFill.style.width = mgmtPercent + '%';
        mgmtFill.style.background = d.maintenance.urgency === 'danger' ? 'var(--danger)' : (d.maintenance.urgency === 'warning' ? 'var(--warning)' : 'var(--secondary)');

        // Spesifikasi
        const gen = d.specs.generator;
        const eng = d.specs.engine;
        document.getElementById('genSpecs').innerHTML = `
            <li><span>Tipe:</span><span>${gen.type}</span></li>
            <li><span>Daya Maks:</span><span>${gen.power}</span></li>
            <li><span>Tegangan:</span><span>${gen.voltage}</span></li>
            <li><span>Frekuensi:</span><span>${gen.frequency}</span></li>
        `;
        document.getElementById('engineSpecs').innerHTML = `
            <li><span>Jenis:</span><span>${eng.type}</span></li>
            <li><span>Silinder:</span><span>${eng.cylinders}</span></li>
            <li><span>Kapasitas:</span><span>${eng.displacement}</span></li>
            <li><span>Bahan Bakar:</span><span>${eng.fuelType}</span></li>
        `;
    } catch (err) {
        console.error(err);
        // fallback: tampilkan pesan ramah
        document.querySelectorAll('.value-large, .health-score').forEach(el => el.innerText = '--');
    }
}

async function updatePowerSource() {
    try {
        const res = await fetch('/api/engine-data/latest');
        const json = await res.json();
        if (json.success && json.data) {
            const data = json.data;
            const isRunning = (data.rpm || 0) > 50;
            const sync = (data.sync || '').toUpperCase();
            const isPLN = sync.includes('ON-GRID') || (data.volt > 200 && !isRunning);
            const srcElem = document.getElementById('powerSource');
            const descElem = document.getElementById('powerDesc');
            if (isRunning) {
                srcElem.innerText = 'GENSET AKTIF';
                descElem.innerText = 'PLN padam, genset menyuplai listrik.';
            } else if (isPLN) {
                srcElem.innerText = 'PLN NORMAL';
                descElem.innerText = 'Listrik dari jaringan utama.';
            } else {
                srcElem.innerText = 'PEMADAMAN';
                descElem.innerText = 'Menunggu genset menyala otomatis.';
            }
            // Daya terpakai & deskripsi
            const powerKw = (data.volt * (data.amp || 0)) / 1000;
            const lampu = Math.floor(powerKw / 0.1);
            document.getElementById('powerKw').innerText = powerKw.toFixed(1);
            document.getElementById('powerDescText').innerHTML = ` (setara ${lampu} lampu LED 100W)`;
        }
    } catch(e) { console.warn(e); }
}

// Polling setiap 5 detik
fetchPublicData();
updatePowerSource();
setInterval(() => {
    fetchPublicData();
    updatePowerSource();
}, 5000);