// ============================================================
// GENSYS ESP32-2 MONITORING FINAL
// Industrial TFT HMI + Touch Navigation + Serial Command Console
// CSV UART + 1s Aggregation Record + SD CSV + MQTT + FFT Page
//
// RX CSV dari ESP32-1 setelah penambahan MAP:
// $seq,timestampMs,rpm,tps,map,iat,clt,afr,batt,fuel,freq,freqGrid,volt,voltGrid,currentA,powerKW,phaseAngle,engineSync,gridSync,valid
//
// Wiring UART:
// ESP32-1 TX GPIO25  ---> ESP32-2 RX GPIO16
// ESP32-1 GND        ---> ESP32-2 GND
//
// TFT/Touch:
// ILI9488/ILI9486 via TFT_eSPI
// FT6206/FT6236 I2C SDA=21, SCL=22
//
// SD Card pada TFT:
// SD_CS   GPIO26
// SD_MOSI GPIO13
// SD_MISO GPIO19
// SD_SCK  GPIO14
//
// Serial command:
// help, database, performance, sensor, network, touch, calibrate,
// page generator, page engine, page fft
// ============================================================

#include <Arduino.h>
#include <HardwareSerial.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include "esp_wifi.h"

#ifndef ESP_ARDUINO_VERSION_MAJOR
#define ESP_ARDUINO_VERSION_MAJOR 2
#endif

#if ESP_ARDUINO_VERSION_MAJOR >= 3
  #include "esp_eap_client.h"
#else
  #include "esp_wpa2.h"
#endif

#include <PubSubClient.h>
#include <Wire.h>
#include <SPI.h>
#include <FS.h>
#include <SD.h>
#include <TFT_eSPI.h>
#include <time.h>
#include <Adafruit_FT6206.h>
#include <math.h>

// ============================================================
// USER CONFIG
// ============================================================
#define DEVICE_ID "ESP32_GENERATOR_01"

// Set 1 hanya jika ingin reset/portal WiFiManager dipaksa muncul.
// Default 0 agar konfigurasi WiFi lama tidak berubah.
#define FORCE_WIFI_PORTAL 0

// Serial tidak spam. Data hanya muncul jika diketik command.
#define DEBUG_RX_RAW 0
#define DEBUG_RX_OK  0

// ============================================================
// WIFI MANAGER + EDUROAM FALLBACK
// ============================================================
// Konfigurasi dibuat mengikuti kode sebelumnya:
// 1) Boot pertama mencoba eduroam WPA2-Enterprise.
// 2) Jika gagal/timeout, enterprise mode dibersihkan.
// 3) Setelah itu fallback ke WiFiManager.
// 4) Dari Serial Monitor bisa dipilih ulang: wifi eduroam / wifi manager / wifi auto.

#ifndef WIFI_MANAGER_AP_NAME
#define WIFI_MANAGER_AP_NAME "GenTrack-Monitor-AP"
#endif

#ifndef WIFI_MANAGER_AP_PASS
#define WIFI_MANAGER_AP_PASS "12345678"
#endif

#ifndef WIFI_MANAGER_TIMEOUT_SEC
#define WIFI_MANAGER_TIMEOUT_SEC 180
#endif

#ifndef USE_EDUROAM_FIRST
#define USE_EDUROAM_FIRST 1
#endif

#ifndef EDUROAM_SSID
#define EDUROAM_SSID       "eduroam"
#endif

#ifndef EDUROAM_IDENTITY
#define EDUROAM_IDENTITY   "13222011@itb.ac.id"
#endif

#ifndef EDUROAM_USERNAME
#define EDUROAM_USERNAME   "13222011@itb.ac.id"
#endif

#ifndef EDUROAM_PASSWORD
#define EDUROAM_PASSWORD   "akun.STEI.011"
#endif

#ifndef EDUROAM_TIMEOUT_MS
#define EDUROAM_TIMEOUT_MS 25000UL
#endif

// ============================================================
// MQTT
// ============================================================
// MQTT dikembalikan seperti konfigurasi sebelumnya.
#ifndef MQTT_HOST
#define MQTT_HOST  "generatorta20.cloud.shiftr.io"
#endif

#ifndef MQTT_PORT
#define MQTT_PORT  1883
#endif

#ifndef MQTT_USER
#define MQTT_USER  "generatorta20"
#endif

#ifndef MQTT_PASS
#define MQTT_PASS  "TA252601020"
#endif

#ifndef MQTT_TOPIC
#define MQTT_TOPIC "gen/data"
#endif

#ifndef MQTT_REALTIME_TOPIC
#define MQTT_REALTIME_TOPIC "gen/realtime"
#endif

// Endpoint HTTP server Node.js untuk sinkronisasi ulang data backup dari SD card.
// Ganti saat build/deploy, contoh:
//   -D CLOUD_INGEST_URL=\"https://domain-server-anda/api/ingest/batch\"
#ifndef CLOUD_INGEST_URL
#define CLOUD_INGEST_URL "http://localhost:3000/api/ingest/batch"
#endif

// NTP WIB.
const char* NTP_SERVER_1 = "pool.ntp.org";
const char* NTP_SERVER_2 = "time.google.com";
const long  GMT_OFFSET_SEC = 7 * 3600;
const int   DAYLIGHT_OFFSET_SEC = 0;

// ============================================================
// UART ANTAR ESP32
// ============================================================
static const uint32_t LINK_BAUD = 115200;
static const int LINK_RX_PIN = 16;
static const int LINK_TX_PIN = 17;

HardwareSerial LinkSerial(2);
String linkRxBuffer = "";

// ESP32-1 sinkronisasi mengirim frame setiap 100 ms = 10 Hz.
#define LINK_EXPECTED_FRAME_INTERVAL_MS 100UL
#define LINK_EXPECTED_FRAME_HZ          10

// ============================================================
// TFT + TOUCH
// ============================================================
TFT_eSPI tft = TFT_eSPI();
Adafruit_FT6206 ts = Adafruit_FT6206();

#define SW 480
#define SH 320

// Industrial palette RGB565.
#define C_BG       0xF7BF
#define C_WHITE    0xFFFF
#define C_PRIMARY  0x1234
#define C_PRIMARY2 0x1A76
#define C_GREEN    0x15D0
#define C_ORANGE   0xFB82
#define C_RED      0xEA28
#define C_DARK     0x08A5
#define C_MUTED    0x6B90
#define C_BORDER   0xD6FC
#define C_PANEL    0xFFFF
#define C_GRID     0xC618
#define C_BLUE2    0x2D7F

#define CTP_SDA 21
#define CTP_SCL 22
#define CTP_RST 33
#define CTP_INT 32

#ifndef TFT_CS
#define TFT_CS 15
#endif

// ============================================================
// SD CARD
// ============================================================
#define SD_MISO 19
#define SD_MOSI 13
#define SD_SCK  14
#define SD_CS   26

#define SD_SPI_FREQ_INIT 400000UL
#define SD_SPI_FREQ_FAST 1000000UL

SPIClass sdSPI(HSPI);
SemaphoreHandle_t sdMutex = NULL;
SemaphoreHandle_t dataMutex = NULL;

const char* DB_FILE = "/database.csv";
const char* SD_SYNC_FILE = "/sync_queue.jsonl";
const char* SD_SYNC_TMP_FILE = "/sync_queue.tmp";

// ============================================================
// TIMING
// ============================================================
#define SENSOR_SAMPLE_HZ          50
#define SENSOR_SAMPLE_INTERVAL_MS 20
#define AGGREGATION_INTERVAL_MS   1000
#define STORAGE_BATCH_SIZE        1
#define SD_SYNC_INTERVAL_MS        30000UL
#define SD_SYNC_BATCH_SIZE         20

const unsigned long publishInterval   = 1000;
const unsigned long localSaveInterval = 1000;
const unsigned long drawInterval      = 500;

// ============================================================
// FFT EDGE
// ============================================================
#define ENABLE_FFT_EDGE        1
#define FFT_SAMPLE_RATE_HZ     10.0f   // Mengikuti UART ESP32-1: 100 ms = 10 Hz
#define FFT_SAMPLES            64
#define FFT_BINS_TO_SEND       32
#define FFT_COMPUTE_INTERVAL_MS 1000UL   // FFT dihitung di task terpisah, bukan di SensorTask50Hz.

// FFT multi-sumber:
// 0 = tegangan generator, 1 = tegangan grid, 2 = RPM mesin.
// Semua sumber dihitung paralel. Halaman FFT menampilkan sumber yang dipilih.
#define FFT_SOURCE_COUNT       3
#define FFT_SRC_VOLT_GEN       0
#define FFT_SRC_VOLT_GRID      1
#define FFT_SRC_RPM            2

// ============================================================
// DATA STRUCT
// ============================================================
struct RawData {
  uint32_t seq = 0;
  uint32_t timestampMs = 0;
  uint32_t sourceSampleHz = LINK_EXPECTED_FRAME_HZ;

  int rpm = 0;
  int tps = 0;
  int map = 0;   // MAP Speeduino dalam kPa
  int iat = 0;
  int clt = 0;

  float batt = 0;
  float afr = 0;
  float fuel = 0;

  float freq = 0;
  float freqGrid = 0;
  float volt = 0;
  float voltGrid = 0;
  float currentA = 0;   // Arus generator dari ESP32 sinkronisasi/dummy electrical
  float powerKW = 0;    // Daya generator dari ESP32 sinkronisasi/dummy electrical
  float phaseAngle = 0;

  bool speeduinoSync = false;
  bool gridSync = false;
  bool valid = false;

  char syncText[12] = "OFF-GRID";
  char statusText[12] = "NO-DATA";
};

struct AggregatedData {
  uint16_t samples = 0;

  float rpmAvg = 0; int rpmMin = 0; int rpmMax = 0;
  float tpsAvg = 0; int tpsMin = 0; int tpsMax = 0;
  float mapAvg = 0; int mapMin = 0; int mapMax = 0;
  float iatAvg = 0; int iatMin = 0; int iatMax = 0;
  float cltAvg = 0; int cltMin = 0; int cltMax = 0;

  float afrAvg = 0; float afrMin = 0; float afrMax = 0;
  float battAvg = 0; float battMin = 0; float battMax = 0;
  float fuelAvg = 0; float fuelMin = 0; float fuelMax = 0;

  float freqAvg = 0; float freqMin = 0; float freqMax = 0;
  float freqGridAvg = 0; float freqGridMin = 0; float freqGridMax = 0;
  float voltAvg = 0; float voltMin = 0; float voltMax = 0;
  float voltGridAvg = 0; float voltGridMin = 0; float voltGridMax = 0;
  float currentAvg = 0; float currentMin = 0; float currentMax = 0;
  float powerAvg = 0; float powerMin = 0; float powerMax = 0;
  float phaseAngleAvg = 0; float phaseAngleMin = 0; float phaseAngleMax = 0;

  bool synced = false;
  bool valid = false;
};

struct AggAccumulator {
  uint16_t count = 0;

  float rpmSum = 0; int rpmMin = 999999; int rpmMax = -999999;
  float tpsSum = 0; int tpsMin = 999999; int tpsMax = -999999;
  float mapSum = 0; int mapMin = 999999; int mapMax = -999999;
  float iatSum = 0; int iatMin = 999999; int iatMax = -999999;
  float cltSum = 0; int cltMin = 999999; int cltMax = -999999;

  float afrSum = 0; float afrMin = 999999; float afrMax = -999999;
  float battSum = 0; float battMin = 999999; float battMax = -999999;
  float fuelSum = 0; float fuelMin = 999999; float fuelMax = -999999;

  float freqSum = 0; float freqMin = 999999; float freqMax = -999999;
  float freqGridSum = 0; float freqGridMin = 999999; float freqGridMax = -999999;
  float voltSum = 0; float voltMin = 999999; float voltMax = -999999;
  float voltGridSum = 0; float voltGridMin = 999999; float voltGridMax = -999999;
  float currentSum = 0; float currentMin = 999999; float currentMax = -999999;
  float powerSum = 0; float powerMin = 999999; float powerMax = -999999;
  float phaseAngleSum = 0; float phaseAngleMin = 999999; float phaseAngleMax = -999999;

  uint16_t syncedCount = 0;
};

struct FFTData {
  bool valid = false;
  uint16_t samples = 0;
  float sampleRateHz = FFT_SAMPLE_RATE_HZ;
  float resolutionHz = FFT_SAMPLE_RATE_HZ / FFT_SAMPLES;
  float peakHz = 0;
  float peakMagnitude = 0;
  float rms = 0;
  float freqBins[FFT_BINS_TO_SEND];
  float magBins[FFT_BINS_TO_SEND];
};

struct StorageRecord {
  bool valid = false;
  uint32_t batchSeq = 0;
  uint8_t slotIndex = 0;
  uint32_t localSeq = 0;
  String recordId = "";
  String timestamp = "";
  uint32_t timestampMs = 0;
  AggregatedData agg;
  FFTData fft;
};

// ============================================================
// GLOBAL STATE
// ============================================================
RawData latestRaw;
AggregatedData aggData;
AggAccumulator acc;

// fftData dipertahankan sebagai hasil FFT aktif/terpilih agar kompatibel
// dengan storage record, MQTT, dan halaman FFT lama.
FFTData fftData;
FFTData fftMultiData[FFT_SOURCE_COUNT];
StorageRecord storageBatch[STORAGE_BATCH_SIZE];
SemaphoreHandle_t fftMutex = NULL;

float fftBuffers[FFT_SOURCE_COUNT][FFT_SAMPLES];
uint16_t fftIndexes[FFT_SOURCE_COUNT] = {0, 0, 0};
bool fftBufferFulls[FFT_SOURCE_COUNT] = {false, false, false};
uint8_t fftSelectedSource = FFT_SRC_VOLT_GEN;

bool wifiOK = false;
bool mqttOK = false;

enum WiFiConnectionMode {
  WIFI_MODE_OFFLINE = 0,
  WIFI_MODE_EDUROAM = 1,
  WIFI_MODE_MANAGER = 2
};

WiFiConnectionMode wifiConnectionMode = WIFI_MODE_OFFLINE;
bool sdOK = false;
bool linkOK = false;
bool needFullRedraw = true;
bool touchDetected = false;

