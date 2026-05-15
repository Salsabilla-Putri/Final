// ============================================================
// ESP32-2 FINAL MONITORING:
// CSV UART + TFT LCD + SD CARD + MQTT + COMPUTATION PERFORMANCE
//
// Format RX dari ESP32-1 sinkronisasi:
// $seq,timestampMs,rpm,tps,iat,clt,afr,batt,fuel,freq,freqGrid,volt,voltGrid,engineSync,gridSync,valid
//
// Jumlah field CSV = 16
//
// UART:
// ESP32-1 GPIO25 TX  ---> ESP32-2 GPIO16 RX
// GND ESP32-1        ---> GND ESP32-2
//
// SD Card pada TFT:
// SD_CS   GPIO26
// SD_MOSI GPIO13
// SD_MISO GPIO12
// SD_SCK  GPIO14
//
// Catatan penting:
// - SD diinisialisasi SEBELUM TFT untuk mengurangi konflik shared SPI.
// - SD dan TFT memakai CS berbeda: TFT_CS=15, SD_CS=26.
// - Performa komputasi ditampilkan di Serial Monitor.
// ============================================================

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

// ============================================================
// KONFIGURASI UTAMA
// ============================================================
#define DEVICE_ID "ESP32_GENERATOR_01"

#define FORCE_WIFI_PORTAL 0
#define DEBUG_RX_RAW 0        // 0 agar Serial tidak terlalu berat pada 50 Hz
#define DEBUG_RX_OK  0        // 1 jika ingin lihat setiap frame RX OK

// ============================================================
// UART ANTAR ESP32
// ============================================================
static const uint32_t LINK_BAUD = 115200;
static const int LINK_RX_PIN = 16;
static const int LINK_TX_PIN = 17;   // optional, tidak wajib dipakai

HardwareSerial LinkSerial(2);
String linkRxBuffer = "";

// ============================================================
// WIFI MANAGER
// ============================================================
#define WIFI_MANAGER_AP_NAME "GenTrack-Monitor-AP"
#define WIFI_MANAGER_AP_PASS "12345678"
#define WIFI_MANAGER_TIMEOUT_SEC 180

// ============================================================
// MQTT
// ============================================================
#define MQTT_HOST  "generatorta20.cloud.shiftr.io"
#define MQTT_PORT  1883
#define MQTT_USER  "generatorta20"
#define MQTT_PASS  "TA252601020"
#define MQTT_TOPIC "gen/data"

WiFiClient espClient;
PubSubClient mqtt(espClient);

// ============================================================
// TFT + TOUCH
// ============================================================
TFT_eSPI tft = TFT_eSPI();
Adafruit_FT6206 ts = Adafruit_FT6206();

#define SW 480
#define SH 320

#define C_BG      0xF7BF
#define C_WHITE   0xFFFF
#define C_PRIMARY 0x1234
#define C_GREEN   0x15D0
#define C_ORANGE  0xFB82
#define C_RED     0xEA28
#define C_DARK    0x08A5
#define C_MUTED   0x6B90
#define C_BORDER  0xD6FC
#define C_LGREEN  0xD79C
#define C_LRED    0xFEEA

#define CTP_SDA 21
#define CTP_SCL 22
#define CTP_RST 33
#define CTP_INT 32

#ifndef TFT_CS
#define TFT_CS 15
#endif

// ============================================================
// SD CARD PADA TFT, SHARED HSPI BUS
// ============================================================
#define SD_MISO 12
#define SD_MOSI 13
#define SD_SCK  14
#define SD_CS   26

// Gunakan 400 kHz untuk init stabil. Setelah OK, boleh dicoba 1 MHz.
#define SD_SPI_FREQ_INIT 400000UL
#define SD_SPI_FREQ_FAST 1000000UL

SPIClass sdSPI(HSPI);
SemaphoreHandle_t sdMutex = NULL;
SemaphoreHandle_t dataMutex = NULL;

const char* DB_FILE = "/genset_log.csv";

// ============================================================
// SAMPLING DAN AGREGASI
// ============================================================
#define SENSOR_SAMPLE_HZ          50
#define SENSOR_SAMPLE_INTERVAL_MS 20
#define AGGREGATION_INTERVAL_MS   1000

const unsigned long publishInterval   = 1000;
const unsigned long localSaveInterval = 1000;
const unsigned long drawInterval      = 1000;

// ============================================================
// FFT EDGE COMPUTING
// ============================================================
// FFT dihitung langsung di ESP32-2 dari data CSV 50 Hz yang diterima lewat UART.
// Catatan: karena sinyal adalah data monitoring hasil sampling 50 Hz, FFT ini
// menganalisis fluktuasi sinyal monitoring, bukan harmonisa raw AC 50 Hz.
#define ENABLE_FFT_EDGE        1
#define FFT_SAMPLE_RATE_HZ     50.0
#define FFT_SAMPLES            64      // power of two: 32, 64, 128, 256
#define FFT_BINS_TO_SEND       32      // maksimum FFT_SAMPLES / 2

// 1 = volt generator, 2 = freq generator, 3 = rpm
#define FFT_SOURCE_SIGNAL      1


// ============================================================
// STRUKTUR DATA
// ============================================================
struct RawData {
  uint32_t seq;
  uint32_t timestampMs;
  uint32_t sourceSampleHz;

  int rpm;
  int tps;
  int iat;
  int clt;

  float batt;
  float afr;
  float fuel;

  float freq;
  float freqGrid;
  float volt;
  float voltGrid;

  bool speeduinoSync;
  bool gridSync;
  bool valid;

  char syncText[12];
  char statusText[12];
};

struct AggregatedData {
  uint16_t samples;

  float rpmAvg; int rpmMin; int rpmMax;
  float tpsAvg; int tpsMin; int tpsMax;
  float iatAvg; int iatMin; int iatMax;
  float cltAvg; int cltMin; int cltMax;

  float afrAvg; float afrMin; float afrMax;
  float battAvg; float battMin; float battMax;
  float fuelAvg; float fuelMin; float fuelMax;

  float freqAvg; float freqMin; float freqMax;
  float freqGridAvg; float freqGridMin; float freqGridMax;
  float voltAvg; float voltMin; float voltMax;
  float voltGridAvg; float voltGridMin; float voltGridMax;

  bool synced;
  bool valid;
};

struct FFTData {
  bool valid;
  uint16_t samples;
  float sampleRateHz;
  float resolutionHz;

  float peakHz;
  float peakMagnitude;
  float rms;

  float freqBins[FFT_BINS_TO_SEND];
  float magBins[FFT_BINS_TO_SEND];
};

struct AggAccumulator {
  uint16_t count;

  float rpmSum; int rpmMin; int rpmMax;
  float tpsSum; int tpsMin; int tpsMax;
  float iatSum; int iatMin; int iatMax;
  float cltSum; int cltMin; int cltMax;

  float afrSum; float afrMin; float afrMax;
  float battSum; float battMin; float battMax;
  float fuelSum; float fuelMin; float fuelMax;

  float freqSum; float freqMin; float freqMax;
  float freqGridSum; float freqGridMin; float freqGridMax;
  float voltSum; float voltMin; float voltMax;
  float voltGridSum; float voltGridMin; float voltGridMax;

  uint16_t syncedCount;
};

RawData latestRaw;
AggregatedData aggData;
AggAccumulator acc;

FFTData fftData;

double fftReal[FFT_SAMPLES];
double fftImag[FFT_SAMPLES];
uint16_t fftIndex = 0;
bool fftBufferFull = false;

// ============================================================
// STATE DAN TIMER
// ============================================================
bool wifiOK = false;
bool mqttOK = false;
bool sdOK = false;
bool linkOK = false;
bool needFullRedraw = true;
int activePage = 0;   // 0=Generator, 1=Engine, 2=FFT

unsigned long lastPublish = 0;
unsigned long lastDraw = 0;
unsigned long lastLocalSave = 0;
unsigned long lastReconnect = 0;
unsigned long lastWifiCheck = 0;
unsigned long lastSerialLog = 0;
unsigned long lastLinkFrameMs = 0;
unsigned long lastSDRetry = 0;
unsigned long lastDBStorageReport = 0;

unsigned long sdSaveSuccessCount = 0;
unsigned long sdSaveFailCount = 0;
uint64_t dbTotalWrittenBytes = 0;
uint32_t dbLastLineBytes = 0;
unsigned long dbStorageReportInterval = 10000;

volatile uint32_t sensorExecutions = 0;
volatile uint32_t sensorMissedDeadlines = 0;
volatile uint32_t parseOKCount = 0;
volatile uint32_t parseFailCount = 0;
volatile uint32_t rxBufferResetCount = 0;

// ============================================================
// PERFORMANCE METRICS
// ============================================================
volatile uint32_t perfUartReadUs = 0;
volatile uint32_t perfCsvParseUs = 0;
volatile uint32_t perfAggregationUs = 0;
volatile uint32_t perfJsonBuildUs = 0;
volatile uint32_t perfMqttPublishUs = 0;
volatile uint32_t perfSdSaveUs = 0;
volatile uint32_t perfTftDrawUs = 0;
volatile uint32_t perfSensorTaskUs = 0;
volatile uint32_t perfFftComputeUs = 0;

