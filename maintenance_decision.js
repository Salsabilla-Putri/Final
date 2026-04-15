'use strict';

function toDateOrNull(input) {
  if (!input) return null;
  const date = input instanceof Date ? input : new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeSeverity(severity) {
  return String(severity || '').trim().toLowerCase();
}

function calculateSeverityCounts(alertHistory = []) {
  return alertHistory.reduce((acc, alert) => {
    const sev = normalizeSeverity(alert?.severity);
    if (sev === 'critical') acc.critical += 1;
    else if (sev === 'high' || sev === 'medium' || sev === 'warning' || sev === 'warn') acc.warning += 1;
    return acc;
  }, { critical: 0, warning: 0 });
}

function detectUnstableSensor(sensorData = []) {
  const rows = Array.isArray(sensorData) ? sensorData : [sensorData];
  const sample = rows.slice(0, 10);
  if (sample.length < 3) return false;

  const metricKeys = ['rpm', 'volt', 'amp', 'freq', 'temp'];
  let unstableScore = 0;

  metricKeys.forEach((key) => {
    const values = sample
      .map((row) => Number(row?.[key]))
      .filter((num) => Number.isFinite(num));

    if (values.length < 3) return;

    const max = Math.max(...values);
    const min = Math.min(...values);
    const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
    if (avg <= 0) return;

    const swingRatio = (max - min) / avg;
    if (swingRatio > 0.2) unstableScore += 1;
  });

  return unstableScore >= 2;
}

function addDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

function generateMaintenanceDecision(sensorData = [], alertHistory = []) {
  const counts = calculateSeverityCounts(alertHistory);
  const unstable = detectUnstableSensor(sensorData);

  if (counts.critical > 0) {
    return {
      status: 'BAHAYA',
      message: 'Kondisi mesin terdeteksi berisiko. Perlu tindakan cepat.',
      recommendation: 'Segera perbaikan dan cek menyeluruh oleh teknisi.',
      suggestedDate: addDays(1)
    };
  }

  if (counts.warning >= 3 || unstable) {
    return {
      status: 'WASPADA',
      message: 'Mesin terlihat kurang stabil dalam beberapa waktu terakhir.',
      recommendation: 'Disarankan melakukan pengecekan rutin secepatnya.',
      suggestedDate: addDays(3)
    };
  }

  return {
    status: 'AMAN',
    message: 'Kondisi mesin stabil. Belum ada tanda masalah serius.',
    recommendation: 'Belum perlu tindakan khusus. Lanjutkan pemantauan rutin.',
    suggestedDate: null
  };
}

function mapDecisionToPriority(status) {
  if (status === 'BAHAYA') return 'high';
  if (status === 'WASPADA') return 'medium';
  return 'low';
}

function toSuggestionDocument(decision) {
  return {
    source: 'system',
    status: 'pending',
    decisionStatus: decision.status,
    message: decision.message,
    recommendation: decision.recommendation,
    suggestedDate: toDateOrNull(decision.suggestedDate),
    priority: mapDecisionToPriority(decision.status),
    createdAt: new Date()
  };
}

module.exports = {
  generateMaintenanceDecision,
  mapDecisionToPriority,
  toSuggestionDocument
};