enum DisplayPage {
  PAGE_GENERATOR = 0,
  PAGE_ENGINE    = 1,
  PAGE_FFT       = 2
};

int activePage = PAGE_GENERATOR;

bool serialTouchDebug = false;
bool touchCalibrationMode = false;

struct TouchCalPoint {
  const char* name;
  int sx;
  int sy;
};

TouchCalPoint calPoints[] = {
  {"TOP_LEFT",     40,  40},
  {"TOP_RIGHT",   440, 40},
  {"BOTTOM_LEFT", 40,  280},
  {"BOTTOM_RIGHT",440, 280},
  {"GEN_ICON",    80,  305},
  {"ENG_ICON",    240, 305},
  {"FFT_ICON",    400, 305}
};

uint8_t calIndex = 0;

unsigned long lastPublish = 0;
unsigned long lastDraw = 0;
unsigned long lastLocalSave = 0;
unsigned long lastSdSync = 0;
unsigned long lastReconnect = 0;
unsigned long lastWifiCheck = 0;
unsigned long lastLinkFrameMs = 0;
unsigned long lastSDRetry = 0;
unsigned long lastDBStorageReport = 0;

uint32_t storageBatchSeq = 0;
uint8_t storageBatchCount = 0;
uint32_t localRecordSeq = 0;

unsigned long sdSaveSuccessCount = 0;
unsigned long sdSaveFailCount = 0;
unsigned long sdSyncSuccessCount = 0;
unsigned long sdSyncFailCount = 0;
uint64_t dbTotalWrittenBytes = 0;
uint32_t dbLastLineBytes = 0;
uint64_t dbCachedFileSizeBytes = 0;
uint64_t sdCachedCardSizeBytes = 0;
uint64_t sdCachedUsedBytes = 0;
uint64_t sdCachedFreeBytes = 0;
unsigned long dbCachedAtMs = 0;

// ── DB size ticker (setiap detik) ──────────────────────────────
bool     dbSizeTickerEnabled  = false;
unsigned long lastDbSizeTickMs = 0;

// ── Test-once mode (kirim 1x ke SD + MQTT lalu stop) ──────────
bool     testOnceMode        = false;
bool     testOnceDone        = false;
unsigned long testOnceTriggeredMs = 0;

// ── Konfirmasi reset SD database ──────────────────────────────
bool     sdResetPending      = false;
unsigned long sdResetPendingMs = 0;

volatile uint32_t sensorExecutions = 0;
volatile uint32_t sensorMissedDeadlines = 0;
volatile uint32_t parseOKCount = 0;
volatile uint32_t parseFailCount = 0;
volatile uint32_t rxBufferResetCount = 0;
volatile uint32_t fastAggCompleted = 0;
volatile uint32_t fastAggUnderfilled = 0;
volatile uint16_t lastFastAggSamples = 0;
volatile uint32_t lastFastAggIntervalMs = 0;

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

unsigned long lastUartReceiveMs = 0;
unsigned long lastAggReadyMs = 0;
unsigned long lastMqttPublishMs = 0;
unsigned long lastTftDrawMs = 0;

// MQTT / MongoDB payload statistics.
uint32_t mqttLastPayloadBytes = 0;          // payload aktual yang dikirim (saat ini masih mencakup FFT)
uint64_t mqttTotalPayloadBytes = 0;
uint32_t mqttLastParameterPayloadBytes = 0; // estimasi cloud DB hanya parameter generator, tanpa FFT
uint64_t mqttTotalParameterPayloadBytes = 0;
uint32_t mqttPublishSuccessCount = 0;
uint32_t mqttPublishFailCount = 0;
uint32_t mqttTotalRecordsSent = 0;
uint32_t mqttLastRecordsSent = 0;

WiFiClient espClient;
PubSubClient mqtt(espClient);

String serialCmd = "";
char tmp[24];

// ============================================================
// SERIAL LOG CONFIG
// ============================================================
// Prinsip: serial print lama tidak dihapus.
// Default tetap tidak spam agar Serial Monitor mudah dipakai.
// Jika ingin melihat log lama/continuous, gunakan command:
//   log on
//   log all
//   rx raw on
//   rx ok on
//   log interval 1000
bool serialLogEnabled = false;
bool serialLogAllEnabled = false;
bool serialLogDatabaseEnabled = false;
bool serialLogPerformanceEnabled = false;
bool serialLogSensorEnabled = false;
bool serialLogNetworkEnabled = false;
bool serialLogAggregationEnabled = false;
bool serialLogStorageEnabled = false;
bool serialLogFFTEnabled = false;
bool serialLogLatestEnabled = false;
bool runtimeDebugRxRaw = DEBUG_RX_RAW;
bool runtimeDebugRxOK = DEBUG_RX_OK;
unsigned long serialLogIntervalMs = 3000;
unsigned long lastSerialLogMs = 0;

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

bool changedFloat(float oldValue, float newValue, float threshold) {
  return isnan(oldValue) || fabs(oldValue - newValue) >= threshold;
}

float estimateGeneratorCurrentA(float rpm, float tps, float mapKpa, float volt) {
  // Belum ada sensor arus pada frame UART, sehingga arus dihitung sebagai estimasi beban.
  // Jika nanti ada sensor arus asli, ganti fungsi ini dengan pembacaan sensor current.
  if (rpm < 100.0f || volt < 20.0f) return 0.0f;

  float loadFromTps = tps * 0.18f;
  float loadFromMap = (mapKpa - 35.0f) * 0.08f;
  if (loadFromMap < 0.0f) loadFromMap = 0.0f;

  float current = 1.5f + loadFromTps + loadFromMap;
  if (current < 0.0f) current = 0.0f;
  if (current > 60.0f) current = 60.0f;
  return current;
}

float estimateGeneratorPowerKW(float volt, float currentA) {
  if (volt < 20.0f || currentA <= 0.0f) return 0.0f;
  return (volt * currentA) / 1000.0f;
}

float estimateMAPkPa(float tps, float rpm) {
  // Fallback hanya untuk kompatibilitas frame lama tanpa MAP.
  // Pada format baru, UI dan database memakai MAP real dari ESP32-1.
  float rpmFactor = rpm / 6000.0f;
  if (rpmFactor < 0.0f) rpmFactor = 0.0f;
  if (rpmFactor > 1.0f) rpmFactor = 1.0f;

  float tpsFactor = tps / 100.0f;
  if (tpsFactor < 0.0f) tpsFactor = 0.0f;
  if (tpsFactor > 1.0f) tpsFactor = 1.0f;

  return 25.0f + 65.0f * tpsFactor + 10.0f * rpmFactor;
}

String getIsoTimestampWIBms() {
  struct tm timeinfo;
  if (getLocalTime(&timeinfo, 10)) {
    char buf[40];
    unsigned long msPart = millis() % 1000UL;
    snprintf(buf, sizeof(buf),
             "%04d-%02d-%02dT%02d:%02d:%02d.%03lu+07:00",
             timeinfo.tm_year + 1900,
             timeinfo.tm_mon + 1,
             timeinfo.tm_mday,
             timeinfo.tm_hour,
             timeinfo.tm_min,
             timeinfo.tm_sec,
             msPart);
    return String(buf);
  }
  return String("millis:") + String(millis());
}

String getCsvTimestampWIBms() {
  struct tm timeinfo;
  if (getLocalTime(&timeinfo, 10)) {
    char buf[40];
    unsigned long msPart = millis() % 1000UL;
    snprintf(buf, sizeof(buf),
             "%04d-%02d-%02d %02d:%02d:%02d.%03lu",
             timeinfo.tm_year + 1900,
             timeinfo.tm_mon + 1,
             timeinfo.tm_mday,
             timeinfo.tm_hour,
             timeinfo.tm_min,
             timeinfo.tm_sec,
             msPart);
    return String(buf);
  }
  return String("millis:") + String(millis());
}

void deselectAllSPI() {
  pinMode(TFT_CS, OUTPUT);
  pinMode(SD_CS, OUTPUT);
  digitalWrite(TFT_CS, HIGH);
  digitalWrite(SD_CS, HIGH);
  delayMicroseconds(50);
}

float getFFTInputSignalBySource(const RawData &d, uint8_t source) {
  switch (source) {
    case FFT_SRC_VOLT_GEN:  return d.volt;
    case FFT_SRC_VOLT_GRID: return d.voltGrid;
    case FFT_SRC_RPM:       return (float)d.rpm;
    default:                return d.volt;
  }
}

const char* getFFTSourceNameById(uint8_t source) {
  switch (source) {
    case FFT_SRC_VOLT_GEN:  return "VOLT_GEN";
    case FFT_SRC_VOLT_GRID: return "VOLT_GRID";
    case FFT_SRC_RPM:       return "RPM";
    default:                return "VOLT_GEN";
  }
}

const char* getFFTSourceUnitById(uint8_t source) {
  switch (source) {
    case FFT_SRC_VOLT_GEN:  return "V";
    case FFT_SRC_VOLT_GRID: return "V";
    case FFT_SRC_RPM:       return "rpm";
    default:                return "";
  }
}

const char* getFFTSourceName() {
  return getFFTSourceNameById(fftSelectedSource);
}

// ============================================================
// CSV PARSER
// ============================================================
bool parseBridgeCsv(const String &line, RawData &out) {
  if (!line.startsWith("$")) return false;

  String data = line.substring(1);

  // Format baru dari ESP32-1 sinkronisasi setelah penambahan MAP:
  // 20 field baru:
  // $seq,timestampMs,rpm,tps,map,iat,clt,afr,batt,fuel,
  // freq,freqGrid,volt,voltGrid,currentA,powerKW,phaseAngle,engineSync,gridSync,valid
  //
  // Backward compatibility:
  // 18 field lama dengan MAP tetapi tanpa arus/power tetap diterima.
  // 17 field lama tanpa MAP tetap diterima, tetapi MAP/arus/power diisi estimasi.
  String fields[20];
  int fieldIndex = 0;
  int start = 0;

  for (int i = 0; i <= data.length(); i++) {
    if (i == data.length() || data[i] == ',') {
      if (fieldIndex < 20) {
        fields[fieldIndex] = data.substring(start, i);
        fields[fieldIndex].trim();
        fieldIndex++;
      }
      start = i + 1;
    }
  }

  if (fieldIndex < 17) return false;

  out.seq = fields[0].toInt();
  out.timestampMs = fields[1].toInt();
  out.sourceSampleHz = LINK_EXPECTED_FRAME_HZ;

  out.rpm = fields[2].toInt();
  out.tps = fields[3].toInt();

  if (fieldIndex >= 20) {
    // Format baru dengan MAP, arus, dan power dari ESP32 sinkronisasi.
    out.map = fields[4].toInt();
    out.iat = fields[5].toInt();
    out.clt = fields[6].toInt();

    out.afr = fields[7].toFloat();
    out.batt = fields[8].toFloat();
    out.fuel = fields[9].toFloat();

    out.freq = fields[10].toFloat();
    out.freqGrid = fields[11].toFloat();
    out.volt = fields[12].toFloat();
    out.voltGrid = fields[13].toFloat();
    out.currentA = fields[14].toFloat();
    out.powerKW = fields[15].toFloat();

    out.phaseAngle = fields[16].toFloat();
    out.speeduinoSync = fields[17].toInt() == 1;
    out.gridSync = fields[18].toInt() == 1;
    out.valid = fields[19].toInt() == 1;
  } else if (fieldIndex >= 18) {
    // Format lama dengan MAP, tetapi belum ada arus/power.
    out.map = fields[4].toInt();
    out.iat = fields[5].toInt();
    out.clt = fields[6].toInt();

    out.afr = fields[7].toFloat();
    out.batt = fields[8].toFloat();
    out.fuel = fields[9].toFloat();

    out.freq = fields[10].toFloat();
    out.freqGrid = fields[11].toFloat();
    out.volt = fields[12].toFloat();
    out.voltGrid = fields[13].toFloat();

    out.currentA = estimateGeneratorCurrentA(out.rpm, out.tps, out.map, out.volt);
    out.powerKW = estimateGeneratorPowerKW(out.volt, out.currentA);

    out.phaseAngle = fields[14].toFloat();
    out.speeduinoSync = fields[15].toInt() == 1;
    out.gridSync = fields[16].toInt() == 1;
    out.valid = fields[17].toInt() == 1;
  } else {
    // Format lama tanpa MAP.
    out.map = (int)estimateMAPkPa(out.tps, out.rpm);
    out.iat = fields[4].toInt();
    out.clt = fields[5].toInt();

    out.afr = fields[6].toFloat();
    out.batt = fields[7].toFloat();
    out.fuel = fields[8].toFloat();

    out.freq = fields[9].toFloat();
    out.freqGrid = fields[10].toFloat();
    out.volt = fields[11].toFloat();
    out.voltGrid = fields[12].toFloat();

    out.currentA = estimateGeneratorCurrentA(out.rpm, out.tps, out.map, out.volt);
    out.powerKW = estimateGeneratorPowerKW(out.volt, out.currentA);

    out.phaseAngle = fields[13].toFloat();
    out.speeduinoSync = fields[14].toInt() == 1;
    out.gridSync = fields[15].toInt() == 1;
    out.valid = fields[16].toInt() == 1;
  }

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

  if (runtimeDebugRxRaw) {
    Serial.print("[RX RAW] ");
    Serial.println(line);
  }

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

    if (runtimeDebugRxOK) {
      Serial.printf("[RX OK] seq=%lu rpm=%d tps=%d map=%d freq=%.2f volt=%.1f phase=%.2f gridSync=%d valid=%d\n",
                    (unsigned long)parsed.seq, parsed.rpm, parsed.tps, parsed.map,
                    parsed.freq, parsed.volt, parsed.phaseAngle,
                    parsed.gridSync ? 1 : 0, parsed.valid ? 1 : 0);
    }
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
      linkRxBuffer = "$";
      continue;
    }

    if (linkRxBuffer.length() == 0) continue;

    if (c == '\n') {
      handleCompleteRxLine(linkRxBuffer);
      linkRxBuffer = "";
      continue;
    }

    if (c != '\r') {
      linkRxBuffer += c;
    }

    if (linkRxBuffer.length() > 260) {
      linkRxBuffer = "";
      rxBufferResetCount++;
      parseFailCount++;
    }
  }

  perfUartReadUs = micros() - readStart;
}

