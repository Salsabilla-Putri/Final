#include <Arduino.h>
#include <HardwareSerial.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <SPI.h>
#include <FS.h>
#include <SD.h>
#include <TFT_eSPI.h>
#include <Adafruit_FT6206.h>
#include <arduinoFFT.h>

// NOTE:
// File ini adalah versi ringkas dari kode Anda + fitur FFT edge computing.
// Integrasi ke sketch existing dapat dilakukan dengan copy blok "FFT EDGE COMPUTING"
// dan pemanggilannya di SensorTask50Hz + buildJsonPayload.

#define DEVICE_ID "ESP32_GENERATOR_01"
#define SENSOR_SAMPLE_HZ          50
#define SENSOR_SAMPLE_INTERVAL_MS 20
#define AGGREGATION_INTERVAL_MS   1000
#define MQTT_TOPIC "gen/data"

// --------------------- DATA MODEL MINIMAL ---------------------
struct RawData {
  uint32_t seq;
  uint32_t timestampMs;
  int rpm;
  float volt;
  float freq;
  bool gridSync;
  bool valid;
  char statusText[12];
};

struct AggregatedData {
  uint16_t samples;
  float rpmAvg;
  float voltAvg;
  float freqAvg;
  bool synced;
  bool valid;
};

RawData latestRaw;
AggregatedData aggData;
SemaphoreHandle_t dataMutex = NULL;

// --------------------- FFT EDGE COMPUTING ---------------------
// N harus pangkat dua.
static const uint16_t FFT_N = 64;
static const double FFT_SAMPLING_HZ = SENSOR_SAMPLE_HZ;

// Input FFT dari sinyal vibration/arus/tegangan.
// Di contoh ini dipakai kanal volt (d.volt). Jika tersedia accelerometer,
// ganti dengan nilai getaran untuk CBM yang lebih tepat.
double fftReal[FFT_N];
double fftImag[FFT_N];
uint16_t fftIndex = 0;
bool fftBufferReady = false;

// Simpan fitur FFT agar payload kecil.
struct FftFeatures {
  bool valid;
  float dominantHz;
  float dominantMag;
  float rms;
  float band0_10;
  float band10_20;
  float band20_25;
  uint32_t computedAtMs;
};

FftFeatures latestFft = {};
volatile uint32_t perfFftUs = 0;
arduinoFFT FFT = arduinoFFT(fftReal, fftImag, FFT_N, FFT_SAMPLING_HZ);

void pushFftSample(float sample) {
  fftReal[fftIndex] = sample;
  fftImag[fftIndex] = 0.0;
  fftIndex++;

  if (fftIndex >= FFT_N) {
    fftIndex = 0;
    fftBufferReady = true;
  }
}

void computeFftIfReady() {
  if (!fftBufferReady) return;

  uint32_t startUs = micros();
  fftBufferReady = false;

  // Windowing untuk mengurangi spectral leakage.
  FFT.windowing(FFTWindow::Hamming, FFTDirection::Forward);
  FFT.compute(FFTDirection::Forward);
  FFT.complexToMagnitude();

  // Hitung fitur spektrum (hanya 0..Nyquist).
  const uint16_t half = FFT_N / 2;
  float maxMag = 0.0f;
  uint16_t maxBin = 1;

  float band0_10 = 0, band10_20 = 0, band20_25 = 0;
  float sqSum = 0;

  for (uint16_t i = 1; i < half; i++) {
    float mag = (float)fftReal[i];
    float hz = (i * FFT_SAMPLING_HZ) / FFT_N;

    sqSum += mag * mag;
    if (mag > maxMag) {
      maxMag = mag;
      maxBin = i;
    }

    if (hz < 10.0f) band0_10 += mag;
    else if (hz < 20.0f) band10_20 += mag;
    else band20_25 += mag;
  }

  latestFft.valid = true;
  latestFft.dominantHz = (maxBin * FFT_SAMPLING_HZ) / FFT_N;
  latestFft.dominantMag = maxMag;
  latestFft.rms = sqrtf(sqSum / (half - 1));
  latestFft.band0_10 = band0_10;
  latestFft.band10_20 = band10_20;
  latestFft.band20_25 = band20_25;
  latestFft.computedAtMs = millis();

  perfFftUs = micros() - startUs;
}

