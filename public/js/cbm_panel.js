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
<section id="cbmPanel" style="margin-top:24px; font-family:inherit;">
  <div style="display:flex;align-items:flex-start;justify-content:space-between;
              margin-bottom:16px;flex-wrap:wrap;gap:10px;">
    <div>
      <h2 style="margin:0;font-size:17px;font-weight:700;color:#1e293b;">
        ⚙️ Condition-Based Maintenance (CBM)
      </h2>
      <p style="margin:3px 0 0;font-size:12px;color:#64748b;">
        Analisis degradasi komponen berbasis tren histori sensor &amp; FFT
      </p>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button id="cbmRefreshBtn"
              style="padding:7px 14px;background:#1745a5;color:#fff;border:none;
                     border-radius:7px;cursor:pointer;font-size:12px;font-weight:700;">
        <i class="fas fa-sync-alt" id="cbmRefreshIcon"></i> Analisis Sekarang
      </button>
      <button id="cbmSendFftBtn"
              title="Kirim FFT peaks dari chart aktif ke analisis server"
              style="padding:7px 12px;background:#0ea5e9;color:#fff;border:none;
                     border-radius:7px;cursor:pointer;font-size:12px;font-weight:700;">
        <i class="fas fa-wave-square"></i> + FFT Peaks
      </button>
    </div>
  </div>

  <div id="cbmLoading"
       style="display:none;padding:18px;text-align:center;color:#64748b;font-size:13px;">
    <i class="fas fa-spinner fa-spin"></i>&nbsp; Menganalisis data sensor...
  </div>

  <div id="cbmContent" style="display:none;">

    <!-- Row 1: Health Score + Component Health -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">

      <div style="background:#fff;border-radius:12px;padding:18px 16px;
                  border:1px solid #f1f5f9;text-align:center;box-shadow:0 1px 5px rgba(0,0,0,.05);">
        <div style="font-size:10px;font-weight:700;letter-spacing:.08em;color:#64748b;
                    text-transform:uppercase;margin-bottom:10px;">Health Score</div>
        <div style="position:relative;width:120px;height:120px;margin:0 auto 12px;">
          <canvas id="cbmHealthCanvas" width="120" height="120"></canvas>
          <div style="position:absolute;top:50%;left:50%;
                      transform:translate(-50%,-50%);text-align:center;line-height:1.2;">
            <div id="cbmScoreNum"
                 style="font-size:28px;font-weight:700;color:#1e293b;">--</div>
            <div style="font-size:11px;color:#94a3b8;">/100</div>
          </div>
        </div>
        <span id="cbmStatusBadge"
              style="display:inline-block;padding:3px 12px;border-radius:20px;
                     font-size:12px;font-weight:700;background:#e2e8f0;color:#475569;">
          ---
        </span>
        <div id="cbmAnalyzedAt"
             style="margin-top:7px;font-size:10px;color:#94a3b8;"></div>
      </div>

      <div style="background:#fff;border-radius:12px;padding:18px 16px;
                  border:1px solid #f1f5f9;box-shadow:0 1px 5px rgba(0,0,0,.05);">
        <div style="font-size:10px;font-weight:700;letter-spacing:.08em;color:#64748b;
                    text-transform:uppercase;margin-bottom:12px;">Status Komponen</div>
        <div id="cbmComponentGrid"
             style="display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:7px;">
        </div>
      </div>
    </div>


    <!-- Findings -->
    <div style="background:#fff;border-radius:12px;padding:18px 16px;
                border:1px solid #f1f5f9;box-shadow:0 1px 5px rgba(0,0,0,.05);margin-bottom:14px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:.08em;color:#64748b;
                  text-transform:uppercase;margin-bottom:14px;">
        Temuan &amp; Rekomendasi CBM
      </div>
      <div id="cbmFindingsEmpty"
           style="display:none;padding:20px;text-align:center;color:#94a3b8;font-size:13px;">
        ✅ Tidak ada anomali terdeteksi pada rentang waktu ini.
      </div>
      <div id="cbmFindingsList"></div>
    </div>


  </div>
