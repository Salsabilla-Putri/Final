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
#include <WiFiClientSecure.h>
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

#ifndef MQTT_REALTIME_TOPIC
#define MQTT_REALTIME_TOPIC "gen/realtime"
#endif

#ifndef MQTT_DATA_TOPIC
#define MQTT_DATA_TOPIC "gen/data"
#endif

// Backward compatibility untuk log lama.
#ifndef MQTT_TOPIC
#define MQTT_TOPIC MQTT_REALTIME_TOPIC
#endif

// Endpoint backend untuk sinkronisasi ulang data historis dari SD card.
// Ganti URL ini jika domain Render/backend berbeda.
#ifndef CLOUD_INGEST_URL
#define CLOUD_INGEST_URL "https://generator-monitoring-system.onrender.com/api/ingest/batch"
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
// ESP32-1 sinkronisasi mengirim frame setiap 200 ms = 5 Hz.
#define LINK_EXPECTED_FRAME_INTERVAL_MS 200UL
#define LINK_EXPECTED_FRAME_HZ          5

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
const char* SYNC_STATE_FILE = "/sync_state.txt";
const char* FAILED_SYNC_LOG_FILE = "/failed_batches.log";

// ============================================================
// TIMING
// ============================================================
#define SENSOR_SAMPLE_HZ          50
#define SENSOR_SAMPLE_INTERVAL_MS 20
#define AGGREGATION_INTERVAL_MS   1000
#define STORAGE_BATCH_SIZE        1

const unsigned long publishInterval   = 1000;   // realtime dashboard + alert
const unsigned long localSaveInterval = 1000;   // local SD database
const unsigned long drawInterval      = 500;

// Cloud historical sync dari SD card.
// Data historis dikirim ke backend sebagai chunk agar aman untuk RAM ESP32.
#define CLOUD_SYNC_INTERVAL_MS       300000UL  // 5 menit
#define CLOUD_RETRY_INTERVAL_MS       30000UL  // retry saat backlog/koneksi pulih
#define CLOUD_HTTP_TIMEOUT_MS         15000UL
#define CLOUD_CHUNK_SIZE                 30    // 30 record/chunk agar payload HTTP tidak terlalu besar

// ============================================================
// FFT EDGE
// ============================================================
#define ENABLE_FFT_EDGE        1
#define FFT_SAMPLE_RATE_HZ     5.0f   // Mengikuti UART ESP32-1: 200 ms = 5 Hz
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

  // Identitas lokal untuk store-and-forward dari SD card.
  // recordId dipakai backend sebagai unique key agar retry tidak menghasilkan duplikasi MongoDB.
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
unsigned long lastReconnect = 0;
unsigned long lastWifiCheck = 0;
unsigned long lastLinkFrameMs = 0;
unsigned long lastSDRetry = 0;
unsigned long lastDBStorageReport = 0;
unsigned long lastCloudSyncAttempt = 0;

uint32_t storageBatchSeq = 0;
uint8_t storageBatchCount = 0;

unsigned long sdSaveSuccessCount = 0;
unsigned long sdSaveFailCount = 0;
uint64_t dbTotalWrittenBytes = 0;

// Store-and-forward cloud sync state.
uint32_t localSeqCounter = 0;
uint32_t lastCloudSentSeq = 0;
uint32_t lastSavedLocalSeq = 0;
uint32_t cloudSyncSuccessCount = 0;
uint32_t cloudSyncFailCount = 0;
uint32_t cloudLastRecordsSent = 0;
uint32_t cloudLastPayloadBytes = 0;
uint32_t cloudLastHttpCode = 0;
unsigned long cloudLastSuccessMs = 0;
unsigned long cloudLastAttemptMs = 0;
bool cloudSyncBusy = false;
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

  // localSeq dibuat saat agregasi 1 detik selesai.
  // Nilai awal localSeqCounter dipulihkan dari database.csv saat boot.
  rec.localSeq = ++localSeqCounter;
  rec.recordId = String(DEVICE_ID) + "-" + String(rec.localSeq);

  rec.timestamp = getIsoTimestampWIBms();
  rec.timestampMs = millis();
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
  json += "\"recordId\":\"" + r.recordId + "\",";
  json += "\"localSeq\":" + String(r.localSeq) + ",";
  json += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
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
  json += "\"recordId\":\"" + r.recordId + "\",";
  json += "\"localSeq\":" + String(r.localSeq) + ",";
  json += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
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
  bool ok = mqtt.publish(MQTT_REALTIME_TOPIC, payload.c_str());
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
// CLOUD BACKUP SYNC FROM SD CARD
// ============================================================
String jsonEscape(const String &s) {
  String out;
  out.reserve(s.length() + 8);
  for (uint16_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (c == '\n') {
      out += "\\n";
    } else if (c == '\r') {
      out += "\\r";
    } else {
      out += c;
    }
  }
  return out;
}

bool splitCsvLine(const String &line, String fields[], uint8_t maxFields, uint8_t &count) {
  count = 0;
  int start = 0;
  for (int i = 0; i <= line.length(); i++) {
    if (i == line.length() || line[i] == ',') {
      if (count < maxFields) {
        fields[count] = line.substring(start, i);
        fields[count].trim();
        count++;
      }
      start = i + 1;
    }
  }
  return count > 0;
}

uint32_t parseLocalSeqFromCsvLine(const String &line) {
  String fields[4];
  uint8_t count = 0;
  if (!splitCsvLine(line, fields, 4, count)) return 0;
  if (count < 2) return 0;
  return (uint32_t)fields[1].toInt();
}