// ============================================================
// AGGREGATION
// ============================================================
void resetAccumulator() {
  acc = AggAccumulator();
}

void addSampleToAccumulator(const RawData &d) {
  if (!d.valid) return;
  if (d.rpm == 0 && d.freq == 0.0f && d.volt == 0.0f) return;

  acc.count++;

  acc.rpmSum += d.rpm; acc.rpmMin = min(acc.rpmMin, d.rpm); acc.rpmMax = max(acc.rpmMax, d.rpm);
  acc.tpsSum += d.tps; acc.tpsMin = min(acc.tpsMin, d.tps); acc.tpsMax = max(acc.tpsMax, d.tps);
  acc.mapSum += d.map; acc.mapMin = min(acc.mapMin, d.map); acc.mapMax = max(acc.mapMax, d.map);
  acc.iatSum += d.iat; acc.iatMin = min(acc.iatMin, d.iat); acc.iatMax = max(acc.iatMax, d.iat);
  acc.cltSum += d.clt; acc.cltMin = min(acc.cltMin, d.clt); acc.cltMax = max(acc.cltMax, d.clt);

  acc.afrSum += d.afr; acc.afrMin = min(acc.afrMin, d.afr); acc.afrMax = max(acc.afrMax, d.afr);
  acc.battSum += d.batt; acc.battMin = min(acc.battMin, d.batt); acc.battMax = max(acc.battMax, d.batt);
  acc.fuelSum += d.fuel; acc.fuelMin = min(acc.fuelMin, d.fuel); acc.fuelMax = max(acc.fuelMax, d.fuel);

  acc.freqSum += d.freq; acc.freqMin = min(acc.freqMin, d.freq); acc.freqMax = max(acc.freqMax, d.freq);
  acc.freqGridSum += d.freqGrid; acc.freqGridMin = min(acc.freqGridMin, d.freqGrid); acc.freqGridMax = max(acc.freqGridMax, d.freqGrid);
  acc.voltSum += d.volt; acc.voltMin = min(acc.voltMin, d.volt); acc.voltMax = max(acc.voltMax, d.volt);
  acc.voltGridSum += d.voltGrid; acc.voltGridMin = min(acc.voltGridMin, d.voltGrid); acc.voltGridMax = max(acc.voltGridMax, d.voltGrid);
  acc.currentSum += d.currentA; acc.currentMin = min(acc.currentMin, d.currentA); acc.currentMax = max(acc.currentMax, d.currentA);
  acc.powerSum += d.powerKW; acc.powerMin = min(acc.powerMin, d.powerKW); acc.powerMax = max(acc.powerMax, d.powerKW);
  acc.phaseAngleSum += d.phaseAngle; acc.phaseAngleMin = min(acc.phaseAngleMin, d.phaseAngle); acc.phaseAngleMax = max(acc.phaseAngleMax, d.phaseAngle);

  if (d.gridSync) acc.syncedCount++;
}

AggregatedData makeAggregateFromAccumulator() {
  AggregatedData out;
  if (acc.count == 0) {
    out.valid = false;
    return out;
  }

  out.samples = acc.count;

  out.rpmAvg = acc.rpmSum / acc.count; out.rpmMin = acc.rpmMin; out.rpmMax = acc.rpmMax;
  out.tpsAvg = acc.tpsSum / acc.count; out.tpsMin = acc.tpsMin; out.tpsMax = acc.tpsMax;
  out.mapAvg = acc.mapSum / acc.count; out.mapMin = acc.mapMin; out.mapMax = acc.mapMax;
  out.iatAvg = acc.iatSum / acc.count; out.iatMin = acc.iatMin; out.iatMax = acc.iatMax;
  out.cltAvg = acc.cltSum / acc.count; out.cltMin = acc.cltMin; out.cltMax = acc.cltMax;

  out.afrAvg = acc.afrSum / acc.count; out.afrMin = acc.afrMin; out.afrMax = acc.afrMax;
  out.battAvg = acc.battSum / acc.count; out.battMin = acc.battMin; out.battMax = acc.battMax;
  out.fuelAvg = acc.fuelSum / acc.count; out.fuelMin = acc.fuelMin; out.fuelMax = acc.fuelMax;

  out.freqAvg = acc.freqSum / acc.count; out.freqMin = acc.freqMin; out.freqMax = acc.freqMax;
  out.freqGridAvg = acc.freqGridSum / acc.count; out.freqGridMin = acc.freqGridMin; out.freqGridMax = acc.freqGridMax;
  out.voltAvg = acc.voltSum / acc.count; out.voltMin = acc.voltMin; out.voltMax = acc.voltMax;
  out.voltGridAvg = acc.voltGridSum / acc.count; out.voltGridMin = acc.voltGridMin; out.voltGridMax = acc.voltGridMax;
  out.currentAvg = acc.currentSum / acc.count; out.currentMin = acc.currentMin; out.currentMax = acc.currentMax;
  out.powerAvg = acc.powerSum / acc.count; out.powerMin = acc.powerMin; out.powerMax = acc.powerMax;
  out.phaseAngleAvg = acc.phaseAngleSum / acc.count; out.phaseAngleMin = acc.phaseAngleMin; out.phaseAngleMax = acc.phaseAngleMax;

  out.synced = acc.syncedCount > (acc.count / 2);
  out.valid = true;
  return out;
}

void pushStorageRecord(const AggregatedData &a) {
  if (!a.valid) return;

  StorageRecord rec;
  rec.valid = true;
  rec.batchSeq = storageBatchSeq;
  rec.slotIndex = storageBatchCount;
  rec.localSeq = ++localRecordSeq;
  rec.timestamp = getIsoTimestampWIBms();
  rec.timestampMs = millis();
  rec.recordId = String(DEVICE_ID) + "-" + String(rec.localSeq) + "-" + String(rec.timestampMs);
  rec.agg = a;

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    rec.fft = fftData;
    xSemaphoreGive(dataMutex);
  }

  storageBatch[storageBatchCount] = rec;
  storageBatchCount++;

  if (storageBatchCount >= STORAGE_BATCH_SIZE) {
    storageBatchCount = 0;
    storageBatchSeq++;
  }
}

void finalizeFastAggregate() {
  uint32_t aggStart = micros();

  AggregatedData out = makeAggregateFromAccumulator();

  static unsigned long prevAggMs = 0;
  unsigned long nowMs = millis();
  if (prevAggMs > 0) {
    lastFastAggIntervalMs = nowMs - prevAggMs;
  }
  prevAggMs = nowMs;

  if (out.valid) {
    if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
      aggData = out;
      xSemaphoreGive(dataMutex);
    }

    pushStorageRecord(out);

    fastAggCompleted++;
    lastFastAggSamples = out.samples;
    lastAggReadyMs = nowMs;

    if (out.samples < 7) fastAggUnderfilled++;
  }

  resetAccumulator();
  perfAggregationUs = micros() - aggStart;
}

// ============================================================
// FFT - simple DFT, tidak bergantung versi arduinoFFT
// ============================================================
void addSampleToFFTBuffer(const RawData &d) {
#if ENABLE_FFT_EDGE
  if (!d.valid) return;

  // Hanya push sample ke buffer FFT. Komputasi FFT dilakukan di FFTTask,
  // sehingga SensorTask50Hz tidak terbebani DFT manual.
  if (fftMutex && xSemaphoreTake(fftMutex, pdMS_TO_TICKS(2)) != pdTRUE) return;

  for (uint8_t source = 0; source < FFT_SOURCE_COUNT; source++) {
    float signal = getFFTInputSignalBySource(d, source);
    if (isnan(signal) || isinf(signal)) continue;

    fftBuffers[source][fftIndexes[source]] = signal;
    fftIndexes[source]++;

    if (fftIndexes[source] >= FFT_SAMPLES) {
      fftIndexes[source] = 0;
      fftBufferFulls[source] = true;
    }
  }

  if (fftMutex) xSemaphoreGive(fftMutex);
#endif
}

FFTData computeFFTForSource(uint8_t source) {
  FFTData local;
  if (source >= FFT_SOURCE_COUNT || !fftBufferFulls[source]) {
    local.valid = false;
    return local;
  }

  float ordered[FFT_SAMPLES];
  for (uint16_t i = 0; i < FFT_SAMPLES; i++) {
    uint16_t idx = (fftIndexes[source] + i) % FFT_SAMPLES;
    ordered[i] = fftBuffers[source][idx];
  }

  float mean = 0;
  for (uint16_t i = 0; i < FFT_SAMPLES; i++) mean += ordered[i];
  mean /= FFT_SAMPLES;

  float sumSq = 0;
  for (uint16_t i = 0; i < FFT_SAMPLES; i++) {
    float x = ordered[i] - mean;
    sumSq += x * x;
  }

  local.valid = true;
  local.samples = FFT_SAMPLES;
  local.sampleRateHz = FFT_SAMPLE_RATE_HZ;
  local.resolutionHz = FFT_SAMPLE_RATE_HZ / FFT_SAMPLES;
  local.rms = sqrt(sumSq / FFT_SAMPLES);

  // X axis = frequency bin dalam Hz.
  // Y axis = magnitude spektrum dari sinyal terpilih.
  for (uint16_t k = 0; k < FFT_BINS_TO_SEND; k++) {
    float re = 0;
    float im = 0;

    for (uint16_t n = 0; n < FFT_SAMPLES; n++) {
      float x = ordered[n] - mean;
      float angle = 2.0f * PI * k * n / FFT_SAMPLES;
      re += x * cos(angle);
      im -= x * sin(angle);
    }

    float mag = sqrt(re * re + im * im) / FFT_SAMPLES;
    local.freqBins[k] = k * local.resolutionHz;
    local.magBins[k] = mag;

    if (k > 0 && mag > local.peakMagnitude) {
      local.peakMagnitude = mag;
      local.peakHz = local.freqBins[k];
    }
  }

  return local;
}

void computeFFTIfReady() {
#if ENABLE_FFT_EDGE
  bool anyReady = false;

  if (fftMutex && xSemaphoreTake(fftMutex, pdMS_TO_TICKS(50)) != pdTRUE) return;

  for (uint8_t source = 0; source < FFT_SOURCE_COUNT; source++) {
    if (fftBufferFulls[source]) {
      anyReady = true;
      break;
    }
  }

  if (!anyReady) {
    if (fftMutex) xSemaphoreGive(fftMutex);
    return;
  }

  uint32_t fftStart = micros();

  FFTData localResults[FFT_SOURCE_COUNT];
  for (uint8_t source = 0; source < FFT_SOURCE_COUNT; source++) {
    localResults[source] = computeFFTForSource(source);
  }

  if (fftMutex) xSemaphoreGive(fftMutex);

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    for (uint8_t source = 0; source < FFT_SOURCE_COUNT; source++) {
      fftMultiData[source] = localResults[source];
    }

    // fftData = data FFT yang sedang dipilih untuk halaman FFT, storage, dan payload MQTT.
    if (fftSelectedSource < FFT_SOURCE_COUNT) {
      fftData = fftMultiData[fftSelectedSource];
    }

    xSemaphoreGive(dataMutex);
  }

  perfFftComputeUs = micros() - fftStart;
#endif
}

void FFTTask(void *pvParameters) {
#if ENABLE_FFT_EDGE
  TickType_t lastWake = xTaskGetTickCount();

  while (true) {
    computeFFTIfReady();
    vTaskDelayUntil(&lastWake, pdMS_TO_TICKS(FFT_COMPUTE_INTERVAL_MS));
  }
#else
  vTaskDelete(NULL);
#endif
}

// ============================================================
// SENSOR TASK 50 Hz
// ============================================================
void SensorTask50Hz(void *pvParameters) {
  TickType_t lastWake = xTaskGetTickCount();
  uint32_t lastAggMs = millis();

  resetAccumulator();

  while (true) {
    uint32_t taskStart = micros();

    readLinkSerialManual();

    RawData sample;
    bool hasSample = false;

    if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(5)) == pdTRUE) {
      sample = latestRaw;
      hasSample = sample.valid;
      xSemaphoreGive(dataMutex);
    }

    static uint32_t lastAggregatedSeq = 0xFFFFFFFF;

    // UART dari ESP32-1 sekarang 100 ms (10 Hz), sedangkan task ini tetap 20 ms.
    // Agar satu frame UART tidak dihitung 5 kali, agregasi hanya mengambil seq baru.
    if (hasSample && sample.seq != lastAggregatedSeq) {
      addSampleToAccumulator(sample);
      addSampleToFFTBuffer(sample);
      lastAggregatedSeq = sample.seq;
    }

    if (millis() - lastAggMs >= AGGREGATION_INTERVAL_MS) {
      lastAggMs = millis();
      finalizeFastAggregate();
      // FFT tidak dihitung di SensorTask50Hz agar deadline 20 ms tidak terlewati.
      // Komputasi FFT berjalan di FFTTask terpisah setiap FFT_COMPUTE_INTERVAL_MS.
    }

    if (millis() - lastLinkFrameMs > 2000) {
      linkOK = false;
    }

    perfLastRxAgeMs = lastUartReceiveMs > 0 ? millis() - lastUartReceiveMs : 999999;
    sensorExecutions++;
    perfSensorTaskUs = micros() - taskStart;

    if (perfSensorTaskUs > SENSOR_SAMPLE_INTERVAL_MS * 1000UL) {
      sensorMissedDeadlines++;
    }

    vTaskDelayUntil(&lastWake, pdMS_TO_TICKS(SENSOR_SAMPLE_INTERVAL_MS));
  }
}

