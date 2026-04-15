function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function generateMaintenanceDecision(sensorData = {}, alertHistory = []) {
  const alerts = Array.isArray(alertHistory) ? alertHistory : [];
  const criticalCount = alerts.filter((a) => String(a?.severity || '').toLowerCase() === 'critical').length;
  const warningCount = alerts.filter((a) => ['medium', 'high', 'warning'].includes(String(a?.severity || '').toLowerCase())).length;

  const rpm = toNumber(sensorData.rpm);
  const temp = toNumber(sensorData.temp ?? sensorData.coolant);
  const volt = toNumber(sensorData.volt);
  const freq = toNumber(sensorData.freq);

  const unstableSignals = [
    temp !== null && temp > 95,
    rpm !== null && (rpm < 1200 || rpm > 3600),
    volt !== null && (volt < 190 || volt > 250),
    freq !== null && (freq < 48 || freq > 52)
  ].filter(Boolean).length;

  let status = 'AMAN';
  let message = 'Mesin terpantau stabil. Saat ini belum perlu tindakan khusus.';
  let recommendation = 'Lanjutkan pemantauan rutin seperti biasa.';
  let suggestedDate = null;

  if (criticalCount > 0 || unstableSignals >= 2) {
    status = 'BAHAYA';
    message = 'Mesin terdeteksi tidak stabil dan perlu ditangani secepatnya.';
    recommendation = 'Segera lakukan pemeriksaan menyeluruh dan perbaikan komponen penting.';
    suggestedDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  } else if (warningCount >= 3 || unstableSignals === 1) {
    status = 'WASPADA';
    message = 'Ada tanda kondisi mesin mulai menurun dalam beberapa waktu terakhir.';
    recommendation = 'Disarankan melakukan pengecekan preventif oleh teknisi.';
    suggestedDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  }

  return {
    status,
    message,
    recommendation,
    suggestedDate
  };
}

module.exports = {
  generateMaintenanceDecision
};
