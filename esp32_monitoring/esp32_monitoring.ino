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
// Init SD dilakukan SEBELUM TFT init untuk menghindari konflik SPI
//
// Serial command:
// help, database, performance, sensor, network, touch, calibrate,
// page generator, page engine, page fft
// test once, test once reset, test once last
// ============================================================

#include <Arduino.h>
#include <HardwareSerial.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include "esp_wifi.h"

#ifndef ESP_ARDUINO_VERSION_MAJOR
#define ESP_ARDUINO_VERSION_MAJOR 2
#endif

#if ESP_ARDUINO_VERSION_MAJOR < 3
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
// EDUROAM WPA2-ENTERPRISE + WIFI MANAGER FALLBACK
// ============================================================
// Mode utama:
// 1) ESP32 mencoba konek ke eduroam dengan WPA2-Enterprise PEAP.
// 2) Jika eduroam gagal/timeout, mode enterprise dimatikan dengan bersih.
// 3) Setelah itu ESP32 membuka AP portal WiFiManager sebagai fallback.
// 4) WiFiManager memakai startConfigPortal(), bukan autoConnect(), agar
//    tidak otomatis mencoba credential lama yang mungkin salah.

#ifndef WIFI_MANAGER_AP_NAME
#define WIFI_MANAGER_AP_NAME "GenTrack-Monitor-AP"
#endif

#ifndef WIFI_MANAGER_AP_PASS
#define WIFI_MANAGER_AP_PASS "12345678"
#endif

#ifndef WIFI_MANAGER_TIMEOUT_SEC
#define WIFI_MANAGER_TIMEOUT_SEC 180
#endif

#ifndef WIFI_MANAGER_SETTLE_MS
#define WIFI_MANAGER_SETTLE_MS 3000UL
#endif

// Set 1 hanya jika ingin reset/portal WiFiManager dipaksa muncul.
// Pada mode eduroam-first, nilai ini hanya berpengaruh saat fallback portal.
#ifndef FORCE_WIFI_PORTAL
#define FORCE_WIFI_PORTAL 0
#endif

// Default aktif: coba eduroam WPA2-Enterprise terlebih dahulu.
#ifndef USE_EDUROAM_FIRST
#define USE_EDUROAM_FIRST 1
#endif

// Konfigurasi eduroam WPA2-Enterprise PEAP.
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

// ============================================================
// MQTT + WIFI STABILITY CONFIG
// ============================================================
// Tujuan:
// - Mencegah MQTT disconnected saat runtime.
// - Mengirim MongoDB sebagai 1 payload batch setiap 2 menit.
// - Menjaga koneksi WiFi lebih stabil.
// - Mengurangi risiko heap fragmentation akibat String JSON.

#define MQTT_BUFFER_SIZE_BYTES       2048
#define MQTT_KEEPALIVE_SEC           60
#define MQTT_SOCKET_TIMEOUT_SEC      15

#define MQTT_RECONNECT_MIN_MS        3000UL
#define MQTT_RECONNECT_MAX_MS        30000UL

#define WIFI_RUNTIME_CHECK_MS        3000UL
#define WIFI_RECONNECT_MIN_MS        10000UL
#define WIFI_RECONNECT_MAX_MS        60000UL
#define WIFI_CONNECT_POLL_MS         500UL
#define WIFI_EDUROAM_MAX_ATTEMPTS    1

// Jika RSSI lebih lemah dari nilai ini, batch MongoDB ditunda.
// Realtime tetap bisa jalan, tetapi history tidak dipaksa upload.
#define WIFI_RSSI_WEAK_DBM           -75

// MongoDB dikirim sebagai 1 payload batch besar via MQTT beginPublish/write/endPublish.
// Nilai ini tetap dipakai sebagai batas payload realtime biasa.
// Batch besar tidak memakai mqtt.publish() agar tidak perlu buffer internal PubSubClient besar.
#define MONGO_BATCH_STREAM_CHUNK_BYTES 512
#define MONGO_BATCH_MAX_PAYLOAD_BYTES  80000UL

// Proteksi heap.
#define HEAP_MIN_FREE_BYTES          25000UL
#define HEAP_MIN_MAX_ALLOC_BYTES     8000UL


// Cloud/MongoDB path:
// Tidak memakai HTTP POST /api/ingest/batch.
// Record parameter-only dikumpulkan di RAM dan dikirim sebagai 1 payload batch
// melalui MQTT_TOPIC = gen/data setiap 10 menit.
// Backend harus subscribe topic gen/data dan melakukan insertMany(payload.records) ke MongoDB.

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
// Buffer hardware/software dibuat lebih besar agar frame tidak hilang saat
// WiFi/TFT/SD sedang sibuk atau saat fallback WiFiManager berjalan.
#define LINK_EXPECTED_FRAME_INTERVAL_MS 100UL
#define LINK_EXPECTED_FRAME_HZ          10
#define LINK_SERIAL_RX_BUFFER_BYTES     4096
#define LINK_LINE_BUFFER_MAX_CHARS      512
#define LINK_RX_TASK_STACK_WORDS        6144
#define LINK_RX_TASK_PRIORITY           3
#define LINK_RX_TASK_DELAY_MS           2

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
#define SD_MISO 12
#define SD_MOSI 13
#define SD_SCK  14
#define SD_CS   26

#define SD_SPI_FREQ_INIT 400000UL
#define SD_SPI_FREQ_FAST 1000000UL

SPIClass sdSPI(HSPI);
SemaphoreHandle_t sdMutex = NULL;
SemaphoreHandle_t dataMutex = NULL;

const char* DB_FILE = "/database.csv";
const char* DB_BACKUP_FILE = "/database_old.csv";
const char* FFT_FILE = "/fft.csv";
const char* FFT_BACKUP_FILE = "/fft_old.csv";

// Header CSV lokal. database.csv hanya berisi parameter agregasi utama.
// Data FFT dipisahkan ke /fft.csv agar database utama tetap ringan untuk arsip lokal dan upload batch.
const char* DB_CSV_HEADER =
  "recordId,localSeq,timestamp,rpm,tps,map,iat,clt,afr,batt,fuel,"
  "freq,volt,currentA,powerKW,phase_diff,synced";

// Header CSV FFT lokal. Format fft_bins_xy: freqHz:magnitude|freqHz:magnitude|...
const char* FFT_CSV_HEADER =
  "recordId,localSeq,timestamp,fft_valid,fft_source,fft_sample_rate_hz,"
  "fft_resolution_hz,fft_peak_hz,fft_peak_magnitude,fft_rms,fft_bins_xy";

// ============================================================
// TIMING
// ============================================================
#define SENSOR_SAMPLE_HZ          50
#define SENSOR_SAMPLE_INTERVAL_MS 20
#define AGGREGATION_INTERVAL_MS   1000
#define STORAGE_BATCH_SIZE        1
// ============================================================
// MONGODB BATCH CONFIG
// ============================================================
// Realtime dashboard tetap 1 detik.
// MongoDB/history dikirim batch setiap 2 menit.

#define MONGODB_BATCH_INTERVAL_MS 120000UL   // 2 menit, lebih aman untuk heap ESP32 + eduroam
#define MONGODB_BATCH_RECORDS     120        // 1 record/detik x 120 detik
#define MONGODB_BUFFER_RECORDS    MONGODB_BATCH_RECORDS
// MQTT broker/cloud sering menolak payload besar. Agar data benar-benar masuk
// ke server.js + MongoDB, 120 record per 2 menit dikirim sebagai 12 publish
// kecil berisi 10 record. Total data tetap 120 record per siklus batch.
#define MONGODB_UPLOAD_CHUNK_RECORDS 10
#define MONGODB_UPLOAD_CHUNK_DELAY_MS 250UL

// SAFE MODE NOTE:
// Dipilih 2 menit/120 record karena lebih aman untuk WPA2-Enterprise eduroam.
// Buffer 5 menit/300 record masih memungkinkan, tetapi heap ESP32 lebih berat
// saat EAP handshake dan MQTT batch publish.

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
  uint8_t source = FFT_SRC_VOLT_GEN;
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
// ACQUISITION + COMPUTE PERFORMANCE MONITOR
// ============================================================
// Target spesifikasi:
// - Akuisisi parameter real-time: 0.1 s sampai 1.0 s
// - Task sampling internal ESP32-2: 20 ms
// - Record monitoring lokal/SD: 1 s
// - Target database online versi aman: 2 menit
#define SPEC_ACQ_MIN_INTERVAL_MS       100UL
#define SPEC_ACQ_MAX_INTERVAL_MS       1000UL
#define SPEC_DATABASE_TARGET_MS        120000UL
#define PERF_U32_MAX_VALUE             0xFFFFFFFFUL

struct PerfMinMax {
  uint32_t count = 0;
  uint32_t minVal = PERF_U32_MAX_VALUE;
  uint32_t maxVal = 0;
  uint64_t sumVal = 0;
};

struct AcquisitionMonitorStats {
  uint32_t startMs = 0;

  PerfMinMax sensorIntervalMs;
  PerfMinMax uartFrameIntervalMs;
  PerfMinMax uartReadUs;
  PerfMinMax csvParseUs;
  PerfMinMax aggregationUs;
  PerfMinMax sensorTaskUs;
  PerfMinMax fftComputeUs;
  PerfMinMax mqttPublishUs;
  PerfMinMax sdSaveUs;
  PerfMinMax tftDrawUs;

  bool hasSensorTick = false;
  uint32_t lastSensorTickMs = 0;
  bool hasUartFrameTick = false;
  uint32_t lastUartFrameTickMs = 0;

  bool hasLastSeq = false;
  uint32_t lastSeq = 0;

  uint32_t frameReceived = 0;
  uint32_t frameValid = 0;
  uint32_t frameParseFailed = 0;
  uint32_t rxNoiseBytes = 0;
  uint32_t rxOverflowReset = 0;
  uint32_t rxResyncCount = 0;
  uint32_t lostFrame = 0;
  uint32_t duplicateFrame = 0;
  uint32_t newSeqSamples = 0;
  uint32_t noDataCycles = 0;

  uint64_t rxBytes = 0;
  uint32_t lastRawFrameBytes = 0;
  uint32_t maxRawFrameBytes = 0;
};

AcquisitionMonitorStats acqMon;

void perfResetStat(PerfMinMax &s) {
  s.count = 0;
  s.minVal = PERF_U32_MAX_VALUE;
  s.maxVal = 0;
  s.sumVal = 0;
}

void perfUpdateStat(PerfMinMax &s, uint32_t value) {
  if (value < s.minVal) s.minVal = value;
  if (value > s.maxVal) s.maxVal = value;
  s.sumVal += value;
  s.count++;
}

float perfAvgStat(const PerfMinMax &s) {
  if (s.count == 0) return 0.0f;
  return (float)s.sumVal / (float)s.count;
}

uint32_t perfMinStat(const PerfMinMax &s) {
  return s.count == 0 ? 0 : s.minVal;
}

const char* passFailText(bool ok) {
  return ok ? "PASS" : "FAIL";
}

void resetAcquisitionMonitorStats() {
  acqMon = AcquisitionMonitorStats();
  acqMon.startMs = millis();
}

void recordSensorIntervalTick() {
  uint32_t nowMs = millis();
  if (acqMon.hasSensorTick) {
    perfUpdateStat(acqMon.sensorIntervalMs, nowMs - acqMon.lastSensorTickMs);
  }
  acqMon.lastSensorTickMs = nowMs;
  acqMon.hasSensorTick = true;
}

void recordUartFrameMonitor(const String &line, bool ok, const RawData &parsed) {
  uint32_t nowMs = millis();

  acqMon.frameReceived++;
  acqMon.lastRawFrameBytes = line.length() + 1; // + newline
  acqMon.rxBytes += acqMon.lastRawFrameBytes;
  if (acqMon.lastRawFrameBytes > acqMon.maxRawFrameBytes) {
    acqMon.maxRawFrameBytes = acqMon.lastRawFrameBytes;
  }

  if (acqMon.hasUartFrameTick) {
    perfUpdateStat(acqMon.uartFrameIntervalMs, nowMs - acqMon.lastUartFrameTickMs);
  }
  acqMon.lastUartFrameTickMs = nowMs;
  acqMon.hasUartFrameTick = true;

  if (ok) {
    acqMon.frameValid++;

    if (acqMon.hasLastSeq) {
      if (parsed.seq == acqMon.lastSeq) {
        acqMon.duplicateFrame++;
      } else if (parsed.seq > acqMon.lastSeq + 1) {
        acqMon.lostFrame += parsed.seq - acqMon.lastSeq - 1;
      }
    }

    acqMon.lastSeq = parsed.seq;
    acqMon.hasLastSeq = true;
  } else {
    acqMon.frameParseFailed++;
  }
}


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
SemaphoreHandle_t mongoUploadRequestSemaphore = NULL;
SemaphoreHandle_t mongoBufferMutex = NULL;
SemaphoreHandle_t mqttMutex = NULL;

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
unsigned long lastMongoBatchSend = 0;
unsigned long lastReconnect = 0;
unsigned long lastWifiCheck = 0;

// ============================================================
// NETWORK RUNTIME STABILITY STATE
// ============================================================
unsigned long mqttReconnectBackoffMs = MQTT_RECONNECT_MIN_MS;
unsigned long wifiReconnectBackoffMs = WIFI_RECONNECT_MIN_MS;
unsigned long lastRuntimeWifiReconnect = 0;

uint32_t mqttReconnectAttemptCount = 0;
uint32_t wifiReconnectAttemptCount = 0;
uint32_t mqttDisconnectRuntimeCount = 0;

uint32_t minFreeHeapBytes = 0xFFFFFFFFUL;
uint32_t minMaxAllocHeapBytes = 0xFFFFFFFFUL;

unsigned long lastLinkFrameMs = 0;
unsigned long lastSDRetry = 0;
unsigned long lastDBStorageReport = 0;

uint32_t storageBatchSeq = 0;
uint8_t storageBatchCount = 0;
uint32_t localRecordSeq = 0;

unsigned long sdSaveSuccessCount = 0;
unsigned long sdSaveFailCount = 0;
uint8_t sdConsecutiveOpenFail = 0;
unsigned long sdDatabaseCreateFailCount = 0;
unsigned long sdDatabaseCreateOkCount = 0;
unsigned long sdLastFileErrorMs = 0;
unsigned long sdLastFileOkMs = 0;
unsigned long sdLastRecoverAttemptMs = 0;
unsigned long sdRecoverSuccessCount = 0;
unsigned long sdRecoverFailCount = 0;
unsigned long mongoUploadSuccessRecords = 0;
unsigned long mongoUploadFailCount = 0;
volatile bool mongoUploadBusy = false;
volatile unsigned long mongoUploadQueuedCount = 0;
int mongoUploadLastHttpCode = 0;
uint16_t mongoUploadLastAckedRecords = 0;
unsigned long mongoUploadLastAttemptMs = 0;
uint64_t dbTotalWrittenBytes = 0;
uint32_t dbLastLineBytes = 0;
uint64_t dbCachedFileSizeBytes = 0;
uint64_t sdCachedCardSizeBytes = 0;
uint64_t sdCachedUsedBytes = 0;
uint64_t sdCachedFreeBytes = 0;
unsigned long dbCachedAtMs = 0;

// Statistik pengiriman buffer RAM MongoDB 2 menit.
// Tidak ada sinkronisasi SD -> MongoDB; MongoDB hanya memakai buffer RAM baru.
uint32_t mongoUploadLastBatchRecords = 0;
uint32_t mongoUploadLastPayloadBytes = 0;
uint16_t mongoUploadLastRunChunks = 0;
uint32_t mongoUploadLastRunRecords = 0;
uint16_t mongoUploadLastAckResponseRecords = 0;
bool mongoUploadLastMqttOk = false;

String mongoDbBuffer[MONGODB_BUFFER_RECORDS];
uint16_t mongoDbBufferCount = 0;
uint32_t mongoDbBufferedTotal = 0;
uint32_t mongoDbBufferOverflowCount = 0;
uint32_t mongoDbLastSentRecords = 0;
uint32_t mongoDbTotalSentRecords = 0;
uint32_t mongoDbLastPayloadBytes = 0;
uint16_t mongoDbLastAckResponseRecords = 0;
unsigned long mongoDbLastSendMs = 0;

// Statistik SD sebagai backup saja. SD tidak ditulis saat WiFi+MQTT normal dan buffer MongoDB sehat.
uint32_t sdBackupRecordCount = 0;
uint32_t sdBackupSkipOnlineCount = 0;
uint32_t sdBackupBecauseNetworkCount = 0;
uint32_t sdBackupBecauseBufferFullCount = 0;
uint32_t sdBackupBecauseMongoFailCount = 0;


// ── DB size ticker (setiap detik) ──────────────────────────────
bool     dbSizeTickerEnabled  = false;
unsigned long lastDbSizeTickMs = 0;

// ── Test-once mode untuk pengujian end-to-end ─────────────────
// Alur sekali uji:
// 1) Terima 1 frame UART valid dari ESP32-1.
// 2) Bekukan RX agar data berikutnya tidak ikut masuk.
// 3) Agregasi 1 record monitoring.
// 4) Simpan 1 record ke SD/local database.
// 5) Publish 1 payload ke MQTT/cloud database.
// 6) Render 1 kali ke TFT, lalu monitoring berhenti pada data tersebut.
bool     testOnceMode          = false;
bool     testOnceDone          = false;
bool     testOnceRxDone        = false;
bool     testOnceAggDone       = false;
bool     testOnceSdDone        = false;
bool     testOnceMqttDone      = false;
bool     testOnceDisplayDone   = false;
uint32_t testOnceSeq           = 0;
uint32_t testOnceLocalSeq      = 0;
unsigned long testOnceTriggeredMs = 0;

// ── Cache RX terakhir untuk mode test-once ───────────────────
// Tujuan:
// - Setelah 1 frame valid diterima, data dibekukan.
// - Serial Monitor dapat menampilkan ulang raw RX + parameter terakhir.
// - seq dan timestampMs tidak berubah sampai command "test once reset".
bool     hasLastRxReport       = false;
String   lastRxRawLineCache    = "";
RawData  lastRxDataCache;
bool     lastRxParseOkCache    = false;
uint32_t lastRxCachedAtMs      = 0;

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

// ── MQTT payload/json monitor ────────────────────────────────
bool serialMqttPayloadEnabled = false;

bool hasLastMqttPayloadCache = false;
String lastMqttPayloadCache = "";
String lastMqttParameterOnlyPayloadCache = "";
String lastMqttRealtimeTopicCache = "";
String lastMqttHistoryTopicCache = "";

bool lastMqttRealtimeOkCache = false;
bool lastMqttHistoryOkCache = false;
uint32_t lastMqttPayloadCacheAtMs = 0;
uint32_t lastMqttPayloadRecordsCache = 0;

// ── SD database/cloud queue payload monitor ─────────────────
// Cache ini dipakai agar command Serial tidak perlu membuka/membaca file SD besar.
bool hasLastDatabasePayloadCache = false;
String lastSdCsvLineCache = "";
String lastSdQueueJsonCache = "";
uint32_t lastDatabasePayloadCacheAtMs = 0;
uint32_t lastDatabaseLocalSeqCache = 0;
uint32_t lastDatabaseCsvBytesCache = 0;
uint32_t lastDatabaseJsonBytesCache = 0;

// Monitor Serial opsional. Default OFF agar tidak membanjiri Serial Monitor.
bool serialDatabasePayloadEnabled = false;     // print payload database saat SD save
bool serialRealtimePayloadEnabled = false;     // print payload monitoring saat MQTT publish
bool serialMongoBufferTickerEnabled = false;    // print ringkas status buffer MongoDB
bool serialMonitorOverviewEnabled = false;     // print ringkas RAW+AGG+MQTT+BUFFER

WiFiClient espClient;
PubSubClient mqtt(espClient);

String serialCmd = "";
char tmp[24];

// Forward declaration untuk fungsi yang dipakai sebelum definisi aslinya.
void printMongoBufferStatus();
void sendMongoDbBufferToMongoDB();
void MongoBufferTask(void *pvParameters);

void updateHeapMonitor();
bool isWiFiUsableForMongoUpload();
void applyWiFiStabilityConfig();
void applyMqttStabilityConfig();
void reconnectMQTT();
void checkWiFiStatus();
bool publishMongoBufferBatchToMqtt(const String &batchPayload);


// ============================================================
// PAPER VALIDATION SERIAL REPORT
// ============================================================
// Dipakai untuk mengambil angka pengujian yang langsung cocok dengan tabel paper:
// Functional Test, Communication Performance, Data Management Evaluation,
// dan Local/Remote Interface Evaluation.
bool paperValidationActive = false;
uint32_t paperValidationStartMs = 0;
uint32_t paperStartFrameReceived = 0;
uint32_t paperStartFrameValid = 0;
uint32_t paperStartFrameParseFailed = 0;
uint32_t paperStartLostFrame = 0;
uint32_t paperStartDuplicateFrame = 0;
uint32_t paperStartSdOk = 0;
uint32_t paperStartSdFail = 0;
uint32_t paperStartMqttOk = 0;
uint32_t paperStartMqttFail = 0;
uint32_t paperStartMongoSent = 0;
uint32_t paperStartMongoFail = 0;
bool paperTickerEnabled = false;
unsigned long paperTickerIntervalMs = 60000UL;
unsigned long lastPaperTickerMs = 0;

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

void printRxParameterReport(const String &rawLine, const RawData &d, bool parseOk) {
  Serial.println();
  Serial.println(F("║----------------UART RX PARAMETER MONITOR--------------------║"));
  Serial.println();
  Serial.print(F("║ RAW UART      : "));
  Serial.println(rawLine);

  Serial.println(F("╟────────────────────────────────────────────────────────────╢"));
  Serial.print(F("║ Parse Status  : "));
  Serial.println(parseOk ? F("OK") : F("FAILED"));

  if (!parseOk) {
    Serial.println(F("╚════════════════════════════════════════════════════════════╝"));
    return;
  }

  Serial.println(F("╟─────────────────── FRAME METADATA ────────────────────────╢"));
  Serial.printf("║ %-14s: %lu\n", "seq", (unsigned long)d.seq);
  Serial.printf("║ %-14s: %lu ms\n", "timestampMs", (unsigned long)d.timestampMs);

  Serial.println(F("╟─────────────────── ENGINE PARAMETER ──────────────────────╢"));
  Serial.printf("║ %-14s: %d rpm\n", "rpm", d.rpm);
  Serial.printf("║ %-14s: %d %%\n", "tps", d.tps);
  Serial.printf("║ %-14s: %d kPa\n", "map", d.map);
  Serial.printf("║ %-14s: %d C\n", "iat", d.iat);
  Serial.printf("║ %-14s: %d C\n", "clt", d.clt);
  Serial.printf("║ %-14s: %.2f\n", "afr", d.afr);
  Serial.printf("║ %-14s: %.2f V\n", "batt", d.batt);
  Serial.printf("║ %-14s: %.1f %%\n", "fuel", d.fuel);

  Serial.println(F("╟──────────────── ELECTRICAL PARAMETER ─────────────────────╢"));
  Serial.printf("║ %-14s: %.3f Hz\n", "freq", d.freq);
  Serial.printf("║ %-14s: %.3f Hz\n", "freqGrid", d.freqGrid);
  Serial.printf("║ %-14s: %.2f V\n", "volt", d.volt);
  Serial.printf("║ %-14s: %.2f V\n", "voltGrid", d.voltGrid);
  Serial.printf("║ %-14s: %.2f A\n", "currentA", d.currentA);
  Serial.printf("║ %-14s: %.3f kW\n", "powerKW", d.powerKW);
  Serial.printf("║ %-14s: %.2f deg\n", "phaseAngle", d.phaseAngle);

  Serial.println(F("╟──────────────────── STATUS PARAMETER ─────────────────────╢"));
  Serial.printf("║ %-14s: %d\n", "engineSync", d.speeduinoSync ? 1 : 0);
  Serial.printf("║ %-14s: %d\n", "gridSync", d.gridSync ? 1 : 0);
  Serial.printf("║ %-14s: %d\n", "valid", d.valid ? 1 : 0);
  Serial.printf("║ %-14s: %s\n", "syncText", d.syncText);
  Serial.printf("║ %-14s: %s\n", "statusText", d.statusText);

  Serial.println(F("╚════════════════════════════════════════════════════════════╝"));
}