// ============================================================
// JSON + MQTT
// ============================================================
String buildJsonRecordParametersOnly(const StorageRecord &r) {
  const AggregatedData &a = r.agg;

  // Database cloud dihitung hanya dari parameter utama generator/mesin.
  // Tidak memasukkan FFT, freqGrid, voltGrid, metadata batch, atau timestampMs.
  String json = "{";
  json += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  json += "\"recordId\":\"" + r.recordId + "\",";
  json += "\"localSeq\":" + String(r.localSeq) + ",";
  json += "\"timestamp\":\"" + r.timestamp + "\",";
  json += "\"rpm\":" + String(a.rpmAvg, 1) + ",";
  json += "\"tps\":" + String(a.tpsAvg, 1) + ",";
  json += "\"map\":" + String(a.mapAvg, 1) + ",";
  json += "\"iat\":" + String(a.iatAvg, 1) + ",";
  json += "\"clt\":" + String(a.cltAvg, 1) + ",";
  json += "\"afr\":" + String(a.afrAvg, 2) + ",";
  json += "\"batt\":" + String(a.battAvg, 2) + ",";
  json += "\"fuel\":" + String(a.fuelAvg, 1) + ",";
  json += "\"freq\":" + String(a.freqAvg, 3) + ",";
  json += "\"volt\":" + String(a.voltAvg, 2) + ",";
  json += "\"currentA\":" + String(a.currentAvg, 2) + ",";
  json += "\"powerKW\":" + String(a.powerAvg, 3) + ",";
  json += "\"phase_diff\":" + String(a.phaseAngleAvg, 2) + ",";
  json += "\"synced\":" + String(a.synced ? "true" : "false");
  json += "}";
  return json;
}


String buildJsonParameterBatchPayload() {
  // Untuk estimasi database, cukup hitung record parameter utama yang benar-benar disimpan.
  // STORAGE_BATCH_SIZE saat ini = 1, sehingga output ini adalah 1 dokumen database.
  for (uint8_t i = 0; i < STORAGE_BATCH_SIZE; i++) {
    if (storageBatch[i].valid) return buildJsonRecordParametersOnly(storageBatch[i]);
  }
  return "{}";
}


String buildJsonRecord(const StorageRecord &r) {
  // Payload MQTT untuk web dashboard: field utama + FFT.
  // Estimasi database tetap memakai buildJsonRecordParametersOnly(),
  // sehingga ukuran cloud DB yang dihitung hanya field utama generator/mesin.
  const AggregatedData &a = r.agg;
  const FFTData &f = r.fft;

  String json = "{";
  json += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  json += "\"recordId\":\"" + r.recordId + "\",";
  json += "\"localSeq\":" + String(r.localSeq) + ",";
  json += "\"timestamp\":\"" + r.timestamp + "\",";
  json += "\"rpm\":" + String(a.rpmAvg, 1) + ",";
  json += "\"tps\":" + String(a.tpsAvg, 1) + ",";
  json += "\"map\":" + String(a.mapAvg, 1) + ",";
  json += "\"iat\":" + String(a.iatAvg, 1) + ",";
  json += "\"clt\":" + String(a.cltAvg, 1) + ",";
  json += "\"afr\":" + String(a.afrAvg, 2) + ",";
  json += "\"batt\":" + String(a.battAvg, 2) + ",";
  json += "\"fuel\":" + String(a.fuelAvg, 1) + ",";
  json += "\"freq\":" + String(a.freqAvg, 3) + ",";
  json += "\"volt\":" + String(a.voltAvg, 2) + ",";
  json += "\"currentA\":" + String(a.currentAvg, 2) + ",";
  json += "\"powerKW\":" + String(a.powerAvg, 3) + ",";
  json += "\"phase_diff\":" + String(a.phaseAngleAvg, 2) + ",";
  json += "\"synced\":" + String(a.synced ? "true" : "false") + ",";

  json += "\"fft\":{";
  json += "\"valid\":" + String(f.valid ? "true" : "false") + ",";
  json += "\"source\":\"" + String(getFFTSourceName()) + "\",";
  json += "\"xUnit\":\"Hz\",";
  json += "\"yUnit\":\"magnitude\",";
  json += "\"sampleRateHz\":" + String(f.sampleRateHz, 1) + ",";
  json += "\"resolutionHz\":" + String(f.resolutionHz, 3) + ",";
  json += "\"peakHz\":" + String(f.peakHz, 3) + ",";
  json += "\"peakMagnitude\":" + String(f.peakMagnitude, 5) + ",";
  json += "\"rms\":" + String(f.rms, 5) + ",";
  json += "\"bins\":[";
  for (uint16_t i = 0; i < FFT_BINS_TO_SEND; i++) {
    if (i) json += ",";
    json += "{\"x\":" + String(f.freqBins[i], 3) + ",\"y\":" + String(f.magBins[i], 5) + "}";
  }
  json += "]}";

  json += "}";
  return json;
}

String buildJsonBatchPayload() {
  uint32_t buildStart = micros();

  String json = "{";
  json += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  json += "\"type\":\"record_1s\",";
  json += "\"publishedAt\":\"" + getIsoTimestampWIBms() + "\",";
  json += "\"records\":[";

  bool first = true;
  for (uint8_t i = 0; i < STORAGE_BATCH_SIZE; i++) {
    if (!storageBatch[i].valid) continue;
    if (!first) json += ",";
    json += buildJsonRecord(storageBatch[i]);
    first = false;
  }

  json += "]}";

  perfJsonBuildUs = micros() - buildStart;
  return json;
}

void publishRealtimeData() {
  if (!wifiOK || !mqtt.connected()) return;
  // Test-once mode: lewati jika sudah pernah kirim
  if (testOnceMode && testOnceDone) return;

  bool hasData = false;
  uint32_t recordsInPayload = 0;
  for (uint8_t i = 0; i < STORAGE_BATCH_SIZE; i++) {
    if (storageBatch[i].valid) {
      hasData = true;
      recordsInPayload++;
    }
  }
  if (!hasData) return;

  String payload = buildJsonBatchPayload();
  String parameterOnlyPayload = buildJsonParameterBatchPayload();

  mqttLastPayloadBytes = payload.length();
  mqttLastParameterPayloadBytes = parameterOnlyPayload.length();
  mqttLastRecordsSent = recordsInPayload;

  uint32_t pubStart = micros();
  bool realtimeOk = mqtt.publish(MQTT_REALTIME_TOPIC, payload.c_str());
  bool historyOk = mqtt.publish(MQTT_TOPIC, payload.c_str());
  bool ok = realtimeOk && historyOk;
  perfMqttPublishUs = micros() - pubStart;

  mqttOK = ok;
  if (ok) {
    lastMqttPublishMs = millis();
    mqttPublishSuccessCount++;
    mqttTotalPayloadBytes += mqttLastPayloadBytes;
    mqttTotalParameterPayloadBytes += mqttLastParameterPayloadBytes;
    mqttTotalRecordsSent += recordsInPayload;
  } else {
    mqttPublishFailCount++;
  }
}

// ============================================================
// SD CARD
// ============================================================

void appendRecordToSdSyncQueue(const StorageRecord &r) {
  File queue = SD.open(SD_SYNC_FILE, FILE_APPEND);
  if (!queue) {
    sdSyncFailCount++;
    return;
  }

  queue.println(buildJsonRecordParametersOnly(r));
  queue.close();
}

bool rewriteSdSyncQueueAfterAck(uint16_t ackedLines) {
  File source = SD.open(SD_SYNC_FILE, FILE_READ);
  if (!source) return true;

  File tmp = SD.open(SD_SYNC_TMP_FILE, FILE_WRITE);
  if (!tmp) {
    source.close();
    return false;
  }

  uint16_t lineNo = 0;
  while (source.available()) {
    String line = source.readStringUntil('\n');
    line.trim();
    if (!line.length()) continue;
    lineNo++;
    if (lineNo <= ackedLines) continue;
    tmp.println(line);
  }

  source.close();
  tmp.close();

  SD.remove(SD_SYNC_FILE);
  if (!SD.rename(SD_SYNC_TMP_FILE, SD_SYNC_FILE)) {
    return false;
  }

  return true;
}

void syncSdQueueToMongoDB() {
  if (!sdOK || !wifiOK) return;
  if (String(CLOUD_INGEST_URL).indexOf("localhost") >= 0) return;
  if (!SD.exists(SD_SYNC_FILE)) return;

  String recordsJson = "";
  uint16_t recordsCount = 0;

  if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(500)) != pdTRUE) return;

  deselectAllSPI();
  File queue = SD.open(SD_SYNC_FILE, FILE_READ);
  if (!queue) {
    xSemaphoreGive(sdMutex);
    return;
  }

  while (queue.available() && recordsCount < SD_SYNC_BATCH_SIZE) {
    String line = queue.readStringUntil('\n');
    line.trim();
    if (!line.length()) continue;
    if (recordsCount > 0) recordsJson += ",";
    recordsJson += line;
    recordsCount++;
  }
  queue.close();
  xSemaphoreGive(sdMutex);

  if (!recordsCount) return;

  String payload = "{";
  payload += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"source\":\"esp32_sd_backup\",";
  payload += "\"records\":[" + recordsJson + "]";
  payload += "}";

  HTTPClient http;
  http.setTimeout(10000);
  if (!http.begin(CLOUD_INGEST_URL)) {
    sdSyncFailCount++;
    return;
  }

  http.addHeader("Content-Type", "application/json");
  int code = http.POST(payload);
  http.end();

  if (code < 200 || code >= 300) {
    sdSyncFailCount++;
    return;
  }

  if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
    bool rewritten = rewriteSdSyncQueueAfterAck(recordsCount);
    xSemaphoreGive(sdMutex);

    if (rewritten) {
      sdSyncSuccessCount += recordsCount;
    } else {
      sdSyncFailCount++;
    }
  } else {
    sdSyncFailCount++;
  }
}

void updateStorageCache() {
  if (!sdOK) return;

  if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
    deselectAllSPI();

    File f = SD.open(DB_FILE, FILE_READ);
    if (f) {
      dbCachedFileSizeBytes = f.size();
      f.close();
    }

    sdCachedCardSizeBytes = SD.cardSize();
    sdCachedUsedBytes = SD.usedBytes();
    sdCachedFreeBytes = sdCachedCardSizeBytes > sdCachedUsedBytes ? sdCachedCardSizeBytes - sdCachedUsedBytes : 0;
    dbCachedAtMs = millis();

    xSemaphoreGive(sdMutex);
  }
}

void initSDCard() {
  Serial.println();
  Serial.println("════════════ SD CARD INIT ════════════");

  deselectAllSPI();
  sdSPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);

  if (!SD.begin(SD_CS, sdSPI, SD_SPI_FREQ_INIT)) {
    sdOK = false;
    Serial.println("[SD] GAGAL. Cek CS=26, MOSI=13, MISO=19, SCK=14, FAT32.");
    Serial.println("══════════════════════════════════════");
    return;
  }

  sdOK = true;
  Serial.println("[SD] OK.");

  if (!SD.exists(DB_FILE)) {
    File f = SD.open(DB_FILE, FILE_WRITE);
    if (f) {
      f.println("recordId,localSeq,timestamp,rpm,tps,map,iat,clt,afr,batt,fuel,freq,volt,currentA,powerKW,phase_diff,synced");
      f.close();
    }
  }

  updateStorageCache();
  Serial.println("══════════════════════════════════════");
}

String buildCsvLine(const StorageRecord &r) {
  const AggregatedData &a = r.agg;

  String line = "";
  line += r.recordId; line += ",";
  line += String(r.localSeq); line += ",";
  String csvTimestamp = r.timestamp.length() ? r.timestamp : getCsvTimestampWIBms();
  line += csvTimestamp; line += ",";
  line += String(a.rpmAvg, 1); line += ",";
  line += String(a.tpsAvg, 1); line += ",";
  line += String(a.mapAvg, 1); line += ",";
  line += String(a.iatAvg, 1); line += ",";
  line += String(a.cltAvg, 1); line += ",";
  line += String(a.afrAvg, 2); line += ",";
  line += String(a.battAvg, 2); line += ",";
  line += String(a.fuelAvg, 1); line += ",";
  line += String(a.freqAvg, 3); line += ",";
  line += String(a.voltAvg, 2); line += ",";
  line += String(a.currentAvg, 2); line += ",";
  line += String(a.powerAvg, 3); line += ",";
  line += String(a.phaseAngleAvg, 2); line += ",";
  line += String(a.synced ? 1 : 0);
  return line;
}


void saveSnapshotToSD() {
  if (!sdOK) return;
  // Test-once mode: lewati jika sudah pernah kirim
  if (testOnceMode && testOnceDone) return;

  bool hasData = false;
  for (uint8_t i = 0; i < STORAGE_BATCH_SIZE; i++) {
    if (storageBatch[i].valid) hasData = true;
  }
  if (!hasData) return;

  uint32_t saveStart = micros();

  if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(200)) == pdTRUE) {
    deselectAllSPI();

    File file = SD.open(DB_FILE, FILE_APPEND);
    if (!file) {
      sdSaveFailCount++;
      sdOK = false;
      xSemaphoreGive(sdMutex);
      return;
    }

    for (uint8_t i = 0; i < STORAGE_BATCH_SIZE; i++) {
      if (!storageBatch[i].valid) continue;
      String line = buildCsvLine(storageBatch[i]);
      file.println(line);
      dbLastLineBytes = line.length() + 2;
      dbTotalWrittenBytes += dbLastLineBytes;
    }

    file.close();

    // Outbox terpisah: record tetap ada di SD sampai server memberi ACK HTTP.
    // Ini membuat MongoDB bisa disusulkan lagi saat WiFi/server kembali stabil.
    for (uint8_t i = 0; i < STORAGE_BATCH_SIZE; i++) {
      if (!storageBatch[i].valid) continue;
      appendRecordToSdSyncQueue(storageBatch[i]);
    }

    sdSaveSuccessCount++;
    if (testOnceMode && !testOnceDone) {
      testOnceDone = true;
      Serial.println();
      Serial.println("╔════════════════════════════════════════════════════════╗");
      Serial.println("║           TEST-ONCE: SNAPSHOT BERHASIL DISIMPAN        ║");
      Serial.println("╟────────────────────────────────────────────────────────╢");
      Serial.println("║  SD card & MQTT: pengiriman dihentikan setelah ini.    ║");
      Serial.println("║  Gunakan command  'test once off'  untuk kembali       ║");
      Serial.println("║  ke mode normal, atau 'test once'  untuk ulangi.       ║");
      Serial.println("╚════════════════════════════════════════════════════════╝");
    }
    xSemaphoreGive(sdMutex);
  } else {
    sdSaveFailCount++;
  }

  perfSdSaveUs = micros() - saveStart;

  if (millis() - lastDBStorageReport > 10000) {
    lastDBStorageReport = millis();
    updateStorageCache();
  }
}