volatile uint32_t perfLastRxAgeMs = 0;
volatile uint32_t perfBackendToFrontendEstimateMs = 0;

unsigned long lastUartReceiveMs = 0;
unsigned long lastAggReadyMs = 0;
unsigned long lastMqttPublishMs = 0;
unsigned long lastTftDrawMs = 0;

char tmp[24];

// ============================================================
// HELPER
// ============================================================
const char* fmtF(float v, int d = 1) {
  dtostrf(v, 0, d, tmp);
  return tmp;
}

String formatBytes(uint64_t bytes) {
  if (bytes < 1024ULL) return String((unsigned long)bytes) + " B";
  if (bytes < 1024ULL * 1024ULL) return String(bytes / 1024.0, 2) + " KB";
  if (bytes < 1024ULL * 1024ULL * 1024ULL) return String(bytes / 1024.0 / 1024.0, 2) + " MB";
  return String(bytes / 1024.0 / 1024.0 / 1024.0, 2) + " GB";
}

uint16_t valColor(float v, float warnHi, float dangerHi, float warnLo = -1e9, float dangerLo = -1e9) {
  if (v >= dangerHi || v <= dangerLo) return C_RED;
  if (v >= warnHi || v <= warnLo) return C_ORANGE;
  return C_GREEN;
}

float getFFTInputSignal(const RawData &d) {
#if FFT_SOURCE_SIGNAL == 1
  return d.volt;
#elif FFT_SOURCE_SIGNAL == 2
  return d.freq;
#elif FFT_SOURCE_SIGNAL == 3
  return (float)d.rpm;
#else
  return d.volt;
#endif
}

const char* getFFTSourceName() {
#if FFT_SOURCE_SIGNAL == 1
  return "volt";
#elif FFT_SOURCE_SIGNAL == 2
  return "freq";
#elif FFT_SOURCE_SIGNAL == 3
  return "rpm";
#else
  return "volt";
#endif
}

void deselectAllSPI() {
  pinMode(TFT_CS, OUTPUT);
  pinMode(SD_CS, OUTPUT);
  digitalWrite(TFT_CS, HIGH);
  digitalWrite(SD_CS, HIGH);
  delayMicroseconds(50);
}

void prepareSDAccess() {
  digitalWrite(TFT_CS, HIGH);
  digitalWrite(SD_CS, HIGH);
  delayMicroseconds(50);
}

// ============================================================
// PARSER CSV DARI ESP32-1
// ============================================================
bool parseBridgeCsv(const String &line, RawData &out) {
  if (!line.startsWith("$")) return false;

  String data = line.substring(1);
  String fields[16];

  int fieldIndex = 0;
  int start = 0;

  for (int i = 0; i <= data.length(); i++) {
    if (i == data.length() || data[i] == ',') {
      if (fieldIndex < 16) {
        fields[fieldIndex] = data.substring(start, i);
        fields[fieldIndex].trim();
        fieldIndex++;
      }
      start = i + 1;
    }
  }

  if (fieldIndex < 16) {
    Serial.print("[CSV FAIL] Field kurang: ");
    Serial.println(fieldIndex);
    return false;
  }

  out.seq = fields[0].toInt();
  out.timestampMs = fields[1].toInt();
  out.sourceSampleHz = SENSOR_SAMPLE_HZ;

  out.rpm = fields[2].toInt();
  out.tps = fields[3].toInt();
  out.iat = fields[4].toInt();
  out.clt = fields[5].toInt();

  out.afr = fields[6].toFloat();
  out.batt = fields[7].toFloat();
  out.fuel = fields[8].toFloat();

  out.freq = fields[9].toFloat();
  out.freqGrid = fields[10].toFloat();
  out.volt = fields[11].toFloat();
  out.voltGrid = fields[12].toFloat();

  out.speeduinoSync = fields[13].toInt() == 1;
  out.gridSync = fields[14].toInt() == 1;
  out.valid = fields[15].toInt() == 1;

  // Fallback: bila valid=0 tetapi data fisik ada, tetap dipakai agar monitoring tidak kosong.
  if (!out.valid && (out.rpm != 0 || out.freq != 0.0f || out.volt != 0.0f)) {
    out.valid = true;
  }

  strlcpy(out.syncText, out.gridSync ? "ON-GRID" : "OFF-GRID", sizeof(out.syncText));
  strlcpy(out.statusText, (out.rpm <= 0) ? "STOPPED" : (out.gridSync ? "ON-GRID" : "RUNNING"), sizeof(out.statusText));

  return true;
}

void handleCompleteRxLine(String line) {
  line.trim();
  if (line.length() == 0) return;

#if DEBUG_RX_RAW
  Serial.print("[RX RAW] ");
  Serial.println(line);
#endif

  RawData parsed;

  uint32_t parseStart = micros();
  bool ok = parseBridgeCsv(line, parsed);
  perfCsvParseUs = micros() - parseStart;

  if (ok) {
    if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(5)) == pdTRUE) {
      latestRaw = parsed;
      xSemaphoreGive(dataMutex);
    }

    lastUartReceiveMs = millis();
    lastLinkFrameMs = millis();
    linkOK = true;
    parseOKCount++;

#if DEBUG_RX_OK
    Serial.print("[RX OK] seq=");
    Serial.print((unsigned long)parsed.seq);
    Serial.print(" rpm=");
    Serial.print(parsed.rpm);
    Serial.print(" freq=");
    Serial.print(parsed.freq, 2);
    Serial.print(" volt=");
    Serial.print(parsed.volt, 1);
    Serial.print(" valid=");
    Serial.println(parsed.valid ? 1 : 0);
#endif
  } else {
    parseFailCount++;
    Serial.print("[RX CSV FAIL] ");
    Serial.println(line);
  }
}

void readLinkSerialManual() {
  uint32_t readStart = micros();

  while (LinkSerial.available()) {
    char c = (char)LinkSerial.read();

    if (c == '$') {
      linkRxBuffer = "";
      linkRxBuffer += c;
      continue;
    }

    if (linkRxBuffer.length() == 0) {
      continue;
    }

    if (c == '\n') {
      handleCompleteRxLine(linkRxBuffer);
      linkRxBuffer = "";
      continue;
    }

    if (c != '\r') {
      linkRxBuffer += c;
    }

    if (linkRxBuffer.length() > 250) {
      Serial.println("[RX BUFFER RESET] CSV terlalu panjang/rusak. Buffer direset.");
      linkRxBuffer = "";
      rxBufferResetCount++;
      parseFailCount++;
    }
  }

  perfUartReadUs = micros() - readStart;
}

// ============================================================
// AGREGASI
// ============================================================
void resetAccumulator() {
  memset(&acc, 0, sizeof(acc));

  acc.rpmMin = acc.tpsMin = acc.iatMin = acc.cltMin = 999999;
  acc.rpmMax = acc.tpsMax = acc.iatMax = acc.cltMax = -999999;

  acc.afrMin = acc.battMin = acc.fuelMin = 999999.0f;
  acc.afrMax = acc.battMax = acc.fuelMax = -999999.0f;

  acc.freqMin = acc.freqGridMin = acc.voltMin = acc.voltGridMin = 999999.0f;
  acc.freqMax = acc.freqGridMax = acc.voltMax = acc.voltGridMax = -999999.0f;
}

void addSampleToAccumulator(const RawData &d) {
  if (d.rpm == 0 && d.freq == 0.0f && d.volt == 0.0f) return;

  acc.count++;

  acc.rpmSum += d.rpm;
  acc.rpmMin = min(acc.rpmMin, d.rpm);
  acc.rpmMax = max(acc.rpmMax, d.rpm);

  acc.tpsSum += d.tps;
  acc.tpsMin = min(acc.tpsMin, d.tps);
  acc.tpsMax = max(acc.tpsMax, d.tps);

  acc.iatSum += d.iat;
  acc.iatMin = min(acc.iatMin, d.iat);
  acc.iatMax = max(acc.iatMax, d.iat);

  acc.cltSum += d.clt;
  acc.cltMin = min(acc.cltMin, d.clt);
  acc.cltMax = max(acc.cltMax, d.clt);

  acc.afrSum += d.afr;
  acc.afrMin = min(acc.afrMin, d.afr);
  acc.afrMax = max(acc.afrMax, d.afr);

  acc.battSum += d.batt;
  acc.battMin = min(acc.battMin, d.batt);
  acc.battMax = max(acc.battMax, d.batt);

  acc.fuelSum += d.fuel;
  acc.fuelMin = min(acc.fuelMin, d.fuel);
  acc.fuelMax = max(acc.fuelMax, d.fuel);

  acc.freqSum += d.freq;
  acc.freqMin = min(acc.freqMin, d.freq);
  acc.freqMax = max(acc.freqMax, d.freq);

  acc.freqGridSum += d.freqGrid;
  acc.freqGridMin = min(acc.freqGridMin, d.freqGrid);
  acc.freqGridMax = max(acc.freqGridMax, d.freqGrid);

  acc.voltSum += d.volt;
  acc.voltMin = min(acc.voltMin, d.volt);
  acc.voltMax = max(acc.voltMax, d.volt);

  acc.voltGridSum += d.voltGrid;
  acc.voltGridMin = min(acc.voltGridMin, d.voltGrid);
  acc.voltGridMax = max(acc.voltGridMax, d.voltGrid);

  if (d.gridSync) acc.syncedCount++;
}


