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