// ============================================================
// WIFI + MQTT
// ============================================================
bool isEduroamCredentialConfigured() {
#if USE_EDUROAM_FIRST
  if (String(EDUROAM_USERNAME) == "username@kampus.ac.id") return false;
  if (String(EDUROAM_PASSWORD) == "password_eduroam") return false;
  if (String(EDUROAM_USERNAME).length() < 4) return false;
  if (String(EDUROAM_PASSWORD).length() < 1) return false;
  return true;
#else
  return false;
#endif
}

void disableEduroamEnterpriseMode() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_wifi_sta_enterprise_disable();
#else
  esp_wifi_sta_wpa2_ent_disable();
#endif
}

void prepareNormalWiFiMode() {
  disableEduroamEnterpriseMode();
  WiFi.disconnect(true, true);
  delay(500);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  esp_wifi_set_ps(WIFI_PS_NONE);
  delay(300);
}

const char* wifiStatusText(wl_status_t st) {
  switch (st) {
    case WL_IDLE_STATUS: return "WL_IDLE_STATUS";
    case WL_NO_SSID_AVAIL: return "WL_NO_SSID_AVAIL";
    case WL_SCAN_COMPLETED: return "WL_SCAN_COMPLETED";
    case WL_CONNECTED: return "WL_CONNECTED";
    case WL_CONNECT_FAILED: return "WL_CONNECT_FAILED";
    case WL_CONNECTION_LOST: return "WL_CONNECTION_LOST";
    case WL_DISCONNECTED: return "WL_DISCONNECTED";
    default: return "UNKNOWN";
  }
}

const char* wifiModeText() {
  if (wifiConnectionMode == WIFI_MODE_EDUROAM) return "EDUROAM";
  if (wifiConnectionMode == WIFI_MODE_MANAGER) return "WIFI MANAGER / SAVED WIFI";
  return "OFFLINE";
}

bool connectEduroam() {
#if USE_EDUROAM_FIRST
  Serial.println();
  Serial.println("╔══════════════ EDUROAM WIFI INIT ══════════════╗");

  if (!isEduroamCredentialConfigured()) {
    Serial.println("[EDUROAM] SKIP: credential belum valid / masih placeholder.");
    Serial.println("[EDUROAM] Fallback ke WiFiManager portal.");
    Serial.println("╚════════════════════════════════════════════════╝");
    return false;
  }

  Serial.println("[EDUROAM] Trying WPA2-Enterprise PEAP connection...");
  Serial.print("[EDUROAM] SSID     : "); Serial.println(EDUROAM_SSID);
  Serial.print("[EDUROAM] Identity : "); Serial.println(EDUROAM_IDENTITY);
  Serial.print("[EDUROAM] Username : "); Serial.println(EDUROAM_USERNAME);
  Serial.println("[EDUROAM] Password : ********");

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  esp_wifi_set_ps(WIFI_PS_NONE);

  WiFi.disconnect(true, true);
  delay(1000);

  disableEduroamEnterpriseMode();
  delay(300);

#if ESP_ARDUINO_VERSION_MAJOR >= 3
  // Arduino-ESP32 core 3.x
  WiFi.begin(
    EDUROAM_SSID,
    WPA2_AUTH_PEAP,
    EDUROAM_IDENTITY,
    EDUROAM_USERNAME,
    EDUROAM_PASSWORD
  );
#else
  // Arduino-ESP32 core 2.x
  esp_wifi_sta_wpa2_ent_set_identity(
    (uint8_t *)EDUROAM_IDENTITY,
    strlen(EDUROAM_IDENTITY)
  );

  esp_wifi_sta_wpa2_ent_set_username(
    (uint8_t *)EDUROAM_USERNAME,
    strlen(EDUROAM_USERNAME)
  );

  esp_wifi_sta_wpa2_ent_set_password(
    (uint8_t *)EDUROAM_PASSWORD,
    strlen(EDUROAM_PASSWORD)
  );

  esp_wifi_sta_wpa2_ent_enable();
  WiFi.begin(EDUROAM_SSID);
#endif

  unsigned long startAttempt = millis();
  wl_status_t lastStatus = WL_IDLE_STATUS;

  while (WiFi.status() != WL_CONNECTED &&
         millis() - startAttempt < EDUROAM_TIMEOUT_MS) {
    wl_status_t st = WiFi.status();

    if (st != lastStatus) {
      Serial.print("[EDUROAM] WiFi status changed: ");
      Serial.print((int)st);
      Serial.print(" / ");
      Serial.println(wifiStatusText(st));
      lastStatus = st;
    }

    Serial.print(".");
    delay(500);
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    wifiOK = true;
    wifiConnectionMode = WIFI_MODE_EDUROAM;

    Serial.println("[EDUROAM] Connected successfully.");
    Serial.print("[EDUROAM] SSID : "); Serial.println(WiFi.SSID());
    Serial.print("[EDUROAM] IP   : "); Serial.println(WiFi.localIP());
    Serial.print("[EDUROAM] RSSI : "); Serial.print(WiFi.RSSI()); Serial.println(" dBm");
    Serial.println("╚════════════════════════════════════════════════╝");
    return true;
  }

  wifiOK = false;
  wifiConnectionMode = WIFI_MODE_OFFLINE;

  Serial.println("[EDUROAM] Failed / timeout.");
  Serial.print("[EDUROAM] WiFi status: ");
  Serial.print((int)WiFi.status());
  Serial.print(" / ");
  Serial.println(wifiStatusText(WiFi.status()));
  Serial.println("[EDUROAM] Cleaning enterprise mode before WiFiManager...");
  prepareNormalWiFiMode();
  Serial.println("[EDUROAM] Fallback to WiFiManager portal.");
  Serial.println("╚════════════════════════════════════════════════╝");

  return false;
#else
  return false;
#endif
}

bool connectWiFiManagerFallback() {
  Serial.println();
  Serial.println("╔════════════ WIFI MANAGER FALLBACK ════════════╗");

  prepareNormalWiFiMode();

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

  if (res && WiFi.status() == WL_CONNECTED) {
    wifiOK = true;
    wifiConnectionMode = WIFI_MODE_MANAGER;

    Serial.print("[WIFI MANAGER] Connected. SSID: "); Serial.println(WiFi.SSID());
    Serial.print("[WIFI MANAGER] IP: "); Serial.println(WiFi.localIP());
    Serial.print("[WIFI MANAGER] RSSI: "); Serial.print(WiFi.RSSI()); Serial.println(" dBm");
    Serial.println("╚════════════════════════════════════════════════╝");
    return true;
  }

  wifiOK = false;
  wifiConnectionMode = WIFI_MODE_OFFLINE;

  Serial.println("[WIFI MANAGER] Failed / timeout. System tetap jalan offline.");
  Serial.println("╚════════════════════════════════════════════════╝");
  return false;
}

void setupWiFiManager() {
  Serial.println();
  Serial.println("╔════════════ WIFI CONNECTION INIT ════════════╗");

  wifiOK = false;
  mqttOK = false;
  wifiConnectionMode = WIFI_MODE_OFFLINE;

#if USE_EDUROAM_FIRST
  if (connectEduroam()) {
    Serial.println("[WIFI] Mode koneksi: EDUROAM");
    Serial.println("╚══════════════════════════════════════════════╝");
    return;
  }
#endif

  if (connectWiFiManagerFallback()) {
    Serial.println("[WIFI] Mode koneksi: WIFI MANAGER / SAVED WIFI");
    Serial.println("╚══════════════════════════════════════════════╝");
    return;
  }

  Serial.println("[WIFI] Tidak terkoneksi. Sistem berjalan offline.");
  Serial.println("╚══════════════════════════════════════════════╝");
}

void reconnectMQTT() {
  if (!wifiOK) return;

  if (mqtt.connected()) {
    mqttOK = true;
    return;
  }

  if (millis() - lastReconnect < 3000) return;
  lastReconnect = millis();

  String clientId = String("GENSYS_MONITOR_") + String((uint32_t)ESP.getEfuseMac(), HEX);

  Serial.println();
  Serial.println("╔════════════ MQTT CONNECT ════════════╗");
  Serial.print("[MQTT] Host  : "); Serial.println(MQTT_HOST);
  Serial.print("[MQTT] Port  : "); Serial.println(MQTT_PORT);
  Serial.print("[MQTT] User  : "); Serial.println(MQTT_USER);
  Serial.println("[MQTT] Pass  : ********");
  Serial.print("[MQTT] Realtime Topic : "); Serial.println(MQTT_REALTIME_TOPIC);
  Serial.print("[MQTT] History Topic  : "); Serial.println(MQTT_TOPIC);
  Serial.print("[MQTT] Client: "); Serial.println(clientId);
  Serial.print("[MQTT] Connecting... ");

  if (mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS)) {
    mqttOK = true;
    Serial.println("OK");
  } else {
    mqttOK = false;
    Serial.print("FAILED rc=");
    Serial.println(mqtt.state());
  }

  Serial.println("╚══════════════════════════════════════╝");
}

void checkWiFiStatus() {
  if (millis() - lastWifiCheck < 3000) return;
  lastWifiCheck = millis();

  wifiOK = WiFi.status() == WL_CONNECTED;
  if (!wifiOK) {
    mqttOK = false;
    if (wifiConnectionMode != WIFI_MODE_OFFLINE) {
      Serial.print("[WIFI] Connection lost from mode: ");
      Serial.println(wifiModeText());
    }
    wifiConnectionMode = WIFI_MODE_OFFLINE;
  }
}
// ============================================================
// BOOT SPLASH + UI COMPONENT
// ============================================================
void drawGensysLogoMark(int cx, int cy, int r, uint16_t fg, uint16_t bg) {
  tft.drawCircle(cx, cy, r, fg);
  tft.drawCircle(cx, cy, r - 4, fg);

  // Large G style.
  tft.fillCircle(cx + 20, cy, r / 2, fg);
  tft.fillCircle(cx + 20, cy, r / 3, bg);
  tft.fillRect(cx + 20, cy - 8, r / 2, 16, bg);
  tft.fillRect(cx + 20, cy, r / 2, 14, fg);

  // Lightning.
  int x0 = cx - r + 12;
  int y0 = cy - 4;
  tft.fillTriangle(x0, y0, cx - 5, cy - r + 12, cx - 28, cy + 4, fg);
  tft.fillTriangle(cx - 28, cy + 4, cx + 5, cy + 2, x0 - 12, cy + r - 6, fg);

  // Plug.
  tft.fillRoundRect(cx - 58, cy + 45, 42, 18, 5, fg);
  tft.fillRect(cx - 68, cy + 51, 12, 5, fg);
  tft.fillRect(cx - 55, cy + 36, 6, 12, fg);
  tft.fillRect(cx - 42, cy + 36, 6, 12, fg);
}

void drawBootSplashStep(const char* statusText, int progress) {
  // Boot page di-render penuh hanya sekali. Step berikutnya hanya update loading bar
  // dan status text agar layar tidak flicker/berkedip saat proses init berjalan.
  static bool bootBaseDrawn = false;
  static int lastProgress = -1;
  static String lastStatus = "";

  int barX = 80;
  int barY = 288;
  int barW = 320;
  int barH = 14;

  progress = constrain(progress, 0, 100);

  if (!bootBaseDrawn || progress <= 0) {
    tft.fillScreen(C_PRIMARY);
    drawGensysLogoMark(SW / 2, 108, 78, C_WHITE, C_PRIMARY);

    tft.setTextColor(C_WHITE, C_PRIMARY);
    tft.setTextDatum(MC_DATUM);
    tft.setTextSize(4);
    tft.drawString("GENSYS", SW / 2, 213);

    tft.setTextSize(1);
    tft.drawString("GENERATOR SYNCHRONIZATION", SW / 2, 246);
    tft.drawString("& MONITORING SYSTEM", SW / 2, 262);

    tft.drawRoundRect(barX, barY, barW, barH, 7, C_WHITE);
    tft.fillRoundRect(barX + 2, barY + 2, barW - 4, barH - 4, 5, C_PRIMARY);

    bootBaseDrawn = true;
    lastProgress = -1;
    lastStatus = "";
  }

  if (progress != lastProgress) {
    int innerW = barW - 4;
    int fillW = map(progress, 0, 100, 0, innerW);

    // Area dalam bar saja yang dibersihkan, bukan seluruh boot page.
    tft.fillRoundRect(barX + 2, barY + 2, innerW, barH - 4, 5, C_PRIMARY);
    if (fillW > 0) {
      tft.fillRoundRect(barX + 2, barY + 2, fillW, barH - 4, 5, C_GREEN);
    }
    lastProgress = progress;
  }

  if (lastStatus != String(statusText)) {
    tft.fillRect(40, 302, 400, 16, C_PRIMARY);
    tft.setTextColor(C_WHITE, C_PRIMARY);
    tft.setTextDatum(MC_DATUM);
    tft.setTextSize(1);
    tft.drawString(statusText, SW / 2, 310);
    tft.setTextDatum(TL_DATUM);
    lastStatus = String(statusText);
  }
}

void drawHeader(const char* title) {
  tft.fillRect(0, 0, SW, 42, C_PRIMARY);
  tft.setTextColor(C_WHITE, C_PRIMARY);
  tft.setTextSize(2);
  tft.setCursor(10, 12);
  tft.print(title);

  tft.setTextSize(1);
  tft.setCursor(300, 10); tft.print("LINK");
  tft.setCursor(352, 10); tft.print("WiFi");
  tft.setCursor(404, 10); tft.print("MQTT");
  tft.setCursor(452, 10); tft.print("SD");

  tft.fillCircle(315, 28, 5, linkOK ? C_GREEN : C_RED);
  tft.fillCircle(368, 28, 5, wifiOK ? C_GREEN : C_RED);
  tft.fillCircle(421, 28, 5, mqtt.connected() ? C_GREEN : C_RED);
  tft.fillCircle(459, 28, 5, sdOK ? C_GREEN : C_RED);
}

