/**
 * Gen-Track · Public View  v3.0  (Enhanced with MQTT & Cost Analytics)
 */
'use strict';

/* ── CONSTANTS ─────────────────────────────── */
const RPM_MAX        = 3600;
const TEMP_MAX       = 120;
const ARC_LEN        = 282.7;   // π × 90
const VOLT_LO        = 198;  const VOLT_HI  = 242;
const FREQ_LO        = 49.5; const FREQ_HI  = 50.5;
const ENGINE_LIFE_H  = 10000;
const OIL_INTERVAL   = 250;
const AIRFLT_INTERVAL = 500;
const FUELFLT_INTERVAL = 500;
const SPARK_INTERVAL  = 1000;
const COOLANT_INTERVAL = 1000;
const BATTERY_INTERVAL = 2000;
const MAJOR_INTERVAL  = 2500;
const TANK_CAPACITY_L = 50;
const AVG_CONSUMPTION_LPH = 2.5;
const FUEL_PRICE_PER_LITER = 12000; // IDR, adjust as needed

/* ── STATE ─────────────────────────────────── */
let trendData   = { labels: [], volt: [], freq: [] };
let uptimeData  = [];
let trendChart  = null;
let donutChart  = null;
let uptimeChart = null;
let chartsReady = false;
let latestDecisionPayload = null;
let previousSource = 'PLN';
let eventLog = [];
let mqttClient = null;
let lastRuntimeUpdate = Date.now();
let dailyTotalCost = 0;
let dailyActiveMs = 0;
let currentFuelLevel = 0;
let currentPowerKw = 0;

/* ── UTILS ─────────────────────────────────── */
const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const fmt = ts => {
  if (!ts) return '-';
  const d = new Date(ts);
  return isNaN(d) ? '-' : d.toLocaleString('id-ID', { day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit' });
};
const initials = n => (n||'U').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();

/* ── GAUGE ARC HELPER ──────────────────────── */
function setArc(id, pct, colorOk, colorWarn, colorErr) {
  const el = $(id);
  if (!el) return;
  const offset = ARC_LEN * (1 - clamp(pct, 0, 1));
  el.style.strokeDashoffset = offset;
  if (pct > .8)       el.style.stroke = colorErr;
  else if (pct > .6)  el.style.stroke = colorWarn;
  else                el.style.stroke = colorOk;
}

function setMetricBar(barId, cardId, value, lo, hi, max) {
  const bar  = $(barId);
  const card = $(cardId);
  if (!bar) return;
  const pct   = clamp(value / max * 100, 0, 100);
  const inRng = value >= lo && value <= hi;
  bar.style.width = pct + '%';
  bar.className = 'mc-fill' + (inRng ? '' : value > 0 ? ' warn' : ' err');
  if (card) card.className = 'mc' + (inRng ? '' : value > 0 ? ' warn' : '');
}

function setDot(id, status) {
  const el = $(id);
  if (el) el.className = (el.className.replace(/\b(ok|warn|err)\b/g,'')).trim() + ' ' + status;
}
function setHealthRow(dotId, badgeId, descId, itemId, status, label, desc) {
  setDot(dotId, status);
  const b = $(badgeId);
  if (b) { b.className = 'hc-badge ' + status; b.textContent = label; }
  const d = $(descId);
  if (d) d.textContent = desc;
  const it = $(itemId);
  if (it) it.className = 'hc ' + status;
}

/* ── POWER SOURCE DETECTION ────────────────── */
function detectSource(data, isRunning) {
  const sync = String(data.sync || '').toUpperCase();
  const hasGrid = sync.includes('ON-GRID') || sync.includes('SYNC') || sync.includes('PLN') || sync.includes('GRID');
  if (!isRunning && !hasGrid) return 'OFF';
  if (isRunning && hasGrid)   return 'HYBRID';
  if (isRunning)              return 'GEN';
  return 'PLN';
}
const SOURCE_META = {
  PLN:    { label:'Jaringan PLN (Listrik Utama)', sub:'Pasokan normal dari PLN aktif', icon:'fas fa-plug',   cls:'pln', genState:'Siaga', plnState:'Aktif ✓', sysLabel:'Normal', genFlow:'PLN' },
  GEN:    { label:'Generator Cadangan',          sub:'Generator aktif menyuplai daya', icon:'fas fa-bolt',  cls:'gen', genState:'Menyala ✓', plnState:'Tidak Aktif', sysLabel:'Mode Cadangan', genFlow:'Generator' },
  HYBRID: { label:'Hybrid (PLN + Generator)',   sub:'Kedua sumber aktif bersamaan',   icon:'fas fa-rotate',cls:'hyb', genState:'Menyala ✓', plnState:'Aktif ✓', sysLabel:'Mode Hybrid', genFlow:'PLN + Gen' },
  OFF:    { label:'Tidak Ada Sumber Daya',      sub:'Sistem mendeteksi gangguan',      icon:'fas fa-power-off',cls:'', genState:'Mati', plnState:'Tidak Aktif', sysLabel:'Offline', genFlow:'--' },
};

/* ── EVENT LOG ──────────────────────────────── */
function addEvent(type, text, status = 'ok') {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  eventLog.unshift({ time: timeStr, type, text, status });
  if (eventLog.length > 20) eventLog.pop();
  renderEventLog();
}
function renderEventLog() {
  const list = $('eventLogList');
  if (!list) return;
  if (eventLog.length === 0) {
    list.innerHTML = '<div class="event-item"><i class="fas fa-circle-notch fa-spin"></i><span>Belum ada kejadian tercatat.</span></div>';
    return;
  }
  list.innerHTML = eventLog.map(ev => `
    <div class="event-item ${ev.status}">
      <span class="event-time">${ev.time}</span>
      <i class="fas fa-${ev.type === 'source' ? 'bolt' : ev.type === 'fuel' ? 'gas-pump' : 'circle-info'}"></i>
      <span>${ev.text}</span>
    </div>`).join('');
}

/* ── CHART INIT ────────────────────────────── */
function initCharts() {
  if (chartsReady || typeof Chart === 'undefined') return;

  const tCtx = $('trendChart');
  if (tCtx) {
    trendChart = new Chart(tCtx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label:'Tegangan (V)', data:[], borderColor:'#3b82f6', backgroundColor:'rgba(59,130,246,.08)',
            borderWidth:2, pointRadius:2, tension:.4, yAxisID:'y' },
          { label:'Frekuensi ×4 (Hz)', data:[], borderColor:'#10b981', backgroundColor:'rgba(16,185,129,.08)',
            borderWidth:2, pointRadius:2, tension:.4, yAxisID:'y2' },
        ]
      },
      options: {
        responsive:true, maintainAspectRatio:false, animation:{duration:400},
        interaction:{ intersect:false, mode:'index' },
        scales:{
          x:{ grid:{display:false}, ticks:{font:{size:10},color:'#8fa2c8', maxTicksLimit:8} },
          y:{ position:'left', min:180, max:260,
              grid:{color:'rgba(200,210,240,.5)'},
              ticks:{font:{size:10},color:'#3b82f6', callback:v=>v+'V'} },
          y2:{ position:'right', min:190, max:215,
               grid:{display:false},
               ticks:{font:{size:10},color:'#10b981', callback:v=>(v/4).toFixed(1)+'Hz'} },
        },
        plugins:{legend:{display:false}}
      }
    });
  }

  const dCtx = $('lifespanDonut');
  if (dCtx) {
    donutChart = new Chart(dCtx, {
      type:'doughnut',
      data:{ datasets:[{ data:[0,100], backgroundColor:['#1f4191','#e8effe'], borderWidth:0, hoverOffset:0 }] },
      options:{ cutout:'75%', responsive:true, maintainAspectRatio:false, animation:{duration:800}, plugins:{ legend:{display:false}, tooltip:{enabled:false} } }
    });
  }

  const uCtx = $('uptimeChart');
  if (uCtx) {
    const labels = getLast7DayLabels();
    uptimeChart = new Chart(uCtx, {
      type:'bar',
      data:{
        labels,
        datasets:[{
          label:'Jam Operasi', data: new Array(7).fill(0),
          backgroundColor:'rgba(31,65,145,.15)', borderColor:'#1f4191', borderWidth:1.5, borderRadius:5,
        }]
      },
      options:{
        responsive:true, maintainAspectRatio:false, animation:{duration:600},
        scales:{ y:{ min:0, max:24, grid:{color:'rgba(200,210,240,.4)'}, ticks:{font:{size:10},color:'#8fa2c8',callback:v=>v+'h'} },
                 x:{ grid:{display:false}, ticks:{font:{size:10},color:'#8fa2c8'} },
        },
        plugins:{ legend:{display:false}, tooltip:{callbacks:{label:ctx=>`${ctx.raw.toFixed(1)} jam`}} }
      }
    });
  }
  chartsReady = true;
}