</section>`;
    }

    // ── HEALTH RING ───────────────────────────────────────────────────────────
    function renderHealthRing(score) {
        const canvas = document.getElementById('cbmHealthCanvas');
        if (!canvas) return;
        const ctx   = canvas.getContext('2d');
        const cx = 60, cy = 60, r = 52, lw = 10;
        const start = -Math.PI / 2;
        const end   = start + (score / 100) * 2 * Math.PI;
        const color = score >= 80 ? '#16a34a' : score >= 55 ? '#ea580c' : '#dc2626';

        ctx.clearRect(0, 0, 120, 120);
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = lw; ctx.stroke();
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
            <div style="display:flex;align-items:center;gap:7px;padding:7px 9px;
                        background:${m.bg};border-radius:8px;border:1px solid ${m.border};">
                <span style="font-size:14px;">${m.icon}</span>
                <div>
                    <div style="font-size:11px;font-weight:600;color:#1e293b;">${comp}</div>
                    <div style="font-size:10px;color:${m.color};font-weight:700;">${m.label}</div>
                </div>
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

            return `
            <div class="cbm-finding-card" style="border:1px solid ${m.border};border-radius:10px;padding:13px 15px;
                        margin-bottom:9px;background:${m.bg};">
              <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
                <div style="flex:1;min-width:200px;">
                  <div style="display:flex;align-items:center;gap:7px;margin-bottom:5px;flex-wrap:wrap;">
                    <span>${m.icon}</span>
                    <span style="font-weight:700;font-size:13px;color:#1e293b;">${f.component}</span>
                    <span style="padding:2px 8px;border-radius:20px;font-size:11px;
                                 background:${m.color}22;color:${m.color};font-weight:700;">${m.label}</span>
                    <span style="padding:2px 8px;border-radius:20px;font-size:11px;
                                 background:#e0e7ff;color:#3730a3;">
                        ${f.type || 'Corrective'} · ${(f.priority || 'MED').toUpperCase()}
                    </span>
                  </div>
                  <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:3px;">
                    ${f.action}
                  </div>
                  <div style="font-size:12px;color:#64748b;margin-bottom:8px;">${f.details}</div>
                  ${f.sensor !== 'rpm_fft' ? `
                  <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
                    <span style="font-size:11px;color:#94a3b8;">Sensor: <b style="color:#475569;">${f.sensor?.toUpperCase()}</b></span>
                    <span style="font-size:11px;color:#94a3b8;">Terkini: <b style="color:#475569;">${f.trend?.latest ?? '--'}</b></span>
                    <span style="font-size:11px;color:${isRising ? '#dc2626' : '#16a34a'};">
                        ${isRising ? '▲' : '▼'} ${slopeAbs}/jam
                    </span>
                    <span style="font-size:11px;color:#94a3b8;">R²: <b style="color:#475569;">${f.trend?.r2 ?? '--'}</b></span>
                    <span style="font-size:11px;color:#94a3b8;">CV: <b style="color:#475569;">${f.trend?.cv ?? '--'}%</b></span>
                    <span style="font-size:11px;color:#94a3b8;">Keyakinan: <b style="color:#475569;">${f.confidence ?? '--'}%</b></span>
                  </div>` : `
                  <span style="font-size:11px;color:#64748b;">Sumber: FFT Spectrum Analysis</span>`}
                </div>
                <div style="display:flex;gap:6px;align-items:flex-start;">
                    <button class="cbm-approve-btn" data-idx="${idx}"
                            style="padding:7px 12px;background:#2563eb;color:#fff;border:none;
                                   border-radius:7px;cursor:pointer;font-size:12px;font-weight:700;
                                   white-space:nowrap;">✅ Setujui</button>
                    <button class="cbm-reject-btn" data-idx="${idx}"
                            style="padding:7px 12px;background:#94a3b8;color:#fff;border:none;
                                   border-radius:7px;cursor:pointer;font-size:12px;font-weight:700;
                                   white-space:nowrap;">❌ Tolak</button>
                </div>
              </div>
            </div>`;
        }).join('');

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
          <thead><tr style="background:#f8fafc;">
            <th style="padding:7px 10px;color:#64748b;font-size:11px;font-weight:600;
                       text-align:left;border-bottom:1px solid #f1f5f9;">Komponen</th>
            <th style="padding:7px 10px;color:#64748b;font-size:11px;font-weight:600;
                       text-align:left;border-bottom:1px solid #f1f5f9;">Tugas</th>
            <th style="padding:7px 10px;color:#64748b;font-size:11px;font-weight:600;
                       text-align:center;border-bottom:1px solid #f1f5f9;">Interval</th>
            <th style="padding:7px 10px;color:#64748b;font-size:11px;font-weight:600;
                       text-align:center;border-bottom:1px solid #f1f5f9;">Sisa Jam</th>
            <th style="padding:7px 10px;color:#64748b;font-size:11px;font-weight:600;
                       text-align:center;border-bottom:1px solid #f1f5f9;">Status</th>
            <th style="padding:7px 10px;border-bottom:1px solid #f1f5f9;"></th>
          </tr></thead>
          <tbody>
            ${schedule.map((s, idx) => {
                const um       = URGENCY[s.urgency] || URGENCY.scheduled;
                const barColor = s.urgency === 'overdue'   ? '#dc2626'
                               : s.urgency === 'due-now'   ? '#ea580c'
                               : s.urgency === 'due-soon'  ? '#ca8a04' : '#16a34a';
                const pct      = Math.min(100, s.percentDue ?? 0);
                return `
                <tr style="border-top:1px solid #f1f5f9;">
                  <td style="padding:9px 10px;font-weight:600;color:#374151;">${s.component}</td>
                  <td style="padding:9px 10px;color:#475569;">${s.task}</td>
                  <td style="padding:9px 10px;text-align:center;color:#64748b;">${s.intervalHours} jam</td>
                  <td style="padding:9px 10px;text-align:center;">
                    <div style="font-size:12px;${s.hoursRemaining <= 0 ? 'font-weight:700;color:#dc2626;' : 'color:#374151;'}">
                        ${s.hoursRemaining <= 0 ? 'OVERDUE' : s.hoursRemaining + ' jam'}
                    </div>
                    <div style="background:#e2e8f0;border-radius:4px;height:4px;
                                margin-top:3px;width:70px;margin-left:auto;margin-right:auto;">
                        <div style="background:${barColor};height:4px;border-radius:4px;width:${pct}%;"></div>
                    </div>
                  </td>
                  <td style="padding:9px 10px;text-align:center;">
                    <span style="padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;
                                 background:${um.color}22;color:${um.color};">
                        ${um.label}
                    </span>
                  </td>
                  <td style="padding:9px 10px;">
                    <button class="cbm-prev-approve-btn" data-prev-idx="${idx}"
                            style="padding:4px 9px;background:#2563eb;color:#fff;
                                   border:none;border-radius:5px;
                                   cursor:pointer;font-size:11px;font-weight:600;">
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
                const url  = `${CBM_API}?hours=720${deviceId ? '&deviceId=' + deviceId : ''}`;
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