void printAggregatedParameterReport(const AggregatedData &a) {
  Serial.println();
  Serial.println(F("║----------------AGGREGATED PARAMETER MONITOR----------------║"));
  Serial.println();
  Serial.println(F("║ RAW UART      : hasil rata-rata agregasi 1 detik"));

  Serial.println(F("╟────────────────────────────────────────────────────────────╢"));
  Serial.print(F("║ Parse Status  : "));
  Serial.println(a.valid ? F("OK") : F("NO VALID AGGREGATE"));

  if (!a.valid) {
    Serial.println(F("╚════════════════════════════════════════════════════════════╝"));
    return;
  }

  Serial.println(F("╟─────────────────── FRAME METADATA ────────────────────────╢"));
  Serial.printf("║ %-14s: %u sample\n", "samples", a.samples);
  Serial.printf("║ %-14s: %lu ms\n", "interval", (unsigned long)lastFastAggIntervalMs);

  Serial.println(F("╟─────────────────── ENGINE PARAMETER ──────────────────────╢"));
  Serial.printf("║ %-14s: %.1f rpm\n", "rpmAvg", a.rpmAvg);
  Serial.printf("║ %-14s: %.1f %%\n", "tpsAvg", a.tpsAvg);
  Serial.printf("║ %-14s: %.1f kPa\n", "mapAvg", a.mapAvg);
  Serial.printf("║ %-14s: %.1f C\n", "iatAvg", a.iatAvg);
  Serial.printf("║ %-14s: %.1f C\n", "cltAvg", a.cltAvg);
  Serial.printf("║ %-14s: %.2f\n", "afrAvg", a.afrAvg);
  Serial.printf("║ %-14s: %.2f V\n", "battAvg", a.battAvg);
  Serial.printf("║ %-14s: %.1f %%\n", "fuelAvg", a.fuelAvg);

  Serial.println(F("╟──────────────── ELECTRICAL PARAMETER ─────────────────────╢"));
  Serial.printf("║ %-14s: %.3f Hz\n", "freqAvg", a.freqAvg);
  Serial.printf("║ %-14s: %.3f Hz\n", "freqGridAvg", a.freqGridAvg);
  Serial.printf("║ %-14s: %.2f V\n", "voltAvg", a.voltAvg);
  Serial.printf("║ %-14s: %.2f V\n", "voltGridAvg", a.voltGridAvg);
  Serial.printf("║ %-14s: %.2f A\n", "currentAvg", a.currentAvg);
  Serial.printf("║ %-14s: %.3f kW\n", "powerAvg", a.powerAvg);
  Serial.printf("║ %-14s: %.2f deg\n", "phaseAvg", a.phaseAngleAvg);

  Serial.println(F("╟──────────────────── STATUS PARAMETER ─────────────────────╢"));
  Serial.printf("║ %-14s: %d\n", "synced", a.synced ? 1 : 0);
  Serial.printf("║ %-14s: %d\n", "valid", a.valid ? 1 : 0);

  Serial.println(F("╚════════════════════════════════════════════════════════════╝"));
}

void cacheLastRxReport(const String &rawLine, const RawData &d, bool parseOk) {
  lastRxRawLineCache = rawLine;
  lastRxDataCache = d;
  lastRxParseOkCache = parseOk;
  lastRxCachedAtMs = millis();
  hasLastRxReport = true;
}

void printLastRxReportFromCache() {
  if (!hasLastRxReport) {
    Serial.println();
    Serial.println(F("╔════════════ LAST UART RX CACHE ════════════╗"));
    Serial.println(F("║ Belum ada frame RX valid yang tersimpan.   ║"));
    Serial.println(F("║ Gunakan: test once                         ║"));
    Serial.println(F("║ atau:    test once reset                   ║"));
    Serial.println(F("╚════════════════════════════════════════════╝"));
    return;
  }

  Serial.println();
  Serial.println(F("╔════════════ LAST UART RX FRAME ════════════╗"));
  Serial.println(F("║ Menampilkan data RX terakhir dari cache.   ║"));
  Serial.println(F("║ Data ini dibekukan pada mode test-once.    ║"));
  Serial.println(F("║ seq dan timestampMs tidak berubah sampai   ║"));
  Serial.println(F("║ command: test once reset.                  ║"));
  Serial.printf("[CACHE] cachedAge=%lu ms\n", (unsigned long)(millis() - lastRxCachedAtMs));
  Serial.println(F("╚════════════════════════════════════════════╝"));

  printRxParameterReport(lastRxRawLineCache, lastRxDataCache, lastRxParseOkCache);
}

void handleCompleteRxLine(String line) {
  line.trim();
  if (line.length() == 0) return;

  // Dalam mode test-once, hanya frame UART valid pertama yang diproses.
  // Frame berikutnya diabaikan agar data pengujian tidak berubah.
  // latestRaw, seq, timestampMs, agregasi, SD, MQTT, dan TFT tetap menggunakan
  // data terakhir yang sudah tersimpan di cache sampai "test once reset".
  if (testOnceMode && testOnceRxDone) {
    if (runtimeDebugRxOK || runtimeDebugRxRaw) {
      printLastRxReportFromCache();
    }
    return;
  }

  RawData parsed;
  uint32_t parseStart = micros();
  bool ok = parseBridgeCsv(line, parsed);
  perfCsvParseUs = micros() - parseStart;
  perfUpdateStat(acqMon.csvParseUs, perfCsvParseUs);
  recordUartFrameMonitor(line, ok, parsed);

  if (ok) {
    cacheLastRxReport(line, parsed, true);

    if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(5)) == pdTRUE) {
      latestRaw = parsed;
      xSemaphoreGive(dataMutex);
    }

    lastUartReceiveMs = millis();
    lastLinkFrameMs = millis();
    linkOK = true;
    parseOKCount++;

    if (testOnceMode && !testOnceRxDone) {
      testOnceRxDone = true;
      testOnceSeq = parsed.seq;
      Serial.println();
      Serial.println(F("╔════════════ TEST-ONCE RX UART ════════════╗"));
      Serial.printf("[TEST] Frame UART valid diterima. seq=%lu\n", (unsigned long)testOnceSeq);
      Serial.println(F("[TEST] RX dibekukan. Menunggu agregasi 1 record, SD, MQTT, dan TFT."));
      Serial.println(F("╚════════════════════════════════════════════╝"));
      printRxParameterReport(line, parsed, true);
    } else if (runtimeDebugRxOK) {
      printRxParameterReport(line, parsed, true);
    } else if (runtimeDebugRxRaw) {
      Serial.print(F("[RX RAW] "));
      Serial.println(line);
    }
  } else {
    parseFailCount++;

    if (runtimeDebugRxOK) {
      printRxParameterReport(line, parsed, false);
    } else {
      Serial.print(F("[RX CSV FAIL] "));
      Serial.println(line);
    }
  }
}

void handleLinkSerialChar(char c) {
  // Terima '\n', '\r', atau '\r\n' sebagai terminator agar kompatibel
  // dengan Serial.print(), Serial.println(), dan pengirim UART custom.
  if (c == '\n' || c == '\r') {
    if (linkRxBuffer.length() > 0) {
      handleCompleteRxLine(linkRxBuffer);
      linkRxBuffer = "";
    }
    return;
  }

  // '$' adalah start-of-frame. Jika ada buffer parsial, berarti frame lama
  // terpotong; resync ke frame baru tanpa menunggu overflow.
  if (c == '$') {
    if (linkRxBuffer.length() > 0) {
      acqMon.rxResyncCount++;
    }
    linkRxBuffer = "$";
    return;
  }

  // Abaikan byte noise sebelum start-of-frame agar parser tidak gagal terus.
  if (linkRxBuffer.length() == 0) {
    acqMon.rxNoiseBytes++;
    return;
  }

  // Hanya simpan karakter printable ASCII CSV. Byte lain dianggap noise.
  if ((uint8_t)c < 32 || (uint8_t)c > 126) {
    acqMon.rxNoiseBytes++;
    return;
  }

  linkRxBuffer += c;

  // Proteksi jika terminator hilang: reset buffer dan tunggu '$' berikutnya.
  if (linkRxBuffer.length() > LINK_LINE_BUFFER_MAX_CHARS) {
    linkRxBuffer = "";
    rxBufferResetCount++;
    parseFailCount++;
    acqMon.rxOverflowReset++;
  }
}

void readLinkSerialManual() {
  uint32_t readStart = micros();

  // Mode test-once: setelah 1 frame valid diterima, kosongkan UART buffer
  // supaya frame baru tidak mengubah latestRaw/aggregate pengujian.
  if (testOnceMode && testOnceRxDone) {
    while (LinkSerial.available()) LinkSerial.read();
    perfUartReadUs = micros() - readStart;
    perfUpdateStat(acqMon.uartReadUs, perfUartReadUs);
    return;
  }

  while (LinkSerial.available()) {
    handleLinkSerialChar((char)LinkSerial.read());
  }

  perfUartReadUs = micros() - readStart;
  perfUpdateStat(acqMon.uartReadUs, perfUartReadUs);
}

void UartRxTask(void *pvParameters) {
  (void)pvParameters;

  while (true) {
    readLinkSerialManual();
    vTaskDelay(pdMS_TO_TICKS(LINK_RX_TASK_DELAY_MS));
  }
}


// ============================================================
// AGGREGATION
// ============================================================
void resetAccumulator() {
  acc = AggAccumulator();
}

void clearStorageBatchForTestOnce() {
  for (uint8_t i = 0; i < STORAGE_BATCH_SIZE; i++) {
    storageBatch[i] = StorageRecord();
  }
  storageBatchCount = 0;
}

void printTestOnceStatus() {
  Serial.println();
  Serial.println(F("================ TEST-ONCE STATUS ================"));
  Serial.print  (F("  mode            : ")); Serial.println(testOnceMode ? F("ON") : F("OFF"));
  Serial.print  (F("  overall done    : ")); Serial.println(testOnceDone ? F("YES") : F("NO"));
  Serial.print  (F("  UART RX         : ")); Serial.println(testOnceRxDone ? F("DONE") : F("WAITING"));
  Serial.print  (F("  aggregation     : ")); Serial.println(testOnceAggDone ? F("DONE") : F("WAITING"));
  Serial.print  (F("  local SD DB     : ")); Serial.println(testOnceSdDone ? F("DONE") : F("WAITING"));
  Serial.print  (F("  MQTT/cloud DB   : ")); Serial.println(testOnceMqttDone ? F("DONE") : F("WAITING"));
  Serial.print  (F("  TFT monitoring  : ")); Serial.println(testOnceDisplayDone ? F("DONE") : F("WAITING"));
  Serial.print  (F("  frozen seq      : ")); Serial.println(testOnceSeq);
  Serial.print  (F("  localSeq record : ")); Serial.println(testOnceLocalSeq);
  Serial.print  (F("  has RX cache    : ")); Serial.println(hasLastRxReport ? F("YES") : F("NO"));
  if (hasLastRxReport) {
    Serial.print(F("  cached seq      : ")); Serial.println(lastRxDataCache.seq);
    Serial.print(F("  cached timestamp: ")); Serial.print(lastRxDataCache.timestampMs); Serial.println(F(" ms"));
  }
  Serial.println(F("=================================================="));
}

void updateTestOnceCompletion() {
  if (!testOnceMode || testOnceDone) return;

  if (testOnceRxDone && testOnceAggDone && testOnceSdDone && testOnceMqttDone && testOnceDisplayDone) {
    testOnceDone = true;
    Serial.println();
    Serial.println(F("╔════════════ TEST-ONCE COMPLETE ════════════╗"));
    Serial.println(F("║ 1 frame UART diterima dan dibekukan.       ║"));
    Serial.println(F("║ 1 record monitoring berhasil diagregasi.   ║"));
    Serial.println(F("║ 1 record tersimpan ke SD/local database.   ║"));
    Serial.println(F("║ 1 payload terkirim ke MQTT/cloud database. ║"));
    Serial.println(F("║ 1 tampilan monitoring sudah dirender.      ║"));
    Serial.println(F("╚════════════════════════════════════════════╝"));
    printTestOnceStatus();
  }
}

void startTestOnceMode() {
  // Jika test-once sudah pernah menerima/memproses frame, jangan membuat data baru.
  // Command "test once" setelah selesai hanya menampilkan data terakhir yang dibekukan.
  // Data baru hanya dibuat dengan command "test once reset".
  if (testOnceMode && (testOnceRxDone || testOnceDone || hasLastRxReport)) {
    Serial.println();
    Serial.println(F("╔════════════ TEST-ONCE HOLD LAST DATA ════════════╗"));
    Serial.println(F("║ Mode test-once sudah memiliki data terakhir.     ║"));
    Serial.println(F("║ Tidak menerima frame baru agar seq/timestamp     ║"));
    Serial.println(F("║ tidak bertambah.                                 ║"));
    Serial.println(F("║ Command untuk data baru: test once reset         ║"));
    Serial.println(F("╚═══════════════════════════════════════════════════╝"));
    printLastRxReportFromCache();
    printTestOnceStatus();
    return;
  }

  testOnceMode = true;
  testOnceDone = false;
  testOnceRxDone = false;
  testOnceAggDone = false;
  testOnceSdDone = false;
  testOnceMqttDone = false;
  testOnceDisplayDone = false;
  testOnceSeq = 0;
  testOnceLocalSeq = 0;
  testOnceTriggeredMs = millis();

  hasLastRxReport = false;
  lastRxRawLineCache = "";
  lastRxDataCache = RawData();
  lastRxParseOkCache = false;
  lastRxCachedAtMs = 0;

  linkRxBuffer = "";
  resetAccumulator();
  clearStorageBatchForTestOnce();

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    latestRaw = RawData();
    aggData = AggregatedData();
    strlcpy(latestRaw.syncText, "OFF-GRID", sizeof(latestRaw.syncText));
    strlcpy(latestRaw.statusText, "NO-DATA", sizeof(latestRaw.statusText));
    xSemaphoreGive(dataMutex);
  }

  // Paksa siklus berikutnya segera mencoba publish, save, dan redraw
  // setelah aggregate pertama tersedia.
  lastPublish = 0;
  lastLocalSave = 0;
  lastDraw = 0;
  needFullRedraw = true;

  Serial.println();
  Serial.println(F("╔════════════ TEST-ONCE STARTED ════════════╗"));
  Serial.println(F("║ ESP32-2 akan menerima 1 frame UART valid. ║"));
  Serial.println(F("║ Setelah itu data dibekukan di cache.      ║"));
  Serial.println(F("║ Ketik test once untuk tampilkan ulang.    ║"));
  Serial.println(F("║ Data baru hanya dengan: test once reset   ║"));
  Serial.println(F("╚════════════════════════════════════════════╝"));
}

void resetTestOnceMode() {
  testOnceMode = true;
  testOnceDone = false;
  testOnceRxDone = false;
  testOnceAggDone = false;
  testOnceSdDone = false;
  testOnceMqttDone = false;
  testOnceDisplayDone = false;
  testOnceSeq = 0;
  testOnceLocalSeq = 0;
  testOnceTriggeredMs = millis();

  hasLastRxReport = false;
  lastRxRawLineCache = "";
  lastRxDataCache = RawData();
  lastRxParseOkCache = false;
  lastRxCachedAtMs = 0;

  linkRxBuffer = "";
  while (LinkSerial.available()) LinkSerial.read();

  resetAccumulator();
  clearStorageBatchForTestOnce();

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
    latestRaw = RawData();
    aggData = AggregatedData();
    strlcpy(latestRaw.syncText, "OFF-GRID", sizeof(latestRaw.syncText));
    strlcpy(latestRaw.statusText, "NO-DATA", sizeof(latestRaw.statusText));
    xSemaphoreGive(dataMutex);
  }

  lastPublish = 0;
  lastLocalSave = 0;
  lastDraw = 0;
  needFullRedraw = true;

  Serial.println();
  Serial.println(F("╔════════════ TEST-ONCE RESET ════════════╗"));
  Serial.println(F("║ Cache lama dihapus.                     ║"));
  Serial.println(F("║ ESP32-2 akan menerima 1 frame UART baru.║"));
  Serial.println(F("║ seq dan timestampMs baru hanya muncul   ║"));
  Serial.println(F("║ setelah frame baru diterima.            ║"));
  Serial.println(F("╚═════════════════════════════════════════╝"));
}