String buildFftBinsJson() {
  // kirim 12 bin pertama (0.78 Hz/bin @ 50Hz, N=64) agar bisa diplot di web.
  String out = "[";
  const uint16_t maxBins = 12;
  for (uint16_t i = 1; i <= maxBins; i++) {
    if (i > 1) out += ",";
    out += "{";
    out += "\"hz\":" + String((i * FFT_SAMPLING_HZ) / FFT_N, 2) + ",";
    out += "\"mag\":" + String((float)fftReal[i], 4);
    out += "}";
  }
  out += "]";
  return out;
}

String buildJsonPayload() {
  RawData r;
  AggregatedData a;
  bool hasAgg = false;

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    r = latestRaw;
    a = aggData;
    hasAgg = aggData.valid;
    xSemaphoreGive(dataMutex);
  }

  String json;
  json.reserve(2200);
  json += "{";
  json += "\"deviceId\":\"" DEVICE_ID "\",";
  json += "\"timestampMs\":" + String(millis()) + ",";
  json += "\"samplingHz\":" + String(SENSOR_SAMPLE_HZ) + ",";
  json += "\"fftN\":" + String(FFT_N) + ",";
  json += "\"perf_esp2FftUs\":" + String(perfFftUs) + ",";

  if (hasAgg) {
    json += "\"rpm\":" + String(a.rpmAvg, 0) + ",";
    json += "\"volt\":" + String(a.voltAvg, 1) + ",";
    json += "\"freq\":" + String(a.freqAvg, 2) + ",";
    json += "\"sync\":\"" + String(a.synced ? "ON-GRID" : "OFF-GRID") + "\",";
  } else {
    json += "\"rpm\":" + String(r.rpm) + ",";
    json += "\"volt\":" + String(r.volt, 1) + ",";
    json += "\"freq\":" + String(r.freq, 2) + ",";
    json += "\"sync\":\"" + String(r.gridSync ? "ON-GRID" : "OFF-GRID") + "\",";
  }

  json += "\"status\":\"" + String(r.statusText) + "\",";

  if (latestFft.valid) {
    json += "\"fft\":{";
    json += "\"dominantHz\":" + String(latestFft.dominantHz, 3) + ",";
    json += "\"dominantMag\":" + String(latestFft.dominantMag, 4) + ",";
    json += "\"rms\":" + String(latestFft.rms, 4) + ",";
    json += "\"band0_10\":" + String(latestFft.band0_10, 4) + ",";
    json += "\"band10_20\":" + String(latestFft.band10_20, 4) + ",";
    json += "\"band20_25\":" + String(latestFft.band20_25, 4) + ",";
    json += "\"computedAtMs\":" + String(latestFft.computedAtMs) + ",";
    json += "\"bins\":" + buildFftBinsJson();
    json += "}";
  } else {
    json += "\"fft\":null";
  }

  json += "}";
  return json;
}

// Contoh pemanggilan di task 50Hz:
void SensorTask50Hz(void *pv) {
  TickType_t lastWake = xTaskGetTickCount();
  while (true) {
    RawData snap;
    bool hasData = false;
    if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(5)) == pdTRUE) {
      snap = latestRaw;
      hasData = latestRaw.valid;
      xSemaphoreGive(dataMutex);
    }

    if (hasData) {
      pushFftSample(snap.volt);   // ganti sumber sinyal sesuai sensor CBM Anda
      computeFftIfReady();
    }

    vTaskDelayUntil(&lastWake, pdMS_TO_TICKS(SENSOR_SAMPLE_INTERVAL_MS));
  }
}
