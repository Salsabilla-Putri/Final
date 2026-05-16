/**
 * public/js/cbm_panel.js
 * ============================================================
 * Condition-Based Maintenance (CBM) Panel
 *
 * Cara penggunaan:
 *  1. Tambahkan <div id="cbmPanelContainer"></div> di reports.html
 *  2. Load script SETELAH reports.js:
 *     <script src="js/cbm_panel.js"></script>
 *
 * Panel otomatis di-render dan di-refresh setiap kali:
 *  - Halaman selesai load
 *  - reports.js memanggil _triggerCbmRefresh() setelah data dimuat
 *  - Tombol "Analisis Sekarang" diklik
 *  - Tombol "+ FFT Peaks" diklik (kirim peaks ke server)
 * ============================================================
 */

/* global selectedSensors, currentData, getReportDeviceId, fftChart */

(function CBMPanel() {
    'use strict';

    const CBM_API     = '/api/cbm/analysis';
    const SUGGEST_API = '/api/cbm/suggestion';

    const LEVEL = {
        critical: { label: 'KRITIS',  color: '#dc2626', bg: '#fef2f2', border: '#fca5a5', icon: '🔴' },
        warn:     { label: 'WASPADA', color: '#ea580c', bg: '#fff7ed', border: '#fdba74', icon: '🟠' },
        watch:    { label: 'PANTAU',  color: '#ca8a04', bg: '#fefce8', border: '#fde68a', icon: '🟡' },
        ok:       { label: 'NORMAL',  color: '#16a34a', bg: '#f0fdf4', border: '#86efac', icon: '🟢' },
    };

    const URGENCY = {
        overdue:    { label: 'TERLAMBAT', color: '#dc2626' },
        'due-now':  { label: 'SEGERA',    color: '#ea580c' },
        'due-soon': { label: 'MENDEKATI', color: '#ca8a04' },
        scheduled:  { label: 'TERJADWAL', color: '#6b7280' },
    };

    let _loading    = false;
    let _lastResult = null;

    // ── HTML TEMPLATE ─────────────────────────────────────────────────────────
    function buildHTML() {
        return `
<style>
  #cbmPanel * { box-sizing: border-box; }
  #cbmPanel .cbm-card {
    background: #fff;
    border-radius: 14px;
    border: 1px solid #e8edf3;
    box-shadow: 0 2px 8px rgba(15,23,42,.07), 0 0 1px rgba(15,23,42,.04);
  }
  #cbmPanel .cbm-card-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .1em;
    color: #94a3b8;
    text-transform: uppercase;
    margin-bottom: 14px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  #cbmPanel .cbm-card-label::after {
    content: '';
    flex: 1;
    height: 1px;
    background: #f1f5f9;
  }
  #cbmRefreshBtn:hover  { background: #1238a0 !important; }
  #cbmSendFftBtn:hover  { background: #0284c7 !important; }
  #cbmRefreshBtn, #cbmSendFftBtn { transition: background .18s; }
  .cbm-finding-card { transition: box-shadow .18s; }
  .cbm-finding-card:hover { box-shadow: 0 4px 14px rgba(15,23,42,.1) !important; }
  .cbm-approve-btn:hover { background: #15803d !important; }
  .cbm-reject-btn:hover  { background: #dc2626 !important; }
  @media (max-width: 800px) {
    #cbmMainGrid { grid-template-columns: 1fr !important; }
    #cbmLeftPanel { flex-direction: row !important; gap: 10px !important; }
    #cbmHealthCard { min-width: 0 !important; flex: 1 !important; }
    #cbmComponentCard { flex: 2 !important; }
  }
</style>

<section id="cbmPanel" style="margin-top:24px;font-family:inherit;">

  <!-- ── HEADER ── -->
  <div style="display:flex;align-items:center;justify-content:space-between;
              margin-bottom:18px;flex-wrap:wrap;gap:10px;">
    <div style="display:flex;align-items:center;gap:12px;">
        <i class="fas fa-cogs" style="font-size:18px;color:#1d4ed8;"></i>
        <h2 style="margin:0;font-size:16px;font-weight:700;color:#0f172a;line-height:1.3;">
          Condition-Based Maintenance
        </h2>
      </div>
    </div>

  <!-- ── LOADING ── -->
  <div id="cbmLoading"
       style="display:none;padding:32px;text-align:center;color:#64748b;font-size:13px;">
    <i class="fas fa-spinner fa-spin" style="font-size:20px;color:#1d4ed8;margin-bottom:8px;display:block;"></i>
    Menganalisis data sensor...
  </div>

  <!-- ── CONTENT ── -->
  <div id="cbmContent" style="display:none;">

    <!-- MAIN GRID: Left (health + komponen) | Right (findings) -->
    <div id="cbmMainGrid" style="display:grid;grid-template-columns:260px 1fr;gap:14px;margin-bottom:14px;align-items:start;">

      <!-- LEFT PANEL -->
      <div id="cbmLeftPanel" style="display:flex;flex-direction:column;gap:14px;">

        <!-- Health Score Card -->
        <div id="cbmHealthCard" class="cbm-card" style="padding:20px 16px;text-align:center;">
          <div class="cbm-card-label">Health Score</div>
          <div style="position:relative;width:130px;height:130px;margin:0 auto 14px;">
            <canvas id="cbmHealthCanvas" width="130" height="130"></canvas>
            <div style="position:absolute;inset:0;display:flex;flex-direction:column;
                        align-items:center;justify-content:center;line-height:1.1;">
              <div id="cbmScoreNum" style="font-size:32px;font-weight:800;color:#0f172a;">--</div>
              <div style="font-size:11px;color:#94a3b8;font-weight:500;">/100</div>
            </div>
          </div>
          <span id="cbmStatusBadge"
                style="display:inline-block;padding:4px 16px;border-radius:99px;
                       font-size:12px;font-weight:700;letter-spacing:.04em;
                       background:#e2e8f0;color:#475569;">---</span>
        </div>

        <!-- Component Health Card -->
        <div id="cbmComponentCard" class="cbm-card" style="padding:18px 16px;">
          <div class="cbm-card-label">Status Komponen</div>
          <div id="cbmComponentGrid" style="display:flex;flex-direction:column;gap:7px;"></div>
        </div>

      </div><!-- /LEFT PANEL -->

      <!-- RIGHT PANEL: Findings -->
      <div class="cbm-card" style="padding:20px 18px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
          <div class="cbm-card-label" style="margin-bottom:0;">Rekomendasi CBM</div>
          <span id="cbmFindingCount"
                style="font-size:11px;font-weight:600;color:#64748b;background:#f1f5f9;
                       padding:2px 10px;border-radius:99px;"></span>
        </div>
        <div id="cbmFindingsEmpty"
             style="display:none;padding:30px 0;text-align:center;color:#94a3b8;font-size:13px;">
          <div style="font-size:28px;margin-bottom:8px;">✅</div>
          Tidak ada anomali terdeteksi pada rentang waktu ini.
        </div>
        <div id="cbmFindingsList" style="display:flex;flex-direction:column;gap:10px;"></div>
      </div><!-- /RIGHT PANEL -->

    </div><!-- /MAIN GRID -->

  </div><!-- /cbmContent -->
</section>`;
    }

    // ── HEALTH RING ───────────────────────────────────────────────────────────
    function renderHealthRing(score) {
        const canvas = document.getElementById('cbmHealthCanvas');
        if (!canvas) return;
        const ctx   = canvas.getContext('2d');
        const size  = 130;
        const cx = size / 2, cy = size / 2, r = 54, lw = 11;
        const start = -Math.PI / 2;
        const end   = start + (score / 100) * 2 * Math.PI;
        const color = score >= 80 ? '#16a34a' : score >= 55 ? '#ea580c' : '#dc2626';
        const trackColor = score >= 80 ? '#dcfce7' : score >= 55 ? '#fff7ed' : '#fef2f2';

        ctx.clearRect(0, 0, size, size);
        // Track
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        ctx.strokeStyle = trackColor; ctx.lineWidth = lw; ctx.stroke();
        // Arc
        ctx.beginPath(); ctx.arc(cx, cy, r, start, end);
        ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.stroke();

        const numEl = document.getElementById('cbmScoreNum');
        if (numEl) { numEl.textContent = score; numEl.style.color = color; }
    }

    function renderStatusBadge(status) {
        const badge  = document.getElementById('cbmStatusBadge');
        if (!badge) return;
        const colors = {
            AMAN:    { bg: '#dcfce7', color: '#15803d' },
            WASPADA: { bg: '#fef9c3', color: '#a16207' },
            BAHAYA:  { bg: '#fee2e2', color: '#b91c1c' }
        };
        const c = colors[status] || { bg: '#e2e8f0', color: '#475569' };
        badge.textContent = status;
        badge.style.background = c.bg;
        badge.style.color = c.color;
    }

    // ── COMPONENT HEALTH ──────────────────────────────────────────────────────
    function renderComponentHealth(componentHealth) {
        const grid = document.getElementById('cbmComponentGrid');
        if (!grid) return;
        grid.innerHTML = Object.entries(componentHealth).map(([comp, level]) => {
            const m = LEVEL[level] || LEVEL.ok;
            return `
            <div style="display:flex;align-items:center;gap:9px;padding:8px 11px;
                        background:${m.bg};border-radius:9px;border:1px solid ${m.border};">
                <span style="font-size:15px;flex-shrink:0;">${m.icon}</span>
                <div style="flex:1;min-width:0;">
                    <div style="font-size:12px;font-weight:600;color:#1e293b;
                                white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${comp}</div>
                </div>
                <span style="font-size:10px;font-weight:700;color:${m.color};
                             background:${m.color}18;padding:2px 7px;border-radius:99px;
                             flex-shrink:0;">${m.label}</span>
            </div>`;
        }).join('');
    }

    // ── FINDINGS ──────────────────────────────────────────────────────────────
    function renderFindings(findings) {
        const list  = document.getElementById('cbmFindingsList');
        const empty = document.getElementById('cbmFindingsEmpty');
        if (!list || !empty) return;

        if (!findings.length) {
            list.innerHTML = ''; empty.style.display = 'block'; return;
        }
        empty.style.display = 'none';

        list.innerHTML = findings.map((f, idx) => {
            const m        = LEVEL[f.level] || LEVEL.ok;
            const isRising = (f.trend?.slopePerHour ?? 0) >= 0;
            const slopeAbs = Math.abs(f.trend?.slopePerHour ?? 0).toFixed(3);
            const priorityColors = {
                high:   { bg: '#fef2f2', color: '#dc2626', label: 'HIGH' },
                medium: { bg: '#fffbeb', color: '#d97706', label: 'MED' },
                low:    { bg: '#f0fdf4', color: '#16a34a', label: 'LOW' },
            };
            const pc = priorityColors[(f.priority || 'medium').toLowerCase()] || priorityColors.medium;

            return `
            <div class="cbm-finding-card" data-idx="${idx}"
                 style="border:1px solid ${m.border};border-left:4px solid ${m.color};
                        border-radius:10px;padding:14px 15px;background:#fff;
                        box-shadow:0 1px 4px rgba(15,23,42,.06);">

              <!-- Top row: title + badges + actions -->
              <div style="display:flex;align-items:flex-start;gap:10px;justify-content:space-between;
                          flex-wrap:wrap;margin-bottom:9px;">
                <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;flex:1;min-width:0;">
                  <span style="font-size:15px;">${m.icon}</span>
                  <span style="font-weight:700;font-size:13px;color:#0f172a;">${f.component}</span>
                  <span style="padding:2px 9px;border-radius:99px;font-size:10.5px;font-weight:700;
                               background:${m.color}18;color:${m.color};">${m.label}</span>
                  <span style="padding:2px 9px;border-radius:99px;font-size:10.5px;font-weight:700;
                               background:#e0e7ff;color:#3730a3;">
                      ${f.type || 'Corrective'}
                  </span>
                  <span style="padding:2px 9px;border-radius:99px;font-size:10.5px;font-weight:700;
                               background:${pc.bg};color:${pc.color};">
                      ${pc.label}
                  </span>
                </div>
                <div style="display:flex;gap:6px;flex-shrink:0;">
                    <button class="cbm-approve-btn" data-idx="${idx}"
                            style="padding:6px 12px;background:#16a34a;color:#fff;border:none;
                                   border-radius:7px;cursor:pointer;font-size:11.5px;font-weight:600;
                                   white-space:nowrap;transition:background .18s;">✅ Setujui</button>
                    <button class="cbm-reject-btn" data-idx="${idx}"
                            style="padding:6px 12px;background:#f1f5f9;color:#ef4444;border:1px solid #fca5a5;
                                   border-radius:7px;cursor:pointer;font-size:11.5px;font-weight:600;
                                   white-space:nowrap;transition:background .18s;">✕ Tolak</button>
                </div>
              </div>

              <!-- Action text -->
              <div style="font-size:13px;font-weight:600;color:#1e293b;margin-bottom:4px;">
                ${f.action}
              </div>
              <div style="font-size:12px;color:#64748b;margin-bottom:10px;line-height:1.5;">
                ${f.details}
              </div>

              <!-- Metrics row -->
              ${f.sensor !== 'rpm_fft' ? `
              <div style="display:flex;gap:0;flex-wrap:wrap;background:#f8fafc;
                          border-radius:8px;overflow:hidden;border:1px solid #f1f5f9;">
                ${[
                  ['Sensor', `<b>${(f.sensor||'').toUpperCase()}</b>`],
                  ['Terkini', `<b>${f.trend?.latest ?? '--'}</b>`],
                  ['Tren', `<span style="color:${isRising?'#dc2626':'#16a34a'};font-weight:700;">${isRising?'▲':'▼'} ${slopeAbs}/jam</span>`],
                  ['R²', `<b>${f.trend?.r2 ?? '--'}</b>`],
                  ['CV', `<b>${f.trend?.cv ?? '--'}%</b>`],
                  ['Keyakinan', `<b>${f.confidence ?? '--'}%</b>`],
                ].map(([k,v]) => `
                  <div style="padding:6px 12px;border-right:1px solid #f1f5f9;white-space:nowrap;">
                    <div style="font-size:10px;color:#94a3b8;margin-bottom:1px;">${k}</div>
                    <div style="font-size:12px;color:#374151;">${v}</div>
                  </div>`).join('')}
              </div>` : `
              <div style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;
                          background:#f0f9ff;border-radius:6px;border:1px solid #bae6fd;">
                <i class="fas fa-wave-square" style="color:#0ea5e9;font-size:11px;"></i>
                <span style="font-size:11px;color:#0369a1;font-weight:500;">Sumber: FFT Spectrum Analysis</span>
              </div>`}
            </div>`;
        }).join('');

        // Update count badge
        const countEl = document.getElementById('cbmFindingCount');
        if (countEl) countEl.textContent = findings.length ? `${findings.length} temuan` : '';

        list.querySelectorAll('.cbm-approve-btn').forEach(btn => {
            btn.addEventListener('click', async function () {
                const finding = findings[parseInt(this.dataset.idx, 10)];
                await handleApproveFinding(finding, this);
            });
        });
        list.querySelectorAll('.cbm-reject-btn').forEach(btn => {
            btn.addEventListener('click', function () {
                const card = this.closest('.cbm-finding-card');
                if (card) card.remove();
                // Jika semua kartu hilang, tampilkan pesan kosong
                if (!list.querySelector('.cbm-finding-card')) {
                    const empty = document.getElementById('cbmFindingsEmpty');
                    if (empty) empty.style.display = 'block';
                }
                const remaining = list.querySelectorAll('.cbm-finding-card').length;
                const countEl = document.getElementById('cbmFindingCount');
                if (countEl) countEl.textContent = remaining ? `${remaining} temuan` : '';
            });
        });
    }

    // ── PREVENTIVE SCHEDULE ───────────────────────────────────────────────────
    function renderPreventive(schedule, totalHours) {
        const list  = document.getElementById('cbmPreventiveList');
        const empty = document.getElementById('cbmPreventiveEmpty');
        const tag   = document.getElementById('cbmTotalHoursTag');
        if (!list || !empty) return;

        if (tag) tag.textContent = `${(totalHours ?? 0).toFixed(1)} jam operasi`;

        if (!schedule.length) {
            list.innerHTML = ''; empty.style.display = 'block'; return;
        }
        empty.style.display = 'none';

        list.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead><tr style="background:#f8fafc;border-bottom:2px solid #e8edf3;">
            <th style="padding:9px 12px;color:#64748b;font-size:10.5px;font-weight:700;
                       text-align:left;letter-spacing:.06em;text-transform:uppercase;">Komponen</th>
            <th style="padding:9px 12px;color:#64748b;font-size:10.5px;font-weight:700;
                       text-align:left;letter-spacing:.06em;text-transform:uppercase;">Tugas</th>
            <th style="padding:9px 12px;color:#64748b;font-size:10.5px;font-weight:700;
                       text-align:center;letter-spacing:.06em;text-transform:uppercase;">Interval</th>
            <th style="padding:9px 12px;color:#64748b;font-size:10.5px;font-weight:700;
                       text-align:center;letter-spacing:.06em;text-transform:uppercase;">Sisa Jam</th>
            <th style="padding:9px 12px;color:#64748b;font-size:10.5px;font-weight:700;
                       text-align:center;letter-spacing:.06em;text-transform:uppercase;">Status</th>
            <th style="padding:9px 12px;"></th>
          </tr></thead>
          <tbody>
            ${schedule.map((s, idx) => {
                const um       = URGENCY[s.urgency] || URGENCY.scheduled;
                const barColor = s.urgency === 'overdue'   ? '#dc2626'
                               : s.urgency === 'due-now'   ? '#ea580c'
                               : s.urgency === 'due-soon'  ? '#ca8a04' : '#16a34a';
                const pct      = Math.min(100, s.percentDue ?? 0);
                return `
                <tr style="border-bottom:1px solid #f1f5f9;transition:background .15s;"
                    onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
                  <td style="padding:10px 12px;font-weight:600;color:#0f172a;">${s.component}</td>
                  <td style="padding:10px 12px;color:#475569;">${s.task}</td>
                  <td style="padding:10px 12px;text-align:center;color:#64748b;">${s.intervalHours} jam</td>
                  <td style="padding:10px 12px;text-align:center;">
                    <div style="font-size:12px;font-weight:600;${s.hoursRemaining <= 0 ? 'color:#dc2626;' : 'color:#374151;'}">
                        ${s.hoursRemaining <= 0 ? '⚠ OVERDUE' : s.hoursRemaining + ' jam'}
                    </div>
                    <div style="background:#e2e8f0;border-radius:4px;height:5px;
                                margin-top:4px;width:72px;margin-left:auto;margin-right:auto;overflow:hidden;">
                        <div style="background:${barColor};height:5px;border-radius:4px;width:${pct}%;transition:width .4s;"></div>
                    </div>
                  </td>
                  <td style="padding:10px 12px;text-align:center;">
                    <span style="padding:3px 10px;border-radius:99px;font-size:10.5px;font-weight:700;
                                 background:${um.color}18;color:${um.color};">
                        ${um.label}
                    </span>
                  </td>
                  <td style="padding:10px 12px;">
                    <button class="cbm-prev-approve-btn" data-prev-idx="${idx}"
                            style="padding:5px 10px;background:#1d4ed8;color:#fff;
                                   border:none;border-radius:6px;
                                   cursor:pointer;font-size:11px;font-weight:600;
                                   white-space:nowrap;transition:background .18s;">
                        ✅ Setujui
                    </button>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>`;

        list.querySelectorAll('.cbm-prev-approve-btn').forEach(btn => {
            btn.addEventListener('click', async function () {
                const s = schedule[parseInt(this.dataset.prevIdx, 10)];
                // Buat finding tiruan dari preventive schedule
                const finding = {
                    action:   s.task,
                    details:  `Preventive berkala. Interval ${s.intervalHours} jam. Sisa ${s.hoursRemaining} jam.`,
                    priority: s.urgency === 'overdue' ? 'high' : s.urgency === 'due-soon' ? 'medium' : 'low',
                    type:     'Preventive',
                    component: s.component,
                    estimatedCost: 0
                };
                await handleApproveFinding(finding, this);
            });
        });
    }

    // ── RENDER ALL ────────────────────────────────────────────────────────────
    function renderAll(data) {
        if (!data) return;
        renderHealthRing(data.healthScore ?? 0);
        renderStatusBadge(data.overallStatus ?? '---');
        renderComponentHealth(data.componentHealth ?? {});
        renderFindings(data.findings ?? []);
        renderPreventive(data.preventiveSchedule ?? [], data.totalOperatingHours ?? 0);

        // const summary = document.getElementById('cbmSummaryBox');
        // if (summary) summary.textContent = data.summary ?? '';

        const analyzedAt = document.getElementById('cbmAnalyzedAt');
        if (analyzedAt && data.analyzedAt) {
            const d = new Date(data.analyzedAt);
            analyzedAt.textContent =
                `${d.toLocaleString('id-ID')} · ${(data.dataPoints ?? 0).toLocaleString()} data pts`;
        }
    }

    // ── APPROVE FINDING (Redirect Flow) ──────────────────────────────────────
    async function handleApproveFinding(finding, btn) {
        const original = btn.innerHTML;
        btn.disabled   = true;
        btn.textContent = '⏳';

        try {
            const res = await fetch(SUGGEST_API, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ finding })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (!json.success) throw new Error(json.error);

            btn.textContent = '✅ Tersimpan';
            // Simpan saran lengkap ke sessionStorage
            sessionStorage.setItem('pendingCbmSuggestion', JSON.stringify(json.data));
            // Redirect ke halaman maintenance
            window.location.href = 'maintenance.html';
        } catch (err) {
            console.error('Approve finding error:', err);
            btn.textContent = '❌ Gagal';
            setTimeout(() => {
                btn.innerHTML = original;
                btn.disabled = false;
            }, 2000);
        }
    }

    // ── FFT PEAKS EXTRACTION ──────────────────────────────────────────────────
    function extractFftPeaks() {
        try {
            const chart = window.fftChart;
            if (!chart?.data?.datasets?.[0]?.data?.length) return [];
            const labels = chart.data.labels;
            const data   = chart.data.datasets[0].data;
            if (!labels?.length || !data?.length) return [];

            const peaks = [];
            for (let i = 1; i < data.length - 1; i++) {
                if (data[i] >= data[i - 1] && data[i] >= data[i + 1] && data[i] > 0.001) {
                    peaks.push({ freq: parseFloat(labels[i]) || 0, amp: data[i] });
                }
            }
            return peaks.sort((a, b) => b.amp - a.amp).slice(0, 5);
        } catch (err) { console.warn('extractFftPeaks error:', err); return []; }
    }

    // ── MAIN LOAD ─────────────────────────────────────────────────────────────
    async function loadCBM(useFftPeaks = false) {
        if (_loading) return;
        _loading = true;

        const loadingEl   = document.getElementById('cbmLoading');
        const contentEl   = document.getElementById('cbmContent');
        const refreshBtn  = document.getElementById('cbmRefreshBtn');
        const refreshIcon = document.getElementById('cbmRefreshIcon');

        if (loadingEl)   loadingEl.style.display  = 'block';
        if (contentEl)   contentEl.style.display  = 'none';
        if (refreshIcon) refreshIcon.classList.add('fa-spin');
        if (refreshBtn)  refreshBtn.disabled = true;

        try {
            const dateFromEl = document.getElementById('dateFrom');
            const dateToEl   = document.getElementById('dateTo');
            const deviceId   = typeof getReportDeviceId === 'function'
                ? getReportDeviceId() : null;

            const body = { hours: 168, deviceId };

            if (dateFromEl?.value && dateToEl?.value) {
                body.startDate = dateFromEl.value;
                body.endDate   = dateToEl.value;
                delete body.hours;
            }

            if (useFftPeaks) {
                const peaks = extractFftPeaks();
                if (peaks.length) {
                    body.fftPeaks = peaks;
                    if (typeof currentData !== 'undefined' && currentData.length) {
                        const rpmVals = currentData
                            .map(d => Number(d.rpm))
                            .filter(v => Number.isFinite(v) && v > 0);
                        if (rpmVals.length) {
                            body.rpmMean = rpmVals.reduce((a, b) => a + b, 0) / rpmVals.length;
                        }
                    }
                }
            }

            const res = await fetch(CBM_API, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(body)
            });

            if (!res.ok) throw new Error(`CBM API ${res.status}`);
            const json = await res.json();
            if (!json.success) throw new Error(json.error || 'Unknown error');

            _lastResult = json.data;
            renderAll(json.data);

        } catch (err) {
            console.error('[CBMPanel] load error:', err);

            // Fallback: GET
            try {
                const deviceId = typeof getReportDeviceId === 'function'
                    ? getReportDeviceId() : '';
                const url  = `${CBM_API}?hours=168${deviceId ? '&deviceId=' + deviceId : ''}`;
                const res  = await fetch(url);
                const json = await res.json();
                if (!json.success) throw new Error(json.error);
                _lastResult = json.data;
                renderAll(json.data);
            } catch (fbErr) {
                if (contentEl) {
                    contentEl.style.display = 'block';
                    contentEl.innerHTML = `
                      <div style="padding:14px;background:#fef2f2;border-radius:10px;
                                  color:#b91c1c;font-size:13px;border:1px solid #fca5a5;">
                        ⚠️ Gagal memuat CBM: ${err.message}<br>
                        <small style="color:#94a3b8;">
                          Pastikan <code>/api/cbm/analysis</code> sudah ditambahkan ke server.js
                          dan file <code>lib_cbm_analysis.js</code> sudah ada di root project.
                        </small>
                      </div>`;
                }
            }
        } finally {
            if (loadingEl)   loadingEl.style.display  = 'none';
            if (contentEl && contentEl.innerHTML !== '')
                             contentEl.style.display  = 'block';
            if (refreshIcon) refreshIcon.classList.remove('fa-spin');
            if (refreshBtn)  refreshBtn.disabled = false;
            _loading = false;
        }
    }

    // ── INIT ──────────────────────────────────────────────────────────────────
    function init() {
        const container = document.getElementById('cbmPanelContainer');
        if (!container) {
            console.warn('[CBMPanel] #cbmPanelContainer tidak ditemukan di HTML.');
            return;
        }

        container.innerHTML = buildHTML();

        document.getElementById('cbmRefreshBtn')
            ?.addEventListener('click', () => loadCBM(false));
        document.getElementById('cbmSendFftBtn')
            ?.addEventListener('click', () => loadCBM(true));

        // Hook tombol Apply & time-btn (delay agar data selesai dimuat lebih dulu)
        document.getElementById('applyDateRange')
            ?.addEventListener('click', () => setTimeout(() => loadCBM(false), 700));
        document.querySelectorAll('.time-btn').forEach(btn => {
            btn.addEventListener('click', () => setTimeout(() => loadCBM(false), 700));
        });

        // Auto-load pertama kali
        loadCBM(false);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Expose ke global untuk di-trigger dari reports.js
    window.CBMPanel = {
        reload:        loadCBM,
        getLastResult: () => _lastResult
    };

})();