void drawPanel(int x, int y, int w, int h, const char* title) {
  tft.fillRoundRect(x, y, w, h, 8, C_PANEL);
  tft.drawRoundRect(x, y, w, h, 8, C_BORDER);
  tft.fillRoundRect(x, y, w, 22, 8, C_PRIMARY);
  tft.fillRect(x, y + 14, w, 8, C_PRIMARY);
  tft.setTextColor(C_WHITE, C_PRIMARY);
  tft.setTextSize(1);
  tft.setCursor(x + 8, y + 7);
  tft.print(title);
}

void drawValueCard(int x, int y, int w, int h, const char* label, const char* value, const char* unit, uint16_t color) {
  tft.fillRoundRect(x, y, w, h, 8, C_WHITE);
  tft.drawRoundRect(x, y, w, h, 8, C_BORDER);

  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextSize(1);
  tft.setCursor(x + 8, y + 8);
  tft.print(label);

  tft.setTextColor(color, C_WHITE);
  tft.setTextSize(2);
  tft.setCursor(x + 8, y + 28);
  tft.print(value);

  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextSize(1);
  tft.setCursor(x + w - 34, y + 35);
  tft.print(unit);
}

void drawValueBox(int x, int y, int w, int h, const char* label, const char* value, const char* unit, uint16_t color) {
  tft.fillRoundRect(x, y, w, h, 8, C_WHITE);
  tft.drawRoundRect(x, y, w, h, 8, C_BORDER);
  tft.setTextDatum(MC_DATUM);

  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextSize(1);
  tft.drawString(label, x + w / 2, y + 15);

  tft.setTextColor(color, C_WHITE);
  tft.setTextSize(2);
  tft.drawString(value, x + w / 2, y + h / 2 + 4);

  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextSize(1);
  tft.drawString(unit, x + w / 2, y + h - 13);
  tft.setTextDatum(TL_DATUM);
}

void drawLineBar(int x, int y, int w, int h, float value, float minVal, float maxVal, uint16_t color, const char* label) {
  float p = (value - minVal) / (maxVal - minVal);
  if (p < 0) p = 0;
  if (p > 1) p = 1;

  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextSize(1);
  tft.setCursor(x, y - 12);
  tft.print(label);

  tft.drawRoundRect(x, y, w, h, 4, C_BORDER);
  tft.fillRoundRect(x + 2, y + 2, w - 4, h - 4, 3, 0xEF7D);

  int fillW = (int)((w - 4) * p);
  tft.fillRoundRect(x + 2, y + 2, fillW, h - 4, 3, color);

  tft.fillRect(x + w + 6, y - 4, 42, h + 8, C_WHITE);
  tft.setTextColor(C_DARK, C_WHITE);
  tft.setCursor(x + w + 8, y - 1);
  tft.print(value, 1);
}

void drawSemiGauge(int x, int y, int r, float value, float minVal, float maxVal,
                   const char* label, const char* valueText, const char* unit,
                   uint16_t color) {
  const int w = 140;
  const int h = 108;
  tft.fillRoundRect(x, y, w, h, 10, C_WHITE);
  tft.drawRoundRect(x, y, w, h, 10, C_BORDER);

  int cx = x + w / 2;
  int cy = y + 70;

  for (int a = 180; a <= 360; a += 6) {
    float rad = a * PI / 180.0f;
    int x1 = cx + cos(rad) * (r - 8);
    int y1 = cy + sin(rad) * (r - 8);
    int x2 = cx + cos(rad) * r;
    int y2 = cy + sin(rad) * r;
    tft.drawLine(x1, y1, x2, y2, C_GRID);
  }

  float p = (value - minVal) / (maxVal - minVal);
  if (p < 0) p = 0;
  if (p > 1) p = 1;

  int endA = 180 + (int)(180.0f * p);
  for (int a = 180; a <= endA; a += 4) {
    float rad = a * PI / 180.0f;
    int x1 = cx + cos(rad) * (r - 10);
    int y1 = cy + sin(rad) * (r - 10);
    int x2 = cx + cos(rad) * r;
    int y2 = cy + sin(rad) * r;
    tft.drawLine(x1, y1, x2, y2, color);
  }

  float needleRad = endA * PI / 180.0f;
  int nx = cx + cos(needleRad) * (r - 18);
  int ny = cy + sin(needleRad) * (r - 18);
  tft.drawLine(cx, cy, nx, ny, color);
  tft.fillCircle(cx, cy, 4, color);

  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextSize(1);
  tft.drawString(label, cx, y + 12);

  // Semua nilai gauge berada di tengah bawah gauge.
  tft.fillRect(x + 14, y + 80, w - 28, 22, C_WHITE);
  tft.setTextColor(color, C_WHITE);
  tft.setTextSize(2);
  tft.drawString(valueText, cx - 8, y + 91);

  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextSize(1);
  tft.drawString(unit, cx + 44, y + 94);
  tft.setTextDatum(TL_DATUM);
}

void drawHeaderStatusDots(bool force) {
  static bool lastLink = false, lastWifi = false, lastMqtt = false, lastSd = false;
  bool nowMqtt = mqtt.connected();

  if (force || lastLink != linkOK) {
    tft.fillCircle(315, 28, 6, C_PRIMARY);
    tft.fillCircle(315, 28, 5, linkOK ? C_GREEN : C_RED);
    lastLink = linkOK;
  }
  if (force || lastWifi != wifiOK) {
    tft.fillCircle(368, 28, 6, C_PRIMARY);
    tft.fillCircle(368, 28, 5, wifiOK ? C_GREEN : C_RED);
    lastWifi = wifiOK;
  }
  if (force || lastMqtt != nowMqtt) {
    tft.fillCircle(421, 28, 6, C_PRIMARY);
    tft.fillCircle(421, 28, 5, nowMqtt ? C_GREEN : C_RED);
    lastMqtt = nowMqtt;
  }
  if (force || lastSd != sdOK) {
    tft.fillCircle(459, 28, 6, C_PRIMARY);
    tft.fillCircle(459, 28, 5, sdOK ? C_GREEN : C_RED);
    lastSd = sdOK;
  }
}

void drawBottomNav() {
  int y = 292;
  int h = 26;

  uint16_t colors[3] = {
    activePage == PAGE_GENERATOR ? C_PRIMARY : C_WHITE,
    activePage == PAGE_ENGINE ? C_PRIMARY : C_WHITE,
    activePage == PAGE_FFT ? C_PRIMARY : C_WHITE
  };

  uint16_t texts[3] = {
    activePage == PAGE_GENERATOR ? C_WHITE : C_PRIMARY,
    activePage == PAGE_ENGINE ? C_WHITE : C_PRIMARY,
    activePage == PAGE_FFT ? C_WHITE : C_PRIMARY
  };

  const char* labels[3] = {"GENERATOR", "ENGINE", "FFT"};
  int xs[3] = {10, 167, 324};

  for (int i = 0; i < 3; i++) {
    tft.fillRoundRect(xs[i], y, 145, h, 8, colors[i]);
    tft.drawRoundRect(xs[i], y, 145, h, 8, C_PRIMARY);
    tft.setTextColor(texts[i], colors[i]);
    tft.setTextSize(1);
    tft.setCursor(xs[i] + 45, y + 9);
    tft.print(labels[i]);
  }
}

// ============================================================
// PAGES
// ============================================================
void drawGeneratorPage(bool full) {
  static bool initialized = false;
  static float lastFreqGen = NAN, lastFreqGrid = NAN, lastVoltGen = NAN, lastVoltGrid = NAN;
  static float lastPhase = NAN, lastCurrentA = NAN, lastPowerKW = NAN;
  static bool lastSynced = false;

  AggregatedData d;

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    d = aggData;
    xSemaphoreGive(dataMutex);
  }

  if (full || !initialized) {
    tft.fillScreen(C_BG);
    drawHeader("GENERATOR MONITOR");
    drawBottomNav();
    initialized = true;
    lastFreqGen = lastFreqGrid = lastVoltGen = lastVoltGrid = NAN;
    lastPhase = lastCurrentA = lastPowerKW = NAN;
  } else {
    drawHeaderStatusDots(false);
  }

  if (changedFloat(lastVoltGen, d.voltAvg, 0.5f)) {
    drawSemiGauge(14, 52, 46, d.voltAvg, 180.0f, 250.0f, "VOLT GEN", fmtF(d.voltAvg, 0), "V",
                  valColor(d.voltAvg, 240, 250, 200, 180));
    lastVoltGen = d.voltAvg;
  }

  if (changedFloat(lastFreqGen, d.freqAvg, 0.02f)) {
    drawSemiGauge(170, 52, 46, d.freqAvg, 45.0f, 55.0f, "FREQ GEN", fmtF(d.freqAvg, 2), "Hz",
                  valColor(d.freqAvg, 51.0, 52.0, 49.0, 48.0));
    lastFreqGen = d.freqAvg;
  }

  if (changedFloat(lastVoltGrid, d.voltGridAvg, 0.5f)) {
    drawSemiGauge(14, 170, 46, d.voltGridAvg, 180.0f, 250.0f, "VOLT GRID", fmtF(d.voltGridAvg, 0), "V",
                  valColor(d.voltGridAvg, 240, 250, 200, 180));
    lastVoltGrid = d.voltGridAvg;
  }

  if (changedFloat(lastFreqGrid, d.freqGridAvg, 0.02f)) {
    drawSemiGauge(170, 170, 46, d.freqGridAvg, 45.0f, 55.0f, "FREQ GRID", fmtF(d.freqGridAvg, 2), "Hz",
                  valColor(d.freqGridAvg, 51.0, 52.0, 49.0, 48.0));
    lastFreqGrid = d.freqGridAvg;
  }

  // Right-side cards: PHASE, POWER, CURRENT, SYNC STATUS.
  // Semua card hanya di-render ulang jika nilainya berubah atau saat ganti page.
  if (changedFloat(lastPhase, d.phaseAngleAvg, 0.1f)) {
    drawValueBox(326, 50, 140, 50, "PHASE", fmtF(d.phaseAngleAvg, 1), "deg",
                 abs(d.phaseAngleAvg) < 10 ? C_GREEN : abs(d.phaseAngleAvg) < 20 ? C_ORANGE : C_RED);
    lastPhase = d.phaseAngleAvg;
  }

  if (changedFloat(lastPowerKW, d.powerAvg, 0.02f)) {
    drawValueBox(326, 106, 140, 50, "POWER", fmtF(d.powerAvg, 2), "kW",
                 valColor(d.powerAvg, 8.0, 12.0, -1e9, -1e9));
    lastPowerKW = d.powerAvg;
  }

  if (changedFloat(lastCurrentA, d.currentAvg, 0.1f)) {
    drawValueBox(326, 162, 140, 50, "CURRENT", fmtF(d.currentAvg, 1), "A",
                 valColor(d.currentAvg, 40.0, 55.0, -1e9, -1e9));
    lastCurrentA = d.currentAvg;
  }

  if (full || d.synced != lastSynced) {
    drawValueBox(326, 218, 140, 56, "SYNC STATUS", d.synced ? "ON-GRID" : "OFF-GRID", "",
                 d.synced ? C_GREEN : C_RED);
    lastSynced = d.synced;
  }
}
void drawEnginePage(bool full) {
  static bool initialized = false;
  static float lastRpm = NAN, lastAfr = NAN, lastMap = NAN;
  static float lastTps = NAN, lastFuel = NAN, lastClt = NAN, lastIat = NAN, lastBatt = NAN;

  AggregatedData d;

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    d = aggData;
    xSemaphoreGive(dataMutex);
  }

  if (full || !initialized) {
    tft.fillScreen(C_BG);
    drawHeader("ENGINE MONITOR");
    drawBottomNav();
    initialized = true;
    lastRpm = lastAfr = lastMap = NAN;
    lastTps = lastFuel = lastClt = lastIat = lastBatt = NAN;
  } else {
    drawHeaderStatusDots(false);
  }

  if (changedFloat(lastRpm, d.rpmAvg, 5.0f)) {
    drawSemiGauge(14, 52, 46, d.rpmAvg, 0.0f, 6000.0f, "ENGINE RPM", fmtF(d.rpmAvg, 0), "rpm",
                  valColor(d.rpmAvg, 4500, 5500, -1e9, -1e9));
    lastRpm = d.rpmAvg;
  }

  if (changedFloat(lastAfr, d.afrAvg, 0.05f)) {
    drawSemiGauge(170, 52, 46, d.afrAvg, 10.0f, 20.0f, "AFR", fmtF(d.afrAvg, 1), "",
                  valColor(d.afrAvg, 16.0, 18.0, 12.0, 10.5));
    lastAfr = d.afrAvg;
  }

  if (changedFloat(lastMap, d.mapAvg, 0.5f)) {
    drawSemiGauge(326, 52, 46, d.mapAvg, 20.0f, 105.0f, "MAP", fmtF(d.mapAvg, 0), "kPa",
                  valColor(d.mapAvg, 95, 105, -1e9, -1e9));
    lastMap = d.mapAvg;
  }

  bool leftPanel = changedFloat(lastTps, d.tpsAvg, 0.5f) || changedFloat(lastFuel, d.fuelAvg, 0.5f);
  if (leftPanel) {
    drawPanel(14, 172, 220, 102, "FUEL & THROTTLE");
    drawLineBar(28, 214, 145, 12, d.tpsAvg, 0.0f, 100.0f, C_GREEN, "TPS");
    drawLineBar(28, 253, 145, 12, d.fuelAvg, 0.0f, 100.0f,
                d.fuelAvg > 30 ? C_GREEN : d.fuelAvg > 15 ? C_ORANGE : C_RED, "Fuel");
    lastTps = d.tpsAvg;
    lastFuel = d.fuelAvg;
  }

  bool rightPanel = changedFloat(lastBatt, d.battAvg, 0.05f) ||
                    changedFloat(lastIat, d.iatAvg, 0.5f) ||
                    changedFloat(lastClt, d.cltAvg, 0.5f);
  if (rightPanel) {
    drawPanel(246, 172, 220, 102, "THERMAL & POWER");
    drawValueCard(256, 205, 62, 58, "Battery", fmtF(d.battAvg, 1), "V",
                  valColor(d.battAvg, 14.5, 15.5, 11.5, 10.5));
    drawValueCard(326, 205, 62, 58, "IAT", fmtF(d.iatAvg, 0), "C",
                  valColor(d.iatAvg, 55, 70, -1e9, -1e9));
    drawValueCard(396, 205, 62, 58, "Coolant", fmtF(d.cltAvg, 0), "C",
                  valColor(d.cltAvg, 90, 105, -1e9, -1e9));
    lastBatt = d.battAvg;
    lastIat = d.iatAvg;
    lastClt = d.cltAvg;
  }
}

