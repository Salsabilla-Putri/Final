/**
 * public/js/cbm_panel.js  (v2 — redesigned)
 * ─────────────────────────────────────────────────────────────────────────────
 * Desain selaras dengan reports.css:
 *  • Warna dominan: #1745a5 (primary)
 *  • Card: white, border-radius 20px, shadow halus
 *  • Finding card: left-border coloured, background PUTIH (tidak warna-warni)
 *  • Badge: pill-shape, warna muted
 *  • Tombol: border-radius 999px, font-weight 600
 *  • Tabel: heading uppercase kecil, border #f1f5f9
 * ─────────────────────────────────────────────────────────────────────────────
 */

/* global currentData, getReportDeviceId, fftChart */

(function CBMPanel() {
    'use strict';

    const CBM_API     = '/api/cbm/analysis';
    const CONVERT_API = '/api/cbm/convert-to-task';

    /* Severity config — hanya border & badge yang berwarna, card tetap putih */
    const SEV = {
        critical: {
            borderColor: '#dc2626',
            badgeClass:  'cbm-badge-critical',
            dotColor:    '#dc2626',
            label:       'Kritis',
            icon:        'fa-circle-exclamation'
        },
        warn: {
            borderColor: '#f97316',
            badgeClass:  'cbm-badge-warn',
            dotColor:    '#f97316',
            label:       'Waspada',
            icon:        'fa-triangle-exclamation'
        },
        watch: {
            borderColor: '#d97706',
            badgeClass:  'cbm-badge-watch',
            dotColor:    '#d97706',
            label:       'Pantau',
            icon:        'fa-eye'
        },
        ok: {
            borderColor: '#10b981',
            badgeClass:  'cbm-badge-ok',
            dotColor:    '#10b981',
            label:       'Normal',
            icon:        'fa-circle-check'
        }
    };

    const URGENCY = {
        overdue:    { label: 'Terlambat', badgeClass: 'cbm-badge-critical', barColor: '#dc2626' },
        'due-now':  { label: 'Segera',    badgeClass: 'cbm-badge-warn',     barColor: '#f97316' },
        'due-soon': { label: 'Mendekati', badgeClass: 'cbm-badge-watch',    barColor: '#d97706' },
        scheduled:  { label: 'Terjadwal', badgeClass: 'cbm-badge-ok',       barColor: '#1745a5' }
    };

    let _loading    = false;
    let _lastResult = null;

    // ── HTML TEMPLATE ─────────────────────────────────────────────────────────
    function buildHTML() {
        return `
<section id="cbmPanel" style="padding:30px;">

  <!-- Header ────────────────────────────────────────────── -->
  <div style="display:flex;align-items:flex-start;justify-content:space-between;
              margin-bottom:24px;flex-wrap:wrap;gap:12px;">
    <h2 class="section-title" style="margin-bottom:0;">
      <i class="fas fa-stethoscope"></i> Condition-Based Maintenance
    </h2>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button id="cbmRefreshBtn" class="cbm-btn-primary">
        <i class="fas fa-sync-alt" id="cbmRefreshIcon"></i> Analisis Sekarang
      </button>
      <button id="cbmSendFftBtn" class="cbm-btn-secondary"
              title="Kirim FFT peaks dari chart aktif ke analisis server">
        <i class="fas fa-wave-square"></i> + FFT Peaks
      </button>
    </div>
  </div>

  <!-- Loading ────────────────────────────────────────────── -->
  <div id="cbmLoading"
       style="display:none;padding:24px;text-align:center;color:#94a3b8;font-size:13px;">
    <i class="fas fa-spinner fa-spin" style="margin-right:8px;color:#1745a5;"></i>
    Menganalisis data sensor...
  </div>

  <!-- Content ────────────────────────────────────────────── -->
  <div id="cbmContent" style="display:none;">

    <!-- Baris 1: Health + Komponen ──────────────────────── -->
    <div class="cbm-top-row"
         style="display:grid;grid-template-columns:200px 1fr;gap:20px;margin-bottom:20px;">

      <!-- Health Score -->
      <div style="background:#fff;border-radius:20px;border:1px solid #e2e8f0;
                  padding:24px 20px;text-align:center;box-shadow:0 4px 6px -1px rgba(0,0,0,.05);">
        <p class="cbm-label" style="margin-bottom:16px;">Skor Kesehatan</p>
        <div class="cbm-ring-wrap" style="margin:0 auto 14px;">
          <canvas id="cbmHealthCanvas" width="120" height="120"></canvas>
          <div class="cbm-ring-center">
            <div id="cbmScoreNum"
                 style="font-size:28px;font-weight:700;color:#0f172a;line-height:1;">--</div>
            <div style="font-size:11px;color:#94a3b8;">/100</div>
          </div>
        </div>
        <span id="cbmStatusBadge" class="cbm-badge" style="font-size:12px;">---</span>
        <div id="cbmAnalyzedAt"
             style="margin-top:10px;font-size:10px;color:#94a3b8;line-height:1.5;"></div>
      </div>

      <!-- Status Komponen -->
      <div style="background:#fff;border-radius:20px;border:1px solid #e2e8f0;
                  padding:24px 20px;box-shadow:0 4px 6px -1px rgba(0,0,0,.05);">
        <p class="cbm-label">Status Komponen</p>
        <div id="cbmComponentList"></div>
      </div>
    </div>

    <!-- Summary ──────────────────────────────────────────── -->
    <div id="cbmSummaryBox" class="cbm-summary" style="margin-bottom:20px;"></div>

    <!-- Temuan ──────────────────────────────────────────── -->
    <div style="background:#fff;border-radius:20px;border:1px solid #e2e8f0;
                padding:24px 20px;box-shadow:0 4px 6px -1px rgba(0,0,0,.05);margin-bottom:20px;">
      <p class="cbm-label">Temuan &amp; Rekomendasi</p>
      <div id="cbmFindingsEmpty" class="cbm-empty" style="display:none;">
        <i class="fas fa-circle-check"
           style="font-size:28px;color:#10b981;display:block;margin-bottom:10px;"></i>
        Tidak ada anomali terdeteksi pada rentang waktu ini.
      </div>
      <div id="cbmFindingsList"></div>
    </div>

    <!-- Jadwal Preventive ───────────────────────────────── -->
    <div style="background:#fff;border-radius:20px;border:1px solid #e2e8f0;
                padding:24px 20px;box-shadow:0 4px 6px -1px rgba(0,0,0,.05);">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
        <p class="cbm-label" style="margin-bottom:0;">Jadwal Preventive Maintenance</p>
        <span id="cbmTotalHoursTag" class="cbm-badge cbm-badge-blue"></span>
      </div>
      <div id="cbmPreventiveEmpty" class="cbm-empty" style="display:none;">
        Tidak ada jadwal yang mendekati atau terlambat.
      </div>
      <div id="cbmPreventiveList" style="overflow-x:auto;"></div>
    </div>

  </div><!-- /cbmContent -->
</section>`;
    }

    // ── HEALTH RING ───────────────────────────────────────────────────────────
    function renderHealthRing(score) {
        const canvas = document.getElementById('cbmHealthCanvas');
        if (!canvas) return;
        const ctx   = canvas.getContext('2d');
        const cx = 60, cy = 60, r = 50, lw = 9;
        const start = -Math.PI / 2;
        const end   = start + (score / 100) * 2 * Math.PI;
        /* Warna ring mengikuti primary kecuali kondisi merah */
        const color = score >= 80 ? '#1745a5' : score >= 55 ? '#f97316' : '#dc2626';

        ctx.clearRect(0, 0, 120, 120);
        /* Track */
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        ctx.strokeStyle = '#f1f5f9'; ctx.lineWidth = lw; ctx.stroke();
        /* Progress */
        ctx.beginPath(); ctx.arc(cx, cy, r, start, end);
        ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.stroke();

        const numEl = document.getElementById('cbmScoreNum');
        if (numEl) { numEl.textContent = score; numEl.style.color = color; }
    }

    function renderStatusBadge(status) {
        const badge = document.getElementById('cbmStatusBadge');
        if (!badge) return;
        const map = {
            AMAN:    { cls: 'cbm-badge-ok',       text: '● Aman'    },
            WASPADA: { cls: 'cbm-badge-watch',     text: '● Waspada' },
            BAHAYA:  { cls: 'cbm-badge-critical',  text: '● Bahaya'  }
        };
        const m = map[status] || { cls: 'cbm-badge-blue', text: status };
        badge.className = `cbm-badge ${m.cls}`;
        badge.textContent = m.text;
    }

    // ── COMPONENT LIST (compact, no coloured tiles) ───────────────────────────
    function renderComponentList(componentHealth) {
        const list = document.getElementById('cbmComponentList');
        if (!list) return;

        if (!Object.keys(componentHealth).length) {
            list.innerHTML = '<p class="cbm-empty">Data komponen belum tersedia.</p>';
            return;
        }

        list.innerHTML = Object.entries(componentHealth).map(([comp, level]) => {
            const s = SEV[level] || SEV.ok;
            return `
            <div class="cbm-comp-item">
                <div class="cbm-comp-dot" style="background:${s.dotColor};"></div>
                <span class="cbm-comp-name">${comp}</span>
                <span class="cbm-badge ${s.badgeClass}" style="font-size:10px;">
                    ${s.label}
                </span>
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
            const s       = SEV[f.level] || SEV.ok;
            const isUp    = (f.trend?.slopePerHour ?? 0) >= 0;
            const slopeAbs = Math.abs(f.trend?.slopePerHour ?? 0).toFixed(3);
            const trendCls = isUp ? 'cbm-trend-up' : 'cbm-trend-down';
            const trendTxt = `${isUp ? '▲' : '▼'} ${slopeAbs}/jam`;

            /* Chip-chip statistik */
            const chips = f.sensor !== 'rpm_fft' ? `
                <span class="cbm-stat-chip">
                    Sensor: <b>${f.sensor?.toUpperCase()}</b>
                </span>
                <span class="cbm-stat-chip">
                    Terkini: <b>${f.trend?.latest ?? '--'}</b>
                </span>
                <span class="cbm-stat-chip ${trendCls}">
                    Tren: <b>${trendTxt}</b>
                </span>
                <span class="cbm-stat-chip">
                    R² <b>${f.trend?.r2 ?? '--'}</b>
                </span>
                <span class="cbm-stat-chip">
                    CV <b>${f.trend?.cv ?? '--'}%</b>
                </span>
                <span class="cbm-stat-chip">
                    Keyakinan <b>${f.confidence ?? '--'}%</b>
                </span>` : `
                <span class="cbm-stat-chip">
                    <i class="fas fa-wave-square" style="color:#1745a5;"></i>
                    Sumber: FFT Spectrum Analysis
                </span>`;

            return `
            <div class="cbm-finding cbm-finding-${f.level}"
                 style="border-left-color:${s.borderColor};">
              <div style="flex:1;min-width:200px;">
                <div style="display:flex;align-items:center;gap:8px;
                            margin-bottom:6px;flex-wrap:wrap;">
                  <i class="fas ${s.icon}" style="color:${s.borderColor};"></i>
                  <span style="font-weight:700;font-size:14px;color:#0f172a;">${f.component}</span>
                  <span class="cbm-badge ${s.badgeClass}">${s.label}</span>
                  <span class="cbm-badge" style="background:#f8fafc;color:#475569;">
                    ${f.type || 'Corrective'}
                  </span>
                  <span class="cbm-badge" style="background:#f8fafc;color:#475569;">
                    ${(f.priority || 'medium').toUpperCase()}
                  </span>
                </div>
                <p style="font-size:13px;font-weight:600;color:#1e293b;margin:0 0 3px;">
                  ${f.action}
                </p>
                <p style="font-size:12px;color:#64748b;margin:0 0 8px;line-height:1.5;">
                  ${f.details}
                </p>
                <div class="cbm-stat-row">${chips}</div>
              </div>
              <button class="cbm-btn-action cbm-create-task-btn"
                      data-idx="${idx}">
                + Buat Task
              </button>
            </div>`;
        }).join('');

        list.querySelectorAll('.cbm-create-task-btn').forEach(btn => {
            btn.addEventListener('click', async function () {
                await handleCreateTask(findings[parseInt(this.dataset.idx, 10)], this);
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
        <table class="cbm-tbl">
          <thead><tr>
            <th>Komponen</th>
            <th>Tugas</th>
            <th style="text-align:center;">Interval</th>
            <th style="text-align:center;">Sisa Jam</th>
            <th style="text-align:center;">Status</th>
            <th></th>
          </tr></thead>
          <tbody>
            ${schedule.map((s, idx) => {
                const u   = URGENCY[s.urgency] || URGENCY.scheduled;
                const pct = Math.min(100, s.percentDue ?? 0);
                return `
                <tr>
                  <td style="font-weight:600;color:#1e293b;">${s.component}</td>
                  <td>${s.task}</td>
                  <td style="text-align:center;color:#64748b;">${s.intervalHours} jam</td>
                  <td style="text-align:center;">
                    <div style="font-size:12px;font-weight:${s.hoursRemaining <= 0 ? 700 : 400};
                                color:${s.hoursRemaining <= 0 ? '#dc2626' : '#334155'};">
                      ${s.hoursRemaining <= 0 ? 'Overdue' : s.hoursRemaining + ' jam'}
                    </div>
                    <div class="cbm-progress" style="margin-left:auto;margin-right:auto;">
                      <div class="cbm-progress-fill"
                           style="width:${pct}%;background:${u.barColor};"></div>
                    </div>
                  </td>
                  <td style="text-align:center;">
                    <span class="cbm-badge ${u.badgeClass}">${u.label}</span>
                  </td>
                  <td>
                    <button class="cbm-btn-action cbm-prev-task-btn"
                            data-prev-idx="${idx}">
                      + Task
                    </button>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>`;

        list.querySelectorAll('.cbm-prev-task-btn').forEach(btn => {
            btn.addEventListener('click', async function () {
                const s = schedule[parseInt(this.dataset.prevIdx, 10)];
                await handleCreateTask({
                    action:    s.task,
                    details:   `Preventive berkala. Interval ${s.intervalHours} jam. Sisa ${s.hoursRemaining} jam.`,
                    priority:  s.urgency === 'overdue' ? 'high'
                              : s.urgency === 'due-soon' ? 'medium' : 'low',
                    type:      'Preventive',
                    component: s.component
                }, this);
            });
        });
    }

    // ── RENDER ALL ────────────────────────────────────────────────────────────
    function renderAll(data) {
        if (!data) return;
        renderHealthRing(data.healthScore ?? 0);
        renderStatusBadge(data.overallStatus ?? '---');
        renderComponentList(data.componentHealth ?? {});
        renderFindings(data.findings ?? []);
        renderPreventive(data.preventiveSchedule ?? [], data.totalOperatingHours ?? 0);

        const summary = document.getElementById('cbmSummaryBox');
        if (summary) summary.textContent = data.summary ?? '';

        const analyzedAt = document.getElementById('cbmAnalyzedAt');
        if (analyzedAt && data.analyzedAt) {
            const d = new Date(data.analyzedAt);
            analyzedAt.innerHTML =
                `${d.toLocaleString('id-ID')}<br>${(data.dataPoints ?? 0).toLocaleString('en-US')} data points`;
        }
    }

    // ── CREATE TASK ───────────────────────────────────────────────────────────
    async function handleCreateTask(finding, btn) {
        const original = btn.innerHTML;
        btn.disabled   = true;
        btn.innerHTML  = '<i class="fas fa-spinner fa-spin"></i>';

        try {
            const res = await fetch(CONVERT_API, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ finding })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            btn.innerHTML  = '<i class="fas fa-check"></i> Tersimpan';
            btn.style.background = '#f0fdf4';
            btn.style.color      = '#166534';
            btn.style.borderColor = '#bbf7d0';
            setTimeout(() => {
                btn.innerHTML        = original;
                btn.style.background = '';
                btn.style.color      = '';
                btn.style.borderColor = '';
                btn.disabled         = false;
            }, 2500);
        } catch (err) {
            console.error('Create task error:', err);
            btn.innerHTML  = '<i class="fas fa-xmark"></i> Gagal';
            btn.style.background  = '#fef2f2';
            btn.style.color       = '#dc2626';
            btn.style.borderColor = '#fca5a5';
            setTimeout(() => {
                btn.innerHTML        = original;
                btn.style.background = '';
                btn.style.color      = '';
                btn.style.borderColor = '';
                btn.disabled         = false;
            }, 2000);
        }
    }

    // ── FFT PEAK EXTRACTION ───────────────────────────────────────────────────
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
        } catch (e) { console.warn('[CBM] extractFftPeaks:', e); return []; }
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
                        if (rpmVals.length)
                            body.rpmMean = rpmVals.reduce((a, b) => a + b, 0) / rpmVals.length;
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
            console.error('[CBM] load error:', err);
            /* Fallback: GET */
            try {
                const deviceId = typeof getReportDeviceId === 'function'
                    ? getReportDeviceId() : '';
                const res  = await fetch(
                    `${CBM_API}?hours=168${deviceId ? '&deviceId=' + deviceId : ''}`);
                const json = await res.json();
                if (!json.success) throw new Error(json.error);
                _lastResult = json.data;
                renderAll(json.data);
            } catch (fbErr) {
                if (contentEl) {
                    contentEl.style.display = 'block';
                    contentEl.innerHTML = `
                      <div style="padding:16px;background:#fef2f2;border-radius:12px;
                                  border:1px solid #fca5a5;color:#dc2626;font-size:13px;">
                        <i class="fas fa-triangle-exclamation" style="margin-right:6px;"></i>
                        Gagal memuat analisis CBM: ${err.message}<br>
                        <small style="color:#94a3b8;display:block;margin-top:6px;">
                          Pastikan endpoint
                          <code style="background:#f8fafc;padding:1px 5px;border-radius:4px;">
                            /api/cbm/analysis
                          </code>
                          sudah ditambahkan ke server.js dan
                          <code style="background:#f8fafc;padding:1px 5px;border-radius:4px;">
                            lib_cbm_analysis.js
                          </code>
                          ada di root project.
                        </small>
                      </div>`;
                }
            }
        } finally {
            if (loadingEl) loadingEl.style.display = 'none';
            if (contentEl && !contentEl.innerHTML.trim().startsWith('<div'))
                contentEl.style.display = 'block';
            else if (contentEl)
                contentEl.style.display = 'block';
            if (refreshIcon) refreshIcon.classList.remove('fa-spin');
            if (refreshBtn)  refreshBtn.disabled = false;
            _loading = false;
        }
    }

    // ── INIT ──────────────────────────────────────────────────────────────────
    function init() {
        const container = document.getElementById('cbmPanelContainer');
        if (!container) {
            console.warn('[CBM] #cbmPanelContainer tidak ditemukan.');
            return;
        }

        container.innerHTML = buildHTML();

        document.getElementById('cbmRefreshBtn')
            ?.addEventListener('click', () => loadCBM(false));
        document.getElementById('cbmSendFftBtn')
            ?.addEventListener('click', () => loadCBM(true));

        /* Hook: Apply + time-btn (delay supaya data selesai dulu) */
        document.getElementById('applyDateRange')
            ?.addEventListener('click', () => setTimeout(() => loadCBM(false), 700));
        document.querySelectorAll('.time-btn')
            .forEach(b => b.addEventListener('click',
                () => setTimeout(() => loadCBM(false), 700)));

        loadCBM(false);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.CBMPanel = { reload: loadCBM, getLastResult: () => _lastResult };
})();