String csvLineToJsonRecord(const String &line) {
  String f[22];
  uint8_t n = 0;
  if (!splitCsvLine(line, f, 22, n)) return "";
  if (n < 20) return "";

  String json = "{";
  json += "\"recordId\":\"" + jsonEscape(f[0]) + "\",";
  json += "\"localSeq\":" + f[1] + ",";
  json += "\"timestamp\":\"" + jsonEscape(f[2]) + "\",";
  json += "\"deviceId\":\"" + jsonEscape(f[3]) + "\",";
  json += "\"rpm\":" + f[4] + ",";
  json += "\"tps\":" + f[5] + ",";
  json += "\"map\":" + f[6] + ",";
  json += "\"iat\":" + f[7] + ",";
  json += "\"clt\":" + f[8] + ",";
  json += "\"afr\":" + f[9] + ",";
  json += "\"batt\":" + f[10] + ",";
  json += "\"fuel\":" + f[11] + ",";
  json += "\"freq\":" + f[12] + ",";
  json += "\"volt\":" + f[13] + ",";
  json += "\"currentA\":" + f[14] + ",";
  json += "\"amp\":" + f[14] + ",";
  json += "\"powerKW\":" + f[15] + ",";
  json += "\"power\":" + f[15] + ",";
  json += "\"phaseAngle\":" + f[16] + ",";
  json += "\"phase_diff\":" + f[16] + ",";
  json += "\"sync\":\"" + jsonEscape(f[17]) + "\",";
  json += "\"status\":\"" + jsonEscape(f[18]) + "\",";
  json += "\"synced\":" + String((f[17] == "ON-GRID" || f[19].toInt() == 1) ? "true" : "false");
  json += "}";
  return json;
}

void writeSyncState(uint32_t lastSeq) {
  if (!sdOK) return;

  if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(300)) == pdTRUE) {
    deselectAllSPI();
    if (SD.exists(SYNC_STATE_FILE)) SD.remove(SYNC_STATE_FILE);

    File f = SD.open(SYNC_STATE_FILE, FILE_WRITE);
    if (f) {
      f.print("lastSentSeq=");
      f.println(lastSeq);
      f.print("lastSentAt=");
      f.println(getIsoTimestampWIBms());
      f.close();
      lastCloudSentSeq = lastSeq;
    }

    xSemaphoreGive(sdMutex);
  }
}

uint32_t readSyncState() {
  if (!sdOK || !SD.exists(SYNC_STATE_FILE)) return 0;

  uint32_t seq = 0;

  if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(300)) == pdTRUE) {
    deselectAllSPI();
    File f = SD.open(SYNC_STATE_FILE, FILE_READ);
    while (f && f.available()) {
      String line = f.readStringUntil('\n');
      line.trim();
      if (line.startsWith("lastSentSeq=")) {
        seq = (uint32_t)line.substring(String("lastSentSeq=").length()).toInt();
        break;
      }
    }
    if (f) f.close();
    xSemaphoreGive(sdMutex);
  }

  lastCloudSentSeq = seq;
  return seq;
}

uint32_t readLastLocalSeqFromDatabase() {
  if (!sdOK || !SD.exists(DB_FILE)) return 0;

  uint32_t maxSeq = 0;

  if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(800)) == pdTRUE) {
    deselectAllSPI();
    File f = SD.open(DB_FILE, FILE_READ);
    while (f && f.available()) {
      String line = f.readStringUntil('\n');
      line.trim();
      if (line.length() == 0 || line.startsWith("recordId,")) continue;
      uint32_t seq = parseLocalSeqFromCsvLine(line);
      if (seq > maxSeq) maxSeq = seq;
    }
    if (f) f.close();
    xSemaphoreGive(sdMutex);
  }

  return maxSeq;
}

void appendFailedSyncLog(const String &reason) {
  if (!sdOK) return;
  if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(300)) == pdTRUE) {
    deselectAllSPI();
    File f = SD.open(FAILED_SYNC_LOG_FILE, FILE_APPEND);
    if (f) {
      f.print(getIsoTimestampWIBms());
      f.print(",lastSentSeq=");
      f.print(lastCloudSentSeq);
      f.print(",reason=");
      f.println(reason);
      f.close();
    }
    xSemaphoreGive(sdMutex);
  }
}

bool buildPendingCloudPayload(String &payload, uint32_t &maxSeqInPayload, uint32_t &recordCount) {
  payload = "";
  maxSeqInPayload = lastCloudSentSeq;
  recordCount = 0;

  if (!sdOK || !SD.exists(DB_FILE)) return false;

  String recordsJson = "";
  recordsJson.reserve(12000);

  if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(1500)) == pdTRUE) {
    deselectAllSPI();

    File f = SD.open(DB_FILE, FILE_READ);
    while (f && f.available()) {
      String line = f.readStringUntil('\n');
      line.trim();
      if (line.length() == 0 || line.startsWith("recordId,")) continue;

      uint32_t seq = parseLocalSeqFromCsvLine(line);
      if (seq <= lastCloudSentSeq) continue;

      String recJson = csvLineToJsonRecord(line);
      if (recJson.length() == 0) continue;

      if (recordCount > 0) recordsJson += ",";
      recordsJson += recJson;
      recordCount++;

      if (seq > maxSeqInPayload) maxSeqInPayload = seq;
      if (recordCount >= CLOUD_CHUNK_SIZE) break;
    }

    if (f) f.close();
    xSemaphoreGive(sdMutex);
  } else {
    return false;
  }

  if (recordCount == 0) return false;

  String batchId = String(DEVICE_ID) + "-" + String(lastCloudSentSeq + 1) + "-" + String(maxSeqInPayload);

  payload.reserve(recordsJson.length() + 300);
  payload = "{";
  payload += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"batchId\":\"" + batchId + "\",";
  payload += "\"source\":\"esp32_sd_backup\",";
  payload += "\"sentAt\":\"" + getIsoTimestampWIBms() + "\",";
  payload += "\"recordCount\":" + String(recordCount) + ",";
  payload += "\"records\":[";
  payload += recordsJson;
  payload += "]}";

  return true;
}