function getLast7DayLabels() {
  const days = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
  return Array.from({length:7}, (_,i) => { const d=new Date(); d.setDate(d.getDate()-(6-i)); return days[d.getDay()]; });
}

/* ── TREND CHART ────────────────────────────── */
function pushTrend(volt, freq, tsLabel) {
  const MAX = 20;
  trendData.labels.push(tsLabel);
  trendData.volt.push(volt);
  trendData.freq.push(freq * 4);
  if (trendData.labels.length > MAX) { trendData.labels.shift(); trendData.volt.shift(); trendData.freq.shift(); }
  if (trendChart) {
    trendChart.data.labels = [...trendData.labels];
    trendChart.data.datasets[0].data = [...trendData.volt];
    trendChart.data.datasets[1].data = [...trendData.freq];
    trendChart.update('none');
  }
}

/* ── DONUT ──────────────────────────────────── */
function updateDonut(engineHours) {
  const used = clamp(engineHours, 0, ENGINE_LIFE_H);
  const remaining = ENGINE_LIFE_H - used;
  const healthPct = Math.round((remaining / ENGINE_LIFE_H) * 100);
  if (donutChart) {
    donutChart.data.datasets[0].data = [used, remaining];
    const col = used < ENGINE_LIFE_H * 0.7 ? '#1f4191' : used < ENGINE_LIFE_H * 0.9 ? '#d97706' : '#dc2626';
    donutChart.data.datasets[0].backgroundColor[0] = col;
    donutChart.update('none');
  }
  if ($('ldcPct')) $('ldcPct').textContent = healthPct + '%';
  if ($('engHoursTotal'))  $('engHoursTotal').textContent  = used.toLocaleString('id-ID') + ' jam';
  if ($('engHoursRemain')) $('engHoursRemain').textContent = remaining.toLocaleString('id-ID') + ' jam';
  const lb = $('lifespanBadge');
  if (lb) {
    if (healthPct >= 50)     { lb.textContent='Kondisi Baik'; lb.className='sh-b ok'; setNavDot('navDot-lifespan','ok'); }
    else if (healthPct >= 20){ lb.textContent='Perhatikan';   lb.className='sh-b warn'; setNavDot('navDot-lifespan','warn'); }
    else                     { lb.textContent='Perlu Overhaul';lb.className='sh-b err';  setNavDot('navDot-lifespan','err'); }
  }
  return healthPct;
}