// ============================================================
// FFT EDGE COMPUTING
// ============================================================
void addSampleToFFTBuffer(const RawData &d) {
#if ENABLE_FFT_EDGE
  if (!d.valid) return;

  float signal = getFFTInputSignal(d);
  if (isnan(signal) || isinf(signal)) return;

  fftReal[fftIndex] = signal;
  fftImag[fftIndex] = 0.0;

  fftIndex++;

  if (fftIndex >= FFT_SAMPLES) {
    fftIndex = 0;
    fftBufferFull = true;
  }
#endif
}

void computeFFTIfReady() {
#if ENABLE_FFT_EDGE
  if (!fftBufferFull) return;

  uint32_t fftStart = micros();

  double localReal[FFT_SAMPLES];
  double localImag[FFT_SAMPLES];

  // Salin circular buffer agar urutan waktu tetap benar.
  for (uint16_t i = 0; i < FFT_SAMPLES; i++) {
    uint16_t idx = (fftIndex + i) % FFT_SAMPLES;
    localReal[i] = fftReal[idx];
    localImag[i] = 0.0;
  }

  // Remove DC offset supaya peak FFT tidak didominasi nilai rata-rata sinyal.
  double mean = 0.0;
  for (uint16_t i = 0; i < FFT_SAMPLES; i++) {
    mean += localReal[i];
  }
  mean /= FFT_SAMPLES;

  double rms = 0.0;
  for (uint16_t i = 0; i < FFT_SAMPLES; i++) {
    localReal[i] -= mean;
    rms += localReal[i] * localReal[i];
  }
  rms = sqrt(rms / FFT_SAMPLES);

  ArduinoFFT<double> FFT = ArduinoFFT<double>(
    localReal,
    localImag,
    FFT_SAMPLES,
    FFT_SAMPLE_RATE_HZ
  );

  FFT.windowing(FFT_WIN_TYP_HAMMING, FFT_FORWARD);
  FFT.compute(FFT_FORWARD);
  FFT.complexToMagnitude();

  FFTData result;
  memset(&result, 0, sizeof(result));

  result.valid = true;
  result.samples = FFT_SAMPLES;
  result.sampleRateHz = FFT_SAMPLE_RATE_HZ;
  result.resolutionHz = FFT_SAMPLE_RATE_HZ / FFT_SAMPLES;
  result.rms = (float)rms;

  float peakMag = 0.0f;
  float peakHz = 0.0f;

  uint16_t maxBins = FFT_BINS_TO_SEND;
  if (maxBins > FFT_SAMPLES / 2) {
    maxBins = FFT_SAMPLES / 2;
  }

  for (uint16_t i = 0; i < maxBins; i++) {
    float binHz = i * result.resolutionHz;
    float mag = (float)localReal[i];

    result.freqBins[i] = binHz;
    result.magBins[i] = mag;

    // Abaikan bin 0 karena itu komponen DC.
    if (i > 0 && mag > peakMag) {
      peakMag = mag;
      peakHz = binHz;
    }
  }

  result.peakHz = peakHz;
  result.peakMagnitude = peakMag;

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    fftData = result;
    xSemaphoreGive(dataMutex);
  }

  perfFftComputeUs = micros() - fftStart;
#endif
}

void finalizeAggregation() {
  uint32_t aggStart = micros();

  if (acc.count == 0) {
    perfAggregationUs = micros() - aggStart;
    return;
  }

  AggregatedData a;
  memset(&a, 0, sizeof(a));

  a.samples = acc.count;

  a.rpmAvg = acc.rpmSum / acc.count;
  a.rpmMin = acc.rpmMin;
  a.rpmMax = acc.rpmMax;

  a.tpsAvg = acc.tpsSum / acc.count;
  a.tpsMin = acc.tpsMin;
  a.tpsMax = acc.tpsMax;

  a.iatAvg = acc.iatSum / acc.count;
  a.iatMin = acc.iatMin;
  a.iatMax = acc.iatMax;

  a.cltAvg = acc.cltSum / acc.count;
  a.cltMin = acc.cltMin;
  a.cltMax = acc.cltMax;

  a.afrAvg = acc.afrSum / acc.count;
  a.afrMin = acc.afrMin;
  a.afrMax = acc.afrMax;

  a.battAvg = acc.battSum / acc.count;
  a.battMin = acc.battMin;
  a.battMax = acc.battMax;

  a.fuelAvg = acc.fuelSum / acc.count;
  a.fuelMin = acc.fuelMin;
  a.fuelMax = acc.fuelMax;

  a.freqAvg = acc.freqSum / acc.count;
  a.freqMin = acc.freqMin;
  a.freqMax = acc.freqMax;

  a.freqGridAvg = acc.freqGridSum / acc.count;
  a.freqGridMin = acc.freqGridMin;
  a.freqGridMax = acc.freqGridMax;

  a.voltAvg = acc.voltSum / acc.count;
  a.voltMin = acc.voltMin;
  a.voltMax = acc.voltMax;

  a.voltGridAvg = acc.voltGridSum / acc.count;
  a.voltGridMin = acc.voltGridMin;
  a.voltGridMax = acc.voltGridMax;

  a.synced = acc.syncedCount > (acc.count / 2);
  a.valid = true;

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    aggData = a;
    xSemaphoreGive(dataMutex);
  }

  lastAggReadyMs = millis();
  resetAccumulator();

  perfAggregationUs = micros() - aggStart;
}

void SensorTask50Hz(void *pv) {
  TickType_t lastWake = xTaskGetTickCount();
  unsigned long lastAggregationTime = millis();

  resetAccumulator();

  while (true) {
    uint32_t taskStart = micros();

    readLinkSerialManual();

    RawData snap;
    bool hasData = false;

    if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(5)) == pdTRUE) {
      snap = latestRaw;
      hasData = latestRaw.valid;
      xSemaphoreGive(dataMutex);
    }

    if (millis() - lastLinkFrameMs > 2000) {
      linkOK = false;
    }

    if (hasData && linkOK) {
      addSampleToAccumulator(snap);
      addSampleToFFTBuffer(snap);
    }

    if (millis() - lastAggregationTime >= AGGREGATION_INTERVAL_MS) {
      lastAggregationTime += AGGREGATION_INTERVAL_MS;
      finalizeAggregation();
      computeFFTIfReady();
    }

    sensorExecutions++;

    perfSensorTaskUs = micros() - taskStart;

    if (perfSensorTaskUs > SENSOR_SAMPLE_INTERVAL_MS * 1000UL) {
      sensorMissedDeadlines++;
    }

    vTaskDelayUntil(&lastWake, pdMS_TO_TICKS(SENSOR_SAMPLE_INTERVAL_MS));
  }
}

