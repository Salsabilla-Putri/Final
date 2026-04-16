# Monitoring

Aplikasi monitoring generator berbasis Express + MongoDB + MQTT dengan frontend statis di folder `public/`.

## Menjalankan secara lokal

1. Install dependency:
   ```bash
   npm install
   ```
2. Siapkan environment variable di file `.env`:
   ```bash
   MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>/<db>
   MQTT_BROKER=mqtt://<host>:1883
   MQTT_USERNAME=<username>
   MQTT_PASSWORD=<password>
   RESEND_API_KEY=re_xxxxxxxxxxxxxxxxx
   ALERT_EMAIL_FROM=alert@generator-domain-anda.com
   PORT=3000
   ```
3. Jalankan server:
   ```bash
   npm run dev
   ```

## Deploy ke Vercel

Project ini sudah disiapkan agar frontend statis dan backend API bisa berjalan di Vercel.

### Struktur deploy
- File statis pada folder `public/` akan disajikan langsung oleh Vercel.
- Endpoint backend `/api/*` diarahkan ke server Express melalui `api/index.js`.
- Halaman root `/` diarahkan ke `public/login.html` melalui `vercel.json`.
- Analisis report tidak lagi bergantung pada proses Python, sehingga aman dijalankan di serverless function Vercel.

### Environment variables yang wajib di Vercel
Tambahkan variabel berikut di Project Settings → Environment Variables:

- `MONGODB_URI`
- `MQTT_BROKER`
- `MQTT_USERNAME`
- `MQTT_PASSWORD`
- `RESEND_API_KEY`
- `ALERT_EMAIL_FROM`

### Langkah deploy
1. Push repository ke Git provider.
2. Import project ke Vercel.
3. Framework preset: **Other**.
4. Build command: biarkan default atau gunakan `npm run vercel-build`.
5. Output directory: kosongkan.
6. Tambahkan semua environment variable di atas.
7. Deploy.

### Catatan operasional
- Koneksi MQTT bersifat best-effort. Jika broker tidak tersedia saat cold start, API tetap hidup dan fallback ke data memori terakhir.
- MongoDB Atlas sangat disarankan agar backend serverless Vercel dapat terhubung dari internet publik.

## Tutorial Alert Email Otomatis (Resend)

Fitur backend sudah mendukung kirim email otomatis ketika alert **critical** terdeteksi, termasuk:
- Arus (`amp`) di atas threshold.
- Tegangan sinkronisasi (`volt`) di luar threshold minimum/maksimum.
- Tegangan aki (`batt`) di luar threshold minimum/maksimum.
- Frekuensi (`freq`) di bawah threshold minimum.
- Temperatur (`temp`/`coolant`) di atas threshold.

### 1) Konfigurasi Resend
1. Buat akun Resend dan verifikasi domain pengirim.
2. Simpan API key Resend ke environment:
   ```bash
   RESEND_API_KEY=<API_KEY_RESEND_ANDA>
   ALERT_EMAIL_FROM=alerts@domain-anda.com
   ALERT_EMAIL_COOLDOWN_MS=60000
   ```
3. Pastikan koleksi user (`users`) sudah berisi email penerima notifikasi.

### 2) Alur kerja notifikasi
1. Data sensor masuk dari topic MQTT `gen/#`.
2. Saat `gen/status` diterima, server menyimpan snapshot data.
3. Server mengecek threshold aktif (`ACTIVE_THRESHOLDS`).
4. Jika ada alert critical, server mengirim email melalui API Resend ke seluruh email user yang terdaftar.
5. Cooldown (`ALERT_EMAIL_COOLDOWN_MS`) mencegah spam email beruntun.

### 3) Testing cepat
1. Set threshold kecil (misalnya `amp.max`) via API `/api/thresholds`.
2. Publish payload MQTT dengan nilai melampaui threshold.
3. Cek data alert di `/api/alerts`.
4. Cek inbox penerima untuk email `[CRITICAL ALERT]`.

## Active Time History Generator

Backend juga menambahkan penyimpanan riwayat waktu aktif generator pada koleksi `active_time_histories`.

### Cara kerja
- Ketika status generator berubah ke aktif (`status=RUNNING` atau `rpm > 0`), sistem membuat session baru (`startedAt`).
- Ketika status berubah non-aktif, session aktif ditutup (`endedAt`) dan dihitung `durationMs`.

### Endpoint baru
- `GET /api/generator-active-time/history`
  - Query opsional: `deviceId`, `limit`, `startDate`, `endDate`
- `GET /api/generator-active-time/stats`
  - Query opsional: `deviceId`, `hours` (default 24)
  - Return total durasi aktif dan jumlah sesi dalam window waktu.