long extractJsonLong(const String &json, const String &key, long fallback) {
  String pattern = "\"" + key + "\":";
  int idx = json.indexOf(pattern);
  if (idx < 0) return fallback;
  idx += pattern.length();

  while (idx < json.length() && (json[idx] == ' ' || json[idx] == '\t')) idx++;

  int end = idx;
  while (end < json.length() && (isDigit(json[end]) || json[end] == '-')) end++;

  if (end <= idx) return fallback;
  return json.substring(idx, end).toInt();
}

bool postCloudPayloadToBackend(const String &payload, uint32_t maxSeqInPayload, uint32_t recordCount) {
  if (!wifiOK || WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  int httpCode = -1;
  String response = "";
  bool ok = false;

  String url = String(CLOUD_INGEST_URL);

  uint32_t startUs = micros();

  if (url.startsWith("https://")) {
    WiFiClientSecure secureClient;
    secureClient.setInsecure();
    if (!http.begin(secureClient, url)) {
      appendFailedSyncLog("HTTP_BEGIN_HTTPS_FAIL");
      return false;
    }
  } else {
    WiFiClient plainClient;
    if (!http.begin(plainClient, url)) {
      appendFailedSyncLog("HTTP_BEGIN_FAIL");
      return false;
    }
  }

  http.setTimeout(CLOUD_HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Id", DEVICE_ID);

  httpCode = http.POST((uint8_t*)payload.c_str(), payload.length());
  cloudLastHttpCode = httpCode;

  if (httpCode > 0) {
    response = http.getString();
    if (httpCode >= 200 && httpCode < 300 && response.indexOf("\"success\":true") >= 0) {
      uint32_t acceptedSeq = (uint32_t)extractJsonLong(response, "lastAcceptedSeq", maxSeqInPayload);
      if (acceptedSeq == 0) acceptedSeq = maxSeqInPayload;
      writeSyncState(acceptedSeq);
      cloudSyncSuccessCount++;
      cloudLastSuccessMs = millis();
      cloudLastRecordsSent = recordCount;
      cloudLastPayloadBytes = payload.length();
      ok = true;
    }
  }

  http.end();

  if (!ok) {
    cloudSyncFailCount++;
    String reason = "HTTP_" + String(httpCode);
    if (response.length()) reason += "_" + response.substring(0, min((int)response.length(), 80));
    appendFailedSyncLog(reason);
  }

  uint32_t elapsedUs = micros() - startUs;
  Serial.printf("[CLOUD SYNC] http=%d ok=%d records=%lu payload=%uB maxSeq=%lu time=%lu us\n",
                httpCode, ok ? 1 : 0, (unsigned long)recordCount,
                (unsigned int)payload.length(), (unsigned long)maxSeqInPayload,
                (unsigned long)elapsedUs);

  return ok;
}

void syncPendingDataFromSDOnce(bool force = false) {
  if (cloudSyncBusy) return;
  if (!sdOK || !wifiOK || WiFi.status() != WL_CONNECTED) return;
  if (testOnceMode && testOnceDone) return;

  unsigned long nowMs = millis();
  unsigned long interval = force ? 0UL : CLOUD_RETRY_INTERVAL_MS;
  if (!force && (nowMs - lastCloudSyncAttempt < interval)) return;

  lastCloudSyncAttempt = nowMs;
  cloudLastAttemptMs = nowMs;
  cloudSyncBusy = true;

  // Refresh checkpoint dari SD agar state tetap benar setelah reboot.
  readSyncState();

  String payload;
  uint32_t maxSeq = 0;
  uint32_t recordCount = 0;

  bool hasPending = buildPendingCloudPayload(payload, maxSeq, recordCount);
  if (hasPending) {
    postCloudPayloadToBackend(payload, maxSeq, recordCount);
  }

  cloudSyncBusy = false;
}

void handleCloudBackupSync() {
  if (!wifiOK || !sdOK) return;

  // Coba sync satu chunk tiap 30 detik jika ada backlog. Saat backlog sudah habis,
  // fungsi buildPendingCloudPayload() akan return false dan tidak ada HTTP request.
  syncPendingDataFromSDOnce(false);
}

// ============================================================
// SD CARD
// ============================================================
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
      f.println("recordId,localSeq,timestamp,deviceId,rpm,tps,map,iat,clt,afr,batt,fuel,freq,volt,currentA,powerKW,phaseAngle,sync,status,synced");
      f.close();
    }
  }

  if (!SD.exists(SYNC_STATE_FILE)) {
    writeSyncState(0);
  } else {
    readSyncState();
  }

  localSeqCounter = readLastLocalSeqFromDatabase();
  if (localSeqCounter < lastCloudSentSeq) localSeqCounter = lastCloudSentSeq;
  Serial.printf("[SD] Local seq restored: lastLocal=%lu lastCloudSent=%lu\n",
                (unsigned long)localSeqCounter, (unsigned long)lastCloudSentSeq);

  updateStorageCache();
  Serial.println("══════════════════════════════════════");
}