/* ── MAINTENANCE ────────────────────────────── */
const MAINT_ITEMS = [
  { id:'oil',      icon:'fas fa-oil-can',       name:'Penggantian Oli Mesin',    interval: OIL_INTERVAL },
  { id:'airflt',   icon:'fas fa-wind',           name:'Filter Udara',             interval: AIRFLT_INTERVAL },
  { id:'fuelflt',  icon:'fas fa-gas-pump',       name:'Filter Bahan Bakar',       interval: FUELFLT_INTERVAL },
  { id:'spark',    icon:'fas fa-fire',           name:'Busi / Injektor',          interval: SPARK_INTERVAL },
  { id:'coolant',  icon:'fas fa-droplet',        name:'Coolant & Antifreeze',     interval: COOLANT_INTERVAL },
  { id:'battery',  icon:'fas fa-car-battery',    name:'Aki / Baterai Start',      interval: BATTERY_INTERVAL },
  { id:'major',    icon:'fas fa-screwdriver-wrench',name:'Servis Besar (Major)',  interval: MAJOR_INTERVAL },
];

function buildMaintenanceSection(data, engineHours) {
  const mData = data.maintenance || {};
  let okCount = 0, warnCount = 0, errCount = 0, nextServiceHoursAway = Infinity;
  const rows = MAINT_ITEMS.map(item => {
    const lastH = mData[item.id + 'LastHours'] != null ? Number(mData[item.id + 'LastHours']) : Math.max(0, engineHours - (engineHours % item.interval));
    const nextDueAt = lastH + item.interval;
    const hoursUsedSince = engineHours - lastH;
    const pct = clamp(hoursUsedSince / item.interval, 0, 1.1);
    const hoursLeft = nextDueAt - engineHours;
    let status, badge;
    if (hoursLeft <= 0)         { status='err';  badge='Perlu Servis';   errCount++; }
    else if (hoursLeft <= 30)   { status='warn'; badge='Segera (<30j)'; warnCount++; }
    else                        { status='ok';   badge='OK';             okCount++; }
    if (hoursLeft > 0 && hoursLeft < nextServiceHoursAway) nextServiceHoursAway = hoursLeft;
    const pctDisp = Math.round(pct * 100);
    const detail = hoursLeft > 0
      ? `Terakhir: ${lastH.toLocaleString()} jam · Berikutnya: ${nextDueAt.toLocaleString()} jam (${hoursLeft.toFixed(0)} jam lagi)`
      : `SUDAH MELEWATI jadwal! Segera lakukan servis.`;
    return { status, badge, pct, pctDisp, detail, item };
  });
  const list = $('maintList');
  if (list) {
    list.innerHTML = rows.map(r => `
      <div class="mi ${r.status}">
        <div class="mi-icon"><i class="${r.item.icon}"></i></div>
        <div class="mi-body"><div class="mi-name">${r.item.name}</div><div class="mi-detail">${r.detail}</div></div>
        <div class="mi-progress"><div class="mi-bar-wrap"><div class="mi-bar ${r.status}" style="width:${Math.min(r.pctDisp,100)}%"></div></div><span class="mi-pct">${r.pctDisp}%</span></div>
        <div class="mi-badge ${r.status}">${r.badge}</div>
      </div>`).join('');
  }
  if ($('maintOkCount'))   $('maintOkCount').textContent   = okCount;
  if ($('maintWarnCount')) $('maintWarnCount').textContent = warnCount;
  if ($('maintErrCount'))  $('maintErrCount').textContent  = errCount;

  const nextServiceDate = mData.nextScheduledDate || null;
  if ($('maintNextDate')) {
    if (nextServiceDate) $('maintNextDate').textContent = new Date(nextServiceDate).toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'});
    else if (nextServiceHoursAway < Infinity) $('maintNextDate').textContent = Math.round(nextServiceHoursAway) + ' jam lagi';
    else $('maintNextDate').textContent = '--';
  }
  const mb = $('maintenanceBadge');
  let maintStatus;
  if (errCount > 0)       { mb && (mb.className='sh-b err',  mb.textContent=`${errCount} Perlu Servis`);   maintStatus='err'; }
  else if (warnCount > 0) { mb && (mb.className='sh-b warn', mb.textContent=`${warnCount} Segera Cek`);    maintStatus='warn'; }
  else                    { mb && (mb.className='sh-b ok',   mb.textContent='Semua OK');                   maintStatus='ok'; }
  setNavDot('navDot-maintenance', maintStatus);

  const nsb = $('nextServiceBanner');
  if (nsb && nextServiceHoursAway < Infinity) {
    nsb.className = 'nsb ' + (nextServiceHoursAway <= 0 ? 'err' : nextServiceHoursAway <= 30 ? 'warn' : '');
    $('nsbTitle').textContent = nextServiceHoursAway <= 0 ? 'Perawatan terlambat — segera jadwalkan servis' : `Servis berikutnya dalam ${Math.round(nextServiceHoursAway)} jam operasi`;
    $('nsbSub').textContent = errCount > 0 ? `${errCount} komponen melewati jadwal servis` : `${okCount} komponen OK · ${warnCount} hampir jatuh tempo`;
    $('nsbVal').textContent = nextServiceHoursAway <= 0 ? 'TERLAMBAT' : Math.round(nextServiceHoursAway) + ' jam';
  }
  return { okCount, warnCount, errCount, maintStatus };
}