// ============================================================
// MQTT PAYLOAD
// ============================================================
String buildJsonPayload() {
  uint32_t jsonStart = micros();

  AggregatedData a;
  RawData r;
  FFTData f;
  bool hasAgg = false;
  bool hasFFT = false;

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    a = aggData;
    r = latestRaw;
    f = fftData;
    hasAgg = aggData.valid;
    hasFFT = fftData.valid;
    xSemaphoreGive(dataMutex);
  }

  const float amp = 0.0f;
  const float voltUse = hasAgg ? a.voltAvg : r.volt;
  const float power = voltUse * amp;

  String json;
  json.reserve(3500);

  json += "{";
  json += "\"deviceId\":\"" DEVICE_ID "\",";
  json += "\"timestampMs\":" + String(millis()) + ",";
  json += "\"sourceTimestampMs\":" + String(r.timestampMs) + ",";
  json += "\"sourceSeq\":" + String(r.seq) + ",";
  json += "\"link\":\"" + String(linkOK ? "OK" : "LOST") + "\",";
  json += "\"samplingHz\":" + String(SENSOR_SAMPLE_HZ) + ",";
  json += "\"aggregationWindowMs\":" + String(AGGREGATION_INTERVAL_MS) + ",";

  // Performance ESP32-2
  json += "\"perf_esp2UartReadUs\":" + String(perfUartReadUs) + ",";
  json += "\"perf_esp2CsvParseUs\":" + String(perfCsvParseUs) + ",";
  json += "\"perf_esp2AggregationUs\":" + String(perfAggregationUs) + ",";
  json += "\"perf_esp2JsonBuildUs\":" + String(perfJsonBuildUs) + ",";
  json += "\"perf_esp2MqttPublishUs\":" + String(perfMqttPublishUs) + ",";
  json += "\"perf_esp2SdSaveUs\":" + String(perfSdSaveUs) + ",";
  json += "\"perf_esp2TftDrawUs\":" + String(perfTftDrawUs) + ",";
  json += "\"perf_esp2SensorTaskUs\":" + String(perfSensorTaskUs) + ",";
  json += "\"perf_esp2FftComputeUs\":" + String(perfFftComputeUs) + ",";

  if (hasAgg) {
    json += "\"samples\":" + String(a.samples) + ",";

    json += "\"rpm\":" + String(a.rpmAvg, 0) + ",";
    json += "\"rpm_min\":" + String(a.rpmMin) + ",";
    json += "\"rpm_max\":" + String(a.rpmMax) + ",";

    json += "\"tps\":" + String(a.tpsAvg, 0) + ",";
    json += "\"tps_min\":" + String(a.tpsMin) + ",";
    json += "\"tps_max\":" + String(a.tpsMax) + ",";

    json += "\"iat\":" + String(a.iatAvg, 1) + ",";
    json += "\"coolant\":" + String(a.cltAvg, 1) + ",";
    json += "\"temp\":" + String(a.cltAvg, 1) + ",";

    json += "\"afr\":" + String(a.afrAvg, 2) + ",";
    json += "\"batt\":" + String(a.battAvg, 2) + ",";
    json += "\"fuel\":" + String(a.fuelAvg, 1) + ",";

    json += "\"volt\":" + String(a.voltAvg, 1) + ",";
    json += "\"volt_grid\":" + String(a.voltGridAvg, 1) + ",";

    json += "\"freq\":" + String(a.freqAvg, 2) + ",";
    json += "\"freq_grid\":" + String(a.freqGridAvg, 2) + ",";

    json += "\"amp\":" + String(amp, 2) + ",";
    json += "\"power\":" + String(power, 1) + ",";
    json += "\"sync\":\"" + String(a.synced ? "ON-GRID" : "OFF-GRID") + "\",";
    json += "\"status\":\"" + String((a.rpmAvg <= 0) ? "STOPPED" : (a.synced ? "ON-GRID" : "RUNNING")) + "\"";
  } else {
    json += "\"samples\":0,";
    json += "\"rpm\":" + String(r.rpm) + ",";
    json += "\"tps\":" + String(r.tps) + ",";
    json += "\"iat\":" + String(r.iat) + ",";
    json += "\"coolant\":" + String(r.clt) + ",";
    json += "\"temp\":" + String(r.clt) + ",";
    json += "\"afr\":" + String(r.afr, 2) + ",";
    json += "\"batt\":" + String(r.batt, 2) + ",";
    json += "\"fuel\":" + String(r.fuel, 1) + ",";
    json += "\"volt\":" + String(r.volt, 1) + ",";
    json += "\"volt_grid\":" + String(r.voltGrid, 1) + ",";
    json += "\"freq\":" + String(r.freq, 2) + ",";
    json += "\"freq_grid\":" + String(r.freqGrid, 2) + ",";
    json += "\"amp\":" + String(amp, 2) + ",";
    json += "\"power\":" + String(power, 1) + ",";
    json += "\"sync\":\"" + String(r.gridSync ? "ON-GRID" : "OFF-GRID") + "\",";
    json += "\"status\":\"" + String(r.statusText) + "\"";
  }

  json += ",";

  if (hasFFT) {
    json += "\"fft\":{";
    json += "\"valid\":true,";
    json += "\"source\":\"" + String(getFFTSourceName()) + "\",";
    json += "\"sampleRateHz\":" + String(f.sampleRateHz, 2) + ",";
    json += "\"samples\":" + String(f.samples) + ",";
    json += "\"resolutionHz\":" + String(f.resolutionHz, 4) + ",";
    json += "\"peakHz\":" + String(f.peakHz, 4) + ",";
    json += "\"peakMagnitude\":" + String(f.peakMagnitude, 4) + ",";
    json += "\"rms\":" + String(f.rms, 4) + ",";

    json += "\"freqBins\":[";
    for (uint16_t i = 0; i < FFT_BINS_TO_SEND; i++) {
      if (i > 0) json += ",";
      json += String(f.freqBins[i], 4);
    }
    json += "],";

    json += "\"magBins\":[";
    for (uint16_t i = 0; i < FFT_BINS_TO_SEND; i++) {
      if (i > 0) json += ",";
      json += String(f.magBins[i], 4);
    }
    json += "]";

    json += "}";
  } else {
    json += "\"fft\":{\"valid\":false}";
  }

  json += "}";

  perfJsonBuildUs = micros() - jsonStart;
  return json;
}

void publishRealtimeData() {
  if (!wifiOK) {
    Serial.println("[MQTT] SKIP: WiFi belum connected.");
    return;
  }

  if (!mqtt.connected()) {
    Serial.print("[MQTT] SKIP: MQTT belum connected. state=");
    Serial.println(mqtt.state());
    return;
  }

  String payload = buildJsonPayload();

  uint32_t publishStart = micros();
  bool ok = mqtt.publish(MQTT_TOPIC, payload.c_str());
  perfMqttPublishUs = micros() - publishStart;
  lastMqttPublishMs = millis();

  Serial.println();
  Serial.println("══════════════ MQTT JSON DATA ══════════════");
  Serial.print("  topic   : ");
  Serial.println(MQTT_TOPIC);
  Serial.print("  result  : ");
  Serial.println(ok ? "OK" : "FAILED");
  Serial.print("  payload bytes : ");
  Serial.println(payload.length());
  Serial.print("  MQTT publish time : ");
  Serial.print(perfMqttPublishUs);
  Serial.println(" us");
  Serial.println("═══════════════════════════════════════════");
}

// ============================================================
// SD CARD
// ============================================================
void writeCsvHeaderIfNeeded() {
  prepareSDAccess();

  if (SD.exists(DB_FILE)) {
    digitalWrite(SD_CS, HIGH);
    return;
  }

  File f = SD.open(DB_FILE, FILE_WRITE);
  if (!f) {
    Serial.println("[SD] Header gagal: file tidak bisa dibuat.");
    digitalWrite(SD_CS, HIGH);
    return;
  }

  f.println("millis,deviceId,link,samplingHz,aggregationWindowMs,samples,perf_uartReadUs,perf_csvParseUs,perf_aggregationUs,perf_jsonBuildUs,perf_mqttPublishUs,perf_sdSaveUs,perf_tftDrawUs,perf_sensorTaskUs,rpm_avg,rpm_min,rpm_max,tps_avg,tps_min,tps_max,iat_avg,coolant_avg,afr_avg,batt_avg,fuel_avg,volt_avg,volt_grid_avg,freq_avg,freq_grid_avg,amp,power,sync,status");
  f.flush();
  f.close();

  digitalWrite(SD_CS, HIGH);

  Serial.println("[SD] Header CSV dibuat.");
}

void printDatabaseStorageReport(size_t lastLineBytes) {
  if (!sdOK) {
    Serial.println("[DB] SKIP: SD belum ready.");
    return;
  }

  if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(1000)) != pdTRUE) {
    Serial.println("[DB] SKIP: mutex timeout.");
    return;
  }

  prepareSDAccess();

  uint64_t fileSize = 0;
  uint64_t cardSize = SD.cardSize();
  uint64_t usedBytes = SD.usedBytes();
  uint64_t freeBytes = (cardSize > usedBytes) ? (cardSize - usedBytes) : 0;

  File db = SD.open(DB_FILE, FILE_READ);
  if (db) {
    fileSize = db.size();
    db.close();
  }

  digitalWrite(SD_CS, HIGH);
  xSemaphoreGive(sdMutex);

  float intervalSec = localSaveInterval / 1000.0f;
  uint32_t recordsPerDay = (uint32_t)(86400.0f / intervalSec);
  uint32_t records7Days = recordsPerDay * 7UL;
  uint64_t estimated7DayBytes = (uint64_t)lastLineBytes * records7Days;

  Serial.println();
  Serial.println("════════════ DATABASE STORAGE REPORT ════════════");
  Serial.printf("[DB] Last row size       : %u bytes\n", (unsigned int)lastLineBytes);
  Serial.printf("[DB] Current file size   : %s\n", formatBytes(fileSize).c_str());
  Serial.printf("[DB] Records / day       : %lu\n", (unsigned long)recordsPerDay);
  Serial.printf("[DB] Records / 7 days    : %lu\n", (unsigned long)records7Days);
  Serial.printf("[DB] Estimate / 7 days   : %s\n", formatBytes(estimated7DayBytes).c_str());
  Serial.printf("[SD] Card size           : %s\n", formatBytes(cardSize).c_str());
  Serial.printf("[SD] Used bytes          : %s\n", formatBytes(usedBytes).c_str());
  Serial.printf("[SD] Free bytes          : %s\n", formatBytes(freeBytes).c_str());
  Serial.printf("[SD] Status capacity     : %s\n", freeBytes >= estimated7DayBytes ? "CUKUP untuk 7 hari" : "TIDAK CUKUP untuk 7 hari");
  Serial.println("══════════════════════════════════════════════════");
}