void drawFFTPage(bool full) {
  static bool initialized = false;
  static uint8_t lastSource = 255;
  static bool lastValid = false;
  static float lastPeakHz = NAN, lastPeakMag = NAN, lastRms = NAN;

  FFTData f;

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    f = fftData;
    xSemaphoreGive(dataMutex);
  }

  bool needSpectrumRedraw = full || !initialized || fftSelectedSource != lastSource ||
                            f.valid != lastValid ||
                            changedFloat(lastPeakHz, f.peakHz, 0.05f) ||
                            changedFloat(lastPeakMag, f.peakMagnitude, 0.002f) ||
                            changedFloat(lastRms, f.rms, 0.002f);

  if (full || !initialized) {
    tft.fillScreen(C_BG);
    drawHeader("FFT EDGE MONITOR");
    drawBottomNav();
    initialized = true;
  } else {
    drawHeaderStatusDots(false);
  }

  if (!needSpectrumRedraw) return;

  drawPanel(14, 55, 452, 222, "FFT SPECTRUM - X:FREQUENCY, Y:MAGNITUDE");

  int gx = 46;
  int gy = 92;
  int gw = 382;
  int gh = 135;

  tft.fillRect(gx, gy, gw, gh, C_WHITE);
  tft.drawRect(gx, gy, gw, gh, C_BORDER);

  for (int i = 0; i <= 4; i++) {
    int yy = gy + i * gh / 4;
    tft.drawLine(gx, yy, gx + gw, yy, C_GRID);
  }

  for (int i = 0; i <= 8; i++) {
    int xx = gx + i * gw / 8;
    tft.drawLine(xx, gy, xx, gy + gh, C_GRID);
  }

  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextSize(1);
  tft.setCursor(gx + 132, gy + gh + 13);
  tft.print("X: Frequency (Hz)");
  tft.setCursor(16, gy + 55);
  tft.print("Y: Mag");

  if (f.valid) {
    float maxMag = 0.001f;
    for (uint16_t i = 1; i < FFT_BINS_TO_SEND; i++) {
      if (f.magBins[i] > maxMag) maxMag = f.magBins[i];
    }

    int prevX = gx;
    int prevY = gy + gh;

    for (uint16_t i = 1; i < FFT_BINS_TO_SEND; i++) {
      int x = gx + map(i, 1, FFT_BINS_TO_SEND - 1, 0, gw);
      int y = gy + gh - (int)((f.magBins[i] / maxMag) * (gh - 6));
      if (y < gy) y = gy;

      tft.drawLine(prevX, prevY, x, y, C_PRIMARY);
      tft.fillCircle(x, y, 2, C_PRIMARY);
      prevX = x;
      prevY = y;
    }

    tft.setTextColor(C_DARK, C_WHITE);
    tft.setTextSize(1);
    tft.setCursor(52, 248);
    tft.print("SRC=");
    tft.print(getFFTSourceName());
    tft.print("  Peak X=");
    tft.print(f.peakHz, 2);
    tft.print("Hz  Y=");
    tft.print(f.peakMagnitude, 4);
    tft.print("  RMS=");
    tft.print(f.rms, 3);
  } else {
    tft.setTextColor(C_MUTED, C_WHITE);
    tft.setTextSize(2);
    tft.setCursor(130, 150);
    tft.print("FFT BUFFERING...");
  }

  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextSize(1);
  tft.setCursor(52, 265);
  tft.print("Serial: fft source voltgen | fft source voltgrid | fft source rpm");

  lastSource = fftSelectedSource;
  lastValid = f.valid;
  lastPeakHz = f.peakHz;
  lastPeakMag = f.peakMagnitude;
  lastRms = f.rms;
}

void drawCurrentPage(bool full) {
  // full=true hanya dipakai ketika ganti halaman / command redraw.
  // Saat full=false, setiap page hanya menggambar komponen yang nilainya berubah
  // berdasarkan cache lastX masing-masing page.
  uint32_t drawStart = micros();

  if (activePage == PAGE_GENERATOR) {
    drawGeneratorPage(full);
  } else if (activePage == PAGE_ENGINE) {
    drawEnginePage(full);
  } else {
    drawFFTPage(full);
  }

  perfTftDrawUs = micros() - drawStart;
  lastTftDrawMs = millis();
}

// ============================================================
// TOUCH
// ============================================================
void readTouchMapped(int &x, int &y, int &rawX, int &rawY) {
  TS_Point p = ts.getPoint();
  rawX = p.x;
  rawY = p.y;

  // Mapping umum untuk FT6206 480x320 rotation landscape.
  // Jika hasil terbalik, gunakan command "calibrate" untuk melihat raw X/Y,
  // lalu sesuaikan rumus di bawah.
  x = map(rawY, 0, 480, 0, 480);
  y = map(rawX, 0, 320, 320, 0);

  if (x < 0) x = 0;
  if (x > SW) x = SW;
  if (y < 0) y = 0;
  if (y > SH) y = SH;
}

void handleTouchNavigation() {
  if (!touchDetected) return;
  if (!ts.touched()) return;

  int x, y, rawX, rawY;
  readTouchMapped(x, y, rawX, rawY);

  if (serialTouchDebug || touchCalibrationMode) {
    Serial.println();
    Serial.println("════════════ TOUCH POINT ════════════");
    Serial.print("Raw X : "); Serial.println(rawX);
    Serial.print("Raw Y : "); Serial.println(rawY);
    Serial.print("Map X : "); Serial.println(x);
    Serial.print("Map Y : "); Serial.println(y);
    Serial.println("═════════════════════════════════════");
  }

  if (touchCalibrationMode) {
    Serial.print("[CAL] ");
    Serial.print(calPoints[calIndex].name);
    Serial.print(" target=(");
    Serial.print(calPoints[calIndex].sx);
    Serial.print(",");
    Serial.print(calPoints[calIndex].sy);
    Serial.print(") raw=(");
    Serial.print(rawX);
    Serial.print(",");
    Serial.print(rawY);
    Serial.print(") map=(");
    Serial.print(x);
    Serial.print(",");
    Serial.print(y);
    Serial.println(")");

    calIndex++;
    if (calIndex >= sizeof(calPoints) / sizeof(calPoints[0])) {
      Serial.println("[CAL] Calibration sampling selesai.");
      Serial.println("[CAL] Sesuaikan fungsi readTouchMapped() jika koordinat ikon belum akurat.");
      touchCalibrationMode = false;
      calIndex = 0;
    }

    delay(400);
    return;
  }

  if (y >= 285) {
    if (x >= 10 && x <= 155) {
      activePage = PAGE_GENERATOR;
      needFullRedraw = true;
    } else if (x >= 167 && x <= 312) {
      activePage = PAGE_ENGINE;
      needFullRedraw = true;
    } else if (x >= 324 && x <= 469) {
      activePage = PAGE_FFT;
      needFullRedraw = true;
    }
    delay(250);
  }
}

// ============================================================
// SERIAL COMMAND CONSOLE
// ============================================================
void printSerialHelp() {
  Serial.println();
  Serial.println(F("GENSYS CMD: help | db | perf | fft | latest | page generator|engine|fft | redraw"));
  Serial.println(F("FFT CMD   : fft source voltgen | fft source voltgrid | fft source rpm"));
  Serial.println(F("DEBUG     : rx raw on/off | rx ok on/off | db reset | db reset confirm"));
}

String buildCloudEstimateRecordOnly() {
  AggregatedData a;
  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    a = aggData;
    xSemaphoreGive(dataMutex);
  }

  String json = "{";
  json += "\"timestamp\":\"" + getIsoTimestampWIBms() + "\",";
  json += "\"rpm\":" + String(a.rpmAvg, 1) + ",";
  json += "\"tps\":" + String(a.tpsAvg, 1) + ",";
  json += "\"map\":" + String(a.mapAvg, 1) + ",";
  json += "\"iat\":" + String(a.iatAvg, 1) + ",";
  json += "\"clt\":" + String(a.cltAvg, 1) + ",";
  json += "\"afr\":" + String(a.afrAvg, 2) + ",";
  json += "\"batt\":" + String(a.battAvg, 2) + ",";
  json += "\"fuel\":" + String(a.fuelAvg, 1) + ",";
  json += "\"freq\":" + String(a.freqAvg, 3) + ",";
  json += "\"volt\":" + String(a.voltAvg, 2) + ",";
  json += "\"currentA\":" + String(a.currentAvg, 2) + ",";
  json += "\"powerKW\":" + String(a.powerAvg, 3) + ",";
  json += "\"phase_diff\":" + String(a.phaseAngleAvg, 2) + ",";
  json += "\"synced\":" + String(a.synced ? "true" : "false");
  json += "}";
  return json;
}


void printDatabaseReport() {
  updateStorageCache();
  String cloudParamOnly = buildCloudEstimateRecordOnly();

  const float sdBytesPerSec = (float)dbLastLineBytes * STORAGE_BATCH_SIZE;
  const float sd7d = sdBytesPerSec * 86400.0f * 7.0f;
  const float cloudRecordBytes = cloudParamOnly.length();
  const float cloudBytesPerSec = cloudRecordBytes * STORAGE_BATCH_SIZE;
  const float mongoFactor = 2.2f;
  const float cloud10y = cloudBytesPerSec * 86400.0f * 365.0f * 10.0f * mongoFactor;

  Serial.println();
  Serial.println(F("================ GENSYS DATA MANAGEMENT ================"));
  Serial.println(F("LOCAL SD / CSV"));
  Serial.print  (F("  status          : ")); Serial.println(sdOK ? F("READY") : F("NOT READY"));
  Serial.print  (F("  file            : ")); Serial.println(DB_FILE);
  Serial.print  (F("  card size       : ")); Serial.println(formatBytes(sdCachedCardSizeBytes));
  Serial.print  (F("  used/free       : ")); Serial.print(formatBytes(sdCachedUsedBytes)); Serial.print(F(" / ")); Serial.println(formatBytes(sdCachedFreeBytes));
  Serial.print  (F("  csv size        : ")); Serial.println(formatBytes(dbCachedFileSizeBytes));
  Serial.print  (F("  last row        : ")); Serial.print(dbLastLineBytes); Serial.println(F(" B/record"));
  Serial.print  (F("  records/sec     : ")); Serial.println(STORAGE_BATCH_SIZE);
  Serial.print  (F("  write rate      : ")); Serial.println(formatBytes((uint64_t)sdBytesPerSec) + F("/s"));
  Serial.print  (F("  est. 7 days     : ")); Serial.println(formatBytes((uint64_t)sd7d));
  Serial.print  (F("  save OK/FAIL    : ")); Serial.print(sdSaveSuccessCount); Serial.print(F(" / ")); Serial.println(sdSaveFailCount);
  Serial.print  (F("  sync OK/FAIL    : ")); Serial.print(sdSyncSuccessCount); Serial.print(F(" / ")); Serial.println(sdSyncFailCount);

  Serial.println(F("LOCAL SD PARAMETERS"));
  Serial.println(F("  recordId,localSeq,timestamp,rpm,tps,map,iat,clt,afr,batt,fuel,freq,volt,currentA,powerKW,phase_diff,synced"));

  Serial.println(F("CLOUD / MONGODB ESTIMATE (MAIN DATABASE FIELDS ONLY)"));
  Serial.print  (F("  mqtt status     : ")); Serial.println(mqtt.connected() ? F("CONNECTED") : F("DISCONNECTED"));
  Serial.print  (F("  realtime topic  : ")); Serial.println(MQTT_REALTIME_TOPIC);
  Serial.print  (F("  history topic   : ")); Serial.println(MQTT_TOPIC);
  Serial.print  (F("  actual MQTT     : ")); Serial.print(mqttLastPayloadBytes); Serial.println(F(" B/publish"));
  Serial.print  (F("  records/publish : ")); Serial.println(mqttLastRecordsSent);
  Serial.print  (F("  param record    : ")); Serial.print((uint32_t)cloudRecordBytes); Serial.println(F(" B/record"));
  Serial.print  (F("  records/sec     : ")); Serial.println(STORAGE_BATCH_SIZE);
  Serial.print  (F("  param rate      : ")); Serial.println(formatBytes((uint64_t)cloudBytesPerSec) + F("/s"));
  Serial.print  (F("  est. 10 years   : ")); Serial.println(formatBytes((uint64_t)cloud10y));
  Serial.print  (F("  pub OK/FAIL     : ")); Serial.print(mqttPublishSuccessCount); Serial.print(F(" / ")); Serial.println(mqttPublishFailCount);
  Serial.println(F("CLOUD PARAMETERS"));
  Serial.println(F("  recordId,localSeq,timestamp,rpm,tps,map,iat,clt,afr,batt,fuel,freq,volt,currentA,powerKW,phase_diff,synced"));
  Serial.println(F("NOTE: estimasi database hanya menghitung field utama."));
  Serial.println(F("      Payload MQTT tetap mengirim FFT untuk web dashboard, tetapi FFT tidak dihitung sebagai storage DB."));
  Serial.println(F("========================================================"));
}