/* ── SIDEBAR DOT ────────────────────────────── */
function setNavDot(id, status) { const el = $(id); if (el) el.className = 'sbl-dot ' + status; }

/* ── SIDEBAR USER ───────────────────────────── */
function initSidebarUser() {
  const name = localStorage.getItem('username') || 'Pengguna';
  if ($('sbAvatar'))   $('sbAvatar').textContent   = initials(name);
  if ($('sbUsername')) $('sbUsername').textContent = name;
}

/* ── ESTIMATE RUNTIME ───────────────────────── */
function calcRuntime(fuelPct, loadKw) {
  if (fuelPct <= 0) return '--';
  const loadFactor = loadKw > 0.9 ? 1.3 : 1.0;
  const consumption = AVG_CONSUMPTION_LPH * loadFactor;
  const remainingLiters = (fuelPct / 100) * TANK_CAPACITY_L;
  const hours = remainingLiters / consumption;
  if (hours < 0.5) return 'Kurang dari 30 mnt';
  if (hours < 1)   return `${(hours*60).toFixed(0)} menit`;
  const h = Math.floor(hours), m = Math.round((hours - h) * 60);
  return `${h} jam ${m} menit`;
}

/* ── COST ESTIMATION ────────────────────────── */
function updateCostDisplay(fuelPct, powerKw, isOn) {
  const costPerHourEl = $('costPerHour');
  const costDailyEl = $('costDaily');
  if (!costPerHourEl || !costDailyEl) return;
  if (!isOn) {
    costPerHourEl.textContent = 'Rp 0';
    costDailyEl.textContent = 'Rp 0';
    return;
  }
  const consumptionLph = AVG_CONSUMPTION_LPH * (powerKw > 0.9 ? 1.3 : 1.0);
  const costPerHour = consumptionLph * FUEL_PRICE_PER_LITER;
  costPerHourEl.textContent = 'Rp ' + costPerHour.toLocaleString('id-ID');

  const now = Date.now();
  const elapsedMs = now - lastRuntimeUpdate;
  dailyActiveMs += (isOn ? elapsedMs : 0);
  dailyTotalCost += (isOn ? (costPerHour * (elapsedMs / 3600000)) : 0);
  lastRuntimeUpdate = now;
  costDailyEl.textContent = 'Rp ' + Math.round(dailyTotalCost).toLocaleString('id-ID');
}