void initSDCard() {
  Serial.println();
  Serial.println("══════════════ SD CARD INIT ══════════════");
  Serial.printf("[SD] CS=%d MOSI=%d MISO=%d SCK=%d\n",
                SD_CS, SD_MOSI, SD_MISO, SD_SCK);

  sdOK = false;

  if (sdMutex == NULL) {
    sdMutex = xSemaphoreCreateMutex();
  }

  if (sdMutex == NULL) {
    Serial.println("[SD] GAGAL: mutex tidak bisa dibuat.");
    return;
  }

  if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(1000)) != pdTRUE) {
    Serial.println("[SD] GAGAL: mutex timeout saat init.");
    return;
  }

  pinMode(TFT_CS, OUTPUT);
  pinMode(SD_CS, OUTPUT);

  digitalWrite(TFT_CS, HIGH);
  digitalWrite(SD_CS, HIGH);
  delay(200);

  SD.end();
  sdSPI.end();
  delay(200);

  sdSPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  delay(200);

  bool beginOK = false;

  uint32_t freqList[] = {
    SD_SPI_FREQ_INIT,
    SD_SPI_FREQ_FAST
  };

  for (int i = 0; i < 2; i++) {
    uint32_t freq = freqList[i];

    Serial.printf("[SD] Mencoba SD.begin() pada %lu Hz...\n", freq);

    digitalWrite(TFT_CS, HIGH);
    digitalWrite(SD_CS, HIGH);
    delay(100);

    beginOK = SD.begin(SD_CS, sdSPI, freq);

    if (beginOK) {
      Serial.printf("[SD] SD.begin() OK pada %lu Hz\n", freq);
      break;
    }

    Serial.printf("[SD] SD.begin() gagal pada %lu Hz\n", freq);
    SD.end();
    delay(200);
  }

  if (!beginOK) {
    Serial.println("[SD] GAGAL TOTAL: SD.begin() gagal.");
    Serial.println("[SD] Pastikan wiring:");
    Serial.println("[SD] SD_CS   -> GPIO26");
    Serial.println("[SD] SD_MOSI -> GPIO13");
    Serial.println("[SD] SD_MISO -> GPIO12");
    Serial.println("[SD] SD_SCK  -> GPIO14");
    digitalWrite(SD_CS, HIGH);
    xSemaphoreGive(sdMutex);
    return;
  }

  uint8_t cardType = SD.cardType();

  if (cardType == CARD_NONE) {
    Serial.println("[SD] GAGAL: CARD_NONE.");
    digitalWrite(SD_CS, HIGH);
    xSemaphoreGive(sdMutex);
    return;
  }

  Serial.print("[SD] Card type: ");
  if (cardType == CARD_MMC) Serial.println("MMC");
  else if (cardType == CARD_SD) Serial.println("SDSC");
  else if (cardType == CARD_SDHC) Serial.println("SDHC");
  else Serial.println("UNKNOWN");

  Serial.printf("[SD] Card size: %s\n", formatBytes(SD.cardSize()).c_str());

  File test = SD.open("/sd_boot_test.txt", FILE_APPEND);
  if (!test) {
    Serial.println("[SD] GAGAL: tidak bisa membuat file test.");
    digitalWrite(SD_CS, HIGH);
    xSemaphoreGive(sdMutex);
    return;
  }

  size_t written = test.printf("Boot test millis=%lu\n", millis());
  test.flush();
  test.close();

  if (written == 0) {
    Serial.println("[SD] GAGAL: write test 0 byte.");
    digitalWrite(SD_CS, HIGH);
    xSemaphoreGive(sdMutex);
    return;
  }

  Serial.printf("[SD] Write test OK. bytes=%u\n", (unsigned int)written);

  writeCsvHeaderIfNeeded();

  if (!SD.exists(DB_FILE)) {
    Serial.println("[SD] GAGAL: file CSV belum terbentuk.");
    digitalWrite(SD_CS, HIGH);
    xSemaphoreGive(sdMutex);
    return;
  }

  digitalWrite(SD_CS, HIGH);

  sdOK = true;
  xSemaphoreGive(sdMutex);

  Serial.println("[SD] STATUS: READY");
  Serial.println("══════════════════════════════════════════");
}

void saveSnapshotToSD() {
  uint32_t sdStart = micros();

  if (!sdOK || sdMutex == NULL) {
    Serial.println("[SD] SKIP: SD belum ready. Cek log SD CARD INIT.");
    perfSdSaveUs = micros() - sdStart;
    return;
  }

  AggregatedData a;
  bool hasAgg = false;

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    a = aggData;
    hasAgg = aggData.valid;
    xSemaphoreGive(dataMutex);
  }

  if (!hasAgg) {
    Serial.println("[SD] SKIP: data agregasi belum valid.");
    perfSdSaveUs = micros() - sdStart;
    return;
  }

  const float amp = 0.0f;
  const float power = a.voltAvg * amp;
  String syncStr = a.synced ? "ON-GRID" : "OFF-GRID";
  String statusStr = (a.rpmAvg <= 0) ? "STOPPED" : (a.synced ? "ON-GRID" : "RUNNING");

  String line;
  line.reserve(700);

  line += String(millis());
  line += "," DEVICE_ID;
  line += "," + String(linkOK ? "OK" : "LOST");
  line += "," + String(SENSOR_SAMPLE_HZ);
  line += "," + String(AGGREGATION_INTERVAL_MS);
  line += "," + String(a.samples);

  // Performance columns
  line += "," + String(perfUartReadUs);
  line += "," + String(perfCsvParseUs);
  line += "," + String(perfAggregationUs);
  line += "," + String(perfJsonBuildUs);
  line += "," + String(perfMqttPublishUs);
  line += "," + String(perfSdSaveUs);
  line += "," + String(perfTftDrawUs);
  line += "," + String(perfSensorTaskUs);

  // Data columns
  line += "," + String(a.rpmAvg, 0);
  line += "," + String(a.rpmMin);
  line += "," + String(a.rpmMax);

  line += "," + String(a.tpsAvg, 0);
  line += "," + String(a.tpsMin);
  line += "," + String(a.tpsMax);

  line += "," + String(a.iatAvg, 1);
  line += "," + String(a.cltAvg, 1);

  line += "," + String(a.afrAvg, 2);
  line += "," + String(a.battAvg, 2);
  line += "," + String(a.fuelAvg, 1);

  line += "," + String(a.voltAvg, 1);
  line += "," + String(a.voltGridAvg, 1);

  line += "," + String(a.freqAvg, 2);
  line += "," + String(a.freqGridAvg, 2);

  line += "," + String(amp, 2);
  line += "," + String(power, 1);
  line += "," + syncStr;
  line += "," + statusStr;

  if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(1000)) != pdTRUE) {
    Serial.println("[SD] Save failed: mutex timeout.");
    perfSdSaveUs = micros() - sdStart;
    return;
  }

  prepareSDAccess();

  File f = SD.open(DB_FILE, FILE_APPEND);

  if (!f) {
    sdSaveFailCount++;
    sdOK = false;

    digitalWrite(SD_CS, HIGH);
    xSemaphoreGive(sdMutex);

    Serial.println("[SD] Save failed: file open gagal.");
    Serial.println("[SD] sdOK=false, akan retry init otomatis.");
    perfSdSaveUs = micros() - sdStart;
    return;
  }

  size_t lineBytes = line.length() + 1;
  size_t written = f.println(line);

  f.flush();
  f.close();

  digitalWrite(SD_CS, HIGH);
  xSemaphoreGive(sdMutex);

  perfSdSaveUs = micros() - sdStart;

  if (written > 0) {
    sdSaveSuccessCount++;
    dbLastLineBytes = lineBytes;
    dbTotalWrittenBytes += written;

    Serial.printf("[SD] Save OK. row=%u bytes written=%u saveTime=%lu us success=%lu fail=%lu\n",
                  (unsigned int)lineBytes,
                  (unsigned int)written,
                  (unsigned long)perfSdSaveUs,
                  sdSaveSuccessCount,
                  sdSaveFailCount);
  } else {
    sdSaveFailCount++;
    Serial.println("[SD] Save failed: write 0 byte.");
  }

  if (written > 0 && millis() - lastDBStorageReport >= dbStorageReportInterval) {
    lastDBStorageReport = millis();
    printDatabaseStorageReport(dbLastLineBytes);
  }
}

// ============================================================
// WIFI + MQTT
// ============================================================
void setupWiFiManager() {
  Serial.println();
  Serial.println("══════════════ WIFI MANAGER INIT ══════════════");

  WiFi.mode(WIFI_STA);

  WiFiManager wm;
  wm.setConfigPortalTimeout(WIFI_MANAGER_TIMEOUT_SEC);
  wm.setConnectTimeout(20);
  wm.setConnectRetries(3);

#if FORCE_WIFI_PORTAL
  wm.resetSettings();
  bool res = wm.startConfigPortal(WIFI_MANAGER_AP_NAME, WIFI_MANAGER_AP_PASS);
#else
  bool res = wm.autoConnect(WIFI_MANAGER_AP_NAME, WIFI_MANAGER_AP_PASS);
#endif

  if (res) {
    wifiOK = true;
    Serial.print("[WIFI] Connected. IP: ");
    Serial.println(WiFi.localIP());
  } else {
    wifiOK = false;
    Serial.println("[WIFI] Failed / timeout. System tetap jalan offline.");
  }

  Serial.println("═══════════════════════════════════════════════");
}

void reconnectMQTT() {
  if (!wifiOK) return;

  if (mqtt.connected()) {
    mqttOK = true;
    return;
  }

  if (millis() - lastReconnect < 3000) return;
  lastReconnect = millis();

  String clientId = String("ESP32_MONITOR_") + String((uint32_t)ESP.getEfuseMac(), HEX);

  Serial.print("[MQTT] Connecting... ");

  if (mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS)) {
    mqttOK = true;
    Serial.println("OK");
  } else {
    mqttOK = false;
    Serial.print("FAILED rc=");
    Serial.println(mqtt.state());
  }
}

void checkWiFiStatus() {
  if (millis() - lastWifiCheck < 3000) return;

  lastWifiCheck = millis();

  wifiOK = WiFi.status() == WL_CONNECTED;

  if (!wifiOK) {
    mqttOK = false;
  }
}