void printPerformanceReport() {
  const float budgetUs = SENSOR_SAMPLE_INTERVAL_MS * 1000.0f;
  const float taskPct = budgetUs > 0 ? (perfSensorTaskUs * 100.0f / budgetUs) : 0.0f;
  Serial.println();
  Serial.println(F("================ GENSYS COMPUTE PERFORMANCE ================"));
  Serial.print(F("UART read      : ")); Serial.print(perfUartReadUs); Serial.println(F(" us"));
  Serial.print(F("CSV parse      : ")); Serial.print(perfCsvParseUs); Serial.println(F(" us"));
  Serial.print(F("Aggregation    : ")); Serial.print(perfAggregationUs); Serial.println(F(" us / 1000 ms window"));
  Serial.print(F("FFT 3-source   : ")); Serial.print(perfFftComputeUs); Serial.println(F(" us"));
  Serial.print(F("JSON build     : ")); Serial.print(perfJsonBuildUs); Serial.println(F(" us"));
  Serial.print(F("MQTT publish   : ")); Serial.print(perfMqttPublishUs); Serial.println(F(" us"));
  Serial.print(F("SD append      : ")); Serial.print(perfSdSaveUs); Serial.println(F(" us"));
  Serial.print(F("TFT draw       : ")); Serial.print(perfTftDrawUs); Serial.println(F(" us"));
  Serial.print(F("Sensor task    : ")); Serial.print(perfSensorTaskUs); Serial.print(F(" us = ")); Serial.print(taskPct, 1); Serial.println(F("% of 20 ms budget"));
  Serial.print(F("Missed deadline: ")); Serial.println((uint32_t)sensorMissedDeadlines);
  Serial.print(F("RX OK/FAIL     : ")); Serial.print((uint32_t)parseOKCount); Serial.print(F(" / ")); Serial.println((uint32_t)parseFailCount);
  Serial.print(F("Last RX age    : ")); Serial.print(perfLastRxAgeMs); Serial.println(F(" ms"));
  Serial.println(F("============================================================="));
}

void printLatestDataReport() {
  RawData r; AggregatedData a;
  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    r = latestRaw; a = aggData; xSemaphoreGive(dataMutex);
  }
  Serial.println();
  Serial.println(F("================ LATEST DATA ================"));
  Serial.printf("RAW seq=%lu valid=%d rpm=%d tps=%d map=%d iat=%d clt=%d afr=%.2f batt=%.2f fuel=%.1f\n",
                (unsigned long)r.seq, r.valid ? 1 : 0, r.rpm, r.tps, r.map, r.iat, r.clt, r.afr, r.batt, r.fuel);
  Serial.printf("RAW freq=%.3f freqGrid=%.3f volt=%.2f voltGrid=%.2f phase=%.2f sync=%d\n",
                r.freq, r.freqGrid, r.volt, r.voltGrid, r.phaseAngle, r.gridSync ? 1 : 0);
  Serial.printf("AGG samples=%u rpm=%.1f map=%.1f freq=%.3f volt=%.2f synced=%d\n",
                a.samples, a.rpmAvg, a.mapAvg, a.freqAvg, a.voltAvg, a.synced ? 1 : 0);
  Serial.printf("DERIVED current=%.1f A power=%.2f kW\n",
                estimateGeneratorCurrentA(a.rpmAvg, a.tpsAvg, a.mapAvg, a.voltAvg),
                estimateGeneratorPowerKW(a.voltAvg, estimateGeneratorCurrentA(a.rpmAvg, a.tpsAvg, a.mapAvg, a.voltAvg)));
  Serial.println(F("============================================="));
}

void printFFTReport() {
  FFTData f[FFT_SOURCE_COUNT];
  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    for (uint8_t source = 0; source < FFT_SOURCE_COUNT; source++) f[source] = fftMultiData[source];
    xSemaphoreGive(dataMutex);
  }
  Serial.println();
  Serial.println(F("================ FFT X-Y DATA ================"));
  Serial.print(F("Active source: ")); Serial.println(getFFTSourceName());
  for (uint8_t source = 0; source < FFT_SOURCE_COUNT; source++) {
    Serial.print(F("SOURCE ")); Serial.print(getFFTSourceNameById(source));
    Serial.print(F(" | valid=")); Serial.print(f[source].valid ? F("YES") : F("NO"));
    Serial.print(F(" | peakX=")); Serial.print(f[source].peakHz, 3);
    Serial.print(F(" Hz | peakY=")); Serial.println(f[source].peakMagnitude, 6);
    for (uint16_t i = 0; i < FFT_BINS_TO_SEND; i++) {
      Serial.print(F("  x=")); Serial.print(f[source].freqBins[i], 3);
      Serial.print(F(" Hz | y=")); Serial.println(f[source].magBins[i], 6);
    }
  }
  Serial.println(F("=============================================="));
}

void resetSDDatabase() {
  if (!sdOK) { Serial.println(F("[DB] SD not ready.")); return; }
  if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
    deselectAllSPI();
    if (SD.exists(DB_FILE)) SD.remove(DB_FILE);
    if (SD.exists(SD_SYNC_FILE)) SD.remove(SD_SYNC_FILE);
    if (SD.exists(SD_SYNC_TMP_FILE)) SD.remove(SD_SYNC_TMP_FILE);
    File f = SD.open(DB_FILE, FILE_WRITE);
    if (f) {
      f.println(F("recordId,localSeq,timestamp,rpm,tps,map,iat,clt,afr,batt,fuel,freq,volt,currentA,powerKW,phase_diff,synced"));
      f.close();
      dbTotalWrittenBytes = 0; dbLastLineBytes = 0; sdSaveSuccessCount = 0; sdSaveFailCount = 0; sdSyncSuccessCount = 0; sdSyncFailCount = 0;
      Serial.println(F("[DB] database.csv reset OK."));
    } else {
      Serial.println(F("[DB] reset failed."));
    }
    xSemaphoreGive(sdMutex);
  }
  updateStorageCache();
}

void handlePeriodicSerialLog() {
  if (!serialLogEnabled) return;
  if (millis() - lastSerialLogMs < serialLogIntervalMs) return;
  lastSerialLogMs = millis();
  if (serialLogDatabaseEnabled) printDatabaseReport();
  if (serialLogPerformanceEnabled) printPerformanceReport();
  if (serialLogFFTEnabled) printFFTReport();
  if (serialLogLatestEnabled) printLatestDataReport();
}

void printDbSizeTicker() {
  printDatabaseReport();
}

void processSerialCommand(String cmd) {
  cmd.trim(); cmd.toLowerCase();
  if (cmd.length() == 0) return;

  if (cmd == "help") printSerialHelp();
  else if (cmd == "database" || cmd == "db") printDatabaseReport();
  else if (cmd == "performance" || cmd == "perf") printPerformanceReport();
  else if (cmd == "latest" || cmd == "data" || cmd == "sample") printLatestDataReport();
  else if (cmd == "fft") printFFTReport();
  else if (cmd == "fft source voltgen") { fftSelectedSource = FFT_SRC_VOLT_GEN; if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) { fftData = fftMultiData[fftSelectedSource]; xSemaphoreGive(dataMutex); } needFullRedraw = true; Serial.println(F("[FFT] source=VOLT_GEN")); }
  else if (cmd == "fft source voltgrid") { fftSelectedSource = FFT_SRC_VOLT_GRID; if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) { fftData = fftMultiData[fftSelectedSource]; xSemaphoreGive(dataMutex); } needFullRedraw = true; Serial.println(F("[FFT] source=VOLT_GRID")); }
  else if (cmd == "fft source rpm") { fftSelectedSource = FFT_SRC_RPM; if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) { fftData = fftMultiData[fftSelectedSource]; xSemaphoreGive(dataMutex); } needFullRedraw = true; Serial.println(F("[FFT] source=RPM")); }
  else if (cmd == "page generator") { activePage = PAGE_GENERATOR; needFullRedraw = true; Serial.println(F("[DISPLAY] generator")); }
  else if (cmd == "page engine") { activePage = PAGE_ENGINE; needFullRedraw = true; Serial.println(F("[DISPLAY] engine")); }
  else if (cmd == "page fft") { activePage = PAGE_FFT; needFullRedraw = true; Serial.println(F("[DISPLAY] fft")); }
  else if (cmd == "redraw") { needFullRedraw = true; Serial.println(F("[DISPLAY] redraw")); }
  else if (cmd == "rx raw on") { runtimeDebugRxRaw = true; Serial.println(F("[RX] raw on")); }
  else if (cmd == "rx raw off") { runtimeDebugRxRaw = false; Serial.println(F("[RX] raw off")); }
  else if (cmd == "rx ok on") { runtimeDebugRxOK = true; Serial.println(F("[RX] ok on")); }
  else if (cmd == "rx ok off") { runtimeDebugRxOK = false; Serial.println(F("[RX] ok off")); }
  else if (cmd == "db ticker on") { dbSizeTickerEnabled = true; Serial.println(F("[DB] ticker on")); }
  else if (cmd == "db ticker off") { dbSizeTickerEnabled = false; Serial.println(F("[DB] ticker off")); }
  else if (cmd == "db reset") { sdResetPending = true; sdResetPendingMs = millis(); Serial.println(F("Type: db reset confirm")); }
  else if (cmd == "db reset confirm") { if (sdResetPending) resetSDDatabase(); sdResetPending = false; }
  else if (cmd == "test once") { testOnceMode = true; testOnceDone = false; Serial.println(F("[TEST] once on")); }
  else if (cmd == "test once off") { testOnceMode = false; testOnceDone = false; Serial.println(F("[TEST] once off")); }
  else if (cmd == "log off") { serialLogEnabled = false; Serial.println(F("[LOG] off")); }
  else if (cmd == "log database on") { serialLogEnabled = true; serialLogDatabaseEnabled = true; Serial.println(F("[LOG] database on")); }
  else if (cmd == "log performance on") { serialLogEnabled = true; serialLogPerformanceEnabled = true; Serial.println(F("[LOG] performance on")); }
  else if (cmd == "log fft on") { serialLogEnabled = true; serialLogFFTEnabled = true; Serial.println(F("[LOG] fft on")); }
  else if (cmd == "log latest on") { serialLogEnabled = true; serialLogLatestEnabled = true; Serial.println(F("[LOG] latest on")); }
  else Serial.println(F("[CMD] unknown. Type help."));
}

void handleSerialCommandConsole() {
  while (Serial.available()) {
    char c = (char)Serial.read();

    if (c == '\n' || c == '\r') {
      if (serialCmd.length() > 0) {
        processSerialCommand(serialCmd);
        serialCmd = "";
      }
    } else {
      serialCmd += c;
      if (serialCmd.length() > 96) {
        serialCmd = "";
        Serial.println("[CMD] Command terlalu panjang, buffer direset.");
      }
    }
  }
}

// ============================================================
// SETUP + LOOP
// ============================================================
void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println();
  Serial.println("BOOTING GENSYS ESP32-2 INDUSTRIAL HMI");

  memset(&latestRaw, 0, sizeof(latestRaw));
  memset(&aggData, 0, sizeof(aggData));
  memset(&fftData, 0, sizeof(fftData));
  memset(&fftMultiData, 0, sizeof(fftMultiData));
  memset(&fftBuffers, 0, sizeof(fftBuffers));
  strlcpy(latestRaw.syncText, "OFF-GRID", sizeof(latestRaw.syncText));
  strlcpy(latestRaw.statusText, "NO-DATA", sizeof(latestRaw.statusText));

  dataMutex = xSemaphoreCreateMutex();
  sdMutex = xSemaphoreCreateMutex();
  fftMutex = xSemaphoreCreateMutex();

  if (dataMutex == NULL) Serial.println("[ERROR] dataMutex gagal dibuat.");
  if (sdMutex == NULL) Serial.println("[ERROR] sdMutex gagal dibuat.");
  if (fftMutex == NULL) Serial.println("[ERROR] fftMutex gagal dibuat.");

  deselectAllSPI();

  LinkSerial.begin(LINK_BAUD, SERIAL_8N1, LINK_RX_PIN, LINK_TX_PIN);
  LinkSerial.setTimeout(50);

  // TFT init dulu agar boot splash tampil.
  pinMode(CTP_RST, OUTPUT);
  digitalWrite(CTP_RST, LOW); delay(10);
  digitalWrite(CTP_RST, HIGH); delay(100);

  tft.init();
  tft.setRotation(1);

  drawBootSplashStep("Initializing UART link...", 10);

  drawBootSplashStep("Initializing touch controller...", 25);
  Wire.begin(CTP_SDA, CTP_SCL);
  if (!ts.begin(40)) {
    touchDetected = false;
    Serial.println("[TOUCH] Tidak terdeteksi.");
  } else {
    touchDetected = true;
    Serial.println("[TOUCH] OK.");
  }

  drawBootSplashStep("Mounting local SD database...", 40);
  initSDCard();

  drawBootSplashStep("Starting WiFi manager...", 58);
  setupWiFiManager();

  drawBootSplashStep("Synchronizing NTP timestamp...", 72);
  if (wifiOK) {
    configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER_1, NTP_SERVER_2);
  }

  drawBootSplashStep("Connecting MQTT broker...", 86);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(4096);

  if (wifiOK) {
    reconnectMQTT();
  }

  drawBootSplashStep("Starting sensor and FFT tasks...", 94);
  xTaskCreatePinnedToCore(
    SensorTask50Hz,
    "SensorTask50Hz",
    12000,
    NULL,
    2,
    NULL,
    1
  );

  xTaskCreatePinnedToCore(
    FFTTask,
    "FFTTask",
    8192,
    NULL,
    1,
    NULL,
    0
  );

  drawBootSplashStep("GENSYS ready", 100);
  delay(600);

  activePage = PAGE_GENERATOR;
  needFullRedraw = true;

  printSerialHelp();

  Serial.println();
  Serial.println("GENSYS READY: CSV RX + 1s RECORD + SD + MQTT + TFT HMI + TOUCH");
  Serial.print("LINK_BAUD = ");
  Serial.println(LINK_BAUD);
}

void loop() {
  handleSerialCommandConsole();
  handlePeriodicSerialLog();

  // ── DB size ticker (setiap 1 detik jika diaktifkan) ──────────
  if (dbSizeTickerEnabled && millis() - lastDbSizeTickMs >= 1000UL) {
    lastDbSizeTickMs = millis();
    updateStorageCache();
    printDbSizeTicker();
  }

  // ── Bersihkan pending reset jika tidak dikonfirmasi dalam 30 detik ──
  if (sdResetPending && millis() - sdResetPendingMs >= 30000UL) {
    sdResetPending = false;
    Serial.println("[DB RESET] Waktu konfirmasi habis. Reset dibatalkan.");
  }

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

  if (millis() - lastSdSync >= SD_SYNC_INTERVAL_MS) {
    lastSdSync = millis();
    syncSdQueueToMongoDB();
  }

  handleTouchNavigation();

  if (millis() - lastDraw >= drawInterval) {
    lastDraw = millis();
    drawCurrentPage(needFullRedraw);
    needFullRedraw = false;
  }

  delay(5);
}