/* ── MAIN VIEW UPDATE ───────────────────────── */
function updatePublicView(data) {
  initCharts();

  const volt    = Number(data.volt    || 0);
  const freq    = Number(data.freq    || 0);
  const current = Number(data.current || data.amp || 0);
  const fuel    = Number(data.fuel    || 0);
  const temp    = Number(data.temp    || data.coolant_temp || 0);
  const oil     = Number(data.oil     || data.oilPressure  || 0);
  const battV   = Number(data.battery || data.battVolt     || 0);
  const coolLvl = Number(data.coolantLevel || 0);
  const rpm     = Number(data.rpm || 0);
  const engH    = Number(data.engineHours || 0);
  const isOn    = String(data.status||'').toLowerCase()==='on' || rpm > 0;

  currentFuelLevel = fuel;
  currentPowerKw = volt*current/1000 || (isOn ? 0.6 : 0);
  updateCostDisplay(fuel, currentPowerKw, isOn);

  const voltOk = volt >= VOLT_LO && volt <= VOLT_HI;
  const freqOk = freq >= FREQ_LO && freq <= FREQ_HI;
  const elecOk = voltOk && freqOk && volt > 0;
  const syncTx = String(data.sync||'').toUpperCase();
  const syncOk = syncTx.includes('ON-GRID')||syncTx.includes('SYNC')||syncTx.includes('PLN')||syncTx.includes('GRID');
  const engineOk = (temp===0||temp<=95) && (oil===0||oil>=200);

  const source = detectSource(data, isOn);
  const sm     = SOURCE_META[source] || SOURCE_META.OFF;

  if (source !== previousSource) {
    const prevLabel = SOURCE_META[previousSource]?.label || previousSource;
    addEvent('source', `${prevLabel} → ${sm.label}`, source === 'GEN' ? 'warn' : source === 'OFF' ? 'err' : 'ok');
    previousSource = source;
  }

  if (fuel < 25 && !window._fuelLowWarned) {
    addEvent('fuel', 'Bahan bakar rendah (< 25%)', 'warn');
    window._fuelLowWarned = true;
  } else if (fuel >= 25) {
    window._fuelLowWarned = false;
  }

  /* Summary card */
  let summaryClass, summaryIconClass, summaryTitle, summaryDesc, summaryBadge;
  if (source === 'OFF') {
    summaryClass='err'; summaryIconClass='fas fa-power-off'; summaryTitle='Tidak Ada Sumber Listrik'; summaryDesc='PLN padam & generator belum menyala.'; summaryBadge='Gangguan';
  } else if (source === 'GEN') {
    summaryClass='warn'; summaryIconClass='fas fa-bolt'; summaryTitle=fuel<25?'Generator Aktif – BBM Rendah':'Generator Sedang Menyala'; summaryDesc=fuel<25?'Listrik tetap tersuplai, BBM terbatas.':'Listrik disuplai oleh generator.'; summaryBadge=fuel<25?'BBM Rendah':'Generator';
  } else if (source === 'HYBRID') {
    summaryClass='ok'; summaryIconClass='fas fa-check-circle'; summaryTitle='Listrik Normal (Hybrid)'; summaryDesc='PLN dan generator bekerja bersama.'; summaryBadge='Optimal';
  } else if (elecOk) {
    summaryClass='ok'; summaryIconClass='fas fa-check-circle'; summaryTitle='Listrik Normal'; summaryDesc='PLN stabil, generator siaga.'; summaryBadge='Normal';
  } else {
    summaryClass='warn'; summaryIconClass='fas fa-triangle-exclamation'; summaryTitle='Kualitas Listrik Kurang Baik'; summaryDesc='PLN berfluktuasi.'; summaryBadge='Fluktuasi';
  }
  const sc = $('summaryCard'); if(sc) sc.className = 'summary-card ' + summaryClass;
  const si = $('summaryIcon'); if(si) si.className = summaryIconClass + ' summary-icon';
  if($('summaryTitle')) $('summaryTitle').textContent = summaryTitle;
  if($('summaryDesc'))  $('summaryDesc').textContent  = summaryDesc;
  if($('summaryBadge')) { $('summaryBadge').textContent = summaryBadge; $('summaryBadge').className = 'summary-badge ' + summaryClass; }

  /* Hero */
  const heroCard = $('heroCard'); if(heroCard) heroCard.className = 'hero-card ' + sm.cls;
  if($('heroIconI')) $('heroIconI').className = sm.icon;
  if($('heroSourceName')) $('heroSourceName').textContent = sm.label;
  if($('heroSourceSub'))  $('heroSourceSub').textContent  = sm.sub;
  if($('heroEstRuntime')) $('heroEstRuntime').textContent = calcRuntime(fuel, currentPowerKw);

  /* Electric */
  if($('mVolt')) $('mVolt').textContent = volt>0?volt.toFixed(1):'--';
  if($('mFreq')) $('mFreq').textContent = freq>0?freq.toFixed(2):'--';
  if($('mAmp'))  $('mAmp').textContent  = current>0?current.toFixed(1):'--';
  if($('mPow'))  $('mPow').textContent  = currentPowerKw>0?currentPowerKw.toFixed(2):'--';
  if($('mVoltHint')) $('mVoltHint').textContent = voltOk?'✓ Tegangan normal':volt>0?'⚠ Di luar batas':'Tidak terdeteksi';
  if($('mFreqHint')) $('mFreqHint').textContent = freqOk?'✓ Frekuensi stabil':freq>0?'⚠ Belum stabil':'Tidak terdeteksi';
  if($('mAmpHint'))  $('mAmpHint').textContent  = current>0?`${((current/16)*100).toFixed(0)}% kapasitas`:'Tidak ada beban';
  if($('mPowHint'))  $('mPowHint').textContent  = currentPowerKw>0?`${((currentPowerKw/1.3)*100).toFixed(0)}% kapasitas`:'Tidak ada konsumsi';
  setMetricBar('mVoltBar','mcVolt', volt, VOLT_LO, VOLT_HI, 260);
  setMetricBar('mFreqBar','mcFreq', freq, FREQ_LO, FREQ_HI, 55);
  setMetricBar('mAmpBar', 'mcAmp',  current, 0, 14, 20);
  setMetricBar('mPowBar', 'mcPow',  currentPowerKw, 0, 1.1, 1.3);

  const eb = $('electricBadge');
  if(eb){ if(!volt){eb.textContent='Tidak Aktif';eb.className='sh-b';setNavDot('navDot-electric','err');}else if(elecOk){eb.textContent='Stabil';eb.className='sh-b ok';setNavDot('navDot-electric','ok');}else{eb.textContent='Tidak Stabil';eb.className='sh-b warn';setNavDot('navDot-electric','warn');} }

  const tsLabel = `${new Date().getHours().toString().padStart(2,'0')}:${new Date().getMinutes().toString().padStart(2,'0')}:${new Date().getSeconds().toString().padStart(2,'0')}`;
  if(volt>0||freq>0) pushTrend(volt, freq, tsLabel);

  /* Engine */
  const rpmPct  = clamp(rpm / RPM_MAX, 0, 1);
  const tempPct = clamp(temp / TEMP_MAX, 0, 1);
  setArc('rpmArc',  rpmPct,  '#1f4191', '#d97706', '#dc2626');
  setArc('tempArc', tempPct, '#10b981', '#d97706', '#dc2626');
  if($('rpmVal'))  $('rpmVal').textContent  = rpm>0?rpm.toFixed(0):'0';
  if($('tempVal')) $('tempVal').textContent = temp>0?temp.toFixed(0):'0';
  const rpmStatusEl=$('rpmStatus'); const tempStatusEl=$('tempStatus');
  if(rpmStatusEl){ const rs=!isOn?'Standby':rpmPct>0.9?'Kritis':rpmPct>0.7?'Tinggi':'Normal'; rpmStatusEl.textContent=rs; rpmStatusEl.className='gc-status'+(rpmPct>0.9?' err':rpmPct>0.7?' warn':''); }
  if(tempStatusEl){ const ts=!isOn?'Dingin':tempPct>.85?'Overheat':tempPct>.7?'Panas':'Normal'; tempStatusEl.textContent=ts; tempStatusEl.className='gc-status'+(tempPct>.85?' err':tempPct>.7?' warn':''); }

  const oilOk=oil===0||(oil>=200&&oil<=600), coolOk=coolLvl===0||coolLvl>=30, battOk=battV===0||(battV>=12.0&&battV<=15.0);
  const loadPct=currentPowerKw>0?Math.round((currentPowerKw/1.3)*100):0, loadOk=loadPct===0||(loadPct>=60&&loadPct<=90);
  if($('esOilVal'))$('esOilVal').textContent=oil>0?oil.toFixed(0)+' kPa':'--';
  if($('esCoolantVal'))$('esCoolantVal').textContent=coolLvl>0?coolLvl.toFixed(0)+'%':'--';
  if($('esBattVal'))$('esBattVal').textContent=battV>0?battV.toFixed(1)+' V':'--';
  if($('esLoadVal'))$('esLoadVal').textContent=loadPct>0?loadPct+'%':'--';
  setDot('esOilDot',oilOk?'ok':'warn'); setDot('esCoolantDot',coolOk?'ok':'warn'); setDot('esBattDot',battOk?'ok':battV>0?'err':''); setDot('esLoadDot',loadOk?'ok':loadPct>90?'warn':'');

  const engBadge=$('engineBadge'); const engOverall=engineOk&&battOk&&coolOk;
  if(engBadge){ if(!isOn){engBadge.textContent='Standby';engBadge.className='sh-b';setNavDot('navDot-engine','ok');}else if(engOverall){engBadge.textContent='Berjalan Normal';engBadge.className='sh-b ok';setNavDot('navDot-engine','ok');}else{engBadge.textContent='Perlu Diperiksa';engBadge.className='sh-b warn';setNavDot('navDot-engine','warn');} }

  updateDonut(engH);

  const weeklyHours = Array.isArray(data.weeklyUptime) && data.weeklyUptime.length===7 ? data.weeklyUptime : [0,0,0,0,0,0,0];
  if(uptimeChart && weeklyHours.length===7){ uptimeChart.data.datasets[0].data=weeklyHours; uptimeChart.update('none'); }
  if($('weeklyTotal')) $('weeklyTotal').textContent=weeklyHours.reduce((a,b)=>a+b,0).toFixed(1)+' jam';

  /* Fuel */
  const fuelEl=$('fuelBarFill'); if(fuelEl)fuelEl.style.width=clamp(fuel,0,100)+'%';
  if($('fuelPct'))$('fuelPct').textContent=fuel>0?fuel.toFixed(0)+'%':'--%';
  let fuelRt; if(!isOn)fuelRt='Generator tidak aktif'; else if(fuel>=75)fuelRt='> 8 jam'; else if(fuel>=50)fuelRt='6–8 jam'; else if(fuel>=25)fuelRt='3–6 jam'; else if(fuel>=10)fuelRt='< 3 jam'; else fuelRt='KRITIS';
  if($('fuelRuntime'))$('fuelRuntime').textContent=fuelRt;

  const fuelBadge=$('fuelBadge'); let fuelSt;
  if(fuel>=50){fuelSt='ok';fuelBadge&&(fuelBadge.className='sh-b ok',fuelBadge.textContent='Aman');}else if(fuel>=25){fuelSt='warn';fuelBadge&&(fuelBadge.className='sh-b warn',fuelBadge.textContent='Pantau');}else{fuelSt='err';fuelBadge&&(fuelBadge.className='sh-b err',fuelBadge.textContent='Rendah');}
  setNavDot('navDot-fuel',fuelSt);
  if($('fuelStatusText'))$('fuelStatusText').textContent=fuelSt==='ok'?'Aman':fuelSt==='warn'?'Perlu Dipantau':'Level Kritis';
  const fa=$('fuelAdvice'); if(fa){ fa.className='fuel-advice '+fuelSt; const fai=fa.querySelector('.fai'); if(fai)fai.className='fas fa-'+(fuelSt==='ok'?'circle-info':'triangle-exclamation')+' fai';
    if($('fuelAdviceText'))$('fuelAdviceText').textContent=fuel>=50?'Bahan bakar cukup.':'Bahan bakar rendah! Segera lakukan pengisian.'; }

  const { maintStatus } = buildMaintenanceSection(data, engH);

  setHealthRow('hcPLNDot','hcPLNBadge','hcPLNDesc','hcPLN', !volt?'err':elecOk?'ok':'warn', !volt?'Tidak Aktif':elecOk?'Stabil':'Tidak Stabil', !volt?'Tidak ada sinyal PLN':elecOk?'Tegangan & frekuensi normal':'Tegangan/frekuensi di luar batas');
  setHealthRow('hcGenDot','hcGenBadge','hcGenDesc','hcGen', !isOn?'ok':engOverall?'ok':'warn', !isOn?'Siaga':engOverall?'Berjalan Normal':'Perlu Periksa', !isOn?'Siap diaktifkan otomatis':engOverall?'Semua parameter normal':'Ada parameter di luar batas');
  setHealthRow('hcSyncDot','hcSyncBadge','hcSyncDesc','hcSync', isOn&&syncOk?'ok':isOn?'warn':'ok', isOn&&syncOk?'Tersinkron':isOn?'Menyinkronkan':'Siaga', '');
  setHealthRow('hcAutoDot','hcAutoBadge','hcAutoDesc','hcAuto', elecOk||!isOn?'ok':'warn', elecOk||!isOn?'Aktif Normal':'Menyesuaikan', 'ATS bekerja normal');
  setHealthRow('hcEngineDot','hcEngineBadge','hcEngineDesc','hcEngine', !isOn?'ok':engOverall?'ok':'warn', !isOn?'Standby':engOverall?'Sehat':'Perlu Cek', '');
  setHealthRow('hcMaintDot','hcMaintBadge','hcMaintDesc','hcMaint', maintStatus, maintStatus==='ok'?'Terjadwal':maintStatus==='warn'?'Segera':'Terlambat', '');

  const allOk=elecOk&&engineOk&&fuel>=25&&maintStatus!=='err';
  const sysDot=$('sbSysDot'); const sysLabel=$('sbSysLabel');
  if(sysDot)sysDot.className='ssb-dot '+(allOk?'ok':fuel<10||maintStatus==='err'?'err':'warn');
  if(sysLabel)sysLabel.textContent=allOk?'Semua Sistem Normal':'Ada yang Perlu Diperhatikan';

  const { msg, tips } = buildMessageTips({ source, elecOk, volt, fuel, isOn, engineOk, maintStatus, syncOk });
  if($('publicMessage')){ const p=$('publicMessage'); p.textContent=msg; p.className=source==='GEN'?'warn':source==='OFF'?'err':''; }
  const tl=$('publicTips'); if(tl){ tl.innerHTML=tips.map(t=>`<li><i class="${t.icon}${t.warn?' warn':t.err?' err':''}"></i><span>${t.text}</span></li>`).join(''); }
  if($('lastUpdate')) $('lastUpdate').innerHTML=`<i class="fas fa-clock"></i> Diperbarui: ${fmt(data.timestamp||new Date().toISOString())}`;
}