void stopTestOnceMode() {
  testOnceMode = false;
  testOnceDone = false;
  testOnceRxDone = false;
  testOnceAggDone = false;
  testOnceSdDone = false;
  testOnceMqttDone = false;
  testOnceDisplayDone = false;
  linkRxBuffer = "";
  needFullRedraw = true;
  Serial.println(F("[TEST] once off. Mode monitoring kembali continuous."));
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

    if (testOnceMode && testOnceRxDone && !testOnceAggDone) {
      testOnceAggDone = true;
      testOnceLocalSeq = localRecordSeq;
      Serial.println();
      Serial.println(F("╔════════════ TEST-ONCE AGGREGATION ════════════╗"));
      Serial.printf("[TEST] 1 record agregasi siap. localSeq=%lu, samples=%u\n",
                    (unsigned long)testOnceLocalSeq, out.samples);
      Serial.println(F("╚════════════════════════════════════════════════╝"));
      printAggregatedParameterReport(out);

      // Paksa loop utama segera menjalankan SD save, MQTT publish, dan TFT draw
      // tanpa menunggu sisa interval sebelumnya.
      lastLocalSave = 0;
      lastPublish = 0;
      lastDraw = 0;
      needFullRedraw = true;
    }

    fastAggCompleted++;
    lastFastAggSamples = out.samples;
    lastAggReadyMs = nowMs;

    if (out.samples < 7) fastAggUnderfilled++;

    if (serialLogAggregationEnabled) {
      printAggregatedParameterReport(out);
    }
  }

  resetAccumulator();
  perfAggregationUs = micros() - aggStart;
  perfUpdateStat(acqMon.aggregationUs, perfAggregationUs);
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
  local.source = source;
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
  perfUpdateStat(acqMon.fftComputeUs, perfFftComputeUs);
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
    recordSensorIntervalTick();
    uint32_t taskStart = micros();

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
      acqMon.newSeqSamples++;
      lastAggregatedSeq = sample.seq;
    } else if (!hasSample) {
      acqMon.noDataCycles++;
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
    perfUpdateStat(acqMon.sensorTaskUs, perfSensorTaskUs);

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
  json += "\"source\":\"" + String(getFFTSourceNameById(f.source)) + "\",";
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

String buildMqttRealtimeFlatPayload() {
  // Payload khusus MQTT realtime ke dashboard.
  // Format dibuat flat: timestamp + parameter langsung di root JSON.
  // FFT tetap ikut sebagai object agar halaman FFT/dashboard masih menerima data spektrum.
  uint32_t buildStart = micros();

  StorageRecord r;
  bool found = false;

  for (uint8_t i = 0; i < STORAGE_BATCH_SIZE; i++) {
    if (storageBatch[i].valid) {
      r = storageBatch[i];
      found = true;
      break;
    }
  }

  if (!found) {
    perfJsonBuildUs = micros() - buildStart;
    return "{}";
  }

  const AggregatedData &a = r.agg;
  const FFTData &f = r.fft;

  String json = "{";
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
  json += "\"freqGrid\":" + String(a.freqGridAvg, 3) + ",";
  json += "\"volt\":" + String(a.voltAvg, 2) + ",";
  json += "\"voltGrid\":" + String(a.voltGridAvg, 2) + ",";
  json += "\"currentA\":" + String(a.currentAvg, 2) + ",";
  json += "\"powerKW\":" + String(a.powerAvg, 3) + ",";
  json += "\"phaseAngle\":" + String(a.phaseAngleAvg, 2) + ",";
  json += "\"synced\":" + String(a.synced ? "true" : "false") + ",";

  json += "\"fft\":{";
  json += "\"valid\":" + String(f.valid ? "true" : "false") + ",";
  json += "\"source\":\"" + String(getFFTSourceNameById(f.source)) + "\",";
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

  perfJsonBuildUs = micros() - buildStart;
  return json;
}

String buildMqttHistoryWrapperPayload() {
  // Payload wrapper tetap dipakai untuk topic history/cloud/batch.
  // Ini menjaga kompatibilitas jika backend masih membaca payload.records[].
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

String buildJsonBatchPayload() {
  // Backward compatibility untuk command/fungsi lama.
  // Setelah implementasi split payload, fungsi ini mengembalikan payload realtime flat.
  return buildMqttRealtimeFlatPayload();
}

void printMqttPayloadReport(const String &payload,
                            const String &parameterOnlyPayload,
                            uint32_t recordsInPayload,
                            bool realtimeOk,
                            bool historyOk,
                            bool fromCache) {
  Serial.println();
  Serial.println(F("╔════════════════ MQTT JSON PAYLOAD MONITOR ════════════════╗"));

  Serial.print(F("║ Source          : "));
  Serial.println(fromCache ? F("LAST SENT CACHE") : F("CURRENT BUILD / LAST PUBLISH"));

  Serial.print(F("║ MQTT host       : "));
  Serial.println(MQTT_HOST);

  Serial.print(F("║ Realtime topic  : "));
  Serial.println(MQTT_REALTIME_TOPIC);

  Serial.print(F("║ History/cloud   : "));
  Serial.println(F("MQTT topic gen/data from RAM buffer every 10 min"));

  Serial.print(F("║ Realtime status : "));
  Serial.println(realtimeOk ? F("PUBLISH OK") : F("PUBLISH FAIL / NOT SENT"));

  Serial.print(F("║ MongoDB batch   : "));
  Serial.println(historyOk ? F("PUBLISH OK") : F("WAITING BATCH BATCH"));

  if (fromCache && lastMqttPayloadCacheAtMs > 0) {
    Serial.print(F("║ Cache age       : "));
    Serial.print(millis() - lastMqttPayloadCacheAtMs);
    Serial.println(F(" ms"));
  }

  Serial.println(F("╠════════════ REALTIME FLAT MQTT JSON PAYLOAD ═══════════════╣"));
  Serial.println(payload);

  Serial.println(F("╠════════════ MONGODB BUFFER RECORD PREVIEW ═════════════════╣"));
  Serial.println(parameterOnlyPayload);

  Serial.println(F("╚═════════════════════════════════════════════════════════════╝"));
}

void printLastMqttPayloadCache() {
  if (!hasLastMqttPayloadCache) {
    Serial.println();
    Serial.println(F("╔════════ MQTT PAYLOAD CACHE ════════╗"));
    Serial.println(F("║ Belum ada payload MQTT terkirim.   ║"));
    Serial.println(F("║ Tunggu publish 1 detik, atau pakai ║"));
    Serial.println(F("║ command: mqtt payload now          ║"));
    Serial.println(F("╚════════════════════════════════════╝"));
    return;
  }

  printMqttPayloadReport(
    lastMqttPayloadCache,
    lastMqttParameterOnlyPayloadCache,
    lastMqttPayloadRecordsCache,
    lastMqttRealtimeOkCache,
    lastMqttHistoryOkCache,
    true
  );
}

void printCurrentMqttPayloadBuild() {
  bool hasData = false;
  uint32_t recordsInPayload = 0;

  for (uint8_t i = 0; i < STORAGE_BATCH_SIZE; i++) {
    if (storageBatch[i].valid) {
      hasData = true;
      recordsInPayload++;
    }
  }

  if (!hasData) {
    Serial.println();
    Serial.println(F("╔════════ MQTT PAYLOAD BUILD ════════╗"));
    Serial.println(F("║ Belum ada storageBatch valid.      ║"));
    Serial.println(F("║ Tunggu 1 record agregasi dahulu.   ║"));
    Serial.println(F("╚════════════════════════════════════╝"));
    return;
  }

  String payload = buildMqttRealtimeFlatPayload();
  String parameterOnlyPayload = buildMqttHistoryWrapperPayload();

  printMqttPayloadReport(
    payload,
    parameterOnlyPayload,
    recordsInPayload,
    false,
    false,
    false
  );
}


void cacheLastDatabasePayload(const StorageRecord &r, const String &csvLine, const String &queueJson) {
  hasLastDatabasePayloadCache = true;
  lastSdCsvLineCache = csvLine;
  lastSdQueueJsonCache = queueJson;
  lastDatabasePayloadCacheAtMs = millis();
  lastDatabaseLocalSeqCache = r.localSeq;
  lastDatabaseCsvBytesCache = csvLine.length() + 2; // CR/LF saat println
  lastDatabaseJsonBytesCache = queueJson.length() + 2;
}

void printDatabasePayloadReport(bool fullPayload) {
  Serial.println();
  Serial.println(F("╔════════════ SD DATABASE + MONGODB BUFFER PAYLOAD ═════════╗"));
  Serial.print(F("║ CSV file        : ")); Serial.println(DB_FILE);
  Serial.print(F("║ FFT file        : ")); Serial.println(FFT_FILE);
  Serial.print(F("║ Mongo topic     : ")); Serial.println(MQTT_TOPIC);
  Serial.print(F("║ Save interval   : ")); Serial.print(localSaveInterval); Serial.println(F(" ms"));
  Serial.print(F("║ Mongo interval  : ")); Serial.print(MONGODB_BATCH_INTERVAL_MS / 1000UL); Serial.println(F(" s"));
  Serial.print(F("║ Target batch    : ")); Serial.println(MONGODB_BUFFER_RECORDS);
  Serial.print(F("║ Buffer count    : ")); Serial.print(mongoDbBufferCount); Serial.print(F(" / ")); Serial.println(MONGODB_BUFFER_RECORDS);

  if (!hasLastDatabasePayloadCache) {
    Serial.println(F("║ Status          : belum ada record agregasi yang disimpan."));
    Serial.println(F("║ Tunggu minimal 1 detik setelah RX UART valid."));
    Serial.println(F("╚════════════════════════════════════════════════════════════╝"));
    return;
  }

  Serial.print(F("║ LocalSeq        : ")); Serial.println(lastDatabaseLocalSeqCache);
  Serial.print(F("║ Cache age       : ")); Serial.print(millis() - lastDatabasePayloadCacheAtMs); Serial.println(F(" ms"));
  Serial.print(F("║ CSV row bytes   : ")); Serial.println(lastDatabaseCsvBytesCache);
  Serial.print(F("║ JSON row bytes  : ")); Serial.println(lastDatabaseJsonBytesCache);
  {
    uint32_t recBytes = getMongoRecordBytesNoFft();
    uint32_t avgSentBytes = getMongoAvgSentRecordBytesNoFft();
    Serial.print(F("║ Mongo record    : ")); Serial.print(recBytes); Serial.println(F(" B/record"));
    Serial.print(F("║ Avg sent record : ")); Serial.print(avgSentBytes); Serial.println(F(" B/record"));
    Serial.print(F("║ Est. storage 10y: ")); Serial.println(formatBytes(estimateMongoPayloadBytesNoFft10Years(avgSentBytes)));
  }
  Serial.print(F("║ Buffer count    : ")); Serial.print(mongoDbBufferCount); Serial.print(F(" / ")); Serial.println(MONGODB_BUFFER_RECORDS);
  Serial.print(F("║ MQTT state   : ")); Serial.println(mongoUploadLastHttpCode);
  Serial.print(F("║ Send busy       : ")); Serial.println(mongoUploadBusy ? F("YES") : F("NO"));

  if (fullPayload) {
    Serial.println(F("╠════════════ LAST CSV ROW WRITTEN TO SD ════════════════════╣"));
    Serial.println(lastSdCsvLineCache);
    Serial.println(F("╠════════════ LAST JSON RECORD BUFFERED FOR MONGODB ════════╣"));
    Serial.println(lastSdQueueJsonCache);
  } else {
    Serial.println(F("║ Detail payload  : ketik 'db payload full' untuk CSV+JSON lengkap."));
  }
  Serial.println(F("╚════════════════════════════════════════════════════════════╝"));
}

void printRealtimeMonitoringPayloadReport(bool fullPayload) {
  Serial.println();
  Serial.println(F("╔════════════ REALTIME MQTT MONITORING STATUS ══════════════╗"));
  Serial.print(F("║ Topic           : ")); Serial.println(MQTT_REALTIME_TOPIC);
  Serial.print(F("║ Interval        : ")); Serial.print(publishInterval); Serial.println(F(" ms"));
  Serial.print(F("║ WiFi/MQTT       : ")); Serial.print(wifiOK ? F("WiFi OK") : F("WiFi FAIL"));
  Serial.print(F(" / ")); Serial.println(mqtt.connected() ? F("MQTT CONNECTED") : F("MQTT DISCONNECTED"));

  if (!hasLastMqttPayloadCache) {
    Serial.println(F("║ Status          : belum ada payload realtime terkirim."));
    Serial.println(F("║ Tunggu publish 1 detik setelah agregasi valid."));
    Serial.println(F("╚════════════════════════════════════════════════════════════╝"));
    return;
  }

  Serial.print(F("║ Last publish age: ")); Serial.print(millis() - lastMqttPayloadCacheAtMs); Serial.println(F(" ms"));
  Serial.print(F("║ Last payload    : ")); Serial.print(lastMqttPayloadCache.length()); Serial.println(F(" B"));
  Serial.print(F("║ Records         : ")); Serial.println(lastMqttPayloadRecordsCache);
  Serial.print(F("║ Realtime status : ")); Serial.println(lastMqttRealtimeOkCache ? F("PUBLISH OK") : F("PUBLISH FAIL"));
  Serial.println(F("║ History/MongoDB : WAITING BATCH MQTT BUFFER PUBLISH."));

  if (fullPayload) {
    Serial.println(F("╠════════════ LAST REALTIME MQTT JSON PAYLOAD ══════════════╣"));
    Serial.println(lastMqttPayloadCache);
  } else {
    Serial.println(F("║ Detail payload  : ketik 'monitoring payload full'."));
  }
  Serial.println(F("╚════════════════════════════════════════════════════════════╝"));
}

void printSerialMonitoringOverview() {
  RawData r; AggregatedData a;
  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    r = latestRaw;
    a = aggData;
    xSemaphoreGive(dataMutex);
  }

  Serial.println();
  Serial.println(F("╔════════════ GENSYS SERIAL MONITOR OVERVIEW ═══════════════╗"));
  Serial.println(F("║ 1) RAW UART TERAKHIR                                      ║"));
  if (hasLastRxReport) {
    Serial.print(F("║ Raw age        : ")); Serial.print(millis() - lastRxCachedAtMs); Serial.println(F(" ms"));
    Serial.print(F("║ Raw line       : ")); Serial.println(lastRxRawLineCache);
  } else {
    Serial.println(F("║ Raw line       : belum ada frame UART."));
  }

  Serial.println(F("╟────────────────────────────────────────────────────────────╢"));
  Serial.println(F("║ 2) HASIL AGREGASI 1 DETIK / DATA DATABASE                 ║"));
  Serial.printf("║ samples=%u rpm=%.1f tps=%.1f map=%.1f freq=%.3f volt=%.2f\n",
                a.samples, a.rpmAvg, a.tpsAvg, a.mapAvg, a.freqAvg, a.voltAvg);
  Serial.printf("║ current=%.2fA power=%.3fkW phase=%.2fdeg synced=%d\n",
                a.currentAvg, a.powerAvg, a.phaseAngleAvg, a.synced ? 1 : 0);
  if (hasLastDatabasePayloadCache) {
    Serial.print(F("║ last CSV bytes : ")); Serial.print(lastDatabaseCsvBytesCache);
    Serial.print(F(" | queue JSON bytes: ")); Serial.println(lastDatabaseJsonBytesCache);
  } else {
    Serial.println(F("║ last CSV bytes : belum ada record SD."));
  }

  Serial.println(F("╟────────────────────────────────────────────────────────────╢"));
  Serial.println(F("║ 3) REALTIME MONITORING / MQTT DASHBOARD                   ║"));
  Serial.print(F("║ MQTT topic     : ")); Serial.println(MQTT_REALTIME_TOPIC);
  Serial.print(F("║ MQTT status    : ")); Serial.println(mqtt.connected() ? F("CONNECTED") : F("DISCONNECTED"));
  Serial.print(F("║ last publish   : ")); Serial.print(hasLastMqttPayloadCache ? String(millis() - lastMqttPayloadCacheAtMs) + " ms ago" : String("never")); Serial.println();
  Serial.print(F("║ last bytes     : ")); Serial.println(hasLastMqttPayloadCache ? lastMqttPayloadCache.length() : 0);

  Serial.println(F("╟────────────────────────────────────────────────────────────╢"));
  Serial.println(F("║ 4) MONGODB 10-MIN RAM BUFFER                              ║"));
  Serial.print(F("║ buffer count   : ")); Serial.print(mongoDbBufferCount); Serial.print(F(" / ")); Serial.println(MONGODB_BUFFER_RECORDS);
  Serial.print(F("║ interval       : ")); Serial.print(MONGODB_BATCH_INTERVAL_MS / 1000UL); Serial.println(F(" s"));
  Serial.print(F("║ target batch   : ")); Serial.println(MONGODB_BUFFER_RECORDS);
  Serial.print(F("║ last batch     : ")); Serial.print(mongoUploadLastBatchRecords); Serial.print(F(" records, ")); Serial.print(mongoUploadLastPayloadBytes); Serial.println(F(" B"));
  Serial.print(F("║ MQTT state      : ")); Serial.println(mongoUploadLastHttpCode);
  Serial.print(F("║ busy           : ")); Serial.println(mongoUploadBusy ? F("YES") : F("NO"));
  Serial.print(F("║ OK/FAIL        : ")); Serial.print(mongoUploadSuccessRecords); Serial.print(F(" / ")); Serial.println(mongoUploadFailCount);
  Serial.println(F("╚════════════════════════════════════════════════════════════╝"));
}

void publishRealtimeData() {
  if (WiFi.status() != WL_CONNECTED) {
    wifiOK = false;
    mqttOK = false;
    return;
  }

  wifiOK = true;

  if (!mqtt.connected()) {
    mqttOK = false;
    reconnectMQTT();

    if (!mqtt.connected()) {
      return;
    }
  }
  // Test-once mode: MQTT realtime hanya 1 kali setelah aggregate tersedia.
  if (testOnceMode && (!testOnceAggDone || testOnceMqttDone)) return;

  bool hasData = false;
  uint32_t recordsInPayload = 0;
  for (uint8_t i = 0; i < STORAGE_BATCH_SIZE; i++) {
    if (storageBatch[i].valid) {
      hasData = true;
      recordsInPayload++;
    }
  }
  if (!hasData) return;

  // MQTT hanya untuk realtime dashboard 1 detik.
  // MQTT realtime tetap ke gen/realtime setiap 1 detik.
  // History/cloud MongoDB dikirim dari buffer RAM ke topic gen/data sesesuai interval batch oleh MongoBufferTask.
  String realtimePayload = buildMqttRealtimeFlatPayload();
  String parameterOnlyPayload = buildJsonParameterBatchPayload();

  mqttLastPayloadBytes = realtimePayload.length();
  mqttLastParameterPayloadBytes = parameterOnlyPayload.length();
  mqttLastRecordsSent = recordsInPayload;

  uint32_t pubStart = micros();
  bool realtimeOk = false;
  if (mqttMutex && xSemaphoreTake(mqttMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
    realtimeOk = mqtt.publish(MQTT_REALTIME_TOPIC, realtimePayload.c_str());
    mqtt.loop();
    xSemaphoreGive(mqttMutex);
  } else if (mqttMutex == NULL) {
    realtimeOk = mqtt.publish(MQTT_REALTIME_TOPIC, realtimePayload.c_str());
    mqtt.loop();
  }
  bool historyOk = false; // status batch MongoDB ditangani MongoBufferTask sesuai interval batch
  bool ok = realtimeOk;
  perfMqttPublishUs = micros() - pubStart;
  perfUpdateStat(acqMon.mqttPublishUs, perfMqttPublishUs);

  mqttOK = ok;

  // Cache payload terakhir untuk command: mqtt payload / json mqtt.
  lastMqttPayloadCache = realtimePayload;
  lastMqttParameterOnlyPayloadCache = parameterOnlyPayload;
  lastMqttRealtimeTopicCache = MQTT_REALTIME_TOPIC;
  lastMqttHistoryTopicCache = MQTT_TOPIC;
  lastMqttRealtimeOkCache = realtimeOk;
  lastMqttHistoryOkCache = historyOk;
  lastMqttPayloadCacheAtMs = millis();
  lastMqttPayloadRecordsCache = recordsInPayload;
  hasLastMqttPayloadCache = true;

  if (serialMqttPayloadEnabled || serialRealtimePayloadEnabled) {
    printMqttPayloadReport(
      realtimePayload,
      parameterOnlyPayload,
      recordsInPayload,
      realtimeOk,
      historyOk,
      false
    );
  }

  if (ok) {
    lastMqttPublishMs = millis();
    mqttPublishSuccessCount++;
    mqttTotalPayloadBytes += mqttLastPayloadBytes;
    mqttTotalParameterPayloadBytes += mqttLastParameterPayloadBytes;
    mqttTotalRecordsSent += recordsInPayload;

    if (testOnceMode && !testOnceMqttDone) {
      testOnceMqttDone = true;
      Serial.println();
      Serial.println(F("╔════════════ TEST-ONCE MQTT REALTIME ════════════╗"));
      Serial.printf("[TEST] Payload realtime terkirim ke topic %s. bytes=%lu, records=%lu\n",
                    MQTT_REALTIME_TOPIC,
                    (unsigned long)mqttLastPayloadBytes,
                    (unsigned long)mqttLastRecordsSent);
      Serial.println(F("[TEST] MongoDB dikirim dari buffer RAM sesuai interval batch via MQTT topic gen/data; SD hanya backup lokal."));
      Serial.println(F("╚══════════════════════════════════════════════════╝"));
      updateTestOnceCompletion();
    }
  } else {
    mqttPublishFailCount++;
  }
}

// ============================================================
// SD CARD
// ============================================================

bool addRecordToMongoDbBuffer(const StorageRecord &r) {
  String json = buildJsonRecordParametersOnly(r);
  if (!json.length()) return false;

  if (mongoBufferMutex && xSemaphoreTake(mongoBufferMutex, pdMS_TO_TICKS(20)) != pdTRUE) {
    mongoDbBufferOverflowCount++;
    return false;
  }

  bool accepted = false;

  if (mongoDbBufferCount < MONGODB_BUFFER_RECORDS) {
    mongoDbBuffer[mongoDbBufferCount++] = json;
    mongoDbBufferedTotal++;
    accepted = true;
  } else {
    // Buffer MongoDB penuh. Kondisi ini biasanya terjadi saat jaringan/MQTT/server
    // bermasalah sehingga batch 2 menit belum berhasil dikirim. Record berikutnya
    // harus dicadangkan ke SD agar tidak hilang.
    mongoDbBufferOverflowCount++;
    accepted = false;
  }

  if (mongoBufferMutex) xSemaphoreGive(mongoBufferMutex);
  return accepted;
}

bool shouldBackupRecordToSD(bool mongoBufferAccepted) {
  bool wifiBad = (WiFi.status() != WL_CONNECTED) || !wifiOK;
  bool mqttBad = !mqtt.connected();
  bool bufferFullOrRejected = (!mongoBufferAccepted) || (mongoDbBufferCount >= MONGODB_BUFFER_RECORDS);
  bool recentMongoFailure = (mongoUploadLastAttemptMs > 0 &&
                             !mongoUploadLastMqttOk &&
                             mongoUploadLastHttpCode != 0 &&
                             (millis() - mongoUploadLastAttemptMs) < MONGODB_BATCH_INTERVAL_MS);

  if (wifiBad || mqttBad) sdBackupBecauseNetworkCount++;
  if (bufferFullOrRejected) sdBackupBecauseBufferFullCount++;
  if (recentMongoFailure) sdBackupBecauseMongoFailCount++;

  return wifiBad || mqttBad || bufferFullOrRejected || recentMongoFailure;
}


void clearMongoDbBufferNoLock(uint16_t countToClear) {
  if (countToClear >= mongoDbBufferCount) {
    for (uint16_t i = 0; i < mongoDbBufferCount; i++) mongoDbBuffer[i] = "";
    mongoDbBufferCount = 0;
    return;
  }

  for (uint16_t i = 0; i < mongoDbBufferCount - countToClear; i++) {
    mongoDbBuffer[i] = mongoDbBuffer[i + countToClear];
  }
  for (uint16_t i = mongoDbBufferCount - countToClear; i < mongoDbBufferCount; i++) {
    mongoDbBuffer[i] = "";
  }
  mongoDbBufferCount -= countToClear;
}

uint16_t buildMongoDbBufferPayload(String &payload, uint16_t maxRecords = MONGODB_BATCH_RECORDS, uint16_t chunkIndex = 0) {
  payload = "";

  if (mongoBufferMutex && xSemaphoreTake(mongoBufferMutex, pdMS_TO_TICKS(150)) != pdTRUE) return 0;

  uint16_t recordsCount = mongoDbBufferCount;
  if (recordsCount > MONGODB_BATCH_RECORDS) recordsCount = MONGODB_BATCH_RECORDS;
  if (recordsCount > maxRecords) recordsCount = maxRecords;

  // Estimasi kasar: 1 record parameter-only ±250-360 byte.
  // Payload akhir berisi metadata batch + array records.
  payload.reserve((uint32_t)recordsCount * 360UL + 260UL);
  payload += "{";
  payload += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"type\":\"mongodb_batch\",";
  payload += "\"source\":\"esp32_monitoring_ram_buffer\",";
  payload += "\"transport\":\"mqtt\",";
  payload += "\"topic\":\"" + String(MQTT_TOPIC) + "\",";
  payload += "\"batchIntervalMs\":" + String(MONGODB_BATCH_INTERVAL_MS) + ",";
  payload += "\"targetBatchRecords\":" + String(MONGODB_BATCH_RECORDS) + ",";
  payload += "\"recordCount\":" + String(recordsCount) + ",";
  payload += "\"chunkIndex\":" + String(chunkIndex) + ",";
  payload += "\"chunkMaxRecords\":" + String(maxRecords) + ",";
  payload += "\"bufferRecordsBeforeChunk\":" + String(mongoDbBufferCount) + ",";
  payload += "\"sentAt\":\"" + getIsoTimestampWIBms() + "\",";
  payload += "\"records\":[";
  for (uint16_t i = 0; i < recordsCount; i++) {
    if (i) payload += ",";
    payload += mongoDbBuffer[i];
  }
  payload += "]}";

  if (mongoBufferMutex) xSemaphoreGive(mongoBufferMutex);
  return recordsCount;
}

uint16_t extractJsonUintField(const String &json, const char* key) {
  String pattern = "\"" + String(key) + "\":";
  int pos = json.indexOf(pattern);
  if (pos < 0) return 0;
  pos += pattern.length();
  while (pos < (int)json.length() && (json.charAt(pos) == ' ' || json.charAt(pos) == '\t')) pos++;

  uint32_t value = 0;
  bool hasDigit = false;
  while (pos < (int)json.length()) {
    char c = json.charAt(pos);
    if (c < '0' || c > '9') break;
    hasDigit = true;
    value = (value * 10UL) + (uint32_t)(c - '0');
    if (value > 65535UL) return 65535;
    pos++;
  }
  return hasDigit ? (uint16_t)value : 0;
}

uint16_t parseAckedRecordsFromResponse(const String &body) {
  uint16_t acked = extractJsonUintField(body, "ackedRecords");
  if (acked) return acked;
  acked = extractJsonUintField(body, "accepted");
  if (acked) return acked;
  acked = extractJsonUintField(body, "processedRecords");
  if (acked) return acked;
  return extractJsonUintField(body, "received");
}


bool publishMongoBufferBatchToMqtt(const String &batchPayload) {
  updateHeapMonitor();

  if (WiFi.status() != WL_CONNECTED) {
    wifiOK = false;
    mqttOK = false;
    mongoUploadLastHttpCode = -201;   // WiFi disconnected
    return false;
  }

  wifiOK = true;

  if (!mqtt.connected()) {
    mqttOK = false;
    reconnectMQTT();

    if (!mqtt.connected()) {
      mongoUploadLastHttpCode = mqtt.state();
      return false;
    }
  }

  if (batchPayload.length() == 0) {
    mongoUploadLastHttpCode = -97;    // empty payload
    return false;
  }

  if ((uint32_t)batchPayload.length() > MONGO_BATCH_MAX_PAYLOAD_BYTES) {
    mongoUploadLastHttpCode = -99;    // payload too large

    Serial.print(F("[MONGO-MQTT] Batch payload too large: "));
    Serial.print(batchPayload.length());
    Serial.print(F(" bytes, max="));
    Serial.println(MONGO_BATCH_MAX_PAYLOAD_BYTES);

    return false;
  }

  // Karena batch 120 record lebih ringan untuk heap ESP32, jangan pakai mqtt.publish()
  // yang bergantung pada buffer internal PubSubClient. Gunakan streaming:
  // beginPublish() -> write() per chunk -> endPublish().
  if (ESP.getFreeHeap() < HEAP_MIN_FREE_BYTES || ESP.getMaxAllocHeap() < (uint32_t)MONGO_BATCH_STREAM_CHUNK_BYTES) {
    mongoUploadLastHttpCode = -202;

    Serial.println(F("[MONGO-MQTT] Skip Mongo batch: heap low / fragmented."));
    Serial.print(F("[MONGO-MQTT] Free heap : "));
    Serial.println(ESP.getFreeHeap());
    Serial.print(F("[MONGO-MQTT] Max alloc : "));
    Serial.println(ESP.getMaxAllocHeap());

    return false;
  }

  bool ok = false;

  if (mqttMutex != NULL) {
    if (xSemaphoreTake(mqttMutex, pdMS_TO_TICKS(3000)) != pdTRUE) {
      mongoUploadLastHttpCode = -98;  // MQTT mutex timeout
      return false;
    }
  }

  mqtt.loop();

  bool started = mqtt.beginPublish(MQTT_TOPIC, (unsigned int)batchPayload.length(), false);
  if (started) {
    const uint8_t *ptr = (const uint8_t*)batchPayload.c_str();
    uint32_t remaining = batchPayload.length();
    uint32_t offset = 0;

    ok = true;
    while (remaining > 0) {
      uint16_t chunk = remaining > MONGO_BATCH_STREAM_CHUNK_BYTES
                       ? MONGO_BATCH_STREAM_CHUNK_BYTES
                       : (uint16_t)remaining;

      size_t written = mqtt.write(ptr + offset, chunk);
      if (written != chunk) {
        ok = false;
        break;
      }

      offset += chunk;
      remaining -= chunk;

      // Beri waktu WiFi stack dan MQTT keepalive.
      mqtt.loop();
      vTaskDelay(pdMS_TO_TICKS(1));
    }

    if (ok) {
      ok = mqtt.endPublish();
    }
  } else {
    ok = false;
  }

  mqtt.loop();

  if (mqttMutex != NULL) {
    xSemaphoreGive(mqttMutex);
  }

  mongoUploadLastHttpCode = ok ? 0 : mqtt.state();
  mqttOK = mqtt.connected();

  if (!ok) {
    Serial.print(F("[MONGO-MQTT] Batch publish failed. state="));
    Serial.println(mqtt.state());
  }

  return ok;
}

void sendMongoDbBufferToMongoDB() {
  // Nama fungsi tetap dipertahankan agar pemanggil lama tidak perlu diubah.
  // Implementasi:
  // - mengirim total 120 record setiap 2 menit,
  // - default MQTT dipecah 10 record/publish agar tidak ditolak broker/cloud,
  // - tiap publish berisi payload.records[],
  // - record yang sudah berhasil dipublish langsung dihapus dari buffer,
  // - record yang gagal tetap disimpan untuk retry berikutnya.

  mongoUploadLastAttemptMs = millis();
  mongoUploadLastAckedRecords = 0;
  mongoUploadLastBatchRecords = 0;
  mongoUploadLastPayloadBytes = 0;
  mongoUploadLastRunChunks = 0;
  mongoUploadLastRunRecords = 0;
  mongoUploadLastAckResponseRecords = 0;
  mongoUploadLastMqttOk = false;

  mongoDbLastSentRecords = 0;
  mongoDbLastPayloadBytes = 0;
  mongoDbLastAckResponseRecords = 0;

  updateHeapMonitor();

  if (!isWiFiUsableForMongoUpload()) {
    mongoUploadFailCount++;
    mongoUploadLastHttpCode = -203;   // WiFi disconnected / RSSI weak

    Serial.println(F("[MONGO-MQTT] Batch postponed: WiFi disconnected or RSSI too weak."));

    if (WiFi.status() == WL_CONNECTED) {
      Serial.print(F("[MONGO-MQTT] RSSI: "));
      Serial.print(WiFi.RSSI());
      Serial.println(F(" dBm"));
    }

    return;
  }

  reconnectMQTT();

  if (!mqtt.connected()) {
    mongoUploadFailCount++;
    mongoUploadLastHttpCode = mqtt.state();

    Serial.print(F("[MONGO-MQTT] Batch postponed: MQTT not connected. state="));
    Serial.println(mqtt.state());

    return;
  }

  uint16_t queuedAtStart = 0;
  if (mongoBufferMutex != NULL) {
    if (xSemaphoreTake(mongoBufferMutex, pdMS_TO_TICKS(150)) == pdTRUE) {
      queuedAtStart = mongoDbBufferCount;
      xSemaphoreGive(mongoBufferMutex);
    }
  } else {
    queuedAtStart = mongoDbBufferCount;
  }

  if (queuedAtStart == 0) return;
  if (queuedAtStart > MONGODB_BATCH_RECORDS) queuedAtStart = MONGODB_BATCH_RECORDS;

  mongoUploadLastBatchRecords = queuedAtStart;
  mongoUploadLastRunRecords = queuedAtStart;

  uint16_t totalSentRecords = 0;
  uint16_t chunkIndex = 0;
  while (totalSentRecords < queuedAtStart) {
    uint16_t remainingTarget = queuedAtStart - totalSentRecords;
    uint16_t chunkLimit = remainingTarget > MONGODB_UPLOAD_CHUNK_RECORDS
                          ? MONGODB_UPLOAD_CHUNK_RECORDS
                          : remainingTarget;

    String batchPayload;
    uint16_t recordsCount = buildMongoDbBufferPayload(batchPayload, chunkLimit, chunkIndex);

    if (recordsCount == 0) {
      break;
    }

    mongoUploadLastRunChunks++;
    mongoUploadLastPayloadBytes += batchPayload.length();
    mongoDbLastPayloadBytes += batchPayload.length();

    if ((uint32_t)batchPayload.length() > MONGO_BATCH_MAX_PAYLOAD_BYTES) {
      mongoUploadLastHttpCode = -99;
      Serial.println();
      Serial.println(F("╔════════════ MONGO MQTT BATCH ERROR ════════════╗"));
      Serial.print(F("[MONGO-MQTT] Chunk payload bytes : "));
      Serial.println(batchPayload.length());
      Serial.print(F("[MONGO-MQTT] Max allowed         : "));
      Serial.println(MONGO_BATCH_MAX_PAYLOAD_BYTES);
      Serial.println(F("[MONGO-MQTT] Solusi: turunkan MONGODB_UPLOAD_CHUNK_RECORDS atau kecilkan field JSON."));
      Serial.println(F("╚═════════════════════════════════════════════════╝"));
      break;
    }

    Serial.println();
    Serial.println(F("╔════════════ MONGO MQTT 2-MIN CHUNK UPLOAD ════════════╗"));
    Serial.print(F("[MONGO-MQTT] Topic          : "));
    Serial.println(MQTT_TOPIC);
    Serial.print(F("[MONGO-MQTT] Chunk          : "));
    Serial.print(chunkIndex + 1);
    Serial.print(F(" | records="));
    Serial.println(recordsCount);
    Serial.print(F("[MONGO-MQTT] Total target   : "));
    Serial.println(queuedAtStart);
    Serial.print(F("[MONGO-MQTT] Payload bytes  : "));
    Serial.println(batchPayload.length());
    Serial.print(F("[MONGO-MQTT] Interval       : "));
    Serial.print(MONGODB_BATCH_INTERVAL_MS / 1000UL);
    Serial.println(F(" s"));
    Serial.print(F("[MONGO-MQTT] RSSI           : "));
    Serial.print(WiFi.RSSI());
    Serial.println(F(" dBm"));
    Serial.print(F("[MONGO-MQTT] Free heap      : "));
    Serial.println(ESP.getFreeHeap());
    Serial.print(F("[MONGO-MQTT] Max alloc heap : "));
    Serial.println(ESP.getMaxAllocHeap());
    Serial.println(F("╚════════════════════════════════════════════════════════╝"));

    bool ok = publishMongoBufferBatchToMqtt(batchPayload);

    if (!ok) {
      mongoUploadFailCount++;
      mongoUploadLastMqttOk = false;
      Serial.print(F("[MONGO-MQTT] Chunk failed. Remaining buffer kept. state/code="));
      Serial.println(mongoUploadLastHttpCode);
      break;
    }

    if (mongoBufferMutex != NULL) {
      if (xSemaphoreTake(mongoBufferMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
        clearMongoDbBufferNoLock(recordsCount);
        xSemaphoreGive(mongoBufferMutex);
      } else {
        mongoUploadFailCount++;
        mongoUploadLastHttpCode = -204;
        mongoUploadLastMqttOk = false;
        Serial.println(F("[MONGO-MQTT] WARNING: publish OK, but failed to lock buffer for clear."));
        break;
      }
    } else {
      clearMongoDbBufferNoLock(recordsCount);
    }

    totalSentRecords += recordsCount;
    mongoUploadSuccessRecords += recordsCount;
    mongoUploadLastAckedRecords += recordsCount;
    mongoUploadLastAckResponseRecords += recordsCount;
    mongoUploadLastMqttOk = true;

    mongoDbLastSentRecords += recordsCount;
    mongoDbTotalSentRecords += recordsCount;
    mongoDbLastAckResponseRecords += recordsCount;
    mongoDbLastSendMs = millis();

    Serial.print(F("[MONGO-MQTT] Chunk sent OK: "));
    Serial.print(recordsCount);
    Serial.print(F(" records. Total sent this cycle="));
    Serial.print(totalSentRecords);
    Serial.print(F(" / "));
    Serial.println(queuedAtStart);

    chunkIndex++;
    mqtt.loop();
    vTaskDelay(pdMS_TO_TICKS(MONGODB_UPLOAD_CHUNK_DELAY_MS));
  }

  if (totalSentRecords > 0) {
    Serial.print(F("[MONGO-MQTT] Upload cycle sent "));
    Serial.print(totalSentRecords);
    Serial.print(F(" / "));
    Serial.print(queuedAtStart);
    Serial.println(F(" records."));
  }

}
// ============================================================
// MONGODB BUFFER TASK
// ============================================================
// Fungsi:
// - Mengirim buffer RAM MongoDB ke MQTT_TOPIC = gen/data.
// - Pengiriman dilakukan setiap MONGODB_BATCH_INTERVAL_MS.
// - Buffer juga dikirim lebih cepat jika penuh.
// - Realtime dashboard tetap dikirim oleh publishRealtimeData()
//   ke MQTT_REALTIME_TOPIC = gen/realtime setiap 1 detik.

void MongoBufferTask(void *pvParameters) {
  (void) pvParameters;

  lastMongoBatchSend = millis();

  while (true) {
    bool manualRequest = false;

    if (mongoUploadRequestSemaphore != NULL) {
      if (xSemaphoreTake(mongoUploadRequestSemaphore, pdMS_TO_TICKS(1000)) == pdTRUE) {
        manualRequest = true;
      }
    } else {
      vTaskDelay(pdMS_TO_TICKS(1000));
    }

    uint16_t bufferCountSnapshot = 0;

    if (mongoBufferMutex != NULL) {
      if (xSemaphoreTake(mongoBufferMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        bufferCountSnapshot = mongoDbBufferCount;
        xSemaphoreGive(mongoBufferMutex);
      }
    } else {
      bufferCountSnapshot = mongoDbBufferCount;
    }

    bool intervalReached = (millis() - lastMongoBatchSend >= MONGODB_BATCH_INTERVAL_MS);
    bool bufferFull = (bufferCountSnapshot >= MONGODB_BUFFER_RECORDS);

    if ((intervalReached || bufferFull || manualRequest) && bufferCountSnapshot > 0) {
      if (!isWiFiUsableForMongoUpload()) {
        if (serialMongoBufferTickerEnabled) {
          Serial.println(F("[MONGO-MQTT] Batch postponed: WiFi not usable."));
        }

        vTaskDelay(pdMS_TO_TICKS(3000));
        continue;
      }

      if (!mqtt.connected()) {
        reconnectMQTT();

        if (!mqtt.connected()) {
          if (serialMongoBufferTickerEnabled) {
            Serial.println(F("[MONGO-MQTT] Batch postponed: MQTT not connected."));
          }

          vTaskDelay(pdMS_TO_TICKS(3000));
          continue;
        }
      }

      mongoUploadBusy = true;
      mongoUploadQueuedCount = bufferCountSnapshot;
      mongoUploadLastAttemptMs = millis();

      sendMongoDbBufferToMongoDB();

      mongoUploadBusy = false;
      mongoUploadQueuedCount = 0;

      // Jika masih ada sisa buffer karena gagal di tengah,
      // jangan reset timer terlalu agresif.
      if (mongoDbBufferCount == 0) {
        lastMongoBatchSend = millis();
      } else {
        // Coba lagi beberapa detik kemudian.
        lastMongoBatchSend = millis() - MONGODB_BATCH_INTERVAL_MS + 10000UL;
      }

      if (serialMongoBufferTickerEnabled) {
        printMongoBufferStatus();
      }
    }
  }
}
void updateStorageCache() {
  if (!sdOK) return;

  // Cache agar command db tidak melakukan operasi SD berat berulang-ulang.
  if (dbCachedAtMs != 0 && millis() - dbCachedAtMs < 30000UL) return;

  if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(120)) == pdTRUE) {
    deselectAllSPI();

    File f = SD.open(DB_FILE, FILE_READ);
    if (f) {
      dbCachedFileSizeBytes = f.size();
      f.close();
    }

    sdCachedCardSizeBytes = SD.cardSize();

    // SD.usedBytes() relatif berat pada beberapa modul SD/TFT sharing SPI.
    // Dipanggil hanya lewat cache 30 detik agar serial command tidak freeze.
    sdCachedUsedBytes = SD.usedBytes();
    sdCachedFreeBytes = sdCachedCardSizeBytes > sdCachedUsedBytes ? sdCachedCardSizeBytes - sdCachedUsedBytes : 0;
    dbCachedAtMs = millis();

    xSemaphoreGive(sdMutex);
  }
}


bool createFreshCsvFile(const char* path, const char* header, const char* label) {
  deselectAllSPI();

  File f = SD.open(path, FILE_WRITE);
  if (!f) {
    sdDatabaseCreateFailCount++;
    sdLastFileErrorMs = millis();
    Serial.print(F("[SD] GAGAL membuat "));
    Serial.print(path);
    Serial.println(F("."));
    return false;
  }

  f.println(header);
  f.flush();
  f.close();

  sdDatabaseCreateOkCount++;
  sdLastFileOkMs = millis();
  dbCachedAtMs = 0;
  Serial.print(F("[SD] "));
  Serial.print(path);
  Serial.print(F(" berhasil dibuat dengan header "));
  Serial.print(label);
  Serial.println(F("."));
  return true;
}

bool createFreshDatabaseCsv() {
  return createFreshCsvFile(DB_FILE, DB_CSV_HEADER, "CSV database");
}

bool createFreshFftCsv() {
  return createFreshCsvFile(FFT_FILE, FFT_CSV_HEADER, "CSV FFT");
}

bool ensureCsvFileExistsNoLock(const char* path,
                               const char* backupPath,
                               const char* header,
                               const char* requiredHeaderToken,
                               bool (*createFreshFn)()) {
  deselectAllSPI();

  if (!SD.exists(path)) {
    Serial.print(F("[SD] "));
    Serial.print(path);
    Serial.println(F(" belum ada. Membuat file baru..."));
    return createFreshFn();
  }

  File f = SD.open(path, FILE_READ);
  if (!f) {
    Serial.print(F("[SD] "));
    Serial.print(path);
    Serial.println(F(" ada tetapi gagal dibuka. Membuat ulang file..."));
    sdLastFileErrorMs = millis();
    SD.remove(path);
    return createFreshFn();
  }

  String existingHeader = f.readStringUntil('\n');
  f.close();
  existingHeader.trim();

  if (existingHeader != String(header) || existingHeader.indexOf(requiredHeaderToken) < 0) {
    Serial.print(F("[SD] Header "));
    Serial.print(path);
    Serial.println(F(" lama/tidak sesuai. Backup file lama dan buat header baru..."));
    if (SD.exists(backupPath)) SD.remove(backupPath);
    bool backupOk = SD.rename(path, backupPath);
    bool createOk = createFreshFn();
    Serial.println(backupOk
      ? F("[SD] File lama berhasil dibackup.")
      : F("[SD] Backup gagal. File baru tetap dibuat jika memungkinkan."));
    return createOk;
  }

  sdLastFileOkMs = millis();
  return true;
}

bool ensureDatabaseCsvExistsNoLock() {
  return ensureCsvFileExistsNoLock(DB_FILE, DB_BACKUP_FILE, DB_CSV_HEADER, "phase_diff", createFreshDatabaseCsv);
}

bool ensureFftCsvExistsNoLock() {
  return ensureCsvFileExistsNoLock(FFT_FILE, FFT_BACKUP_FILE, FFT_CSV_HEADER, "fft_bins_xy", createFreshFftCsv);
}

bool ensureSdCsvFilesExistNoLock() {
  bool dbOk = ensureDatabaseCsvExistsNoLock();
  bool fftOk = ensureFftCsvExistsNoLock();
  return dbOk && fftOk;
}

bool ensureDatabaseCsvExists() {
  if (!sdOK) return false;

  if (sdMutex == NULL) {
    return ensureSdCsvFilesExistNoLock();
  }

  if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(1500)) != pdTRUE) {
    Serial.println(F("[SD] SD sedang dipakai. Pengecekan file CSV ditunda, bukan dianggap gagal."));
    return false;
  }

  bool ok = ensureSdCsvFilesExistNoLock();
  xSemaphoreGive(sdMutex);
  return ok;
}