// ============================================================
// TFT UI - VISUAL DASHBOARD: CARD + GAUGE + LINE + FFT
// ============================================================
void drawHeader(const char* title) {
  tft.fillRect(0, 0, SW, 42, C_PRIMARY);

  tft.setTextColor(C_WHITE, C_PRIMARY);
  tft.setTextSize(2);
  tft.setCursor(10, 12);
  tft.print(title);

  tft.setTextSize(1);

  tft.fillCircle(SW - 176, 20, 5, linkOK ? C_GREEN : C_RED);
  tft.setCursor(SW - 168, 16);
  tft.print("LINK");

  tft.fillCircle(SW - 122, 20, 5, wifiOK ? C_GREEN : C_RED);
  tft.setCursor(SW - 114, 16);
  tft.print("WiFi");

  tft.fillCircle(SW - 70, 20, 5, mqtt.connected() ? C_GREEN : C_RED);
  tft.setCursor(SW - 62, 16);
  tft.print("MQTT");

  tft.fillCircle(SW - 22, 20, 5, sdOK ? C_GREEN : C_RED);
  tft.setCursor(SW - 15, 16);
  tft.print("SD");
}

void drawPageTabs(bool full) {
  const char* tabs[3] = {"GEN", "ENG", "FFT"};
  int tabW = 62;
  int x0 = 10;
  int y = 290;

  if (full) {
    tft.fillRect(0, y - 3, SW, 33, C_BG);
  }

  for (int i = 0; i < 3; i++) {
    int x = x0 + i * (tabW + 8);
    uint16_t bg = (activePage == i) ? C_PRIMARY : C_WHITE;
    uint16_t fg = (activePage == i) ? C_WHITE : C_DARK;
    uint16_t bd = (activePage == i) ? C_PRIMARY : C_BORDER;

    tft.fillRoundRect(x, y, tabW, 24, 6, bg);
    tft.drawRoundRect(x, y, tabW, 24, 6, bd);
    tft.setTextColor(fg, bg);
    tft.setTextSize(1);
    tft.setCursor(x + 20, y + 8);
    tft.print(tabs[i]);
  }

  tft.setTextColor(C_MUTED, C_BG);
  tft.setTextSize(1);
  tft.setCursor(236, 298);
  tft.print("tap header to switch page");
}

void drawValueCard(int x, int y, int w, int h, const char* label, const char* value, const char* unit, uint16_t accent, bool full) {
  if (full) {
    tft.fillRoundRect(x, y, w, h, 7, C_WHITE);
    tft.drawRoundRect(x, y, w, h, 7, C_BORDER);
    tft.fillRect(x + 2, y + 2, w - 4, 5, accent);
  }

  tft.fillRect(x + 7, y + 14, w - 14, h - 22, C_WHITE);

  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextSize(1);
  tft.setCursor(x + 9, y + 13);
  tft.print(label);

  tft.setTextColor(accent, C_WHITE);
  tft.setTextSize(2);
  int vw = strlen(value) * 12;
  tft.setCursor(x + (w - vw) / 2, y + 33);
  tft.print(value);

  tft.setTextColor(C_DARK, C_WHITE);
  tft.setTextSize(1);
  int uw = strlen(unit) * 6;
  tft.setCursor(x + (w - uw) / 2, y + h - 15);
  tft.print(unit);
}

float clampFloat(float v, float lo, float hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

void drawSemiGauge(int x, int y, int r, float value, float minVal, float maxVal,
                   const char* label, const char* valueText, const char* unit,
                   uint16_t accent, bool full) {
  int w = r * 2 + 18;
  int h = r + 70;

  if (full) {
    tft.fillRoundRect(x, y, w, h, 8, C_WHITE);
    tft.drawRoundRect(x, y, w, h, 8, C_BORDER);
  }

  int cx = x + w / 2;
  int cy = y + r + 19;

  // Bersihkan area gauge tanpa menghapus border.
  tft.fillRect(x + 5, y + 10, w - 10, h - 20, C_WHITE);

  // Background arc menggunakan segment garis.
  for (int deg = 200; deg <= 340; deg += 6) {
    float rad = deg * DEG_TO_RAD;
    int x1 = cx + cos(rad) * (r - 5);
    int y1 = cy + sin(rad) * (r - 5);
    int x2 = cx + cos(rad) * r;
    int y2 = cy + sin(rad) * r;
    tft.drawLine(x1, y1, x2, y2, C_BORDER);
  }

  float pct = (value - minVal) / (maxVal - minVal);
  pct = clampFloat(pct, 0.0f, 1.0f);
  int endDeg = 200 + (int)(pct * 140.0f);

  for (int deg = 200; deg <= endDeg; deg += 4) {
    float rad = deg * DEG_TO_RAD;
    int x1 = cx + cos(rad) * (r - 7);
    int y1 = cy + sin(rad) * (r - 7);
    int x2 = cx + cos(rad) * r;
    int y2 = cy + sin(rad) * r;
    tft.drawLine(x1, y1, x2, y2, accent);
  }

  float needleRad = endDeg * DEG_TO_RAD;
  int nx = cx + cos(needleRad) * (r - 13);
  int ny = cy + sin(needleRad) * (r - 13);
  tft.drawLine(cx, cy, nx, ny, C_DARK);
  tft.fillCircle(cx, cy, 3, C_DARK);

  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextSize(1);
  tft.setCursor(x + 9, y + 9);
  tft.print(label);

  tft.setTextColor(accent, C_WHITE);
  tft.setTextSize(2);
  int vw = strlen(valueText) * 12;
  tft.setCursor(cx - vw / 2, y + h - 42);
  tft.print(valueText);

  tft.setTextColor(C_DARK, C_WHITE);
  tft.setTextSize(1);
  int uw = strlen(unit) * 6;
  tft.setCursor(cx - uw / 2, y + h - 18);
  tft.print(unit);
}

void drawBarGauge(int x, int y, int w, int h, float value, float minVal, float maxVal,
                  const char* label, const char* valueText, uint16_t accent, bool full) {
  if (full) {
    tft.fillRoundRect(x, y, w, h, 7, C_WHITE);
    tft.drawRoundRect(x, y, w, h, 7, C_BORDER);
  }

  tft.fillRect(x + 7, y + 10, w - 14, h - 18, C_WHITE);

  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextSize(1);
  tft.setCursor(x + 10, y + 10);
  tft.print(label);

  tft.setTextColor(accent, C_WHITE);
  tft.setCursor(x + w - 72, y + 10);
  tft.print(valueText);

  int bx = x + 12;
  int by = y + 34;
  int bw = w - 24;
  int bh = 14;

  tft.drawRoundRect(bx, by, bw, bh, 4, C_BORDER);
  tft.fillRoundRect(bx + 2, by + 2, bw - 4, bh - 4, 3, C_BG);

  float pct = (value - minVal) / (maxVal - minVal);
  pct = clampFloat(pct, 0.0f, 1.0f);
  int fillW = (int)((bw - 4) * pct);
  if (fillW > 0) {
    tft.fillRoundRect(bx + 2, by + 2, fillW, bh - 4, 3, accent);
  }
}

void pushHistory(float* arr, uint8_t len, float v) {
  for (uint8_t i = 0; i < len - 1; i++) arr[i] = arr[i + 1];
  arr[len - 1] = v;
}

void drawLineChart(int x, int y, int w, int h, const char* title,
                   const float* data, uint8_t len, float minVal, float maxVal,
                   uint16_t accent, bool full) {
  if (full) {
    tft.fillRoundRect(x, y, w, h, 7, C_WHITE);
    tft.drawRoundRect(x, y, w, h, 7, C_BORDER);
  }

  tft.fillRect(x + 8, y + 18, w - 16, h - 28, C_WHITE);

  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextSize(1);
  tft.setCursor(x + 10, y + 8);
  tft.print(title);

  int gx = x + 12;
  int gy = y + 24;
  int gw = w - 24;
  int gh = h - 36;

  tft.drawRect(gx, gy, gw, gh, C_BORDER);

  for (int i = 1; i < 3; i++) {
    int yy = gy + (gh * i) / 3;
    tft.drawFastHLine(gx + 1, yy, gw - 2, C_BG);
  }

  for (uint8_t i = 1; i < len; i++) {
    float v0 = clampFloat(data[i - 1], minVal, maxVal);
    float v1 = clampFloat(data[i], minVal, maxVal);

    int x0 = gx + (int)((float)(i - 1) * (gw - 2) / (len - 1)) + 1;
    int x1 = gx + (int)((float)i * (gw - 2) / (len - 1)) + 1;
    int y0 = gy + gh - 1 - (int)((v0 - minVal) * (gh - 2) / (maxVal - minVal));
    int y1 = gy + gh - 1 - (int)((v1 - minVal) * (gh - 2) / (maxVal - minVal));

    tft.drawLine(x0, y0, x1, y1, accent);
  }
}

void drawFFTBarChart(int x, int y, int w, int h, const FFTData &f, bool hasFFT, bool full) {
  if (full) {
    tft.fillRoundRect(x, y, w, h, 7, C_WHITE);
    tft.drawRoundRect(x, y, w, h, 7, C_BORDER);
  }

  tft.fillRect(x + 8, y + 18, w - 16, h - 28, C_WHITE);

  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextSize(1);
  tft.setCursor(x + 10, y + 8);
  tft.print("FFT SPECTRUM");

  int gx = x + 14;
  int gy = y + 28;
  int gw = w - 28;
  int gh = h - 44;
  tft.drawRect(gx, gy, gw, gh, C_BORDER);

  if (!hasFFT) {
    tft.setTextColor(C_ORANGE, C_WHITE);
    tft.setCursor(x + 18, y + 46);
    tft.print("Waiting FFT buffer...");
    return;
  }

  float maxMag = 1.0f;
  for (uint16_t i = 1; i < FFT_BINS_TO_SEND; i++) {
    if (f.magBins[i] > maxMag) maxMag = f.magBins[i];
  }

  int barGap = 1;
  int barW = max(2, (gw - 4) / FFT_BINS_TO_SEND - barGap);

  for (uint16_t i = 0; i < FFT_BINS_TO_SEND; i++) {
    float mag = f.magBins[i];
    int bh = (int)(mag * (gh - 4) / maxMag);
    int bx = gx + 2 + i * (barW + barGap);
    int by = gy + gh - 2 - bh;
    uint16_t c = (i == 0) ? C_MUTED : C_PRIMARY;
    tft.fillRect(bx, by, barW, bh, c);
  }

  tft.setTextColor(C_DARK, C_WHITE);
  tft.setTextSize(1);
  tft.setCursor(x + 12, y + h - 14);
  tft.print("Peak ");
  tft.print(f.peakHz, 2);
  tft.print("Hz | RMS ");
  tft.print(f.rms, 2);
}

void getDisplaySnapshot(RawData &r, AggregatedData &a, FFTData &f, bool &hasAgg, bool &hasFFT) {
  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    r = latestRaw;
    a = aggData;
    f = fftData;
    hasAgg = aggData.valid;
    hasFFT = fftData.valid;
    xSemaphoreGive(dataMutex);
  }
}