String buildCsvLine(const StorageRecord &r) {
  const AggregatedData &a = r.agg;

  String syncText = a.synced ? "ON-GRID" : "OFF-GRID";
  String statusText = (a.rpmAvg <= 0.0f) ? "STOPPED" : (a.synced ? "ON-GRID" : "RUNNING");

  String line = "";
  line += r.recordId; line += ",";
  line += String(r.localSeq); line += ",";
  line += r.timestamp; line += ",";
  line += String(DEVICE_ID); line += ",";
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
  line += syncText; line += ",";
  line += statusText; line += ",";
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

      // Hindari duplikasi jika loop save berjalan sebelum agregasi baru tersedia.
      if (storageBatch[i].localSeq <= lastSavedLocalSeq) continue;

      String line = buildCsvLine(storageBatch[i]);
      file.println(line);
      lastSavedLocalSeq = storageBatch[i].localSeq;
      dbLastLineBytes = line.length() + 2;
      dbTotalWrittenBytes += dbLastLineBytes;
    }

    file.close();
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
  Serial.print("[MQTT] Data Topic     : "); Serial.println(MQTT_DATA_TOPIC);
  Serial.print("[HTTP] Cloud ingest  : "); Serial.println(CLOUD_INGEST_URL);
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
  tft.setCursor(x + 8, y + 7);
  tft.print(label);
  tft.setTextColor(color, C_WHITE);
  tft.setTextSize(2);
  tft.setCursor(x + 8, y + 25);
  tft.print(value);
  tft.setTextSize(1);
  tft.print(" ");
  tft.print(unit);
}

void drawLinearBar(int x, int y, int w, int h, float value, float minV, float maxV, uint16_t color) {
  tft.fillRoundRect(x, y, w, h, 4, 0xE71C);
  tft.drawRoundRect(x, y, w, h, 4, C_BORDER);
  float p = (value - minV) / (maxV - minV);
  if (p < 0) p = 0;
  if (p > 1) p = 1;
  tft.fillRoundRect(x + 2, y + 2, (int)((w - 4) * p), h - 4, 4, color);
}

void drawGauge(int cx, int cy, int r, float value, float minV, float maxV, const char* label, const char* unit, uint16_t color) {
  tft.fillCircle(cx, cy, r + 3, C_WHITE);
  tft.drawCircle(cx, cy, r, C_BORDER);
  tft.drawCircle(cx, cy, r - 1, C_BORDER);

  // Semicircle ticks.
  for (int i = 0; i <= 10; i++) {
    float a = PI * (1.0f + i / 10.0f);
    int x1 = cx + cos(a) * (r - 7);
    int y1 = cy + sin(a) * (r - 7);
    int x2 = cx + cos(a) * (r - 2);
    int y2 = cy + sin(a) * (r - 2);
    tft.drawLine(x1, y1, x2, y2, C_MUTED);
  }

  float p = (value - minV) / (maxV - minV);
  if (p < 0) p = 0;
  if (p > 1) p = 1;
  float angle = PI * (1.0f + p);
  int nx = cx + cos(angle) * (r - 14);
  int ny = cy + sin(angle) * (r - 14);
  tft.drawLine(cx, cy, nx, ny, color);
  tft.fillCircle(cx, cy, 4, color);

  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextSize(1);
  tft.drawString(label, cx, cy + r - 25);
  tft.setTextColor(color, C_WHITE);
  tft.setTextSize(2);
  tft.drawString(String(value, 1), cx, cy + r - 10);
  tft.setTextSize(1);
  tft.drawString(unit, cx, cy + r + 7);
  tft.setTextDatum(TL_DATUM);
}

// ============================================================
// PAGE RENDER
// ============================================================
void drawNavBar() {
  tft.fillRect(0, 284, SW, 36, C_PRIMARY);
  tft.setTextDatum(MC_DATUM);
  tft.setTextSize(1);

  const char* labels[3] = {"GEN", "ENGINE", "FFT"};
  int centers[3] = {80, 240, 400};
  for (int i = 0; i < 3; i++) {
    uint16_t bg = (activePage == i) ? C_GREEN : C_PRIMARY2;
    tft.fillRoundRect(centers[i] - 55, 290, 110, 24, 8, bg);
    tft.setTextColor(C_WHITE, bg);
    tft.drawString(labels[i], centers[i], 302);
  }
  tft.setTextDatum(TL_DATUM);
}