/* ── MESSAGE & TIPS BUILDER ─────────────────── */
function buildMessageTips({ source, elecOk, volt, fuel, isOn, engineOk, maintStatus, syncOk }) {
  const tips=[]; let msg;
  if(source==='OFF'){ msg='Tidak ada sumber listrik. Generator akan menyala otomatis.'; tips.push({icon:'fas fa-lightbulb',text:'Simpan pekerjaan penting.'});}
  else if(source==='GEN'){ msg=fuel<25?'Generator aktif, BBM rendah.':'Generator menyuplai listrik.'; tips.push({icon:'fas fa-check-circle',text:'Generator aktif.'});}
  else if(source==='HYBRID'){ msg='Mode hybrid aktif. Kualitas optimal.'; tips.push({icon:'fas fa-circle-check',text:'PLN dan generator bekerja bersama.'});}
  else if(!elecOk&&volt>0){ msg='Listrik PLN berfluktuasi.'; tips.push({icon:'fas fa-triangle-exclamation',warn:true,text:'Hindari peralatan sensitif.'});}
  else{ msg='Semua sistem normal.'; tips.push({icon:'fas fa-circle-check',text:'Listrik stabil.'});}
  if(!engineOk&&isOn)tips.push({icon:'fas fa-wrench',warn:true,text:'Parameter mesin perlu diperiksa.'});
  if(maintStatus==='err')tips.push({icon:'fas fa-screwdriver-wrench',warn:true,text:'Komponen melewati jadwal servis.'});
  if(maintStatus==='warn')tips.push({icon:'fas fa-calendar-check',text:'Servis rutin akan segera tiba.'});
  if(fuel>=25&&fuel<50)tips.push({icon:'fas fa-gas-pump',text:'Pengisian BBM segera dijadwalkan.'});
  if(tips.length<3){ tips.push({icon:'fas fa-leaf',text:'Matikan peralatan tidak terpakai.'}); tips.push({icon:'fas fa-bell',text:'Hubungi petugas jika ada gangguan.'}); }
  return {msg, tips};
}

