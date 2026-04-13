#!/usr/bin/env python3
import json
import math
import sys
from datetime import datetime


def parse_ts(value):
    if not value:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if not s:
        return None
    try:
        if s.endswith('Z'):
            s = s[:-1] + '+00:00'
        return datetime.fromisoformat(s).timestamp()
    except Exception:
        return None


def linear_slope(values):
    n = len(values)
    if n < 2:
        return 0.0
    sx = (n - 1) * n / 2.0
    sxx = (n - 1) * n * (2 * n - 1) / 6.0
    sy = sum(values)
    sxy = sum(i * v for i, v in enumerate(values))
    den = n * sxx - sx * sx
    if den == 0:
        return 0.0
    return (n * sxy - sx * sy) / den


def dft_magnitude(signal):
    n = len(signal)
    half = n // 2
    out = []
    for k in range(1, half):
        re = 0.0
        im = 0.0
        for t, x in enumerate(signal):
            a = 2.0 * math.pi * k * t / n
            re += x * math.cos(a)
            im -= x * math.sin(a)
        out.append((re * re + im * im) ** 0.5 / half)
    return out


def analyze(rows, sensor, max_points=300):
    filtered = []
    for row in rows or []:
        v = row.get(sensor)
        ts = parse_ts(row.get('timestamp') or row.get('createdAt') or row.get('date'))
        if ts is None:
            continue
        try:
            fv = float(v)
        except Exception:
            continue
        filtered.append((ts, fv))

    filtered.sort(key=lambda x: x[0])
    values = [v for _, v in filtered]

    if len(values) < 16:
        return {
            'ok': True,
            'sensor': sensor,
            'summary': f'FFT needs at least 16 samples for {sensor}. Current: {len(values)} sample(s).',
            'stats': {
                'count': len(values)
            },
            'peaks': [],
            'spectrum': []
        }

    # sample-rate estimation using median delta
    deltas = []
    for i in range(1, len(filtered)):
        d = filtered[i][0] - filtered[i - 1][0]
        if d > 0:
            deltas.append(d)
    deltas.sort()
    median_dt = deltas[len(deltas) // 2] if deltas else 1.0
    sample_rate = 1.0 / max(median_dt, 1e-6)

    fft_size = 1
    while fft_size < len(values):
        fft_size <<= 1
    fft_size = min(fft_size, 1024)

    signal = values[-fft_size:]
    if len(signal) < fft_size:
        signal = [0.0] * (fft_size - len(signal)) + signal

    mean = sum(signal) / len(signal)
    signal = [x - mean for x in signal]

    mags = dft_magnitude(signal)
    spectrum = []
    for i, amp in enumerate(mags, start=1):
        freq = i * sample_rate / fft_size
        if math.isfinite(freq) and math.isfinite(amp):
            spectrum.append({'freq': freq, 'amp': amp})

    peaks = sorted(spectrum, key=lambda p: p['amp'], reverse=True)[:3]

    cnt = len(values)
    avg = sum(values) / cnt
    var = sum((x - avg) ** 2 for x in values) / max(cnt - 1, 1)
    slope = linear_slope(values)

    return {
        'ok': True,
        'sensor': sensor,
        'summary': f'FFT of {sensor} | Samples: {fft_size} | Estimated sampling: {sample_rate:.3f} Hz',
        'stats': {
            'count': cnt,
            'mean': avg,
            'stddev': var ** 0.5,
            'min': min(values),
            'max': max(values),
            'slope_per_sample': slope,
            'trend': 'up' if slope > 0 else ('down' if slope < 0 else 'flat')
        },
        'peaks': peaks,
        'spectrum': spectrum[:max_points]
    }


def main():
    try:
        payload = json.load(sys.stdin)
        rows = payload.get('rows') or []
        sensor = payload.get('sensor') or 'rpm'
        max_points = int(payload.get('max_points') or 300)
        result = analyze(rows, sensor, max_points=max_points)
        print(json.dumps(result))
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