void ensureDatabaseCsvHeader() {
  if (!ensureSdCsvFilesExistNoLock()) {
    Serial.println(F("[SD] WARNING: SD init OK, tetapi /database.csv atau /fft.csv belum berhasil dibuat."));
  }
}

void initSDCard() {
  Serial.println();
  Serial.println(F("════════════ SD CARD INIT ════════════"));

  sdOK = false;

  // Mengikuti konfigurasi test SD yang berhasil pada modul TFT ILI9488/ILI9486.
  // SD card on-board TFT memakai HSPI terpisah dan perlu semua CS dinonaktifkan
  // sebelum SD.begin(), terutama karena TFT dan SD berbagi lingkungan SPI.
  pinMode(TFT_CS, OUTPUT);
  pinMode(SD_CS, OUTPUT);

  digitalWrite(TFT_CS, HIGH);
  digitalWrite(SD_CS, HIGH);

  delay(1000);

  sdSPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  delay(300);

  bool begun = false;

  for (uint8_t attempt = 1; attempt <= 10; attempt++) {
    Serial.print(F("SD INIT ATTEMPT "));
    Serial.print(attempt);
    Serial.print(F("/10 ... "));

    digitalWrite(TFT_CS, HIGH);
    digitalWrite(SD_CS, HIGH);
    delay(100);

    if (SD.begin(SD_CS, sdSPI, 400000UL)) {
      if (SD.cardType() != CARD_NONE) {
        begun = true;
        Serial.println(F("OK"));
        break;
      }
    }

    Serial.println(F("FAILED"));
    SD.end();
    delay(500);
  }

  if (!begun) {
    sdOK = false;
    Serial.println(F("SD INIT FAILED FINAL"));
    Serial.println(F("[SD] Cek wiring/pin: CS=26, MOSI=13, MISO=19, SCK=14, format FAT32."));
    Serial.println(F("══════════════════════════════════════"));
    return;
  }

  sdOK = true;
  sdConsecutiveOpenFail = 0;
  sdLastFileOkMs = millis();

  Serial.println(F("[SD] OK."));
  Serial.print(F("[SD] Card type : "));
  uint8_t cardType = SD.cardType();
  if (cardType == CARD_MMC) Serial.println(F("MMC"));
  else if (cardType == CARD_SD) Serial.println(F("SDSC"));
  else if (cardType == CARD_SDHC) Serial.println(F("SDHC"));
  else Serial.println(F("UNKNOWN"));

  Serial.print(F("[SD] Card size : "));
  Serial.println(formatBytes(SD.cardSize()));

  // Test tulis singkat seperti sketch SD test, tetapi memakai nama khusus agar
  // tidak mengganggu database utama.
  File testFile = SD.open("/sd_init_test.txt", FILE_WRITE);
  if (!testFile) {
    Serial.println(F("[SD] OPEN TEST FILE FAILED"));
    sdOK = false;
    sdLastFileErrorMs = millis();
    Serial.println(F("══════════════════════════════════════"));
    return;
  }

  testFile.println(F("SD card test OK"));
  testFile.close();
  Serial.println(F("[SD] WRITE TEST OK"));

  if (sdMutex == NULL || xSemaphoreTake(sdMutex, pdMS_TO_TICKS(3000)) == pdTRUE) {
    ensureDatabaseCsvHeader();
    if (sdMutex != NULL) xSemaphoreGive(sdMutex);
  } else {
    Serial.println(F("[SD] WARNING: mutex masih sibuk saat init; header CSV akan dipastikan saat append berikutnya."));
  }

  updateStorageCache();
  Serial.println(F("══════════════════════════════════════"));
}


String csvEscapeField(const String &value) {
  String out = "\"";
  for (uint16_t i = 0; i < value.length(); i++) {
    char c = value.charAt(i);
    if (c == '\"') out += "\"\"";
    else out += c;
  }
  out += "\"";
  return out;
}