void drawGeneratorPage(bool full) {
  AggregatedData d;
  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    d = aggData;
    xSemaphoreGive(dataMutex);
  }

  if (full) {
    tft.fillScreen(C_BG);
    drawHeader("GENERATOR SYNCHRONIZATION");
    drawPanel(8, 52, 220, 100, "GENERATOR");
    drawPanel(252, 52, 220, 100, "GRID");
    drawPanel(8, 162, 464, 102, "SYNC STATUS");
    drawNavBar();
  }

  uint16_t vColor = valColor(d.voltAvg, 240, 260, 180, 160);
  uint16_t vgColor = valColor(d.voltGridAvg, 240, 260, 180, 160);
  uint16_t fColor = valColor(d.freqAvg, 52, 55, 48, 45);
  uint16_t fgColor = valColor(d.freqGridAvg, 52, 55, 48, 45);

  drawGauge(70, 103, 38, d.voltAvg, 0, 300, "Volt Gen", "V", vColor);
  drawGauge(314, 103, 38, d.voltGridAvg, 0, 300, "Volt Grid", "V", vgColor);

  tft.setTextColor(C_DARK, C_PANEL);
  tft.setTextSize(1);
  tft.fillRect(120, 82, 90, 48, C_PANEL);
  tft.setCursor(126, 85); tft.print("Freq Gen");
  drawLinearBar(126, 104, 80, 10, d.freqAvg, 45, 55, fColor);
  tft.setCursor(126, 119); tft.print(String(d.freqAvg, 2)); tft.print(" Hz");

  tft.fillRect(364, 82, 90, 48, C_PANEL);
  tft.setCursor(370, 85); tft.print("Freq Grid");
  drawLinearBar(370, 104, 80, 10, d.freqGridAvg, 45, 55, fgColor);
  tft.setCursor(370, 119); tft.print(String(d.freqGridAvg, 2)); tft.print(" Hz");

  tft.fillRect(25, 190, 420, 54, C_PANEL);
  drawValueCard(28, 184, 120, 58, "PHASE", String(d.phaseAngleAvg, 1).c_str(), "deg", valColor(fabs(d.phaseAngleAvg), 20, 45));
  drawValueCard(170, 184, 120, 58, "SYNC", d.synced ? "ON" : "OFF", "", d.synced ? C_GREEN : C_RED);
  drawValueCard(312, 184, 120, 58, "SAMPLES", String(d.samples).c_str(), "", C_PRIMARY);

  drawNavBar();
}

void drawEnginePage(bool full) {
  AggregatedData d;
  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    d = aggData;
    xSemaphoreGive(dataMutex);
  }

  if (full) {
    tft.fillScreen(C_BG);
    drawHeader("ENGINE MONITORING");
    drawPanel(8, 52, 464, 98, "PRIMARY ENGINE PARAMETERS");
    drawPanel(8, 158, 464, 108, "SUPPORT PARAMETERS");
    drawNavBar();
  }

  drawGauge(75, 105, 36, d.rpmAvg, 0, 6000, "RPM", "rpm", valColor(d.rpmAvg, 4500, 5500));
  drawGauge(240, 105, 36, d.afrAvg, 10, 18, "AFR", "", valColor(d.afrAvg, 16, 18, 12, 10));
  drawGauge(405, 105, 36, d.tpsAvg, 0, 100, "TPS", "%", valColor(d.tpsAvg, 80, 95));

  int x = 34;
  int y = 178;
  int w = 170;
  int gap = 42;

  tft.fillRect(26, 174, 430, 82, C_PANEL);

  tft.setTextColor(C_DARK, C_PANEL);
  tft.setTextSize(1);
  tft.setCursor(x, y); tft.print("Coolant "); tft.print(String(d.cltAvg, 1)); tft.print(" C");
  drawLinearBar(x + 120, y + 2, w, 10, d.cltAvg, 40, 120, valColor(d.cltAvg, 95, 110));

  tft.setCursor(x, y + 20); tft.print("IAT     "); tft.print(String(d.iatAvg, 1)); tft.print(" C");
  drawLinearBar(x + 120, y + 22, w, 10, d.iatAvg, 0, 80, valColor(d.iatAvg, 60, 75));

  tft.setCursor(x, y + 40); tft.print("Batt    "); tft.print(String(d.battAvg, 2)); tft.print(" V");
  drawLinearBar(x + 120, y + 42, w, 10, d.battAvg, 10, 16, valColor(d.battAvg, 14.8, 16, 11.8, 10));

  tft.setCursor(x, y + 60); tft.print("Fuel    "); tft.print(String(d.fuelAvg, 1)); tft.print(" %");
  drawLinearBar(x + 120, y + 62, w, 10, d.fuelAvg, 0, 100, valColor(d.fuelAvg, 101, 102, 20, 10));

  drawNavBar();
}

void drawFFTPage(bool full) {
  AggregatedData d;
  FFTData f;

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    d = aggData;
    f = fftData;
    xSemaphoreGive(dataMutex);
  }

  if (full) {
    tft.fillScreen(C_BG);
    drawHeader("EDGE FFT ANALYSIS");
    drawPanel(8, 52, 464, 210, "FFT SPECTRUM");
    drawNavBar();
  }

  int px = 30, py = 78, pw = 420, ph = 130;
  tft.fillRect(px, py, pw, ph, C_WHITE);
  tft.drawRect(px, py, pw, ph, C_BORDER);

  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextSize(1);
  tft.setCursor(px, py + ph + 6);
  tft.print("Source: "); tft.print(getFFTSourceName());
  tft.print(" | X=Hz | Y=Magnitude | Peak: ");
  tft.print(String(f.peakHz, 2)); tft.print(" Hz");

  if (f.valid) {
    float maxMag = 0.001f;
    for (uint16_t i = 0; i < FFT_BINS_TO_SEND; i++) {
      if (f.magBins[i] > maxMag) maxMag = f.magBins[i];
    }
    for (uint16_t i = 1; i < FFT_BINS_TO_SEND; i++) {
      int x1 = px + (i - 1) * pw / (FFT_BINS_TO_SEND - 1);
      int y1 = py + ph - (int)(f.magBins[i - 1] / maxMag * (ph - 12));
      int x2 = px + i * pw / (FFT_BINS_TO_SEND - 1);
      int y2 = py + ph - (int)(f.magBins[i] / maxMag * (ph - 12));
      tft.drawLine(x1, y1, x2, y2, C_PRIMARY);
    }
  } else {
    tft.setTextColor(C_RED, C_WHITE);
    tft.setTextDatum(MC_DATUM);
    tft.drawString("WAITING 64 SAMPLES", px + pw / 2, py + ph / 2);
    tft.setTextDatum(TL_DATUM);
  }

  drawValueCard(30, 228, 126, 34, "PEAK X", String(f.peakHz, 2).c_str(), "Hz", C_PRIMARY);
  drawValueCard(178, 228, 126, 34, "PEAK Y", String(f.peakMagnitude, 4).c_str(), "", C_PRIMARY);
  drawValueCard(326, 228, 126, 34, "RMS", String(f.rms, 3).c_str(), getFFTSourceUnitById(fftSelectedSource), C_PRIMARY);

  drawNavBar();
}