void drawPageGenerator(bool full) {
  uint32_t drawStart = micros();

  RawData r;
  AggregatedData a;
  FFTData f;
  bool hasAgg = false;
  bool hasFFT = false;
  getDisplaySnapshot(r, a, f, hasAgg, hasFFT);

  float freq = hasAgg ? a.freqAvg : r.freq;
  float freqGrid = hasAgg ? a.freqGridAvg : r.freqGrid;
  float volt = hasAgg ? a.voltAvg : r.volt;
  float voltGrid = hasAgg ? a.voltGridAvg : r.voltGrid;
  bool synced = hasAgg ? a.synced : r.gridSync;
  float delta = fabs(freq - freqGrid);

  static float freqHist[24] = {0};
  static float voltHist[24] = {0};
  pushHistory(freqHist, 24, freq);
  pushHistory(voltHist, 24, volt);

  if (full) {
    tft.fillScreen(C_BG);
    drawHeader("GENERATOR MONITOR");
  } else {
    drawHeader("GENERATOR MONITOR");
  }

  drawSemiGauge(8, 52, 45, freq, 45.0f, 55.0f, "FREQ GEN", fmtF(freq, 2), "Hz",
                valColor(freq, 51.0, 52.0, 49.0, 48.0), full);
  drawSemiGauge(164, 52, 45, volt, 180.0f, 250.0f, "VOLT GEN", fmtF(volt, 0), "VAC",
                valColor(volt, 240, 250, 200, 180), full);
  drawValueCard(320, 52, 150, 75, "DELTA FREQ", fmtF(delta, 2), "Hz",
                delta < 0.3f ? C_GREEN : delta < 1.0f ? C_ORANGE : C_RED, full);

  drawBarGauge(320, 135, 150, 56, voltGrid, 180.0f, 250.0f, "VOLT PLN", fmtF(voltGrid, 0),
               valColor(voltGrid, 240, 250, 200, 180), full);
  drawBarGauge(320, 198, 150, 56, freqGrid, 45.0f, 55.0f, "FREQ PLN", fmtF(freqGrid, 2),
               valColor(freqGrid, 51.0, 52.0, 49.0, 48.0), full);

  drawLineChart(8, 178, 148, 78, "Freq trend", freqHist, 24, 45.0f, 55.0f, C_PRIMARY, full);
  drawLineChart(164, 178, 148, 78, "Volt trend", voltHist, 24, 180.0f, 250.0f, C_GREEN, full);

  uint16_t bg = synced ? C_LGREEN : C_LRED;
  uint16_t bd = synced ? C_GREEN : C_RED;
  tft.fillRoundRect(8, 262, 462, 24, 6, bg);
  tft.drawRoundRect(8, 262, 462, 24, 6, bd);
  tft.setTextColor(C_DARK, bg);
  tft.setTextSize(1);
  tft.setCursor(18, 270);
  tft.print(linkOK ? (synced ? "SYNC: ON-GRID" : "SYNC: OFF-GRID") : "LINK ESP32-1: LOST");
  tft.setCursor(250, 270);
  tft.print("FFT ");
  tft.print(hasFFT ? "READY" : "BUFFERING");

  drawPageTabs(full);

  lastTftDrawMs = millis();
  perfTftDrawUs = micros() - drawStart;
}

void drawPageEngine(bool full) {
  uint32_t drawStart = micros();

  RawData r;
  AggregatedData a;
  FFTData f;
  bool hasAgg = false;
  bool hasFFT = false;
  getDisplaySnapshot(r, a, f, hasAgg, hasFFT);

  float rpm = hasAgg ? a.rpmAvg : r.rpm;
  float tps = hasAgg ? a.tpsAvg : r.tps;
  float clt = hasAgg ? a.cltAvg : r.clt;
  float fuel = hasAgg ? a.fuelAvg : r.fuel;
  float batt = hasAgg ? a.battAvg : r.batt;
  float afr = hasAgg ? a.afrAvg : r.afr;
  float iat = hasAgg ? a.iatAvg : r.iat;

  static float rpmHist[24] = {0};
  static float cltHist[24] = {0};
  pushHistory(rpmHist, 24, rpm);
  pushHistory(cltHist, 24, clt);

  if (full) {
    tft.fillScreen(C_BG);
    drawHeader("ENGINE MONITOR");
  } else {
    drawHeader("ENGINE MONITOR");
  }

  drawSemiGauge(8, 52, 45, rpm, 0.0f, 6000.0f, "RPM", fmtF(rpm, 0), "rev/min",
                rpm < 600 ? C_MUTED : rpm < 3500 ? C_GREEN : rpm < 5000 ? C_ORANGE : C_RED, full);
  drawSemiGauge(164, 52, 45, clt, 30.0f, 120.0f, "COOLANT", fmtF(clt, 0), "C",
                valColor(clt, 95, 105, 40, 30), full);
  drawSemiGauge(320, 52, 45, fuel, 0.0f, 100.0f, "FUEL", fmtF(fuel, 0), "%",
                fuel < 10 ? C_RED : fuel < 20 ? C_ORANGE : C_GREEN, full);

  drawBarGauge(8, 178, 148, 56, tps, 0.0f, 100.0f, "TPS", fmtF(tps, 0), valColor(tps, 80, 95), full);
  drawBarGauge(164, 178, 148, 56, batt, 10.0f, 15.0f, "BATTERY", fmtF(batt, 1),
               batt < 11.5f ? C_RED : batt < 12.0f ? C_ORANGE : C_GREEN, full);
  drawBarGauge(320, 178, 150, 56, afr, 10.0f, 20.0f, "AFR", fmtF(afr, 2),
               (afr >= 14.0f && afr <= 15.5f) ? C_GREEN : (afr < 12.0f || afr > 17.0f) ? C_RED : C_ORANGE, full);

  drawLineChart(8, 240, 226, 46, "RPM trend", rpmHist, 24, 0.0f, 6000.0f, C_PRIMARY, full);
  drawLineChart(244, 240, 226, 46, "Coolant trend", cltHist, 24, 30.0f, 120.0f, C_ORANGE, full);

  drawPageTabs(full);

  lastTftDrawMs = millis();
  perfTftDrawUs = micros() - drawStart;
}

void drawPageFFT(bool full) {
  uint32_t drawStart = micros();

  RawData r;
  AggregatedData a;
  FFTData f;
  bool hasAgg = false;
  bool hasFFT = false;
  getDisplaySnapshot(r, a, f, hasAgg, hasFFT);

  if (full) {
    tft.fillScreen(C_BG);
    drawHeader("FFT ANALYSIS");
  } else {
    drawHeader("FFT ANALYSIS");
  }

  drawFFTBarChart(8, 52, 300, 170, f, hasFFT, full);

  drawValueCard(318, 52, 152, 74, "FFT SOURCE", getFFTSourceName(), "signal", C_PRIMARY, full);

  char sampleText[16];
  snprintf(sampleText, sizeof(sampleText), "%u", hasFFT ? f.samples : 0);
  drawValueCard(318, 134, 152, 74, "FFT SAMPLE", sampleText, "points", C_GREEN, full);

  drawValueCard(318, 216, 152, 70, "PEAK FREQ", hasFFT ? fmtF(f.peakHz, 2) : "--", "Hz",
                hasFFT ? C_ORANGE : C_MUTED, full);

  tft.setTextColor(C_DARK, C_BG);
  tft.setTextSize(1);
  tft.setCursor(12, 230);
  tft.print("Resolution: ");
  if (hasFFT) tft.print(f.resolutionHz, 4); else tft.print("--");
  tft.print(" Hz/bin | Fs: ");
  tft.print(FFT_SAMPLE_RATE_HZ, 0);
  tft.print(" Hz");

  tft.setCursor(12, 246);
  tft.print("FFT dihitung di ESP32 sebelum publish MQTT gen/data.");

  tft.setCursor(12, 262);
  tft.print("Website pakai fft.freqBins dan fft.magBins.");

  drawPageTabs(full);

  lastTftDrawMs = millis();
  perfTftDrawUs = micros() - drawStart;
}