String buildFftBinsCsvField(const FFTData &f) {
  if (!f.valid) return "";

  String bins = "";
  // Reserve secukupnya untuk mengurangi fragmentasi String saat membentuk 32 bin.
  bins.reserve(FFT_BINS_TO_SEND * 16);
  for (uint16_t i = 0; i < FFT_BINS_TO_SEND; i++) {
    if (i) bins += "|";
    bins += String(f.freqBins[i], 3);
    bins += ":";
    bins += String(f.magBins[i], 5);
  }
  return bins;
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

String buildFftCsvLine(const StorageRecord &r) {
  const FFTData &f = r.fft;

  String line = "";
  line += r.recordId; line += ",";
  line += String(r.localSeq); line += ",";
  String csvTimestamp = r.timestamp.length() ? r.timestamp : getCsvTimestampWIBms();
  line += csvTimestamp; line += ",";
  line += String(f.valid ? 1 : 0); line += ",";
  line += getFFTSourceNameById(f.source); line += ",";
  line += String(f.sampleRateHz, 1); line += ",";
  line += String(f.resolutionHz, 3); line += ",";
  line += String(f.peakHz, 3); line += ",";
  line += String(f.peakMagnitude, 5); line += ",";
  line += String(f.rms, 5); line += ",";
  line += csvEscapeField(buildFftBinsCsvField(f));

  return line;
}


void saveSnapshotToSD() {
  // Fungsi ini tetap dipanggil setiap 1 detik, tetapi SD hanya ditulis jika:
  // 1) WiFi/MQTT/server bermasalah,
  // 2) buffer RAM MongoDB penuh/tidak bisa menerima record,
  // 3) test-once mode sedang aktif.
  //
  // Saat koneksi normal:
  // - record masuk RAM buffer MongoDB,
  // - realtime publish tetap ke gen/realtime tiap 1 detik,
  // - database MongoDB/history dikirim batch ke gen/data tiap 2 menit,
  // - SD tidak ditulis agar umur SD lebih panjang dan tidak ada duplikasi lokal.

  if (testOnceMode && (!testOnceAggDone || testOnceSdDone)) return;

  bool hasData = false;
  for (uint8_t i = 0; i < STORAGE_BATCH_SIZE; i++) {
    if (storageBatch[i].valid) hasData = true;
  }
  if (!hasData) return;

  uint32_t saveStart = micros();

  bool backupNeeded = testOnceMode;
  uint8_t validRecords = 0;

  for (uint8_t i = 0; i < STORAGE_BATCH_SIZE; i++) {
    if (!storageBatch[i].valid) continue;
    validRecords++;

    bool acceptedToMongoRam = addRecordToMongoDbBuffer(storageBatch[i]);
    if (shouldBackupRecordToSD(acceptedToMongoRam)) {
      backupNeeded = true;
    }
  }

  if (!backupNeeded) {
    sdBackupSkipOnlineCount += validRecords;

    perfSdSaveUs = micros() - saveStart;
    perfUpdateStat(acqMon.sdSaveUs, perfSdSaveUs);
    return;
  }

  if (!sdOK) {
    sdSaveFailCount++;
    sdLastFileErrorMs = millis();

    perfSdSaveUs = micros() - saveStart;
    perfUpdateStat(acqMon.sdSaveUs, perfSdSaveUs);

    if (serialDatabasePayloadEnabled) {
      Serial.println(F("[SD-BACKUP] Backup dibutuhkan, tetapi SD NOT READY."));
    }
    return;
  }

  if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(1500)) == pdTRUE) {
    if (!ensureSdCsvFilesExistNoLock()) {
      sdSaveFailCount++;
      sdLastFileErrorMs = millis();
      xSemaphoreGive(sdMutex);

      perfSdSaveUs = micros() - saveStart;
      perfUpdateStat(acqMon.sdSaveUs, perfSdSaveUs);
      return;
    }

    deselectAllSPI();

    File file = SD.open(DB_FILE, FILE_APPEND);
    File fftFile = SD.open(FFT_FILE, FILE_APPEND);
    if (!file || !fftFile) {
      sdSaveFailCount++;
      sdConsecutiveOpenFail++;
      sdLastFileErrorMs = millis();

      if (file) file.close();
      if (fftFile) fftFile.close();

      Serial.print(F("[SD-BACKUP] Gagal membuka CSV append (database/fft). consecutiveFail="));
      Serial.println(sdConsecutiveOpenFail);

      if (sdConsecutiveOpenFail >= 5) {
        sdOK = false;
        Serial.println(F("[SD-BACKUP] Append gagal 5x berturut-turut. SD ditandai NOT READY dan akan retry init otomatis."));
      }

      xSemaphoreGive(sdMutex);
      perfSdSaveUs = micros() - saveStart;
      perfUpdateStat(acqMon.sdSaveUs, perfSdSaveUs);
      return;
    }

    sdConsecutiveOpenFail = 0;
    sdLastFileOkMs = millis();

    for (uint8_t i = 0; i < STORAGE_BATCH_SIZE; i++) {
      if (!storageBatch[i].valid) continue;

      String line = buildCsvLine(storageBatch[i]);
      String fftLine = buildFftCsvLine(storageBatch[i]);
      String queueJson = buildJsonRecordParametersOnly(storageBatch[i]);

      file.println(line);
      fftFile.println(fftLine);

      dbLastLineBytes = line.length() + 2;
      dbTotalWrittenBytes += dbLastLineBytes;
      sdBackupRecordCount++;
      cacheLastDatabasePayload(storageBatch[i], line, queueJson);
    }

    file.flush();
    fftFile.flush();
    file.close();
    fftFile.close();

    sdSaveSuccessCount++;

    if (serialDatabasePayloadEnabled && hasLastDatabasePayloadCache) {
      Serial.println(F("[SD-BACKUP] Record disimpan karena jaringan/MQTT/server/buffer bermasalah."));
    }

    if (testOnceMode && !testOnceSdDone) {
      testOnceSdDone = true;
      Serial.println();
      Serial.println(F("╔════════════ TEST-ONCE LOCAL SD BACKUP ════════════╗"));
      Serial.printf("[TEST] 1 record backup tersimpan ke %s dan FFT ke %s. lastRow=%lu bytes\n",
                    DB_FILE, FFT_FILE, (unsigned long)dbLastLineBytes);
      Serial.println(F("[TEST] Pada mode normal, SD hanya ditulis jika WiFi/MQTT/server bermasalah."));
      Serial.println(F("╚═══════════════════════════════════════════════════╝"));
      updateTestOnceCompletion();
    }

    xSemaphoreGive(sdMutex);
  } else {
    sdSaveFailCount++;
    sdLastFileErrorMs = millis();
    Serial.println(F("[SD-BACKUP] SD sedang dipakai task lain. Backup 1 detik ini dilewati."));
  }

  perfSdSaveUs = micros() - saveStart;
  perfUpdateStat(acqMon.sdSaveUs, perfSdSaveUs);

  if (serialDatabasePayloadEnabled && hasLastDatabasePayloadCache) {
    printDatabasePayloadReport(false);
  }

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
#if USE_EDUROAM_FIRST
  #if ESP_ARDUINO_VERSION_MAJOR >= 3
    // Arduino-ESP32 core 3.x menangani WPA2-Enterprise melalui overload
    // WiFi.begin(..., WPA2_AUTH_PEAP, ...). Beberapa paket core 3.x tidak
    // mengekspor API disable EAP, sehingga jangan panggil API itu
    // langsung. WiFi.disconnect()/WiFi.mode(WIFI_OFF) di stopWiFiCleanly()
    // dipakai untuk membersihkan state sebelum fallback WiFiManager.
    return;
  #else
    esp_wifi_sta_wpa2_ent_disable();
  #endif
#else
  // Eduroam dimatikan. Jangan panggil fungsi enterprise agar tidak panic
  // saat WiFi driver belum siap pada beberapa core ESP32.
  return;
#endif
}


// ============================================================
// NETWORK + HEAP STABILITY HELPERS
// ============================================================

void updateHeapMonitor() {
  uint32_t freeHeap = ESP.getFreeHeap();
  uint32_t maxAlloc = ESP.getMaxAllocHeap();

  if (freeHeap < minFreeHeapBytes) {
    minFreeHeapBytes = freeHeap;
  }

  if (maxAlloc < minMaxAllocHeapBytes) {
    minMaxAllocHeapBytes = maxAlloc;
  }
}

bool isWiFiUsableForMongoUpload() {
  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  long rssi = WiFi.RSSI();

  // Jika RSSI terlalu lemah, jangan paksa batch MongoDB.
  // Ini mencegah MQTT publish burst saat koneksi tidak stabil.
  if (rssi != 0 && rssi < WIFI_RSSI_WEAK_DBM) {
    return false;
  }

  return true;
}

void applyWiFiStabilityConfig() {
  WiFi.setSleep(false);
  esp_wifi_set_ps(WIFI_PS_NONE);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
}

void applyMqttStabilityConfig() {
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(MQTT_BUFFER_SIZE_BYTES);
  mqtt.setKeepAlive(MQTT_KEEPALIVE_SEC);
  mqtt.setSocketTimeout(MQTT_SOCKET_TIMEOUT_SEC);
}

const char* wifiStatusText(wl_status_t st);

void stopWiFiCleanly(bool eraseCredentials) {
  Serial.println(F("[WIFI] Stopping current STA connection..."));

  if (mqtt.connected()) {
    mqtt.disconnect();
  }
  mqttOK = false;

  WiFi.setAutoReconnect(false);
  WiFi.disconnect(eraseCredentials, eraseCredentials);
  delay(800);

  WiFi.mode(WIFI_OFF);
  delay(WIFI_MANAGER_SETTLE_MS);

  WiFi.mode(WIFI_STA);
  delay(800);

  applyWiFiStabilityConfig();

  Serial.print(F("[WIFI] Clean state. status="));
  Serial.print((int)WiFi.status());
  Serial.print(F(" / "));
  Serial.println(wifiStatusText(WiFi.status()));
}

void prepareNormalWiFiMode() {
  disableEduroamEnterpriseMode();
  delay(300);

  // Matikan total STA yang masih connecting sebelum fallback ke WiFiManager.
  // eraseCredentials=false agar credential WiFi normal tetap aman.
  stopWiFiCleanly(false);

  applyWiFiStabilityConfig();
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
  if (wifiConnectionMode == WIFI_MODE_EDUROAM) return "EDUROAM WPA2-ENTERPRISE";
  if (wifiConnectionMode == WIFI_MODE_MANAGER) return "WIFI MANAGER PORTAL";
  return "OFFLINE";
}

bool waitForWiFiConnection(const __FlashStringHelper* label, unsigned long timeoutMs) {
  unsigned long startAttempt = millis();
  wl_status_t lastStatus = (wl_status_t)255;

  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < timeoutMs) {
    wl_status_t st = WiFi.status();

    if (st != lastStatus) {
      Serial.print(label);
      Serial.print(F(" status changed: "));
      Serial.print((int)st);
      Serial.print(F(" / "));
      Serial.println(wifiStatusText(st));
      lastStatus = st;
    }

    Serial.print('.');
    delay(WIFI_CONNECT_POLL_MS);
    yield();
  }

  Serial.println();
  return WiFi.status() == WL_CONNECTED;
}

void printWiFiConnectedInfo(const __FlashStringHelper* label) {
  Serial.print(label);
  Serial.println(F(" connected."));
  Serial.print(label);
  Serial.print(F(" SSID : "));
  Serial.println(WiFi.SSID());
  Serial.print(label);
  Serial.print(F(" IP   : "));
  Serial.println(WiFi.localIP());
  Serial.print(label);
  Serial.print(F(" RSSI : "));
  Serial.print(WiFi.RSSI());
  Serial.println(F(" dBm"));
}

bool connectEduroam(bool eraseCredentials = true) {
#if USE_EDUROAM_FIRST
  Serial.println();
  Serial.println("╔══════════════ EDUROAM WIFI INIT BOOT-ONLY ══════════════╗");

  if (!isEduroamCredentialConfigured()) {
    Serial.println("[EDUROAM] SKIP: credential belum valid / masih placeholder.");
    Serial.println("[EDUROAM] Fallback ke WiFiManager portal.");
    Serial.println("╚═══════════════════════════════════════════════════════════╝");
    return false;
  }

  Serial.println("[EDUROAM] Trying WPA2-Enterprise PEAP connection...");
  Serial.print("[EDUROAM] SSID     : "); Serial.println(EDUROAM_SSID);
  Serial.print("[EDUROAM] Identity : "); Serial.println(EDUROAM_IDENTITY);
  Serial.print("[EDUROAM] Username : "); Serial.println(EDUROAM_USERNAME);
  Serial.println("[EDUROAM] Password : ********");

  // Urutan ini mengikuti kode eduroam yang sebelumnya stabil:
  // mode STA -> disable sleep -> disconnect bersih -> disable EAP lama -> begin EAP.
  // Fungsi ini hanya boleh dipanggil saat boot. Runtime reconnect cukup WiFi.reconnect().
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  esp_wifi_set_ps(WIFI_PS_NONE);

  WiFi.disconnect(eraseCredentials, eraseCredentials);
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

  if (waitForWiFiConnection(F("[EDUROAM]"), EDUROAM_TIMEOUT_MS)) {
    wifiOK = true;
    wifiConnectionMode = WIFI_MODE_EDUROAM;

    printWiFiConnectedInfo(F("[EDUROAM]"));
    Serial.println("╚═══════════════════════════════════════════════════════════╝");
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

  // Setelah gagal, bersihkan EAP satu kali lalu fallback ke WiFiManager.
  // Jangan coba eduroam ulang dalam loop karena dapat membuat driver EAP tidak stabil.
  prepareNormalWiFiMode();

  Serial.println("[EDUROAM] Fallback to WiFiManager portal.");
  Serial.println("╚═══════════════════════════════════════════════════════════╝");

  return false;
#else
  return false;
#endif
}

bool connectWiFiManagerFallback() {
  Serial.println();
  Serial.println(F("╔════════════ WIFI MANAGER PORTAL FALLBACK SAFE ════════════╗"));
  Serial.println(F("[WIFI MANAGER] Eduroam gagal. Membuka portal fallback."));
  Serial.println(F("[WIFI MANAGER] startConfigPortal dipakai agar tidak auto-connect credential lama."));

  mqttOK = false;
  wifiOK = false;

  // prepareNormalWiFiMode() sudah membersihkan STA/enterprise state.
  // Pakai urutan konservatif sesuai contoh WiFiManager: kembali ke STA,
  // jangan paksa AP_STA, jangan disconnect ulang, dan jangan panggil
  // esp_wifi_set_ps() tepat sebelum startConfigPortal(). Pada beberapa
  // board/core, perubahan mode AP_STA manual setelah enterprise gagal dapat
  // memicu abort sebelum AP portal sempat aktif.
  WiFi.persistent(false);
  WiFi.setAutoReconnect(false);
  WiFi.mode(WIFI_STA);
  delay(1000);

  static WiFiManager wm;
  wm.setDebugOutput(false);
  wm.setConfigPortalTimeout(WIFI_MANAGER_TIMEOUT_SEC);
  wm.setConnectTimeout(30);
  wm.setConnectRetries(1);

#if FORCE_WIFI_PORTAL
  wm.resetSettings();
#endif

  Serial.print(F("[WIFI MANAGER] AP SSID : "));
  Serial.println(WIFI_MANAGER_AP_NAME);
  Serial.print(F("[WIFI MANAGER] AP PASS : "));
  Serial.println(WIFI_MANAGER_AP_PASS);
  Serial.println(F("[WIFI MANAGER] Starting config portal now..."));

  // startConfigPortal membuka AP portal dan tidak menjalankan autoConnect().
  bool res = wm.startConfigPortal(WIFI_MANAGER_AP_NAME, WIFI_MANAGER_AP_PASS);

  if (res && WiFi.status() == WL_CONNECTED) {
    wifiOK = true;
    wifiConnectionMode = WIFI_MODE_MANAGER;
    applyWiFiStabilityConfig();
    WiFi.persistent(false);

    printWiFiConnectedInfo(F("[WIFI MANAGER]"));
    Serial.println(F("╚════════════════════════════════════════════════════════════╝"));
    return true;
  }

  wifiOK = false;
  wifiConnectionMode = WIFI_MODE_OFFLINE;
  WiFi.persistent(false);

  Serial.println(F("[WIFI MANAGER] Failed / timeout. System tetap jalan offline."));
  Serial.print(F("[WIFI MANAGER] Final WiFi status: "));
  Serial.print((int)WiFi.status());
  Serial.print(F(" / "));
  Serial.println(wifiStatusText(WiFi.status()));
  Serial.println(F("╚════════════════════════════════════════════════════════════╝"));
  return false;
}


void setupWiFiManager() {
  Serial.println();
  Serial.println(F("╔════════════ WIFI CONNECTION INIT ════════════╗"));

  wifiOK = false;
  mqttOK = false;
  wifiConnectionMode = WIFI_MODE_OFFLINE;

#if USE_EDUROAM_FIRST
  Serial.println(F("[WIFI] Mode utama: eduroam WPA2-Enterprise boot-only"));
  Serial.print(F("[WIFI] Target SSID: "));
  Serial.println(EDUROAM_SSID);

  // Eduroam hanya dicoba 1 kali saat boot. Ini mengikuti kode lama yang stabil.
  // Jika gagal, sistem fallback ke WiFiManager. Saat runtime, jangan panggil
  // connectEduroam() lagi; cukup WiFi.reconnect().
  if (connectEduroam(true)) {
    Serial.println(F("[WIFI] Mode koneksi: EDUROAM WPA2-ENTERPRISE"));
    Serial.println(F("╚══════════════════════════════════════════════╝"));
    return;
  }

  Serial.println(F("[WIFI] Eduroam gagal saat boot. Masuk fallback AP WiFiManager."));
#else
  Serial.println(F("[WIFI] USE_EDUROAM_FIRST=0, langsung membuka fallback AP WiFiManager."));
#endif

  // connectEduroam() yang gagal sudah memanggil prepareNormalWiFiMode().
  // Untuk mode tanpa eduroam, tetap bersihkan mode WiFi sebelum portal.
#if !USE_EDUROAM_FIRST
  prepareNormalWiFiMode();
#endif

  if (connectWiFiManagerFallback()) {
    Serial.println(F("[WIFI] Mode koneksi: WIFI MANAGER / SAVED WIFI"));
    Serial.println(F("╚══════════════════════════════════════════════╝"));
    return;
  }

  Serial.println(F("[WIFI] Tidak terkoneksi. Sistem berjalan offline."));
  Serial.println(F("╚══════════════════════════════════════════════╝"));
}


void reconnectMQTT() {
  if (WiFi.status() != WL_CONNECTED) {
    wifiOK = false;
    mqttOK = false;
    return;
  }

  wifiOK = true;

  if (mqtt.connected()) {
    mqttOK = true;
    mqttReconnectBackoffMs = MQTT_RECONNECT_MIN_MS;
    mqtt.loop();
    return;
  }

  mqttOK = false;

  if (millis() - lastReconnect < mqttReconnectBackoffMs) {
    return;
  }

  lastReconnect = millis();
  mqttReconnectAttemptCount++;

  applyMqttStabilityConfig();

  String clientId = String("GENSYS_MONITOR_") + String((uint32_t)ESP.getEfuseMac(), HEX);

  Serial.println();
  Serial.println(F("╔════════════ MQTT RECONNECT ════════════╗"));
  Serial.print(F("[MQTT] Host       : ")); Serial.println(MQTT_HOST);
  Serial.print(F("[MQTT] Port       : ")); Serial.println(MQTT_PORT);
  Serial.print(F("[MQTT] Client     : ")); Serial.println(clientId);
  Serial.print(F("[MQTT] Attempt    : ")); Serial.println(mqttReconnectAttemptCount);
  Serial.print(F("[MQTT] Backoff ms : ")); Serial.println(mqttReconnectBackoffMs);
  Serial.print(F("[MQTT] WiFi RSSI  : ")); Serial.print(WiFi.RSSI()); Serial.println(F(" dBm"));
  Serial.print(F("[MQTT] Free heap  : ")); Serial.println(ESP.getFreeHeap());
  Serial.print(F("[MQTT] Max alloc  : ")); Serial.println(ESP.getMaxAllocHeap());
  Serial.print(F("[MQTT] Connecting : "));

  bool ok = mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS);

  if (ok) {
    mqttOK = true;
    mqttReconnectBackoffMs = MQTT_RECONNECT_MIN_MS;
    Serial.println(F("OK"));
  } else {
    mqttOK = false;
    int state = mqtt.state();

    Serial.print(F("FAILED state="));
    Serial.println(state);

    mqttReconnectBackoffMs *= 2;
    if (mqttReconnectBackoffMs > MQTT_RECONNECT_MAX_MS) {
      mqttReconnectBackoffMs = MQTT_RECONNECT_MAX_MS;
    }
  }

  Serial.println(F("╚════════════════════════════════════════╝"));
}

void checkWiFiStatus() {
  if (millis() - lastWifiCheck < WIFI_RUNTIME_CHECK_MS) {
    return;
  }

  lastWifiCheck = millis();
  updateHeapMonitor();

  bool wasWifiOk = wifiOK;
  wl_status_t st = WiFi.status();

  wifiOK = (st == WL_CONNECTED);

  if (!wifiOK) {
    mqttOK = false;

    if (wasWifiOk) {
      mqttDisconnectRuntimeCount++;

      Serial.println();
      Serial.println(F("╔════════════ WIFI RUNTIME LOST ════════════╗"));
      Serial.print(F("[WIFI] Status        : "));
      Serial.println((int)st);
      Serial.print(F("[WIFI] Free heap     : "));
      Serial.println(ESP.getFreeHeap());
      Serial.print(F("[WIFI] Max alloc     : "));
      Serial.println(ESP.getMaxAllocHeap());
      Serial.println(F("╚═══════════════════════════════════════════╝"));
    }

    // Jangan buka WiFiManager portal di runtime karena blocking.
    // Cukup reconnect credential tersimpan dengan backoff.
    if (millis() - lastRuntimeWifiReconnect >= wifiReconnectBackoffMs) {
      lastRuntimeWifiReconnect = millis();
      wifiReconnectAttemptCount++;

      Serial.println();
      Serial.println(F("╔════════════ WIFI RUNTIME RECONNECT ════════════╗"));
      Serial.print(F("[WIFI] Attempt    : "));
      Serial.println(wifiReconnectAttemptCount);
      Serial.print(F("[WIFI] Backoff ms : "));
      Serial.println(wifiReconnectBackoffMs);
      Serial.print(F("[WIFI] Status     : "));
      Serial.println((int)st);
      Serial.print(F("[WIFI] Mode       : "));
      Serial.println(wifiModeText());

      applyWiFiStabilityConfig();

      if (wifiConnectionMode == WIFI_MODE_EDUROAM) {
        Serial.println(F("[WIFI] Reconnect using existing eduroam session only."));
        Serial.println(F("[WIFI] connectEduroam() is NOT called during runtime to avoid EAP driver abort."));
        WiFi.reconnect();
      } else {
        Serial.println(F("[WIFI] Reconnect using active WiFiManager credential..."));
        WiFi.reconnect();
      }

      Serial.println(F("╚════════════════════════════════════════════════╝"));

      wifiReconnectBackoffMs *= 2;
      if (wifiReconnectBackoffMs > WIFI_RECONNECT_MAX_MS) {
        wifiReconnectBackoffMs = WIFI_RECONNECT_MAX_MS;
      }
    }

    return;
  }

  // WiFi connected.
  wifiReconnectBackoffMs = WIFI_RECONNECT_MIN_MS;
  if (wifiConnectionMode == WIFI_MODE_OFFLINE) {
    wifiConnectionMode = (WiFi.SSID() == EDUROAM_SSID) ? WIFI_MODE_EDUROAM : WIFI_MODE_MANAGER;
  }

  if (!wasWifiOk && wifiOK) {
    Serial.println();
    Serial.println(F("╔════════════ WIFI RUNTIME RECOVERED ════════════╗"));
    Serial.print(F("[WIFI] IP        : "));
    Serial.println(WiFi.localIP());
    Serial.print(F("[WIFI] RSSI      : "));
    Serial.print(WiFi.RSSI());
    Serial.println(F(" dBm"));
    Serial.print(F("[WIFI] Free heap : "));
    Serial.println(ESP.getFreeHeap());
    Serial.println(F("╚════════════════════════════════════════════════╝"));
  }

  applyWiFiStabilityConfig();
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
  perfUpdateStat(acqMon.tftDrawUs, perfTftDrawUs);
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

  static unsigned long lastTouchMs = 0;
  static int lastTouchedPage = -1;

  // Debounce touch agar 1 tap tidak terbaca berkali-kali.
  if (millis() - lastTouchMs < 180UL) return;

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

    lastTouchMs = millis();
    return;
  }

  int targetPage = -1;

  // Area navbar bawah layar.
  // Generator : x 10-155
  // Engine    : x 167-312
  // FFT       : x 324-469
  if (y >= 285 && y <= 320) {
    if (x >= 10 && x <= 155) {
      targetPage = PAGE_GENERATOR;
    } else if (x >= 167 && x <= 312) {
      targetPage = PAGE_ENGINE;
    } else if (x >= 324 && x <= 469) {
      targetPage = PAGE_FFT;
    }
  }

  if (targetPage >= 0) {
    lastTouchMs = millis();

    if (targetPage != activePage) {
      activePage = targetPage;
      needFullRedraw = true;
      lastDraw = 0;   // paksa redraw segera pada loop berikutnya

      Serial.print(F("[TOUCH] Page changed to "));
      if (activePage == PAGE_GENERATOR) Serial.println(F("GENERATOR"));
      else if (activePage == PAGE_ENGINE) Serial.println(F("ENGINE"));
      else Serial.println(F("FFT"));
    }

    lastTouchedPage = targetPage;
  }
}