void drawCurrentPage(bool full) {
  uint32_t drawStart = micros();
  if (activePage == PAGE_GENERATOR) drawGeneratorPage(full);
  else if (activePage == PAGE_ENGINE) drawEnginePage(full);
  else drawFFTPage(full);
  perfTftDrawUs = micros() - drawStart;
}

// ============================================================
// TOUCH
// ============================================================
TS_Point normalizeTouchPoint(TS_Point p) {
  // FT6206 default orientation untuk landscape 480x320 sering tertukar.
  // Mapping dibuat stabil untuk navigasi bawah.
  int x = map(p.y, 0, 320, 0, SW);
  int y = map(p.x, 0, 480, SH, 0);
  x = constrain(x, 0, SW - 1);
  y = constrain(y, 0, SH - 1);
  return TS_Point(x, y, p.z);
}

void handleTouchNavigation() {
  if (!touchDetected) return;
  if (!ts.touched()) return;

  TS_Point raw = ts.getPoint();
  TS_Point p = normalizeTouchPoint(raw);

  if (serialTouchDebug) {
    Serial.print("[TOUCH RAW] x="); Serial.print(raw.x);
    Serial.print(" y="); Serial.print(raw.y);
    Serial.print(" z="); Serial.println(raw.z);
    Serial.print("[TOUCH MAP] x="); Serial.print(p.x);
    Serial.print(" y="); Serial.println(p.y);
  }

  if (touchCalibrationMode) {
    Serial.print("[CAL] "); Serial.print(calPoints[calIndex].name);
    Serial.print(" screen=("); Serial.print(calPoints[calIndex].sx);
    Serial.print(","); Serial.print(calPoints[calIndex].sy);
    Serial.print(") raw=("); Serial.print(raw.x);
    Serial.print(","); Serial.print(raw.y);
    Serial.print(") map=("); Serial.print(p.x);
    Serial.print(","); Serial.print(p.y);
    Serial.println(")");
    calIndex++;
    if (calIndex >= sizeof(calPoints) / sizeof(calPoints[0])) {
      touchCalibrationMode = false;
      calIndex = 0;
      Serial.println("[CAL] selesai.");
    }
    delay(500);
    return;
  }

  if (p.y >= 284) {
    if (p.x < 160) activePage = PAGE_GENERATOR;
    else if (p.x < 320) activePage = PAGE_ENGINE;
    else activePage = PAGE_FFT;
    needFullRedraw = true;
    delay(250);
  }
}

// ============================================================
// SERIAL REPORTS + COMMANDS
// ============================================================
void printLatestDataReport() {
  AggregatedData d;
  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    d = aggData;
    xSemaphoreGive(dataMutex);
  }

  Serial.println();
  Serial.println(F("================ LATEST / DATA ================"));
  Serial.print(F("samples: ")); Serial.println(d.samples);
  Serial.print(F("rpm    : ")); Serial.println(d.rpmAvg, 1);
  Serial.print(F("tps    : ")); Serial.println(d.tpsAvg, 1);
  Serial.print(F("map    : ")); Serial.println(d.mapAvg, 1);
  Serial.print(F("iat    : ")); Serial.println(d.iatAvg, 1);
  Serial.print(F("clt    : ")); Serial.println(d.cltAvg, 1);
  Serial.print(F("afr    : ")); Serial.println(d.afrAvg, 2);
  Serial.print(F("batt   : ")); Serial.println(d.battAvg, 2);
  Serial.print(F("fuel   : ")); Serial.println(d.fuelAvg, 1);
  Serial.print(F("freq   : ")); Serial.println(d.freqAvg, 3);
  Serial.print(F("freqG  : ")); Serial.println(d.freqGridAvg, 3);
  Serial.print(F("volt   : ")); Serial.println(d.voltAvg, 2);
  Serial.print(F("voltG  : ")); Serial.println(d.voltGridAvg, 2);
  Serial.print(F("current: ")); Serial.println(d.currentAvg, 2);
  Serial.print(F("power  : ")); Serial.println(d.powerAvg, 3);
  Serial.print(F("phase  : ")); Serial.println(d.phaseAngleAvg, 2);
  Serial.print(F("synced : ")); Serial.println(d.synced ? F("YES") : F("NO"));
  Serial.println(F("=============================================="));
}