void drawDashboard(bool full) {
  if (activePage == 0) {
    drawPageGenerator(full);
  } else if (activePage == 1) {
    drawPageEngine(full);
  } else {
    drawPageFFT(full);
  }
}

// ============================================================
// SERIAL PERFORMANCE STATUS
// ============================================================
void printPerformanceStatus() {
  if (millis() - lastSerialLog < 5000) return;
  lastSerialLog = millis();

  RawData r;
  AggregatedData a;
  bool hasAgg = false;

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    r = latestRaw;
    a = aggData;
    hasAgg = aggData.valid;
    xSemaphoreGive(dataMutex);
  }

  uint32_t rxAge = lastUartReceiveMs > 0 ? millis() - lastUartReceiveMs : 0;
  uint32_t aggAge = lastAggReadyMs > 0 ? millis() - lastAggReadyMs : 0;
  uint32_t mqttAge = lastMqttPublishMs > 0 ? millis() - lastMqttPublishMs : 0;
  uint32_t tftAge = lastTftDrawMs > 0 ? millis() - lastTftDrawMs : 0;

  uint32_t computeNoMqttUs =
    perfUartReadUs +
    perfCsvParseUs +
    perfAggregationUs +
    perfFftComputeUs +
    perfJsonBuildUs +
    perfSdSaveUs +
    perfTftDrawUs;

  uint32_t computeWithMqttUs = computeNoMqttUs + perfMqttPublishUs;

  Serial.println();
  Serial.println("════════════ RUNTIME + PERFORMANCE STATUS ════════════");
  Serial.print("[LINK] "); Serial.println(linkOK ? "OK" : "LOST");
  Serial.print("[WIFI] "); Serial.println(wifiOK ? "OK" : "OFF");
  Serial.print("[MQTT] "); Serial.println(mqtt.connected() ? "OK" : "OFF");
  Serial.print("[SD] "); Serial.println(sdOK ? "READY" : "NOT READY");

  Serial.print("[RX OK] "); Serial.println((uint32_t)parseOKCount);
  Serial.print("[RX FAIL] "); Serial.println((uint32_t)parseFailCount);
  Serial.print("[RX RESET] "); Serial.println((uint32_t)rxBufferResetCount);

  Serial.print("[LATEST SEQ] "); Serial.println((unsigned long)r.seq);
  Serial.print("[LATEST RPM] "); Serial.println(r.rpm);
  Serial.print("[LATEST FREQ] "); Serial.println(r.freq, 2);
  Serial.print("[LATEST VOLT] "); Serial.println(r.volt, 1);
  Serial.print("[AGG VALID] "); Serial.println(hasAgg ? "YES" : "NO");
  Serial.print("[AGG SAMPLES] "); Serial.println(hasAgg ? a.samples : 0);

  Serial.println("──────── COMPUTATION TIME ESP32-2 ────────");
  Serial.printf("[PERF] UART read task       : %lu us\n", (unsigned long)perfUartReadUs);
  Serial.printf("[PERF] CSV parse            : %lu us\n", (unsigned long)perfCsvParseUs);
  Serial.printf("[PERF] Aggregation          : %lu us\n", (unsigned long)perfAggregationUs);
  Serial.printf("[PERF] FFT compute          : %lu us\n", (unsigned long)perfFftComputeUs);
  Serial.printf("[PERF] JSON build           : %lu us\n", (unsigned long)perfJsonBuildUs);
  Serial.printf("[PERF] MQTT publish         : %lu us\n", (unsigned long)perfMqttPublishUs);
  Serial.printf("[PERF] SD save              : %lu us\n", (unsigned long)perfSdSaveUs);
  Serial.printf("[PERF] TFT draw             : %lu us\n", (unsigned long)perfTftDrawUs);
  Serial.printf("[PERF] 50Hz task runtime    : %lu us\n", (unsigned long)perfSensorTaskUs);
  Serial.printf("[PERF] Compute no MQTT      : %lu us\n", (unsigned long)computeNoMqttUs);
  Serial.printf("[PERF] Compute with MQTT    : %lu us\n", (unsigned long)computeWithMqttUs);

  Serial.println("──────── LATENCY AGE CHECK ────────");
  Serial.printf("[AGE] Last UART RX age      : %lu ms\n", (unsigned long)rxAge);
  Serial.printf("[AGE] Last aggregation age  : %lu ms\n", (unsigned long)aggAge);
  Serial.printf("[AGE] Last MQTT publish age : %lu ms\n", (unsigned long)mqttAge);
  Serial.printf("[AGE] Last TFT draw age     : %lu ms\n", (unsigned long)tftAge);

  Serial.println("──────── TASK + SD COUNTER ────────");
  Serial.print("[TASK 50Hz EXEC] "); Serial.println((uint32_t)sensorExecutions);
  Serial.print("[TASK MISS] "); Serial.println((uint32_t)sensorMissedDeadlines);
  Serial.print("[SD SAVE OK] "); Serial.println(sdSaveSuccessCount);
  Serial.print("[SD SAVE FAIL] "); Serial.println(sdSaveFailCount);
  Serial.println("══════════════════════════════════════════════════════");
}

// ============================================================
// SETUP + LOOP
// ============================================================
void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println();
  Serial.println("BOOTING ESP32-2 FINAL CSV UART + SD + MQTT + PERFORMANCE");

  memset(&latestRaw, 0, sizeof(latestRaw));
  memset(&aggData, 0, sizeof(aggData));
  memset(&fftData, 0, sizeof(fftData));

  strlcpy(latestRaw.syncText, "OFF-GRID", sizeof(latestRaw.syncText));
  strlcpy(latestRaw.statusText, "NO-DATA", sizeof(latestRaw.statusText));

  dataMutex = xSemaphoreCreateMutex();
  sdMutex = xSemaphoreCreateMutex();

  if (dataMutex == NULL) {
    Serial.println("[ERROR] dataMutex gagal dibuat.");
  }

  if (sdMutex == NULL) {
    Serial.println("[ERROR] sdMutex gagal dibuat.");
  }

  deselectAllSPI();

  LinkSerial.begin(LINK_BAUD, SERIAL_8N1, LINK_RX_PIN, LINK_TX_PIN);
  LinkSerial.setTimeout(50);

  // PENTING: SD init lebih dulu sebelum TFT agar shared SPI lebih stabil.
  initSDCard();

  // Baru init TFT setelah SD.
  tft.init();
  tft.setRotation(1);
  tft.fillScreen(C_BG);
  tft.setTextColor(C_PRIMARY, C_BG);
  tft.setTextSize(2);
  tft.setCursor(10, 20);
  tft.print("ESP32-2 Monitor Booting...");

  Wire.begin(CTP_SDA, CTP_SCL);

  if (!ts.begin(40)) {
    Serial.println("[TOUCH] Tidak terdeteksi.");
  } else {
    Serial.println("[TOUCH] OK.");
  }

  setupWiFiManager();

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(4096);

  if (wifiOK) {
    reconnectMQTT();
  }

  xTaskCreatePinnedToCore(
    SensorTask50Hz,
    "SensorTask50Hz",
    12000,
    NULL,
    2,
    NULL,
    1
  );

  needFullRedraw = true;

  Serial.println();
  Serial.println("ESP32-2 READY: CSV RX + AGGREGATION + MQTT + TFT + SD + PERFORMANCE");
  Serial.print("LINK_BAUD = ");
  Serial.println(LINK_BAUD);
}

void loop() {
  checkWiFiStatus();

  if (wifiOK) {
    reconnectMQTT();
    mqtt.loop();
  }

  if (!sdOK && millis() - lastSDRetry >= 5000) {
    lastSDRetry = millis();
    Serial.println("[SD] Retry init otomatis...");
    initSDCard();
    needFullRedraw = true;
  }

  if (millis() - lastPublish >= publishInterval) {
    lastPublish = millis();
    publishRealtimeData();
  }

  if (millis() - lastLocalSave >= localSaveInterval) {
    lastLocalSave = millis();
    saveSnapshotToSD();
  }

  // Navigasi tampilan: sentuh area header untuk pindah halaman GEN -> ENG -> FFT.
  if (ts.touched()) {
    TS_Point p = ts.getPoint();
    int tx = map(p.y, 0, 480, 0, 480);
    int ty = map(p.x, 0, 320, 320, 0);

    if (ty < 48) {
      activePage++;
      if (activePage > 2) activePage = 0;
      needFullRedraw = true;
      delay(250);
    }
  }

  if (millis() - lastDraw >= drawInterval) {
    lastDraw = millis();
    drawDashboard(needFullRedraw);
    needFullRedraw = false;
  }

  printPerformanceStatus();

  delay(5);
}