// ============================================================
// PAPER VALIDATION REPORT FUNCTIONS
// ============================================================
float safePercentFloat(float numerator, float denominator) {
  if (denominator <= 0.0f) return 0.0f;
  return numerator * 100.0f / denominator;
}

void resetPaperValidationCounters() {
  resetAcquisitionMonitorStats();
  sensorMissedDeadlines = 0;
  parseOKCount = 0;
  parseFailCount = 0;
  rxBufferResetCount = 0;
  fastAggCompleted = 0;
  fastAggUnderfilled = 0;

  paperValidationActive = true;
  paperValidationStartMs = millis();
  paperStartFrameReceived = acqMon.frameReceived;
  paperStartFrameValid = acqMon.frameValid;
  paperStartFrameParseFailed = acqMon.frameParseFailed;
  paperStartLostFrame = acqMon.lostFrame;
  paperStartDuplicateFrame = acqMon.duplicateFrame;
  paperStartSdOk = sdSaveSuccessCount;
  paperStartSdFail = sdSaveFailCount;
  paperStartMqttOk = mqttPublishSuccessCount;
  paperStartMqttFail = mqttPublishFailCount;
  paperStartMongoSent = mongoDbTotalSentRecords;
  paperStartMongoFail = mongoUploadFailCount;
  lastPaperTickerMs = millis();

  Serial.println();
  Serial.println(F("╔════════════════ PAPER VALIDATION START ════════════════╗"));
  Serial.println(F("║ Counter pengujian paper di-reset.                     ║"));
  Serial.println(F("║ Jalankan sistem selama durasi uji, lalu ketik: paper  ║"));
  Serial.println(F("║ Rekomendasi: 5-10 menit untuk UART/MQTT/SD, 10 menit  ║"));
  Serial.println(F("║ untuk validasi batch MongoDB.                         ║"));
  Serial.println(F("╚════════════════════════════════════════════════════════╝"));
}

void printPaperCsvSummary(float runtimeSec,
                          float uartAvgMs,
                          float uartMinMs,
                          float uartMaxMs,
                          float uartLossPct,
                          float frameSuccessPct,
                          float sdReliabilityPct,
                          float mqttReliabilityPct,
                          float mongoConsistencyPct,
                          float sensorTaskAvgUs,
                          float csvParseAvgUs,
                          float aggregationAvgUs,
                          float sdAvgUs,
                          float mqttAvgUs,
                          float tftAvgUs,
                          float fftAvgUs,
                          uint32_t mongoRecordBytesNoFft,
                          uint32_t mongoAvgSentRecordBytesNoFft,
                          uint64_t mongoPayload10yNoFft,
                          uint64_t mongoStorage10yNoFft) {
  Serial.println(F("╠════════════ COPYABLE CSV LINE FOR PAPER/EXCEL ════════════╣"));
  Serial.print(F("PAPER_CSV,"));
  Serial.print(runtimeSec, 1); Serial.print(',');
  Serial.print(LINK_BAUD); Serial.print(',');
  Serial.print(uartAvgMs, 2); Serial.print(',');
  Serial.print(uartMinMs, 2); Serial.print(',');
  Serial.print(uartMaxMs, 2); Serial.print(',');
  Serial.print(frameSuccessPct, 2); Serial.print(',');
  Serial.print(uartLossPct, 3); Serial.print(',');
  Serial.print(AGGREGATION_INTERVAL_MS); Serial.print(',');
  Serial.print(publishInterval); Serial.print(',');
  Serial.print(localSaveInterval); Serial.print(',');
  Serial.print(sdReliabilityPct, 2); Serial.print(',');
  Serial.print(mqttReliabilityPct, 2); Serial.print(',');
  Serial.print(mongoConsistencyPct, 2); Serial.print(',');
  Serial.print(sensorTaskAvgUs, 1); Serial.print(',');
  Serial.print(csvParseAvgUs, 1); Serial.print(',');
  Serial.print(aggregationAvgUs, 1); Serial.print(',');
  Serial.print(sdAvgUs, 1); Serial.print(',');
  Serial.print(mqttAvgUs, 1); Serial.print(',');
  Serial.print(tftAvgUs, 1); Serial.print(',');
  Serial.print(fftAvgUs, 1); Serial.print(',');
  Serial.print(mongoRecordBytesNoFft); Serial.print(',');
  Serial.print(mongoAvgSentRecordBytesNoFft); Serial.print(',');
  Serial.print((double)mongoPayload10yNoFft / 1024.0 / 1024.0, 2); Serial.print(',');
  Serial.println((double)mongoStorage10yNoFft / 1024.0 / 1024.0, 2);
}

void printPaperValidationReport() {
  updateStorageCache();

  uint32_t nowMs = millis();
  float runtimeSec = paperValidationActive
                   ? max(1.0f, (nowMs - paperValidationStartMs) / 1000.0f)
                   : max(1.0f, (nowMs - acqMon.startMs) / 1000.0f);

  uint32_t frameReceived = acqMon.frameReceived - paperStartFrameReceived;
  uint32_t frameValid = acqMon.frameValid - paperStartFrameValid;
  uint32_t frameFailed = acqMon.frameParseFailed - paperStartFrameParseFailed;
  uint32_t lostFrame = acqMon.lostFrame - paperStartLostFrame;
  uint32_t duplicateFrame = acqMon.duplicateFrame - paperStartDuplicateFrame;

  uint32_t sdOk = sdSaveSuccessCount - paperStartSdOk;
  uint32_t sdFail = sdSaveFailCount - paperStartSdFail;
  uint32_t mqttOk = mqttPublishSuccessCount - paperStartMqttOk;
  uint32_t mqttFail = mqttPublishFailCount - paperStartMqttFail;
  uint32_t mongoSent = mongoDbTotalSentRecords - paperStartMongoSent;
  uint32_t mongoFail = mongoUploadFailCount - paperStartMongoFail;

  float expectedSdRecords = (float)(sdOk + sdFail); // SD sekarang hanya backup saat jaringan/server bermasalah.
  float sdReliabilityPct = (expectedSdRecords <= 0.0f) ? 100.0f : safePercentFloat((float)sdOk, expectedSdRecords);
  if (sdReliabilityPct > 100.0f) sdReliabilityPct = 100.0f;

  float frameSuccessPct = safePercentFloat((float)frameValid, (float)frameReceived);
  float uartLossPct = safePercentFloat((float)lostFrame, (float)(frameValid + lostFrame));
  float mqttReliabilityPct = safePercentFloat((float)mqttOk, (float)(mqttOk + mqttFail));
  float mongoConsistencyPct = safePercentFloat((float)mongoSent, (float)max(1UL, (unsigned long)sdOk));
  if (mongoConsistencyPct > 100.0f) mongoConsistencyPct = 100.0f;

  float uartAvgMs = perfAvgStat(acqMon.uartFrameIntervalMs);
  float uartMinMs = perfMinStat(acqMon.uartFrameIntervalMs);
  float uartMaxMs = acqMon.uartFrameIntervalMs.count == 0 ? 0.0f : (float)acqMon.uartFrameIntervalMs.maxVal;
  float sensorAvgMs = perfAvgStat(acqMon.sensorIntervalMs);

  float sensorTaskAvgUs = perfAvgStat(acqMon.sensorTaskUs);
  float uartReadAvgUs = perfAvgStat(acqMon.uartReadUs);
  float csvParseAvgUs = perfAvgStat(acqMon.csvParseUs);
  float aggregationAvgUs = perfAvgStat(acqMon.aggregationUs);
  float sdAvgUs = perfAvgStat(acqMon.sdSaveUs);
  float mqttAvgUs = perfAvgStat(acqMon.mqttPublishUs);
  float tftAvgUs = perfAvgStat(acqMon.tftDrawUs);
  float fftAvgUs = perfAvgStat(acqMon.fftComputeUs);

  uint32_t mongoRecordBytesNoFft = getMongoRecordBytesNoFft();
  uint32_t mongoAvgSentRecordBytesNoFft = getMongoAvgSentRecordBytesNoFft();
  uint64_t mongoPayload10yNoFft = estimateMongoPayloadBytesNoFft10Years(mongoAvgSentRecordBytesNoFft);
  uint64_t mongoStorage10yNoFft = estimateMongoStorageBytesNoFft10Years(mongoAvgSentRecordBytesNoFft);
  float mongoRecordsPerSec = 1000.0f / (float)localSaveInterval;

  bool uartIntervalPass = (uartAvgMs > 0.0f && uartAvgMs <= 200.0f);
  bool aggregationPass = (AGGREGATION_INTERVAL_MS >= 100UL && AGGREGATION_INTERVAL_MS <= 1000UL);
  bool mqttIntervalPass = (publishInterval == 1000UL);
  bool sdIntervalPass = (localSaveInterval == 1000UL);
  bool sdReliabilityPass = (sdReliabilityPct >= 99.0f);
  bool mqttReliabilityPass = (mqttReliabilityPct >= 99.0f || (mqttOk == 0 && mqttFail == 0));
  bool packetLossPass = (uartLossPct < 1.0f);
  bool deadlinePass = (sensorMissedDeadlines == 0);
  bool mongoBatchPass = (MONGODB_BATCH_INTERVAL_MS == 120000UL);
  bool localInterfacePass = (perfAvgStat(acqMon.tftDrawUs) > 0.0f || lastTftDrawMs > 0);

  Serial.println();
  Serial.println(F("╔════════════════ IEEE PAPER VALIDATION REPORT ════════════════╗"));
  Serial.print  (F("║ Test runtime                 : ")); Serial.print(runtimeSec, 1); Serial.println(F(" s"));
  Serial.print  (F("║ Device ID                    : ")); Serial.println(DEVICE_ID);

  Serial.println(F("╠════════════ COMMUNICATION PERFORMANCE ═════════════╣"));
  Serial.print  (F("║ UART baud rate               : ")); Serial.print(LINK_BAUD); Serial.println(F(" bps"));
  Serial.print  (F("║ UART frame interval avg      : ")); Serial.print(uartAvgMs, 2); Serial.println(F(" ms"));
  Serial.print  (F("║ UART throughput              : ")); Serial.print(frameReceived / runtimeSec, 2); Serial.print(F(" frame/s | ")); Serial.print(acqMon.rxBytes / runtimeSec, 1); Serial.println(F(" B/s"));
  Serial.print  (F("║ UART packet loss             : ")); Serial.print(uartLossPct, 3); Serial.println(F(" %"));
  Serial.print  (F("║ Frame valid/fail             : ")); Serial.print(frameValid); Serial.print(F(" / ")); Serial.println(frameFailed);
  Serial.print  (F("║ Frame success rate           : ")); Serial.print(frameSuccessPct, 2); Serial.println(F(" %"));
  Serial.print  (F("║ Duplicate frame              : ")); Serial.println(duplicateFrame);
  Serial.print  (F("║ Aggregation interval         : ")); Serial.print(AGGREGATION_INTERVAL_MS); Serial.println(F(" ms")); 
  Serial.print  (F("║ MQTT publish interval        : ")); Serial.print(publishInterval); Serial.println(F(" ms")); 
  Serial.print  (F("║ MQTT delivery reliability    : ")); Serial.print(mqttReliabilityPct, 2); Serial.println(F(" %")); 

  Serial.println(F("╠════════════ DATA MANAGEMENT EVALUATION ═══════════╣"));
  Serial.print  (F("║ SD backup policy             : ")); Serial.println(F("ONLY when WiFi/MQTT/server/buffer problem"));
  Serial.print  (F("║ SD check interval            : ")); Serial.print(localSaveInterval); Serial.println(F(" ms"));
  Serial.print  (F("║ Expected SD backup records   : ")); Serial.println(expectedSdRecords, 0);
  Serial.print  (F("║ Stored SD backup OK/FAIL     : ")); Serial.print(sdOk); Serial.print(F(" / ")); Serial.println(sdFail);
  Serial.print  (F("║ SD backup records total      : ")); Serial.println(sdBackupRecordCount);
  Serial.print  (F("║ SD skipped online total      : ")); Serial.println(sdBackupSkipOnlineCount);
  Serial.print  (F("║ SD logging reliability       : ")); Serial.print(sdReliabilityPct, 2); Serial.println(F(" %"));
  Serial.print  (F("║ Last CSV row size            : ")); Serial.print(dbLastLineBytes); Serial.println(F(" B/record"));
  Serial.print  (F("║ Current SD Card size         : ")); Serial.println(formatBytes(dbCachedFileSizeBytes));
  Serial.print  (F("║ Estimated SD 7 days          : ")); Serial.println(formatBytes((uint64_t)((float)dbLastLineBytes * 86400.0f * 7.0f)));
  Serial.print  (F("║ MongoDB batch interval       : ")); Serial.print(MONGODB_BATCH_INTERVAL_MS / 60000UL); Serial.println(F(" min"));
  Serial.print  (F("║ MongoDB sent records         : ")); Serial.println(mongoSent);
  Serial.print  (F("║ MongoDB failed batch count   : ")); Serial.println(mongoFail);
  Serial.print  (F("║ Last MQTT state              : ")); Serial.println(mongoUploadLastHttpCode);
  Serial.print  (F("║ MongoDB record size          : ")); Serial.print(mongoRecordBytesNoFft); Serial.println(F(" B/record"));
  Serial.print  (F("║ MongoDB avg sent record      : ")); Serial.print(mongoAvgSentRecordBytesNoFft); Serial.println(F(" B/record"));
  Serial.print  (F("║ MongoDB records rate         : ")); Serial.print(mongoRecordsPerSec, 3); Serial.println(F(" record/s"));
  Serial.print  (F("║ Est. MongoDB payload 10 year : ")); Serial.println(formatBytes(mongoPayload10yNoFft));

  Serial.println(F("╠════════════ COMPUTATION PERFORMANCE ══════════╣"));
  Serial.print  (F("║ Sensor interval avg          : ")); Serial.print(sensorAvgMs, 2); Serial.println(F(" ms"));
  Serial.print  (F("║ SensorTask avg               : ")); Serial.print(sensorTaskAvgUs, 1); Serial.println(F(" us"));
  Serial.print  (F("║ UART read avg                : ")); Serial.print(uartReadAvgUs, 1); Serial.println(F(" us"));
  Serial.print  (F("║ CSV parse avg                : ")); Serial.print(csvParseAvgUs, 1); Serial.println(F(" us"));
  Serial.print  (F("║ Aggregation avg              : ")); Serial.print(aggregationAvgUs, 1); Serial.println(F(" us"));
  Serial.print  (F("║ SD append avg                : ")); Serial.print(sdAvgUs, 1); Serial.println(F(" us"));
  Serial.print  (F("║ MQTT publish avg             : ")); Serial.print(mqttAvgUs, 1); Serial.println(F(" us"));
  Serial.print  (F("║ TFT draw avg                 : ")); Serial.print(tftAvgUs, 1); Serial.println(F(" us"));
  Serial.print  (F("║ FFT compute avg              : ")); Serial.print(fftAvgUs, 1); Serial.println(F(" us"));
  Serial.print  (F("║ Missed deadline 20 ms        : ")); Serial.println(sensorMissedDeadlines);


  printPaperCsvSummary(runtimeSec, uartAvgMs, uartMinMs, uartMaxMs, uartLossPct,
                       frameSuccessPct, sdReliabilityPct, mqttReliabilityPct,
                       mongoConsistencyPct, sensorTaskAvgUs, csvParseAvgUs,
                       aggregationAvgUs, sdAvgUs, mqttAvgUs, tftAvgUs, fftAvgUs,
                       mongoRecordBytesNoFft, mongoAvgSentRecordBytesNoFft,
                       mongoPayload10yNoFft, mongoStorage10yNoFft);

  Serial.println(F("╚══════════════════════════════════════════════════════════════╝"));
}