void printDatabaseReport();
void printPerformanceReport();
void printFFTReport();
void printSerialHelp() {
  Serial.println();
  Serial.println(F("GENSYS CMD: help | db | perf | fft | latest | page generator|engine|fft | redraw"));
  Serial.println(F("FFT CMD   : fft source voltgen | fft source voltgrid | fft source rpm"));
  Serial.println(F("DEBUG     : rx raw on/off | rx ok on/off | db reset | db reset confirm"));
  Serial.println(F("CLOUD     : cloud sync | cloud state"));
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
  Serial.println(F("LOCAL SD"));
  Serial.print  (F("  status          : ")); Serial.println(sdOK ? F("READY") : F("NOT READY"));
  Serial.print  (F("  file            : ")); Serial.println(DB_FILE);
  Serial.print  (F("  sync state      : ")); Serial.println(SYNC_STATE_FILE);
  Serial.print  (F("  card size       : ")); Serial.println(formatBytes(sdCachedCardSizeBytes));
  Serial.print  (F("  used/free       : ")); Serial.print(formatBytes(sdCachedUsedBytes)); Serial.print(F(" / ")); Serial.println(formatBytes(sdCachedFreeBytes));
  Serial.print  (F("  csv size        : ")); Serial.println(formatBytes(dbCachedFileSizeBytes));
  Serial.print  (F("  last row        : ")); Serial.print(dbLastLineBytes); Serial.println(F(" B/record"));
  Serial.print  (F("  write rate      : ")); Serial.println(formatBytes((uint64_t)sdBytesPerSec) + F("/s"));
  Serial.print  (F("  est. 7 days     : ")); Serial.println(formatBytes((uint64_t)sd7d));
  Serial.print  (F("  save OK/FAIL    : ")); Serial.print(sdSaveSuccessCount); Serial.print(F(" / ")); Serial.println(sdSaveFailCount);
  Serial.print  (F("  local seq       : ")); Serial.println(localSeqCounter);
  Serial.print  (F("  last saved seq  : ")); Serial.println(lastSavedLocalSeq);

  Serial.println(F("CLOUD REALTIME / MQTT"));
  Serial.print  (F("  mqtt status     : ")); Serial.println(mqtt.connected() ? F("CONNECTED") : F("DISCONNECTED"));
  Serial.print  (F("  realtime topic  : ")); Serial.println(MQTT_REALTIME_TOPIC);
  Serial.print  (F("  pub OK/FAIL     : ")); Serial.print(mqttPublishSuccessCount); Serial.print(F(" / ")); Serial.println(mqttPublishFailCount);

  Serial.println(F("CLOUD HISTORY / SD BACKUP SYNC"));
  Serial.print  (F("  ingest url      : ")); Serial.println(CLOUD_INGEST_URL);
  Serial.print  (F("  chunk size      : ")); Serial.println(CLOUD_CHUNK_SIZE);
  Serial.print  (F("  last sent seq   : ")); Serial.println(lastCloudSentSeq);
  Serial.print  (F("  sync OK/FAIL    : ")); Serial.print(cloudSyncSuccessCount); Serial.print(F(" / ")); Serial.println(cloudSyncFailCount);
  Serial.print  (F("  last http code  : ")); Serial.println(cloudLastHttpCode);
  Serial.print  (F("  last chunk rec  : ")); Serial.println(cloudLastRecordsSent);
  Serial.print  (F("  last payload    : ")); Serial.println(formatBytes(cloudLastPayloadBytes));
  Serial.print  (F("  param record    : ")); Serial.print((uint32_t)cloudRecordBytes); Serial.println(F(" B/record"));
  Serial.print  (F("  est. 10 years   : ")); Serial.println(formatBytes((uint64_t)cloud10y));

  Serial.println(F("NOTE: SD card adalah backup lokal. Data historis dikirim ulang ke MongoDB melalui /api/ingest/batch."));
  Serial.println(F("      Alert realtime tetap diproses dari MQTT gen/realtime, bukan dari data backup historis."));
  Serial.println(F("========================================================"));
}

void printPerformanceReport() {
  const float budgetUs = SENSOR_SAMPLE_INTERVAL_MS * 1000.0f;
  const float taskPct = budgetUs > 0 ? (perfSensorTaskUs * 100.0f / budgetUs) : 0.0f;
  Serial.println();
  Serial.println(F("================ GENSYS COMPUTE PERFORMANCE ================"));
  Serial.print(F("UART read      : ")); Serial.print(perfUartReadUs); Serial.println(F(" us"));
  Serial.print(F("CSV parse      : ")); Serial.print(perfCsvParseUs); Serial.println(F(" us"));
  Serial.print(F("Aggregation    : ")); Serial.print(perfAggregationUs); Serial.println(F(" us"));
  Serial.print(F("FFT 3-source   : ")); Serial.print(perfFftComputeUs); Serial.println(F(" us"));
  Serial.print(F("JSON build     : ")); Serial.print(perfJsonBuildUs); Serial.println(F(" us"));
  Serial.print(F("MQTT publish   : ")); Serial.print(perfMqttPublishUs); Serial.println(F(" us"));
  Serial.print(F("SD append      : ")); Serial.print(perfSdSaveUs); Serial.println(F(" us"));
  Serial.print(F("TFT draw       : ")); Serial.print(perfTftDrawUs); Serial.println(F(" us"));
  Serial.print(F("Sensor task    : ")); Serial.print(perfSensorTaskUs); Serial.print(F(" us = "));
  Serial.print(taskPct, 1); Serial.println(F(" % of 20ms budget"));
  Serial.print(F("Missed deadline: ")); Serial.println((uint32_t)sensorMissedDeadlines);
  Serial.print(F("RX OK/FAIL     : ")); Serial.print((uint32_t)parseOKCount); Serial.print(F(" / ")); Serial.println((uint32_t)parseFailCount);
  Serial.print(F("Last RX age    : ")); Serial.print((uint32_t)perfLastRxAgeMs); Serial.println(F(" ms"));
  Serial.println(F("============================================================"));
}