/* ── FETCH DATA (fallback) ──────────────────── */
async function loadPublicData() {
  const btn=$('refreshPublic'), lbEl=$('liveBadge');
  if(btn)btn.classList.add('spinning');
  try {
    const [latestRes, decisionRes, activeTimeRes] = await Promise.all([
      fetch('/api/engine-data/latest'),
      fetch('/api/maintenance/suggestion'),
      fetch('/api/generator-active-time/history?limit=400')
    ]);
    if(!latestRes.ok) throw new Error('HTTP '+latestRes.status);
    const json=await latestRes.json();
    const decisionJson=decisionRes.ok?await decisionRes.json():null;
    const activeTimeJson=activeTimeRes.ok?await activeTimeRes.json():null;
    const mergedData={ ...(json?.data||{}), weeklyUptimeHistory:activeTimeJson?.data||[] };
    updatePublicView(mergedData);
    updateDecisionView(decisionJson?.data||null, decisionJson?.suggestion||null);
    if(lbEl){lbEl.style.background='var(--ok-bg)';lbEl.style.color='var(--ok)';lbEl.style.borderColor='var(--ok-border)';}
  } catch(e){ console.warn('Fetch error:',e); if(lbEl){lbEl.style.background='var(--err-bg)';lbEl.style.color='var(--err)';lbEl.style.borderColor='var(--err-bdr)';} }
  finally { if(btn)btn.classList.remove('spinning'); }
}