// ============================================================
// SERIAL COMMAND CONSOLE
// ============================================================
void printSerialHelp() {
  Serial.println();
  Serial.println(F("GENSYS CMD: help | paper | paper start | paper ticker on/off | spec/acq | db/database | mongo buffer | send now | perf | fft | latest"));
  Serial.println(F("SERIAL    : monitor overview | monitor overview on/off | raw uart | db payload | db payload full"));
  Serial.println(F("SERIAL    : monitoring payload | monitoring payload full | db payload on/off | monitoring payload on/off | mongo ticker on/off"));
  Serial.println(F("TEST CMD  : test once | test once reset | test once last | test once status | test once off | perf reset"));
  Serial.println(F("LOG CMD   : log acq on | log performance on | log aggregation on | log latest on | log off"));
  Serial.println(F("FFT CMD   : fft source voltgen | fft source voltgrid | fft source rpm"));
  Serial.println(F("DEBUG     : rx raw on/off | rx ok on/off | rx monitor on/off | db reset | db reset confirm"));
  Serial.println(F("MQTT JSON : mqtt payload | mqtt payload now | mqtt payload on | mqtt payload off"));
  Serial.println(F("ALIAS     : json mqtt | json mqtt now | json mqtt on | json mqtt off"));
  Serial.println(F("REKOMENDASI UJI: ketik 'perf reset', tunggu 2-5 menit, lalu ketik 'perf' atau 'db'."));
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


// Estimasi kapasitas MongoDB untuk kebutuhan tabel Data Management IEEE.
// Perhitungan ini memakai JSON parameter-only yang dikirim ke topic gen/data.
// FFT sengaja tidak dihitung karena FFT hanya untuk analisis edge/realtime, bukan record utama MongoDB.
#define MONGODB_ESTIMATION_YEARS 10UL
#define MONGODB_STORAGE_OVERHEAD_FACTOR 1.2f

uint32_t getMongoRecordBytesNoFft() {
  // Prioritas 1: ukuran JSON parameter-only yang terakhir benar-benar disimpan ke buffer MongoDB.
  // lastDatabaseJsonBytesCache sudah merepresentasikan record tanpa FFT dari buildJsonRecordParametersOnly().
  if (lastDatabaseJsonBytesCache > 2) return lastDatabaseJsonBytesCache - 2; // cache menambahkan CR/LF, MQTT tidak mengirim CR/LF

  // Prioritas 2: estimasi dari aggregate terakhir jika belum ada record tersimpan.
  String estimateRecord = buildCloudEstimateRecordOnly();
  return estimateRecord.length();
}

uint32_t getMongoAvgSentRecordBytesNoFft() {
  if (mongoDbLastSentRecords > 0 && mongoDbLastPayloadBytes > 0) {
    return mongoDbLastPayloadBytes / mongoDbLastSentRecords;
  }
  if (mongoUploadLastAckedRecords > 0 && mongoUploadLastPayloadBytes > 0) {
    return mongoUploadLastPayloadBytes / mongoUploadLastAckedRecords;
  }
  return getMongoRecordBytesNoFft();
}

uint64_t estimateMongoPayloadBytesNoFft10Years(uint32_t recordBytes) {
  // 1 record per second mengikuti localSaveInterval = 1000 ms.
  // Jika interval berubah, rumus otomatis menyesuaikan recordsPerDay.
  if (recordBytes == 0) return 0;
  double intervalSec = (double)localSaveInterval / 1000.0;
  if (intervalSec <= 0.0) intervalSec = 1.0;

  double recordsPerDay = 86400.0 / intervalSec;
  double totalBytes = (double)recordBytes * recordsPerDay * 365.0 * (double)MONGODB_ESTIMATION_YEARS * MONGODB_STORAGE_OVERHEAD_FACTOR;
  if (totalBytes < 0.0) totalBytes = 0.0;
  return (uint64_t)totalBytes;
}

uint64_t estimateMongoStorageBytesNoFft10Years(uint32_t recordBytes) {
  // Payload JSON × faktor overhead MongoDB.
  // Faktor overhead mencakup field metadata BSON, struktur dokumen, dan index dasar.
  double payloadBytes = (double)estimateMongoPayloadBytesNoFft10Years(recordBytes);
  return (uint64_t)(payloadBytes * MONGODB_STORAGE_OVERHEAD_FACTOR);
}


void printMongoBufferStatus() {
  uint16_t bufferCount = mongoDbBufferCount;

  Serial.println();
  Serial.println(F("================ MONGODB 10-MIN BUFFER ================"));
  Serial.print  (F("  buffer records : ")); Serial.print(bufferCount); Serial.print(F(" / ")); Serial.println(MONGODB_BUFFER_RECORDS);
  Serial.print  (F("  interval       : ")); Serial.print(MONGODB_BATCH_INTERVAL_MS / 1000UL); Serial.println(F(" s"));
  Serial.print  (F("  topic          : ")); Serial.println(MQTT_TOPIC);
  Serial.print  (F("  last sent      : ")); Serial.print(mongoDbLastSentRecords); Serial.println(F(" records"));
  Serial.print  (F("  total sent     : ")); Serial.print(mongoDbTotalSentRecords); Serial.println(F(" records"));
  Serial.print  (F("  last payload   : ")); Serial.print(mongoDbLastPayloadBytes); Serial.println(F(" B"));
  {
    uint32_t recBytes = getMongoRecordBytesNoFft();
    uint32_t avgSentBytes = getMongoAvgSentRecordBytesNoFft();
    uint64_t payload10y = estimateMongoPayloadBytesNoFft10Years(avgSentBytes);
    uint64_t storage10y = estimateMongoStorageBytesNoFft10Years(avgSentBytes);
    Serial.print  (F("  record size    : ")); Serial.print(avgSentBytes); Serial.println(F(" B/record"));
    Serial.print  (F("  est. payload 10y: ")); Serial.println(formatBytes(payload10y));
    Serial.print  (F("  est. MongoDB 10y: ")); Serial.print(formatBytes(storage10y)); Serial.print(F(" @ overhead x")); Serial.println(MONGODB_STORAGE_OVERHEAD_FACTOR, 1);
  }
  Serial.print  (F("  Publish OK/FAIL: ")); Serial.print(mongoUploadSuccessRecords); Serial.print(F(" / ")); Serial.println(mongoUploadFailCount);
  Serial.print  (F("  last MQTT state  : ")); Serial.println(mongoUploadLastHttpCode);
  Serial.print  (F("  MQTT published   : ")); Serial.print(mongoDbLastAckResponseRecords); Serial.println(F(" records"));
  Serial.print  (F("  buffered total : ")); Serial.println(mongoDbBufferedTotal);
  Serial.print  (F("  overflow count : ")); Serial.println(mongoDbBufferOverflowCount);
  Serial.print  (F("  send busy      : ")); Serial.println(mongoUploadBusy ? F("YES") : F("NO"));
  Serial.print  (F("  send queued    : ")); Serial.println(mongoUploadQueuedCount);
  Serial.print  (F("  last send age  : "));
  if (mongoDbLastSendMs == 0) Serial.println(F("never"));
  else { Serial.print((millis() - mongoDbLastSendMs) / 1000UL); Serial.println(F(" s ago")); }
  Serial.println(F("STATUS: buffer berkurang setelah publish OK ke topic gen/data. Validasi insert MongoDB dilakukan di backend/dashboard."));
  Serial.println(F("NOTE  : Tidak ada HTTP batch; SD tetap arsip lokal, cloud lewat MQTT gen/data."));
  Serial.println(F("======================================================="));
}

void printDatabaseReport() {
  updateStorageCache();
  String cloudParamOnly = buildCloudEstimateRecordOnly();

  const float sdBytesPerSec = (float)dbLastLineBytes * STORAGE_BATCH_SIZE;
  const float sd7d = sdBytesPerSec * 86400.0f * 7.0f;
  const uint32_t cloudRecordBytes = getMongoRecordBytesNoFft();
  const uint32_t cloudAvgSentRecordBytes = getMongoAvgSentRecordBytesNoFft();
  const float cloudBytesPerSec = (float)cloudAvgSentRecordBytes * (1000.0f / (float)localSaveInterval);
  const uint64_t cloudPayload10y = estimateMongoPayloadBytesNoFft10Years(cloudAvgSentRecordBytes);
  const uint64_t cloudStorage10y = estimateMongoStorageBytesNoFft10Years(cloudAvgSentRecordBytes);

  Serial.println();
  Serial.println(F("================ GENSYS DATA MANAGEMENT ================"));
  Serial.println(F("LOCAL SD / CSV"));
  Serial.print  (F("  status          : ")); Serial.println(sdOK ? F("READY") : F("NOT READY"));
  Serial.print  (F("  file            : ")); Serial.println(DB_FILE);
  Serial.print  (F("  fft file        : ")); Serial.println(FFT_FILE);
  Serial.print  (F("  card size       : ")); Serial.println(formatBytes(sdCachedCardSizeBytes));
  Serial.print  (F("  used/free       : ")); Serial.print(formatBytes(sdCachedUsedBytes)); Serial.print(F(" / ")); Serial.println(formatBytes(sdCachedFreeBytes));
  Serial.print  (F("  csv size        : ")); Serial.println(formatBytes(dbCachedFileSizeBytes));
  Serial.print  (F("  last row        : ")); Serial.print(dbLastLineBytes); Serial.println(F(" B/record"));
  Serial.print  (F("  records/sec     : ")); Serial.println(STORAGE_BATCH_SIZE);
  Serial.print  (F("  write rate      : ")); Serial.println(formatBytes((uint64_t)sdBytesPerSec) + F("/s"));
  Serial.print  (F("  est. 7 days     : ")); Serial.println(formatBytes((uint64_t)sd7d));
  Serial.print  (F("  save OK/FAIL    : ")); Serial.print(sdSaveSuccessCount); Serial.print(F(" / ")); Serial.println(sdSaveFailCount);
  Serial.print  (F("  backup records  : ")); Serial.println(sdBackupRecordCount);
  Serial.print  (F("  skipped online  : ")); Serial.println(sdBackupSkipOnlineCount);
  Serial.print  (F("  backup reason   : NET=")); Serial.print(sdBackupBecauseNetworkCount);
  Serial.print(F(" BUF=")); Serial.print(sdBackupBecauseBufferFullCount);
  Serial.print(F(" MONGO=")); Serial.println(sdBackupBecauseMongoFailCount);
  Serial.print  (F("  buffer count    : ")); Serial.print(mongoDbBufferCount); Serial.print(F(" / ")); Serial.println(MONGODB_BUFFER_RECORDS);
  Serial.print  (F("  MQTT send OK/FAIL: ")); Serial.print(mongoUploadSuccessRecords); Serial.print(F(" / ")); Serial.println(mongoUploadFailCount);
  Serial.print  (F("  last MQTT state    : ")); Serial.println(mongoUploadLastHttpCode);
  Serial.println();

  Serial.println(F("CLOUD / MONGODB HISTORY - MQTT BUFFER PUBLISH BATCH (MAIN DATABASE FIELDS ONLY)"));
  Serial.print  (F("  realtime topic  : ")); Serial.println(MQTT_REALTIME_TOPIC);
  Serial.print  (F("  mongo topic     : ")); Serial.println(MQTT_TOPIC);
  Serial.print  (F("  publish path    : ")); Serial.println(F("MQTT publish topic gen/data"));
  Serial.print  (F("  target batch    : ")); Serial.println(MONGODB_BUFFER_RECORDS);
  Serial.print  (F("  buffer count    : ")); Serial.print(mongoDbBufferCount); Serial.print(F(" / ")); Serial.println(MONGODB_BUFFER_RECORDS);
  Serial.print  (F("  interval        : ")); Serial.print(MONGODB_BATCH_INTERVAL_MS / 60000UL); Serial.println(F(" min"));
  Serial.print  (F("  last batch recs : ")); Serial.println(mongoUploadLastBatchRecords);
  Serial.print  (F("  record size     : ")); Serial.print(cloudRecordBytes); Serial.println(F(" B/record"));
  Serial.print  (F("  avg sent record : ")); Serial.print(cloudAvgSentRecordBytes); Serial.println(F(" B/record"));
  Serial.print  (F("  records/sec     : ")); Serial.println(1000.0f / (float)localSaveInterval, 3);
  Serial.print  (F("  param rate      : ")); Serial.println(formatBytes((uint64_t)cloudBytesPerSec) + F("/s"));
  Serial.print  (F("  est. storage 10y: ")); Serial.println(formatBytes(cloudPayload10y));
  Serial.print  (F("  MQTT send OK/FAIL: ")); Serial.print(mongoUploadSuccessRecords); Serial.print(F(" / ")); Serial.println(mongoUploadFailCount);
  Serial.print  (F("  sent total      : ")); Serial.println(mongoDbTotalSentRecords);
  Serial.println(F("========================================================"));
}

void printAcquisitionSpecReport() {
  RawData r;
  AggregatedData a;

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    r = latestRaw;
    a = aggData;
    xSemaphoreGive(dataMutex);
  }

  const float runtimeSec = max(1.0f, (millis() - acqMon.startMs) / 1000.0f);
  const float frameRateHz = acqMon.frameReceived / runtimeSec;
  const float rxBytesPerSec = acqMon.rxBytes / runtimeSec;
  const float frameSuccessRate = acqMon.frameReceived > 0 ? (acqMon.frameValid * 100.0f / acqMon.frameReceived) : 0.0f;

  const float sensorAvgMs = perfAvgStat(acqMon.sensorIntervalMs);
  const float frameAvgMs  = perfAvgStat(acqMon.uartFrameIntervalMs);
  const float taskAvgUs   = perfAvgStat(acqMon.sensorTaskUs);
  const float taskBudgetUs = SENSOR_SAMPLE_INTERVAL_MS * 1000.0f;

  const float cpuAvgPct = taskBudgetUs > 0 ? taskAvgUs * 100.0f / taskBudgetUs : 0.0f;

  const bool uartIntervalPass =
    acqMon.uartFrameIntervalMs.count > 0 &&
    frameAvgMs >= SPEC_ACQ_MIN_INTERVAL_MS &&
    frameAvgMs <= SPEC_ACQ_MAX_INTERVAL_MS;

  const bool recordIntervalPass =
    lastFastAggIntervalMs >= SPEC_ACQ_MIN_INTERVAL_MS &&
    lastFastAggIntervalMs <= SPEC_ACQ_MAX_INTERVAL_MS;

  const bool deadlinePass = sensorMissedDeadlines == 0;
  const bool qualityPass = frameSuccessRate >= 99.0f && acqMon.lostFrame == 0;
  const bool realtimePass = uartIntervalPass && recordIntervalPass && deadlinePass && qualityPass;

  const bool localSavePass =
    localSaveInterval >= SPEC_ACQ_MIN_INTERVAL_MS &&
    localSaveInterval <= SPEC_ACQ_MAX_INTERVAL_MS;

  const bool databaseTargetPass =
    publishInterval == SPEC_DATABASE_TARGET_MS ||
    MONGODB_BATCH_INTERVAL_MS == SPEC_DATABASE_TARGET_MS;

  Serial.println();
  Serial.println(F("╔════════════════ GENSYS SPEC & ACQUISITION TEST ════════════════╗"));

  Serial.println(F("║ [1] SPESIFIKASI YANG DIUJI                                      ║"));
  Serial.print  (F("║ Akuisisi real-time target     : "));
  Serial.print(SPEC_ACQ_MIN_INTERVAL_MS); Serial.print(F("-")); Serial.print(SPEC_ACQ_MAX_INTERVAL_MS); Serial.println(F(" ms"));
  Serial.print  (F("║ SensorTask internal target    : ")); Serial.print(SENSOR_SAMPLE_INTERVAL_MS); Serial.println(F(" ms"));
  Serial.print  (F("║ UART ESP32-1 expected         : ")); Serial.print(LINK_EXPECTED_FRAME_INTERVAL_MS); Serial.println(F(" ms"));
  Serial.print  (F("║ Record lokal/SD interval      : ")); Serial.print(localSaveInterval); Serial.println(F(" ms"));
  Serial.print  (F("║ Target database online        : ")); Serial.print(SPEC_DATABASE_TARGET_MS / 60000UL); Serial.println(F(" menit"));
  Serial.print  (F("║ MQTT publish saat ini         : ")); Serial.print(publishInterval); Serial.println(F(" ms"));
  Serial.print  (F("║ MongoDB buffer interval       : ")); Serial.print(MONGODB_BATCH_INTERVAL_MS); Serial.println(F(" ms"));

  Serial.println(F("║ [2] PARAMETER MONITORING TERSEDIA                               ║"));
  Serial.print  (F("║ Kelistrikan : V=")); Serial.print(r.volt, 2);
  Serial.print  (F(" V | I=")); Serial.print(r.currentA, 2);
  Serial.print  (F(" A | P=")); Serial.print(r.powerKW, 3);
  Serial.print  (F(" kW | f=")); Serial.print(r.freq, 3);
  Serial.print  (F(" Hz | phase=")); Serial.print(r.phaseAngle, 2); Serial.println(F(" deg"));
  Serial.print  (F("║ Mesin       : RPM=")); Serial.print(r.rpm);
  Serial.print  (F(" | CLT=")); Serial.print(r.clt);
  Serial.print  (F(" C | IAT=")); Serial.print(r.iat);
  Serial.print  (F(" C | MAP=")); Serial.print(r.map);
  Serial.print  (F(" kPa | AFR=")); Serial.println(r.afr, 2);

  Serial.println(F("║ [3] TIMING AKUISISI                                              ║"));
  Serial.print  (F("║ Sensor interval avg         : "));
  Serial.print(sensorAvgMs, 2); Serial.println(F(" ms"));
  Serial.print  (F("║ UART frame avg              : "));
  Serial.print(frameAvgMs, 2); Serial.println(F(" ms"));
  Serial.print  (F("║ UART noise/overflow/resync  : "));
  Serial.print(acqMon.rxNoiseBytes); Serial.print(F(" / "));
  Serial.print(acqMon.rxOverflowReset); Serial.print(F(" / "));
  Serial.println(acqMon.rxResyncCount);
  Serial.print  (F("║ Last 1s aggregation interval: ")); Serial.print(lastFastAggIntervalMs); Serial.println(F(" ms"));
  Serial.print  (F("║ Last 1s aggregation samples : ")); Serial.print(lastFastAggSamples); Serial.println(F(" sample"));

  Serial.println(F("║ [4] WAKTU EKSEKUSI KOMPUTASI                                     ║"));
  Serial.print  (F("║ UART read avg               : ")); Serial.print(perfAvgStat(acqMon.uartReadUs), 1); Serial.println(F(" us"));
  Serial.print  (F("║ CSV parse avg               : ")); Serial.print(perfAvgStat(acqMon.csvParseUs), 1); Serial.println(F(" us"));
  Serial.print  (F("║ Aggregation avg             : ")); Serial.print(perfAvgStat(acqMon.aggregationUs), 1); Serial.println(F(" us"));
  Serial.print  (F("║ FFT compute avg             : ")); Serial.print(perfAvgStat(acqMon.fftComputeUs), 1); Serial.println(F(" us"));
  Serial.print  (F("║ SensorTask total avg        : ")); Serial.print(taskAvgUs, 1); Serial.println(F(" us"));
  Serial.print  (F("║ CPU usage est. avg          : ")); Serial.print(cpuAvgPct, 2); Serial.println(F(" %"));

  Serial.println(F("║ [5] DATA QUALITY & THROUGHPUT                                     ║"));
  Serial.print  (F("║ Frame RX valid/fail         : ")); Serial.print(acqMon.frameValid); Serial.print(F(" / ")); Serial.println(acqMon.frameParseFailed);
  Serial.print  (F("║ Frame received total        : ")); Serial.println(acqMon.frameReceived);
  Serial.print  (F("║ Lost / duplicate frame      : ")); Serial.print(acqMon.lostFrame); Serial.print(F(" / ")); Serial.println(acqMon.duplicateFrame);
  Serial.print  (F("║ Success rate                : ")); Serial.print(frameSuccessRate, 2); Serial.println(F(" %"));
  Serial.print  (F("║ RX throughput               : ")); Serial.print(frameRateHz, 2); Serial.print(F(" frame/s | ")); Serial.print(rxBytesPerSec, 1); Serial.println(F(" B/s"));
  Serial.print  (F("║ Raw frame current           : ")); Serial.print(acqMon.lastRawFrameBytes); Serial.println(F(" B"));

  Serial.println(F("║ [6] MONITORING, STORAGE, DAN DATABASE                             ║"));
  Serial.print  (F("║ TFT draw avg                : ")); Serial.print(perfAvgStat(acqMon.tftDrawUs), 1); Serial.println(F(" us"));
  Serial.print  (F("║ SD append avg               : ")); Serial.print(perfAvgStat(acqMon.sdSaveUs), 1); Serial.println(F(" us"));
  Serial.print  (F("║ MQTT publish avg            : ")); Serial.print(perfAvgStat(acqMon.mqttPublishUs), 1); Serial.println(F(" us"));
  Serial.print  (F("║ SD row size / file size     : ")); Serial.print(dbLastLineBytes); Serial.print(F(" B / ")); Serial.println(formatBytes(dbCachedFileSizeBytes));
  Serial.print  (F("║ MQTT payload last           : ")); Serial.print(mqttLastPayloadBytes); Serial.print(F(" B, records=")); Serial.println(mqttLastRecordsSent);

  Serial.println(F("║ [7] HASIL KETERCAPAIAN                                            ║"));
  Serial.print  (F("║ Akuisisi UART 0.1-1 s       : ")); Serial.println(passFailText(uartIntervalPass));
  Serial.print  (F("║ Record monitoring 0.1-1 s   : ")); Serial.println(passFailText(recordIntervalPass));
  Serial.print  (F("║ Deadline SensorTask 20 ms   : ")); Serial.println(passFailText(deadlinePass));
  Serial.print  (F("║ Kualitas data UART          : ")); Serial.println(passFailText(qualityPass));
  Serial.print  (F("║ Penyimpanan lokal 7 hari    : ")); Serial.println(passFailText(localSavePass && sdOK));
  Serial.print  (F("║ Interval database 2 menit   : ")); Serial.println(passFailText(databaseTargetPass));
  Serial.print  (F("║ OVERALL REAL-TIME MONITOR   : ")); Serial.println(passFailText(realtimePass));

  if (!databaseTargetPass) {
    Serial.println(F("║ CATATAN: MONGODB_BATCH_INTERVAL_MS belum 2 menit. Cek nilai macro timing.        ║"));
  }

  Serial.println(F("╚═════════════════════════════════════════════════════════════════════╝"));
}


void printPerformanceReport() {
  updateStorageCache();

  const float runtimeSec = max(1.0f, (millis() - acqMon.startMs) / 1000.0f);
  const float frameRateHz = acqMon.frameReceived / runtimeSec;
  const float rxBytesPerSec = acqMon.rxBytes / runtimeSec;
  const float frameSuccessRate = acqMon.frameReceived > 0
                               ? (acqMon.frameValid * 100.0f / acqMon.frameReceived)
                               : 0.0f;

  const float sensorAvgMs = perfAvgStat(acqMon.sensorIntervalMs);
  const float uartAvgMs   = perfAvgStat(acqMon.uartFrameIntervalMs);

  const float budgetUs = SENSOR_SAMPLE_INTERVAL_MS * 1000.0f;
  const float sensorTaskAvgUs = perfAvgStat(acqMon.sensorTaskUs);
  const float sensorTaskAvgPct = budgetUs > 0 ? (sensorTaskAvgUs * 100.0f / budgetUs) : 0.0f;

  String cloudParamOnly = buildCloudEstimateRecordOnly();
  const float sdRowBytes = dbLastLineBytes > 0 ? (float)dbLastLineBytes : 0.0f;
  const float sdBytesPerSec = sdRowBytes * STORAGE_BATCH_SIZE;
  const float sdPerDay = sdBytesPerSec * 86400.0f;
  const float sd7d = sdPerDay * 7.0f;

  const uint32_t cloudRecordBytes = getMongoRecordBytesNoFft();
  const uint32_t cloudAvgSentRecordBytes = getMongoAvgSentRecordBytesNoFft();
  const float cloudBytesPerSec = (float)cloudAvgSentRecordBytes * (1000.0f / (float)localSaveInterval);
  const float cloudBatchCapacityPer2Min = (float)MONGODB_BATCH_RECORDS;
  const float cloudBatchGeneratedPer10Min = (600000.0f / (float)localSaveInterval) * STORAGE_BATCH_SIZE;
  const float cloudBatchPayloadEstimate = (float)cloudAvgSentRecordBytes * min(cloudBatchGeneratedPer10Min, cloudBatchCapacityPer2Min);
  const uint64_t cloudPayload10y = estimateMongoPayloadBytesNoFft10Years(cloudAvgSentRecordBytes);
  const uint64_t cloudStorage10y = estimateMongoStorageBytesNoFft10Years(cloudAvgSentRecordBytes);

  Serial.println();
  Serial.println(F("╔════════════════════ GENSYS PERFORMANCE + DATABASE ESTIMATE ═══════════════════╗"));
  Serial.println(F("║ [1] PERFORMA AKUISISI DATA                                                    ║"));
  Serial.print  (F("║ Runtime monitor              : ")); Serial.print(runtimeSec, 1); Serial.println(F(" s"));
  Serial.print  (F("║ Target SensorTask            : ")); Serial.print(SENSOR_SAMPLE_INTERVAL_MS); Serial.println(F(" ms / 50 Hz"));
  Serial.print  (F("║ Sensor interval avg          : ")); Serial.print(sensorAvgMs, 1); Serial.println(F(" ms"));
  Serial.print  (F("║ UART frame interval avg      : ")); Serial.print(uartAvgMs, 1); Serial.println(F(" ms"));
  Serial.print  (F("║ UART throughput              : ")); Serial.print(frameRateHz, 2); Serial.print(F(" frame/s | ")); Serial.print(rxBytesPerSec, 1); Serial.println(F(" B/s"));
  Serial.print  (F("║ Raw frame current            : ")); Serial.print(acqMon.lastRawFrameBytes); Serial.println(F(" B"));
  Serial.print  (F("║ Frame RX valid/fail          : ")); Serial.print(acqMon.frameValid); Serial.print(F(" / ")); Serial.println(acqMon.frameParseFailed);
  Serial.print  (F("║ UART noise/overflow/resync   : "));
  Serial.print(acqMon.rxNoiseBytes); Serial.print(F(" / "));
  Serial.print(acqMon.rxOverflowReset); Serial.print(F(" / "));
  Serial.println(acqMon.rxResyncCount);
  Serial.print  (F("║ Frame success rate           : ")); Serial.print(frameSuccessRate, 2); Serial.println(F(" %"));
  Serial.print  (F("║ Lost / duplicate frame       : ")); Serial.print(acqMon.lostFrame); Serial.print(F(" / ")); Serial.println(acqMon.duplicateFrame);
  Serial.print  (F("║ Buffer reset                 : ")); Serial.println((uint32_t)rxBufferResetCount);
  Serial.print  (F("║ Last RX age                  : ")); Serial.print(perfLastRxAgeMs); Serial.println(F(" ms"));

  Serial.println(F("║ [2] WAKTU KOMPUTASI PER FUNGSI                                                 ║"));
  Serial.print  (F("║ UART read avg                : ")); Serial.print(perfAvgStat(acqMon.uartReadUs), 1); Serial.println(F(" us"));
  Serial.print  (F("║ CSV parse avg                : ")); Serial.print(perfAvgStat(acqMon.csvParseUs), 1); Serial.println(F(" us"));
  Serial.print  (F("║ Aggregation avg              : ")); Serial.print(perfAvgStat(acqMon.aggregationUs), 1); Serial.println(F(" us"));
  Serial.print  (F("║ FFT compute avg              : ")); Serial.print(perfAvgStat(acqMon.fftComputeUs), 1); Serial.println(F(" us"));
  Serial.print  (F("║ JSON build last              : ")); Serial.print(perfJsonBuildUs); Serial.println(F(" us"));
  Serial.print  (F("║ MQTT publish avg             : ")); Serial.print(perfAvgStat(acqMon.mqttPublishUs), 1); Serial.println(F(" us"));
  Serial.print  (F("║ SD append avg                : ")); Serial.print(perfAvgStat(acqMon.sdSaveUs), 1); Serial.println(F(" us"));
  Serial.print  (F("║ TFT draw avg                 : ")); Serial.print(perfAvgStat(acqMon.tftDrawUs), 1); Serial.println(F(" us"));
  Serial.print  (F("║ SensorTask avg budget        : ")); Serial.print(sensorTaskAvgUs, 1); Serial.print(F(" us = ")); Serial.print(sensorTaskAvgPct, 1); Serial.println(F("%"));
  Serial.print  (F("║ Missed deadline 20 ms        : ")); Serial.println((uint32_t)sensorMissedDeadlines);
  Serial.print  (F("║ FastAgg OK/underfilled       : ")); Serial.print((uint32_t)fastAggCompleted); Serial.print(F(" / ")); Serial.println((uint32_t)fastAggUnderfilled);
  Serial.print  (F("║ Last aggregation samples/int : ")); Serial.print((uint32_t)lastFastAggSamples); Serial.print(F(" sample / ")); Serial.print((uint32_t)lastFastAggIntervalMs); Serial.println(F(" ms"));

  Serial.println(F("║ [3] ESTIMASI DATABASE LOKAL SD CARD                                             ║"));
  Serial.print  (F("║ File CSV                     : ")); Serial.println(DB_FILE);
  Serial.print  (F("║ SD status                    : ")); Serial.println(sdOK ? F("READY") : F("NOT READY"));
  Serial.print  (F("║ Card size                    : ")); Serial.println(formatBytes(sdCachedCardSizeBytes));
  Serial.print  (F("║ Used / free                  : ")); Serial.print(formatBytes(sdCachedUsedBytes)); Serial.print(F(" / ")); Serial.println(formatBytes(sdCachedFreeBytes));
  Serial.print  (F("║ Current CSV size             : ")); Serial.println(formatBytes(dbCachedFileSizeBytes));
  Serial.print  (F("║ Last CSV row                 : ")); Serial.print(dbLastLineBytes); Serial.println(F(" B/record, tanpa kolom FFT"));
  Serial.print  (F("║ Local save interval          : ")); Serial.print(localSaveInterval); Serial.println(F(" ms"));
  Serial.print  (F("║ Local record rate            : ")); Serial.print(STORAGE_BATCH_SIZE); Serial.println(F(" record/s"));
  Serial.print  (F("║ Estimated SD rate            : ")); Serial.println(formatBytes((uint64_t)sdBytesPerSec) + F("/s"));
  Serial.print  (F("║ Estimated SD per day         : ")); Serial.println(formatBytes((uint64_t)sdPerDay));
  Serial.print  (F("║ Estimated SD 7 days          : ")); Serial.println(formatBytes((uint64_t)sd7d));
  Serial.print  (F("║ SD save OK/FAIL              : ")); Serial.print(sdSaveSuccessCount); Serial.print(F(" / ")); Serial.println(sdSaveFailCount);

  Serial.println(F("║ [4] ESTIMASI DATABASE CLOUD MONGODB                                             ║"));
  Serial.print  (F("║ Realtime MQTT dashboard      : every ")); Serial.print(publishInterval); Serial.println(F(" ms"));
  Serial.print  (F("║ MongoDB buffer send interval : ")); Serial.print(MONGODB_BATCH_INTERVAL_MS / 60000UL); Serial.println(F(" min"));
  Serial.print  (F("║ Target records per batch     : ")); Serial.println(MONGODB_BUFFER_RECORDS);
  Serial.print  (F("║ Current buffer count         : ")); Serial.print(mongoDbBufferCount); Serial.print(F(" / ")); Serial.println(MONGODB_BUFFER_RECORDS);
  Serial.print  (F("║ Generated records / 10 min   : ")); Serial.println(cloudBatchGeneratedPer10Min, 0);
  Serial.print  (F("║ Estimated cloud batch payload: ")); Serial.println(formatBytes((uint64_t)cloudBatchPayloadEstimate));
  Serial.print  (F("║ MongoDB record size          : ")); Serial.print(cloudRecordBytes); Serial.println(F(" B/record, tanpa FFT"));
  Serial.print  (F("║ MongoDB avg sent record      : ")); Serial.print(cloudAvgSentRecordBytes); Serial.println(F(" B/record, tanpa FFT"));
  Serial.print  (F("║ Effective cloud data rate    : ")); Serial.println(formatBytes((uint64_t)cloudBytesPerSec) + F("/s"));
  Serial.print  (F("║ Estimated payload 10 years   : ")); Serial.println(formatBytes(cloudPayload10y));
  Serial.print  (F("║ Estimated MongoDB 10 years   : ")); Serial.print(formatBytes(cloudStorage10y)); Serial.print(F(" @ overhead x")); Serial.println(MONGODB_STORAGE_OVERHEAD_FACTOR, 1);
  Serial.println(F("║ Note: estimation excludes FFT and uses parameter-only gen/data records."));
  Serial.print  (F("║ Last MongoDB batch/payload   : ")); Serial.print(mongoUploadLastBatchRecords); Serial.print(F(" record / ")); Serial.println(formatBytes(mongoUploadLastPayloadBytes));
  Serial.print  (F("║ MongoDB sent total           : ")); Serial.println(mongoDbTotalSentRecords);
  Serial.print  (F("║ MQTT send OK/FAIL            : ")); Serial.print(mongoUploadSuccessRecords); Serial.print(F(" / ")); Serial.println(mongoUploadFailCount);
  Serial.print  (F("║ Last MQTT state           : ")); Serial.println(mongoUploadLastHttpCode);
  Serial.println(F("╚════════════════════════════════════════════════════════════════════════════════╝"));
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

void printSdFileCheck() {
  Serial.println();
  Serial.println(F("╔════════════════ SD FILE CHECK ════════════════╗"));
  Serial.print  (F("║ sdOK                         : ")); Serial.println(sdOK ? F("READY") : F("NOT READY"));
  Serial.print  (F("║ DB_FILE                      : ")); Serial.println(DB_FILE);
  Serial.print  (F("║ FFT_FILE                     : ")); Serial.println(FFT_FILE);
  Serial.print  (F("║ Save OK/FAIL                 : ")); Serial.print(sdSaveSuccessCount); Serial.print(F(" / ")); Serial.println(sdSaveFailCount);
  Serial.print  (F("║ DB create OK/FAIL            : ")); Serial.print(sdDatabaseCreateOkCount); Serial.print(F(" / ")); Serial.println(sdDatabaseCreateFailCount);
  Serial.print  (F("║ Consecutive append fail      : ")); Serial.println(sdConsecutiveOpenFail);
  Serial.print  (F("║ Last file OK age             : ")); Serial.print(sdLastFileOkMs ? millis() - sdLastFileOkMs : 0); Serial.println(F(" ms"));
  Serial.print  (F("║ Last file error age          : ")); Serial.print(sdLastFileErrorMs ? millis() - sdLastFileErrorMs : 0); Serial.println(F(" ms"));

  if (!sdOK) {
    Serial.println(F("║ SD belum ready menurut variabel sdOK. Coba command: sd reinit"));
    Serial.println(F("╚═══════════════════════════════════════════════╝"));
    return;
  }

  if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(500)) != pdTRUE) {
    Serial.println(F("║ SD mutex busy. Coba ulangi beberapa detik lagi."));
    Serial.println(F("╚═══════════════════════════════════════════════╝"));
    return;
  }

  deselectAllSPI();

  bool dbExists = SD.exists(DB_FILE);
  bool fftExists = SD.exists(FFT_FILE);
  Serial.print  (F("║ database.csv exist           : ")); Serial.println(dbExists ? F("YES") : F("NO"));
  Serial.print  (F("║ fft.csv exist                : ")); Serial.println(fftExists ? F("YES") : F("NO"));

  if (dbExists) {
    File f = SD.open(DB_FILE, FILE_READ);
    if (f) {
      Serial.print(F("║ database.csv size            : "));
      Serial.print(f.size());
      Serial.println(F(" bytes"));
      String header = f.readStringUntil('\n');
      header.trim();
      Serial.print(F("║ database header parameter-only: "));
      Serial.println(header.indexOf("fft_bins_xy") < 0 ? F("YES") : F("NO"));
      f.close();
    } else {
      Serial.println(F("║ database.csv open            : FAILED"));
    }
  }

  if (fftExists) {
    File ff = SD.open(FFT_FILE, FILE_READ);
    if (ff) {
      Serial.print(F("║ fft.csv size                 : "));
      Serial.print(ff.size());
      Serial.println(F(" bytes"));
      String header = ff.readStringUntil('\n');
      header.trim();
      Serial.print(F("║ fft header has fft_bins_xy   : "));
      Serial.println(header.indexOf("fft_bins_xy") >= 0 ? F("YES") : F("NO"));
      ff.close();
    } else {
      Serial.println(F("║ fft.csv open                 : FAILED"));
    }
  }


  xSemaphoreGive(sdMutex);
  Serial.println(F("╚═══════════════════════════════════════════════╝"));
}