void printFFTReport() {
  FFTData f[FFT_SOURCE_COUNT];
  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    for (uint8_t i = 0; i < FFT_SOURCE_COUNT; i++) f[i] = fftMultiData[i];
    xSemaphoreGive(dataMutex);
  }

  Serial.println();
  Serial.println(F("================ FFT ALL SOURCES ================"));
  for (uint8_t source = 0; source < FFT_SOURCE_COUNT; source++) {
    Serial.print(F("SOURCE: ")); Serial.print(getFFTSourceNameById(source));
    Serial.print(F(" | unit=")); Serial.print(getFFTSourceUnitById(source));
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
    File f = SD.open(DB_FILE, FILE_WRITE);
    if (f) {
      f.println(F("recordId,localSeq,timestamp,deviceId,rpm,tps,map,iat,clt,afr,batt,fuel,freq,volt,currentA,powerKW,phaseAngle,sync,status,synced"));
      f.close();

      if (SD.exists(SYNC_STATE_FILE)) SD.remove(SYNC_STATE_FILE);
      if (SD.exists(FAILED_SYNC_LOG_FILE)) SD.remove(FAILED_SYNC_LOG_FILE);

      localSeqCounter = 0;
      lastSavedLocalSeq = 0;
      lastCloudSentSeq = 0;
      writeSyncState(0);

      dbTotalWrittenBytes = 0; dbLastLineBytes = 0; sdSaveSuccessCount = 0; sdSaveFailCount = 0;
      cloudSyncSuccessCount = 0; cloudSyncFailCount = 0; cloudLastRecordsSent = 0; cloudLastPayloadBytes = 0;
      Serial.println(F("[DB] database.csv + sync_state reset OK."));
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
  else if (cmd == "page generator") { activePage = PAGE_GENERATOR; needFullRedraw = true; Serial.println(F("[PAGE] generator")); }
  else if (cmd == "page engine") { activePage = PAGE_ENGINE; needFullRedraw = true; Serial.println(F("[PAGE] engine")); }
  else if (cmd == "page fft") { activePage = PAGE_FFT; needFullRedraw = true; Serial.println(F("[PAGE] fft")); }
  else if (cmd == "redraw") { needFullRedraw = true; Serial.println(F("[UI] redraw requested")); }
  else if (cmd == "fft source voltgen") { fftSelectedSource = FFT_SRC_VOLT_GEN; needFullRedraw = true; Serial.println(F("[FFT] source=VOLT_GEN")); }
  else if (cmd == "fft source voltgrid") { fftSelectedSource = FFT_SRC_VOLT_GRID; needFullRedraw = true; Serial.println(F("[FFT] source=VOLT_GRID")); }
  else if (cmd == "fft source rpm") { fftSelectedSource = FFT_SRC_RPM; needFullRedraw = true; Serial.println(F("[FFT] source=RPM")); }
  else if (cmd == "touch debug on") { serialTouchDebug = true; Serial.println(F("[TOUCH] debug on")); }
  else if (cmd == "touch debug off") { serialTouchDebug = false; Serial.println(F("[TOUCH] debug off")); }
  else if (cmd == "calibrate") { touchCalibrationMode = true; calIndex = 0; Serial.println(F("[CAL] Sentuh titik navigasi sesuai instruksi serial.")); }
  else if (cmd == "rx raw on") { runtimeDebugRxRaw = true; Serial.println(F("[RX] raw on")); }
  else if (cmd == "rx raw off") { runtimeDebugRxRaw = false; Serial.println(F("[RX] raw off")); }
  else if (cmd == "rx ok on") { runtimeDebugRxOK = true; Serial.println(F("[RX] ok on")); }
  else if (cmd == "rx ok off") { runtimeDebugRxOK = false; Serial.println(F("[RX] ok off")); }
  else if (cmd == "db ticker on") { dbSizeTickerEnabled = true; Serial.println(F("[DB] ticker on")); }
  else if (cmd == "db ticker off") { dbSizeTickerEnabled = false; Serial.println(F("[DB] ticker off")); }
  else if (cmd == "cloud sync") { syncPendingDataFromSDOnce(true); }
  else if (cmd == "cloud state") {
    Serial.println(F("========== CLOUD SYNC STATE =========="));
    Serial.print(F("lastCloudSentSeq: ")); Serial.println(lastCloudSentSeq);
    Serial.print(F("localSeqCounter : ")); Serial.println(localSeqCounter);
    Serial.print(F("lastSavedSeq    : ")); Serial.println(lastSavedLocalSeq);
    Serial.print(F("success/fail    : ")); Serial.print(cloudSyncSuccessCount); Serial.print(F("/")); Serial.println(cloudSyncFailCount);
    Serial.print(F("last http code  : ")); Serial.println(cloudLastHttpCode);
    Serial.print(F("last records    : ")); Serial.println(cloudLastRecordsSent);
    Serial.print(F("last payload B  : ")); Serial.println(cloudLastPayloadBytes);
    Serial.println(F("======================================"));
  }
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
  mqtt.setBufferSize(8192);

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
    handleCloudBackupSync();
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

  handleTouchNavigation();

  if (millis() - lastDraw >= drawInterval) {
    lastDraw = millis();
    drawCurrentPage(needFullRedraw);
    needFullRedraw = false;
  }

  delay(5);
}