function updateDecisionView(decision, suggestion) {
  latestDecisionPayload=decision||null;
  const status=decision?.status||'-';
  if($('decisionStatusText'))$('decisionStatusText').textContent=status;
  if($('decisionMessageText'))$('decisionMessageText').textContent=decision?.message||'Belum ada data.';
  if($('decisionRecommendationText'))$('decisionRecommendationText').textContent=decision?.recommendation||'-';
  const badge=$('decisionBadge'); if(badge){badge.className='sh-b';badge.textContent=status==='-'?'Tidak tersedia':status; if(status==='AMAN')badge.classList.add('ok');else if(status==='WASPADA')badge.classList.add('warn');else if(status==='BAHAYA')badge.classList.add('err');}
  setNavDot('navDot-decision',status==='BAHAYA'?'err':status==='WASPADA'?'warn':'ok');
  const approveBtn=$('approveDecisionBtn'); const infoEl=$('decisionApproveInfo');
  if(!approveBtn)return;
  const alreadyPending=suggestion?.status==='pending';
  approveBtn.disabled=!decision||alreadyPending;
  approveBtn.textContent=alreadyPending?'Sudah Disetujui':'Setujui';
  if(infoEl)infoEl.textContent=alreadyPending?'Saran sudah masuk halaman teknisi.':'Setujui untuk kirim ke teknisi.';
}

async function approveDecision() {
  if(!latestDecisionPayload)return;
  const approveBtn=$('approveDecisionBtn'), infoEl=$('decisionApproveInfo');
  if(approveBtn)approveBtn.disabled=true;
  try{ const res=await fetch('/api/maintenance/suggestion',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'approve',decision:latestDecisionPayload})}); if(!res.ok)throw new Error(`HTTP ${res.status}`); if(infoEl)infoEl.textContent='Saran berhasil dikirim.'; loadPublicData(); }
  catch(err){ console.error(err); if(infoEl)infoEl.textContent='Gagal kirim saran.'; if(approveBtn)approveBtn.disabled=false; }
}

/* ── MQTT INTEGRATION ───────────────────────── */
function connectMQTT() {
  if (typeof mqtt === 'undefined') {
    console.warn('MQTT.js belum siap, coba lagi nanti');
    return;
  }
  const brokerUrl = 'wss://broker.shiftr.io';
  const options = {
    clientId: 'gen-track-public-' + Math.random().toString(16).substr(2, 8),
    clean: true,
    connectTimeout: 4000,
    reconnectPeriod: 3000,
  };
  mqttClient = mqtt.connect(brokerUrl, options);

  mqttClient.on('connect', () => {
    console.log('MQTT connected');
    mqttClient.subscribe(['genset/voltage','genset/current','genset/power','genset/temp','genset/fuel','genset/status'], (err) => {
      if (err) console.error('Subscribe error:', err);
    });
  });

  mqttClient.on('message', (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());
      const topicKey = topic.split('/')[1]; // voltage, current, etc.
      let updateData = {};
      if (topicKey === 'voltage') updateData.volt = Number(payload.voltage || payload.value || payload);
      else if (topicKey === 'current') updateData.current = Number(payload.current || payload.value || payload);
      else if (topicKey === 'power') updateData.power = Number(payload.power || payload.value || payload);
      else if (topicKey === 'temp') updateData.temp = Number(payload.temp || payload.temperature || payload.value || payload);
      else if (topicKey === 'fuel') updateData.fuel = Number(payload.fuel || payload.value || payload);
      else if (topicKey === 'status') updateData.status = String(payload.status || payload.value || payload);
      if (Object.keys(updateData).length > 0) {
        // merge with current (we keep a global data object)
        if (!window._mqttData) window._mqttData = {};
        Object.assign(window._mqttData, updateData);
        updatePublicView(window._mqttData);
      }
    } catch (e) {
      console.warn('MQTT parse error:', e);
    }
  });

  mqttClient.on('error', (err) => console.error('MQTT error:', err));
  mqttClient.on('reconnect', () => console.log('MQTT reconnecting...'));
  mqttClient.on('close', () => console.log('MQTT disconnected'));
}

/* ── SIDEBAR & SCROLL SPY ──────────────────── */
function initSidebar() {
  const menu=$('menuBtn'), overlay=$('sbOverlay');
  const open=()=>document.body.classList.add('sb-open');
  const close=()=>document.body.classList.remove('sb-open');
  if(menu)menu.addEventListener('click',open);
  if(overlay)overlay.addEventListener('click',close);
  document.querySelectorAll('.sb-link').forEach(a=>a.addEventListener('click',close));
}

function initScrollSpy() {
  const sectionIds=['summarySection','electricSection','engineSection','lifespanSection','fuelSection','maintenanceSection','decisionSection','healthSection','eventLogSection','infoSection'];
  const links=document.querySelectorAll('.sb-link');
  const obs=new IntersectionObserver(entries=>{ entries.forEach(e=>{ if(e.isIntersecting) links.forEach(a=>a.classList.toggle('active',a.dataset.section===e.target.id));}); },{threshold:0.35});
  sectionIds.forEach(id=>{const el=$(id);if(el)obs.observe(el);});
}

/* ── BOOT ────────────────────────────────────── */
initSidebarUser();
initSidebar();
initScrollSpy();

if (typeof Chart !== 'undefined') initCharts();
else window.addEventListener('load', initCharts);

// Initial data & MQTT
loadPublicData();
connectMQTT();
setInterval(loadPublicData, 30_000); // periodic fallback

$('refreshPublic')?.addEventListener('click', loadPublicData);
$('approveDecisionBtn')?.addEventListener('click', approveDecision);
$('logoutPublic')?.addEventListener('click', ()=>{ localStorage.clear(); window.location.replace('login.html'); });