void createDatabaseCsvFromCommand() {
  if (!sdOK) {
    Serial.println(F("[DB] SD not ready. Coba command: sd reinit"));
    return;
  }

  if (ensureDatabaseCsvExists()) {
    sdConsecutiveOpenFail = 0;
    sdOK = true;
    updateStorageCache();
    Serial.println(F("[DB] /database.csv dan /fft.csv siap."));
  } else {
    Serial.println(F("[DB] Gagal membuat/mengecek /database.csv."));
  }
}

void reinitSdFromCommand() {
  Serial.println(F("[SD] Manual reinit diminta."));
  sdOK = false;
  sdConsecutiveOpenFail = 0;
  initSDCard();
  needFullRedraw = true;
}

void resetSDDatabase() {
  if (!sdOK) { Serial.println(F("[DB] SD not ready.")); return; }
  if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(500)) == pdTRUE) {
    deselectAllSPI();
    if (SD.exists(DB_FILE)) SD.remove(DB_FILE);
    if (SD.exists(FFT_FILE)) SD.remove(FFT_FILE);
    if (createFreshDatabaseCsv() && createFreshFftCsv()) {
      dbTotalWrittenBytes = 0; dbLastLineBytes = 0; sdSaveSuccessCount = 0; sdSaveFailCount = 0; sdConsecutiveOpenFail = 0; mongoUploadSuccessRecords = 0; mongoUploadFailCount = 0; mongoUploadLastHttpCode = 0; mongoUploadLastAckedRecords = 0; mongoUploadLastAttemptMs = 0; mongoUploadLastBatchRecords = 0; mongoUploadLastPayloadBytes = 0; mongoUploadLastRunChunks = 0; mongoUploadLastRunRecords = 0; mongoUploadLastAckResponseRecords = 0; hasLastDatabasePayloadCache = false; lastSdCsvLineCache = ""; lastSdQueueJsonCache = ""; mongoDbBufferCount = 0; mongoDbBufferedTotal = 0; mongoDbBufferOverflowCount = 0; mongoDbLastSentRecords = 0; mongoDbTotalSentRecords = 0; mongoDbLastPayloadBytes = 0; mongoDbLastAckResponseRecords = 0; mongoDbLastSendMs = 0;
      Serial.println(F("[DB] database.csv dan fft.csv reset OK."));
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
  if (serialLogSensorEnabled) printAcquisitionSpecReport();
  if (serialLogFFTEnabled) printFFTReport();
  if (serialLogLatestEnabled) printLatestDataReport();
  if (serialMonitorOverviewEnabled) printSerialMonitoringOverview();
  if (serialMongoBufferTickerEnabled) printMongoBufferStatus();
}

void printDbSizeTicker() {
  printDatabaseReport();
}

void processSerialCommand(String cmd) {
  cmd.trim(); cmd.toLowerCase();
  if (cmd.length() == 0) return;

  if (cmd == "help") printSerialHelp();
  else if (cmd == "paper" || cmd == "paper report" || cmd == "validation" || cmd == "paper validation") printPaperValidationReport();
  else if (cmd == "paper start" || cmd == "validation start" || cmd == "paper reset") resetPaperValidationCounters();
  else if (cmd == "paper ticker on") { paperTickerEnabled = true; lastPaperTickerMs = millis(); Serial.println(F("[PAPER] ticker ON. Report tampil setiap 60 detik.")); }
  else if (cmd == "paper ticker off") { paperTickerEnabled = false; Serial.println(F("[PAPER] ticker OFF.")); }
  else if (cmd == "database" || cmd == "db" || cmd == "db estimate" || cmd == "database estimate" || cmd == "storage estimate") printDatabaseReport();
  else if (cmd == "sd check" || cmd == "db check" || cmd == "file check") printSdFileCheck();
  else if (cmd == "db create" || cmd == "database create" || cmd == "create db" || cmd == "create database") createDatabaseCsvFromCommand();
  else if (cmd == "sd reinit" || cmd == "sd retry" || cmd == "reinit sd") reinitSdFromCommand();
  else if (cmd == "mongo" || cmd == "mongo buffer" || cmd == "buffer") printMongoBufferStatus();
  else if (cmd == "monitor overview" || cmd == "serial monitor" || cmd == "monitor all" || cmd == "status all") printSerialMonitoringOverview();
  else if (cmd == "monitor overview on" || cmd == "serial monitor on" || cmd == "monitor all on") { serialLogEnabled = true; serialMonitorOverviewEnabled = true; Serial.println(F("[SERIAL] overview ON. Ringkasan RAW+AGG+MQTT+BUFFER tampil berkala.")); }
  else if (cmd == "monitor overview off" || cmd == "serial monitor off" || cmd == "monitor all off") { serialMonitorOverviewEnabled = false; Serial.println(F("[SERIAL] overview OFF.")); }
  else if (cmd == "raw uart" || cmd == "uart raw" || cmd == "rx raw now") printLastRxReportFromCache();
  else if (cmd == "db payload" || cmd == "database payload" || cmd == "storage payload") printDatabasePayloadReport(false);
  else if (cmd == "db payload full" || cmd == "database payload full" || cmd == "storage payload full") printDatabasePayloadReport(true);
  else if (cmd == "monitoring payload" || cmd == "realtime payload" || cmd == "mqtt realtime") printRealtimeMonitoringPayloadReport(false);
  else if (cmd == "monitoring payload full" || cmd == "realtime payload full" || cmd == "mqtt realtime full") printRealtimeMonitoringPayloadReport(true);
  else if (cmd == "db payload on") { serialDatabasePayloadEnabled = true; Serial.println(F("[DB] payload monitor ON. Setiap SD save menampilkan ringkasan payload database.")); }
  else if (cmd == "db payload off") { serialDatabasePayloadEnabled = false; Serial.println(F("[DB] payload monitor OFF.")); }
  else if (cmd == "monitoring payload on" || cmd == "realtime payload on") { serialRealtimePayloadEnabled = true; Serial.println(F("[MQTT] realtime monitoring payload ON.")); }
  else if (cmd == "monitoring payload off" || cmd == "realtime payload off") { serialRealtimePayloadEnabled = false; Serial.println(F("[MQTT] realtime monitoring payload OFF.")); }
  else if (cmd == "mongo ticker on") { serialLogEnabled = true; serialMongoBufferTickerEnabled = true; Serial.println(F("[MONGO] buffer ticker ON.")); }
  else if (cmd == "mongo ticker off") { serialMongoBufferTickerEnabled = false; Serial.println(F("[MONGO] buffer ticker OFF.")); }
  else if (cmd == "spec" || cmd == "acq" || cmd == "compute") printAcquisitionSpecReport();
  else if (cmd == "performance" || cmd == "perf" || cmd == "perf acq" || cmd == "performance acq" || cmd == "acquisition performance") printPerformanceReport();
  else if (cmd == "perf reset" || cmd == "acq reset") { resetAcquisitionMonitorStats(); sensorMissedDeadlines = 0; parseOKCount = 0; parseFailCount = 0; rxBufferResetCount = 0; fastAggCompleted = 0; fastAggUnderfilled = 0; Serial.println(F("[PERF] acquisition statistics reset.")); }
  else if (cmd == "latest" || cmd == "data" || cmd == "sample") printLatestDataReport();
  else if (cmd == "aggregation" || cmd == "agg" || cmd == "aggregate") { AggregatedData a; if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) { a = aggData; xSemaphoreGive(dataMutex); } printAggregatedParameterReport(a); }
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
  else if (cmd == "rx monitor on") { runtimeDebugRxRaw = true; runtimeDebugRxOK = true; Serial.println(F("[RX] monitor on: raw UART + named parameters")); printLastRxReportFromCache(); }
  else if (cmd == "rx monitor off") { runtimeDebugRxRaw = false; runtimeDebugRxOK = false; Serial.println(F("[RX] monitor off")); }
  else if (cmd == "db ticker on") { dbSizeTickerEnabled = true; Serial.println(F("[DB] ticker on")); }
  else if (cmd == "db ticker off") { dbSizeTickerEnabled = false; Serial.println(F("[DB] ticker off")); }
  else if (cmd == "db reset") { sdResetPending = true; sdResetPendingMs = millis(); Serial.println(F("Type: db reset confirm")); }
  else if (cmd == "db reset confirm") { if (sdResetPending) resetSDDatabase(); sdResetPending = false; }
  else if (cmd == "mqtt payload" || cmd == "json mqtt" || cmd == "payload mqtt") printLastMqttPayloadCache();
  else if (cmd == "mqtt payload now" || cmd == "json mqtt now" || cmd == "payload mqtt now") printCurrentMqttPayloadBuild();
  else if (cmd == "mqtt payload on" || cmd == "json mqtt on") { serialMqttPayloadEnabled = true; Serial.println(F("[MQTT] Payload JSON monitor ON. Setiap publish MQTT akan ditampilkan.")); }
  else if (cmd == "mqtt payload off" || cmd == "json mqtt off") { serialMqttPayloadEnabled = false; Serial.println(F("[MQTT] Payload JSON monitor OFF.")); }
  else if (cmd == "test once" || cmd == "monitor once" || cmd == "db once") startTestOnceMode();
  else if (cmd == "test once reset" || cmd == "monitor once reset" || cmd == "db once reset") resetTestOnceMode();
  else if (cmd == "test once status" || cmd == "monitor once status") printTestOnceStatus();
  else if (cmd == "test once last" || cmd == "rx last" || cmd == "last rx") printLastRxReportFromCache();
  else if (cmd == "test once off" || cmd == "monitor continuous" || cmd == "continuous") stopTestOnceMode();
  else if (cmd == "log off") { serialLogEnabled = false; serialLogAllEnabled = false; serialLogDatabaseEnabled = false; serialLogPerformanceEnabled = false; serialLogSensorEnabled = false; serialLogNetworkEnabled = false; serialLogAggregationEnabled = false; serialLogStorageEnabled = false; serialLogFFTEnabled = false; serialLogLatestEnabled = false; serialMonitorOverviewEnabled = false; serialMongoBufferTickerEnabled = false; Serial.println(F("[LOG] off")); }
  else if (cmd == "log database on") { serialLogEnabled = true; serialLogDatabaseEnabled = true; Serial.println(F("[LOG] database on")); }
  else if (cmd == "log performance on") { serialLogEnabled = true; serialLogPerformanceEnabled = true; Serial.println(F("[LOG] performance on")); }
  else if (cmd == "log aggregation on" || cmd == "log agg on") { serialLogEnabled = true; serialLogAggregationEnabled = true; Serial.println(F("[LOG] aggregation on")); }
  else if (cmd == "log acq on" || cmd == "log spec on") { serialLogEnabled = true; serialLogSensorEnabled = true; Serial.println(F("[LOG] acquisition/spec on")); }
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
  Serial.println("BOOTING GENSYS ESP32-2 INDUSTRIAL HMI - SD BEFORE TFT SAFE V4");

  memset(&latestRaw, 0, sizeof(latestRaw));
  memset(&aggData, 0, sizeof(aggData));
  memset(&fftData, 0, sizeof(fftData));
  memset(&fftMultiData, 0, sizeof(fftMultiData));
  memset(&fftBuffers, 0, sizeof(fftBuffers));
  resetAcquisitionMonitorStats();
  strlcpy(latestRaw.syncText, "OFF-GRID", sizeof(latestRaw.syncText));
  strlcpy(latestRaw.statusText, "NO-DATA", sizeof(latestRaw.statusText));

  dataMutex = xSemaphoreCreateMutex();
  sdMutex = xSemaphoreCreateMutex();
  mongoBufferMutex = xSemaphoreCreateMutex();
  mqttMutex = xSemaphoreCreateMutex();
  fftMutex = xSemaphoreCreateMutex();
  mongoUploadRequestSemaphore = xSemaphoreCreateBinary();


  // ============================================================
  // STRING RESERVE TO REDUCE HEAP FRAGMENTATION
  // ============================================================
  for (uint16_t i = 0; i < MONGODB_BUFFER_RECORDS; i++) {
    mongoDbBuffer[i].reserve(384);
  }

  lastMqttPayloadCache.reserve(1024);
  lastMqttParameterOnlyPayloadCache.reserve(1024);
  lastSdCsvLineCache.reserve(384);
  lastSdQueueJsonCache.reserve(512);
  serialCmd.reserve(128);
  linkRxBuffer.reserve(LINK_LINE_BUFFER_MAX_CHARS + 1);

  if (dataMutex == NULL) Serial.println("[ERROR] dataMutex gagal dibuat.");
  if (sdMutex == NULL) Serial.println("[ERROR] sdMutex gagal dibuat.");
  if (mongoBufferMutex == NULL) Serial.println("[ERROR] mongoBufferMutex gagal dibuat.");
  if (fftMutex == NULL) Serial.println("[ERROR] fftMutex gagal dibuat.");
  if (mongoUploadRequestSemaphore == NULL) Serial.println("[ERROR] mongoUploadRequestSemaphore gagal dibuat.");

  deselectAllSPI();

  LinkSerial.setRxBufferSize(LINK_SERIAL_RX_BUFFER_BYTES);
  LinkSerial.begin(LINK_BAUD, SERIAL_8N1, LINK_RX_PIN, LINK_TX_PIN);
  LinkSerial.setTimeout(20);

  xTaskCreatePinnedToCore(
    UartRxTask,
    "UartRxTask",
    LINK_RX_TASK_STACK_WORDS,
    NULL,
    LINK_RX_TASK_PRIORITY,
    NULL,
    1
  );

  // ============================================================
  // SD INIT SEBELUM TFT INIT
  // ============================================================
  // Urutan ini sengaja dibuat sama prinsipnya dengan sketch SD basic
  // yang berhasil: SD diinisialisasi saat bus masih bersih, sebelum
  // tft.init(), touch, WiFi, MQTT, dan task FreeRTOS berjalan.
  Serial.println(F("[BOOT] Initializing SD before TFT..."));
  deselectAllSPI();
  initSDCard();
  deselectAllSPI();

  // TFT init setelah SD selesai agar TFT tidak mengganggu proses SD.begin().
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

  drawBootSplashStep(sdOK ? "Local SD database mounted" : "SD offline - continuing", 40);

  drawBootSplashStep("Starting WiFi manager...", 58);
  setupWiFiManager();

  drawBootSplashStep("Synchronizing NTP timestamp...", 72);
  if (wifiOK) {
    configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER_1, NTP_SERVER_2);
  }

  drawBootSplashStep("Connecting MQTT broker...", 86);
  applyWiFiStabilityConfig();
  applyMqttStabilityConfig();

  if (wifiOK) {
    reconnectMQTT();
  }

  drawBootSplashStep("Starting sensor, UART, and FFT tasks...", 94);
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

  xTaskCreatePinnedToCore(
  MongoBufferTask,
  "MongoBufferTask",
  10000,
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

  if (paperTickerEnabled && millis() - lastPaperTickerMs >= paperTickerIntervalMs) {
    lastPaperTickerMs = millis();
    printPaperValidationReport();
  }

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
    if (mqttMutex && xSemaphoreTake(mqttMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
      mqtt.loop();
      xSemaphoreGive(mqttMutex);
    } else if (mqttMutex == NULL) {
      mqtt.loop();
    }
  }

  if (!sdOK && millis() - lastSDRetry >= 5000) {
    lastSDRetry = millis();
    Serial.println("[SD] Retry init otomatis...");
    initSDCard();
    needFullRedraw = true;
  }

  // Test-once tetap aman karena publishRealtimeData()
  // sudah punya guard: hanya publish 1 kali saat test-once.
  if (millis() - lastPublish >= publishInterval) {
    lastPublish = millis();
    publishRealtimeData();
  }

  // Test-once tetap aman karena saveSnapshotToSD()
  // sudah punya guard: hanya simpan 1 kali saat test-once.
  if (millis() - lastLocalSave >= localSaveInterval) {
    lastLocalSave = millis();
    saveSnapshotToSD();
  }

  // Kirim buffer RAM MongoDB sesesuai interval batch; SD tetap hanya arsip lokal.
 

  // WAJIB tetap aktif meskipun test-once sudah selesai.
  // Yang dibekukan hanya data RX/agregasi/database, bukan UI.
  handleTouchNavigation();

  // Render tetap jalan agar page bisa berpindah.
  // Jika needFullRedraw=true karena tap page, redraw dilakukan langsung
  // tanpa menunggu drawInterval.
  if (needFullRedraw || millis() - lastDraw >= drawInterval) {
    lastDraw = millis();

    drawCurrentPage(needFullRedraw);
    needFullRedraw = false;

    // Status test-once display hanya ditandai sekali.
    // Setelah itu display tetap boleh dirender untuk navigasi page.
    if (testOnceMode && testOnceAggDone && !testOnceDisplayDone) {
      testOnceDisplayDone = true;
      Serial.println();
      Serial.println(F("╔════════════ TEST-ONCE TFT MONITORING ════════════╗"));
      Serial.println(F("[TEST] Satu tampilan monitoring telah dirender ke TFT."));
      Serial.println(F("[TEST] Data dibekukan, tetapi HMI/touch navigation tetap aktif."));
      Serial.println(F("╚═══════════════════════════════════════════════════╝"));
      updateTestOnceCompletion();
    }
  }

  delay(5);
}
