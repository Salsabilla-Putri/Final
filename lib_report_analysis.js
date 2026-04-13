function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const ts = Date.parse(String(value).trim());
  return Number.isFinite(ts) ? ts / 1000 : null;
}

function linearSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const sx = ((n - 1) * n) / 2;
  const sxx = ((n - 1) * n * (2 * n - 1)) / 6;
  const sy = values.reduce((sum, value) => sum + value, 0);
  const sxy = values.reduce((sum, value, index) => sum + index * value, 0);
  const den = n * sxx - sx * sx;
  return den === 0 ? 0 : (n * sxy - sx * sy) / den;
}

function dftMagnitude(signal) {
  const n = signal.length;
  const half = Math.floor(n / 2);
  const out = [];

  for (let k = 1; k < half; k += 1) {
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t += 1) {
      const angle = (2 * Math.PI * k * t) / n;
      re += signal[t] * Math.cos(angle);
      im -= signal[t] * Math.sin(angle);
    }
    out.push(Math.sqrt(re * re + im * im) / half);
  }

  return out;
}

function analyzeReportRows(rows, sensor = 'rpm', maxPoints = 300) {
  const filtered = (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const timestamp = parseTimestamp(row.timestamp || row.createdAt || row.date);
      const value = Number(row[sensor]);
      if (!Number.isFinite(timestamp) || !Number.isFinite(value)) return null;
      return [timestamp, value];
    })
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0]);

  const values = filtered.map(([, value]) => value);
  if (values.length < 16) {
    return {
      ok: true,
      sensor,
      summary: `FFT needs at least 16 samples for ${sensor}. Current: ${values.length} sample(s).`,
      stats: { count: values.length },
      peaks: [],
      spectrum: []
    };
  }

  const deltas = [];
  for (let index = 1; index < filtered.length; index += 1) {
    const delta = filtered[index][0] - filtered[index - 1][0];
    if (delta > 0) deltas.push(delta);
  }
  deltas.sort((a, b) => a - b);
  const medianDelta = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 1;
  const sampleRate = 1 / Math.max(medianDelta, 1e-6);

  let fftSize = 1;
  while (fftSize < values.length) fftSize *= 2;
  fftSize = Math.min(fftSize, 1024);

  const signal = values.slice(-fftSize);
  while (signal.length < fftSize) signal.unshift(0);

  const mean = signal.reduce((sum, value) => sum + value, 0) / signal.length;
  const centeredSignal = signal.map((value) => value - mean);

  const spectrum = dftMagnitude(centeredSignal)
    .map((amplitude, index) => ({
      freq: ((index + 1) * sampleRate) / fftSize,
      amp: amplitude
    }))
    .filter(({ freq, amp }) => Number.isFinite(freq) && Number.isFinite(amp));

  const peaks = [...spectrum].sort((a, b) => b.amp - a.amp).slice(0, 3);
  const count = values.length;
  const average = values.reduce((sum, value) => sum + value, 0) / count;
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / Math.max(count - 1, 1);
  const slope = linearSlope(values);

  return {
    ok: true,
    sensor,
    summary: `FFT of ${sensor} | Samples: ${fftSize} | Estimated sampling: ${sampleRate.toFixed(3)} Hz`,
    stats: {
      count,
      mean: average,
      stddev: Math.sqrt(variance),
      min: Math.min(...values),
      max: Math.max(...values),
      slope_per_sample: slope,
      trend: slope > 0 ? 'up' : slope < 0 ? 'down' : 'flat'
    },
    peaks,
    spectrum: spectrum.slice(0, maxPoints)
  };
}

module.exports = {
  analyzeReportRows
};
