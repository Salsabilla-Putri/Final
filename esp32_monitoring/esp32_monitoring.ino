// ============================================================
// GENSYS ESP32-2 MONITORING FINAL
// Industrial TFT HMI + Touch Navigation + Serial Command Console
// CSV UART + 1s Aggregation Record + SD CSV + MQTT realtime
//
// RX CSV dari ESP32-1 setelah penambahan MAP:
// $seq,timestampMs,rpm,tps,map,iat,clt,afr,batt,fuel,freq,freqGrid,volt,voltGrid,currentA,powerKW,phaseAngle,engineSync,gridSync,valid,syncStatus
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
// SD_MISO GPIO12
// SD_SCK  GPIO14
// Init SD dilakukan SEBELUM TFT init untuk menghindari konflik SPI
//
// Serial command:
// help, database, performance, sensor, network, touch, calibrate,
// page generator, page engine
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
#include "gensys_logo_200x200_rgb565.h"

#if __has_include(<PNGdec.h>)
  #include <PNGdec.h>
  #define GENSYS_HAS_PNGDEC 1
#else
  #define GENSYS_HAS_PNGDEC 0
#endif


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

// ESP32 hanya radio 2.4 GHz. Set country agar scan tidak terkunci
// ke channel 1-11 saja; di Indonesia AP/router bisa muncul di channel 12/13.
#ifndef WIFI_COUNTRY_CC
#define WIFI_COUNTRY_CC "ID"
#endif

#ifndef WIFI_COUNTRY_CHANNELS
#define WIFI_COUNTRY_CHANNELS 13
#endif

#ifndef WIFI_MANAGER_SCAN_DEBUG
#define WIFI_MANAGER_SCAN_DEBUG 1
#endif

#ifndef WIFI_LCD_SELECT_TIMEOUT_MS
#define WIFI_LCD_SELECT_TIMEOUT_MS 30000UL
#endif

#ifndef WIFI_LCD_CONNECT_TIMEOUT_MS
#define WIFI_LCD_CONNECT_TIMEOUT_MS 20000UL
#endif

#ifndef WIFI_LCD_MAX_NETWORKS
#define WIFI_LCD_MAX_NETWORKS 6
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

#ifndef FALLBACK_WIFI_SSID
#define FALLBACK_WIFI_SSID "hai"
#endif

#ifndef FALLBACK_WIFI_PASS
#define FALLBACK_WIFI_PASS "hello123"
#endif

#ifndef FALLBACK_WIFI_TIMEOUT_MS
#define FALLBACK_WIFI_TIMEOUT_MS 20000UL
#endif

// ============================================================
// MQTT
// ============================================================
// Default broker Shiftr.io untuk dashboard realtime.
// PubSubClient membutuhkan host polos tanpa skema; jika build flag memberi URI
// seperti mqtt://generatorta20.cloud.shiftr.io, kode akan menormalisasi saat runtime.
#ifndef MQTT_HOST
#define MQTT_HOST  "mqtt://generatorta20.cloud.shiftr.io"
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

#ifndef MQTT_VHOST
#define MQTT_VHOST ""
#endif

// Shiftr.io memakai username langsung. MQTT_AUTH_USERNAME/build flag tetap bisa override
// jika suatu saat broker membutuhkan format lain.
#ifndef MQTT_AUTH_USERNAME
#define MQTT_AUTH_USERNAME MQTT_USER
#endif

#ifndef MQTT_LOGIN_USER
#define MQTT_LOGIN_USER MQTT_AUTH_USERNAME
#endif

#ifndef MQTT_TOPIC
#define MQTT_TOPIC "gen/realtime"
#endif

#ifndef MQTT_REALTIME_TOPIC
#define MQTT_REALTIME_TOPIC "gen/realtime"
#endif

// ============================================================
// MQTT + WIFI STABILITY CONFIG
// ============================================================
// Tujuan:
// - Mencegah MQTT disconnected saat runtime.
// - Mengirim data dashboard realtime setiap 0,5 detik.
// - Menjaga koneksi WiFi lebih stabil.
// - Mengurangi risiko heap fragmentation akibat String JSON.

#define MQTT_BUFFER_SIZE_BYTES       2048
#define MQTT_KEEPALIVE_SEC           120
#define MQTT_SOCKET_TIMEOUT_SEC      1   // Batasi blocking mqtt.connect agar TFT tidak freeze lama

#define MQTT_RECONNECT_MIN_MS        1000UL
#define MQTT_RECONNECT_MAX_MS        10000UL

#define WIFI_RUNTIME_CHECK_MS        1000UL
#define WIFI_RECONNECT_MIN_MS        1000UL
#define WIFI_RECONNECT_MAX_MS        10000UL
#define WIFI_CONNECT_POLL_MS         500UL
#define WIFI_EDUROAM_MAX_ATTEMPTS    1

// Jika RSSI lebih lemah dari nilai ini, batch MongoDB ditunda.
// Realtime tetap bisa jalan, tetapi history tidak dipaksa upload.
#define WIFI_RSSI_WEAK_DBM           -75

// MongoDB dikirim sebagai 1 payload batch besar via MQTT beginPublish/write/endPublish.
// Nilai ini tetap dipakai sebagai batas payload realtime biasa.
// Batch besar tidak memakai mqtt.publish() agar tidak perlu buffer internal PubSubClient besar.
#define MONGO_BATCH_STREAM_CHUNK_BYTES 512
#define MONGO_BATCH_MAX_PAYLOAD_BYTES  160000UL

// Proteksi heap.
#define HEAP_MIN_FREE_BYTES          25000UL
#define HEAP_MIN_MAX_ALLOC_BYTES     8000UL


// Cloud/MongoDB path:
// Hanya mode buffermongo: ESP32 publish ke gen/realtime.
// Server yang menahan buffer 600 record dan menyimpan ke MongoDB.
// ESP32 tidak lagi mengirim buffer SD/RAM ke MongoDB.

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
// Palet warna logo GENSYS (Format RGB565)
#define C_GENSYS_BLUE   0x1317 // #1560b8
#define C_GENSYS_ORANGE 0xFC80 // #fb9200
#define C_GENSYS_NAVY   0x1967 // #1e2f3f

// Industrial palette RGB565.
#define C_BG       0xF7BF
#define C_WHITE    0xFFFF
#define C_PRIMARY  C_GENSYS_BLUE // Ganti warna primary menjadi biru Gensys
#define C_PRIMARY2 0x1A76
#define C_GREEN    0x15D0
#define C_YELLOW   0xFFE0
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
// Pin SD sesuai wiring modul yang dipakai pada perangkat ini.
#define SD_MISO 12
#define SD_MOSI 13
#define SD_SCK  14
#define SD_CS   26

#define SD_SPI_FREQ_INIT 400000UL
#define SD_SPI_FREQ_FAST 1000000UL
#define SD_AUTO_RETRY_INTERVAL_MS 60000UL

SPIClass sdSPI(HSPI);
SemaphoreHandle_t sdMutex = NULL;
SemaphoreHandle_t dataMutex = NULL;

const char* DB_FILE = "/sdDatabase.csv";
const char* DB_LEGACY_FILE = "/database.csv";  // File lama tidak dipakai lagi agar mulai bersih dengan sdDatabase.csv.
const char* BOOT_LOGO_PNG_FILE = "/logo.png";

// Header CSV lokal. sdDatabase.csv hanya berisi parameter agregasi utama.
const char* DB_CSV_HEADER =
  "recordId,localSeq,timestamp,rpm,tps,map,iat,clt,afr,batt,fuel,"
  "freq,volt,currentA,powerKW,phase_diff,powerSource";

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
// Realtime dashboard dan history dikirim ke server lewat buffermongo; tidak ada batch MongoDB dari ESP32.

#define MONGODB_BATCH_INTERVAL_MS 600000UL  // status-only; server buffermongo yang melakukan flush 10 menit
#define MONGODB_BATCH_RECORDS     600        // kapasitas fallback: 1 record/detik x 10 menit
#define MONGODB_BUFFER_RECORDS    MONGODB_BATCH_RECORDS
// Pengiriman fallback tetap mengikuti interval 10 menit. Saat interval tiba,
// buffer 600 record dikirim setelah 10 menit dalam chunk kecil 100 record.
// Jeda 500 ms antar chunk memberi waktu broker/backend memproses payload sebelum
// chunk berikutnya dikirim, sehingga data lebih stabil masuk ke MongoDB.
#define MONGODB_UPLOAD_CHUNK_RECORDS 100
#define MONGODB_UPLOAD_CHUNK_DELAY_MS 500UL

// Mode pengiriman data ke MongoDB hanya buffermongo.
#ifndef DATA_SEND_MODE
#define DATA_SEND_MODE "buffermongo"
#endif
#define DATA_SEND_MODE_BUFFERMONGO 1
#define DATA_SEND_MODE_BUFFERESP   2
#ifndef DATA_SEND_MODE_ID
#define DATA_SEND_MODE_ID DATA_SEND_MODE_BUFFERMONGO
#endif

// TEST DATABASE: tetap tulis sdDatabase.csv di SD walaupun WiFi/MQTT normal.
// Aktifkan hanya saat pengujian agar SD tidak cepat aus pada operasi harian.
#define SD_SAVE_ONLINE_FOR_DB_TEST 1

// SAFE MODE NOTE:
// Dipilih 10 menit/600 record untuk pengiriman database jangka panjang.
// Buffer 5 menit/300 record masih memungkinkan, tetapi heap ESP32 lebih berat
// saat EAP handshake dan MQTT fallback batch publish.

const unsigned long publishInterval   = 1000;
const unsigned long localSaveInterval = 1000;
const unsigned long drawInterval      = 1000;   // LCD partial update tiap 0,5 detik mengikuti agregasi cepat

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

  char syncText[12] = "off";       // sync/genset/grid/off dari ESP32-1
  char syncStatus[12] = "off";     // field ke-21 payload UART
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
  char syncStatus[12] = "off";
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
  uint16_t statusSyncCount = 0;
  uint16_t statusGensetCount = 0;
  uint16_t statusGridCount = 0;
  uint16_t statusOffCount = 0;
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
};

// ============================================================
// ACQUISITION + COMPUTE PERFORMANCE MONITOR
// ============================================================
// Target spesifikasi:
// - Akuisisi parameter real-time: 0.1 s sampai 1.0 s
// - Task sampling internal ESP32-2: 20 ms
// - Record monitoring lokal/SD: 1 s
// - Target database online: 10 menit
#define SPEC_ACQ_MIN_INTERVAL_MS       100UL
#define SPEC_ACQ_MAX_INTERVAL_MS       1000UL
#define SPEC_DATABASE_TARGET_MS        600000UL
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
  PerfMinMax reservedComputeUs;
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
StorageRecord storageBatch[STORAGE_BATCH_SIZE];
SemaphoreHandle_t mongoUploadRequestSemaphore = NULL;
SemaphoreHandle_t mongoBufferMutex = NULL;
SemaphoreHandle_t mqttMutex = NULL;

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
bool displayUpdateNow = false;
volatile uint32_t displayAggregateSeq = 0;  // naik setiap agregasi agar TFT memaksa refresh nilai
bool touchDetected = false;

String wifiLcdSsids[WIFI_LCD_MAX_NETWORKS];
int32_t wifiLcdRssis[WIFI_LCD_MAX_NETWORKS];
int wifiLcdEncryptions[WIFI_LCD_MAX_NETWORKS];
uint8_t wifiLcdNetworkCount = 0;

enum DisplayPage {
  PAGE_GENERATOR = 0,
  PAGE_ENGINE    = 1
};

int activePage = PAGE_GENERATOR;

bool serialTouchDebug = true;
bool touchCalibrationMode = true;

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
  {"GEN_ICON",    120, 305},
  {"ENG_ICON",    360, 305}
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
uint32_t lastSdSavedLocalSeq = 0;
uint32_t lastMongoBufferedLocalSeq = 0;
uint32_t lastMqttHistoryPublishedLocalSeq = 0;

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

// Statistik pengiriman buffer RAM MongoDB 10 menit.
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
volatile uint32_t perfLastRxAgeMs = 0;

unsigned long lastUartReceiveMs = 0;
unsigned long lastAggReadyMs = 0;
unsigned long lastMqttPublishMs = 0;
unsigned long lastTftDrawMs = 0;

// MQTT / MongoDB payload statistics.
uint32_t mqttLastPayloadBytes = 0;          // payload aktual yang dikirim
uint64_t mqttTotalPayloadBytes = 0;
uint32_t mqttLastParameterPayloadBytes = 0; // estimasi cloud DB hanya parameter generator
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
char mqttResolvedHost[96] = MQTT_HOST;
uint16_t mqttResolvedPort = MQTT_PORT;
bool mqttHostHadScheme = false;

String serialCmd = "";
char tmp[24];

volatile uint8_t currentDataSendMode = DATA_SEND_MODE_ID;

const char* getDataSendModeText() {
  return "buffermongo";
}

bool isBufferEspMode() {
  return false;
}

bool isBufferMongoMode() {
  return true;
}

void printDataSendModeStatus() {
  Serial.println();
  Serial.println(F("================ DATA SEND MODE ================"));
  Serial.print  (F("  active mode    : ")); Serial.println(getDataSendModeText());
  Serial.println(F("  buffermongo    : ESP32 publish gen/realtime; server buffer 600 record lalu simpan MongoDB."));
  Serial.println(F("  bufferesp      : DISABLED (tidak ada sinkronisasi SD/RAM ESP32 ke MongoDB)."));
  Serial.println(F("================================================"));
}
void setDataSendMode(uint8_t mode) {
  (void) mode;
  currentDataSendMode = DATA_SEND_MODE_BUFFERMONGO;

  Serial.println();
  Serial.println(F("================ DATA SEND MODE UPDATED ================"));
  Serial.println(F("  active mode : buffermongo"));
  Serial.println(F("  path        : topic gen/realtime -> server buffer 600 record -> MongoDB."));
  Serial.println(F("  note        : mode ESP32 buffer lokal ke MongoDB dinonaktifkan."));
  Serial.println(F("========================================================"));
}

// Forward declaration untuk fungsi yang dipakai sebelum definisi aslinya.
void printMongoBufferStatus();

void updateHeapMonitor();
bool isWiFiUsableForMongoUpload();
void applyWiFiStabilityConfig();
void applyMqttStabilityConfig();
void reconnectMQTT();
void checkWiFiStatus();
bool retrySDCardOnceFast();
void serviceDisplayAndTouch();
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
bool serialLogLatestEnabled = false;
bool runtimeDebugRxRaw = DEBUG_RX_RAW;
bool runtimeDebugRxOK = DEBUG_RX_OK;
unsigned long serialLogIntervalMs = 3000;
unsigned long lastSerialLogMs = 0;

// ============================================================
// THRESHOLD WARNA LCD
// ============================================================
// Normal = hijau, warning = kuning, kritis = merah.
#define THRESH_VOLT_WARN_HI     240.0f
#define THRESH_VOLT_CRIT_HI     250.0f
#define THRESH_VOLT_WARN_LO     200.0f
#define THRESH_VOLT_CRIT_LO     180.0f
#define THRESH_FREQ_WARN_HI      51.0f
#define THRESH_FREQ_CRIT_HI      52.0f
#define THRESH_FREQ_WARN_LO      49.0f
#define THRESH_FREQ_CRIT_LO      48.0f
#define THRESH_PHASE_WARN_ABS    10.0f
#define THRESH_PHASE_CRIT_ABS    20.0f
#define THRESH_POWER_WARN_HI      8.0f
#define THRESH_POWER_CRIT_HI     12.0f
#define THRESH_CURRENT_WARN_HI   40.0f
#define THRESH_CURRENT_CRIT_HI   55.0f
#define THRESH_RPM_WARN_HI     4500.0f
#define THRESH_RPM_CRIT_HI     5500.0f
#define THRESH_AFR_WARN_HI       16.0f
#define THRESH_AFR_CRIT_HI       18.0f
#define THRESH_AFR_WARN_LO       12.0f
#define THRESH_AFR_CRIT_LO       10.5f
#define THRESH_MAP_WARN_HI       95.0f
#define THRESH_MAP_CRIT_HI      105.0f
#define THRESH_BATT_WARN_HI      14.5f
#define THRESH_BATT_CRIT_HI      15.5f
#define THRESH_BATT_WARN_LO      11.5f
#define THRESH_BATT_CRIT_LO      10.5f
#define THRESH_FUEL_WARN_LO      30.0f
#define THRESH_FUEL_CRIT_LO      15.0f
#define THRESH_IAT_WARN_HI       55.0f
#define THRESH_IAT_CRIT_HI       70.0f
#define THRESH_CLT_WARN_HI       90.0f
#define THRESH_CLT_CRIT_HI      105.0f

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
  if (v >= warnHi || v <= warnLo) return C_YELLOW;
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

String getClockWIBms() {
  struct tm timeinfo;
  unsigned long msPart = millis() % 1000UL;
  char buf[20];

  if (getLocalTime(&timeinfo, 5)) {
    snprintf(buf, sizeof(buf), "%02d:%02d:%02d:%03lu",
             timeinfo.tm_hour,
             timeinfo.tm_min,
             timeinfo.tm_sec,
             msPart);
    return String(buf);
  }

  unsigned long totalSeconds = millis() / 1000UL;
  unsigned int hh = (totalSeconds / 3600UL) % 24UL;
  unsigned int mm = (totalSeconds / 60UL) % 60UL;
  unsigned int ss = totalSeconds % 60UL;
  snprintf(buf, sizeof(buf), "%02u:%02u:%02u:%03lu", hh, mm, ss, msPart);
  return String(buf);
}

void deselectAllSPI() {
  pinMode(TFT_CS, OUTPUT);
  pinMode(SD_CS, OUTPUT);
  digitalWrite(TFT_CS, HIGH);
  digitalWrite(SD_CS, HIGH);
  delayMicroseconds(50);
}

const char* normalizeSyncStatusText(const char *status) {
  if (status == NULL) return "off";
  if (strcasecmp(status, "sync") == 0) return "sync";
  if (strcasecmp(status, "genset") == 0) return "genset";
  if (strcasecmp(status, "grid") == 0) return "grid";
  return "off";
}

const char* deriveSyncStatusFromRaw(const RawData &d) {
  if (!d.valid) return "off";

  bool gensetOn = d.speeduinoSync || d.rpm > 0 || d.volt > 20.0f || d.freq > 5.0f;
  bool gridOn = d.gridSync || d.voltGrid > 20.0f || d.freqGrid > 5.0f;

  if (gensetOn && gridOn) return "sync";
  if (gensetOn && !gridOn) return "genset";
  if (!gensetOn && gridOn) return "grid";
  return "off";
}

const char* getDisplaySyncStatus(const char *status) {
  status = normalizeSyncStatusText(status);
  if (strcmp(status, "sync") == 0) return "SYNC";
  if (strcmp(status, "genset") == 0) return "GENSET";
  if (strcmp(status, "grid") == 0) return "GRID";
  return "OFF";
}

const char* getPowerSourceFromSynced(bool synced) {
  return synced ? "sync" : "genset";
}

const char* getSyncTextFromSynced(bool synced) {
  return synced ? "sync" : "genset";
}

const char* getPowerSourceFromAggregate(const AggregatedData &a) {
  return normalizeSyncStatusText(a.syncStatus);
}

const char* getSyncTextFromAggregate(const AggregatedData &a) {
  return normalizeSyncStatusText(a.syncStatus);
}

const char* getDisplaySyncTextFromAggregate(const AggregatedData &a) {
  return getDisplaySyncStatus(a.syncStatus);
}

// ============================================================
// CSV PARSER
// ============================================================
bool parseBridgeCsv(const String &line, RawData &out) {
  if (!line.startsWith("$")) return false;

  String data = line.substring(1);

  // Format baru dari ESP32-1 sinkronisasi setelah penambahan MAP:
  // 21 field baru:
  // $seq,timestampMs,rpm,tps,map,iat,clt,afr,batt,fuel,
  // freq,freqGrid,volt,voltGrid,currentA,powerKW,phaseAngle,engineSync,gridSync,valid,syncStatus
  //
  // Backward compatibility:
  // 18 field lama dengan MAP tetapi tanpa arus/power tetap diterima.
  // 17 field lama tanpa MAP tetap diterima, tetapi MAP/arus/power diisi estimasi.
  String fields[21];
  int fieldIndex = 0;
  int start = 0;

  for (int i = 0; i <= data.length(); i++) {
    if (i == data.length() || data[i] == ',') {
      if (fieldIndex < 21) {
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

    if (fieldIndex >= 21) {
      strlcpy(out.syncStatus, normalizeSyncStatusText(fields[20].c_str()), sizeof(out.syncStatus));
    } else {
      strlcpy(out.syncStatus, deriveSyncStatusFromRaw(out), sizeof(out.syncStatus));
    }
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

  if (!out.valid && (out.rpm != 0 || out.freq != 0.0f || out.volt != 0.0f || out.voltGrid != 0.0f)) {
    out.valid = true;
  }

  // Untuk frame lama 17/18/20 field, syncStatus diturunkan dari status generator/grid.
  if (fieldIndex < 21) {
    strlcpy(out.syncStatus, deriveSyncStatusFromRaw(out), sizeof(out.syncStatus));
  }

  strlcpy(out.syncText, out.syncStatus, sizeof(out.syncText));
  strlcpy(out.statusText, getDisplaySyncStatus(out.syncStatus), sizeof(out.statusText));
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
  Serial.printf("║ %-14s: %s\n", "syncStatus", d.syncStatus);
  Serial.printf("║ %-14s: %s\n", "statusText", d.statusText);

  Serial.println(F("╚════════════════════════════════════════════════════════════╝"));
}

void printAggregatedParameterReport(const AggregatedData &a) {
  Serial.println();
  Serial.println(F("║----------------AGGREGATED PARAMETER MONITOR----------------║"));
  Serial.println();
  Serial.println(F("║ RAW UART      : hasil rata-rata agregasi 0,5 detik"));

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
    strlcpy(latestRaw.syncText, "off", sizeof(latestRaw.syncText));
    strlcpy(latestRaw.syncStatus, "off", sizeof(latestRaw.syncStatus));
    strlcpy(latestRaw.statusText, "NO-DATA", sizeof(latestRaw.statusText));
    xSemaphoreGive(dataMutex);
  }

  // Paksa siklus berikutnya segera mencoba publish, save, dan update nilai TFT
  // setelah aggregate pertama tersedia tanpa full redraw halaman.
  lastPublish = 0;
  lastLocalSave = 0;
  lastDraw = 0;
  displayUpdateNow = true;

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
    strlcpy(latestRaw.syncText, "off", sizeof(latestRaw.syncText));
    strlcpy(latestRaw.syncStatus, "off", sizeof(latestRaw.syncStatus));
    strlcpy(latestRaw.statusText, "NO-DATA", sizeof(latestRaw.statusText));
    xSemaphoreGive(dataMutex);
  }

  lastPublish = 0;
  lastLocalSave = 0;
  lastDraw = 0;
  displayUpdateNow = true;

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
  displayUpdateNow = true;
  Serial.println(F("[TEST] once off. Mode monitoring kembali continuous."));
}

void addSampleToAccumulator(const RawData &d) {
  if (!d.valid) return;

  // Terima juga mode GRID-only dari ESP32 sinkronisasi. Sebelumnya sample
  // dibuang ketika rpm/freq/volt generator = 0, sehingga agregasi 0,5 detik
  // tidak bergerak saat hanya PLN/grid yang hidup. Parameter grid wajib ikut
  // dihitung supaya LCD, MQTT dashboard, dan database tetap berubah tiap
  // window agregasi 0,5 detik sesuai status sumber daya aktual.
  bool hasGeneratorData = d.rpm != 0 || d.freq != 0.0f || d.volt != 0.0f;
  bool hasGridData = d.freqGrid != 0.0f || d.voltGrid != 0.0f;
  if (!hasGeneratorData && !hasGridData) return;

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

  const char *st = normalizeSyncStatusText(d.syncStatus);
  if (strcmp(st, "sync") == 0) acc.statusSyncCount++;
  else if (strcmp(st, "genset") == 0) acc.statusGensetCount++;
  else if (strcmp(st, "grid") == 0) acc.statusGridCount++;
  else acc.statusOffCount++;
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

  // Ambil status mayoritas selama window agregasi 0,5 detik.
  uint16_t bestCount = acc.statusOffCount;
  const char *bestStatus = "off";
  if (acc.statusGridCount > bestCount) { bestCount = acc.statusGridCount; bestStatus = "grid"; }
  if (acc.statusGensetCount > bestCount) { bestCount = acc.statusGensetCount; bestStatus = "genset"; }
  if (acc.statusSyncCount > bestCount) { bestCount = acc.statusSyncCount; bestStatus = "sync"; }
  strlcpy(out.syncStatus, bestStatus, sizeof(out.syncStatus));

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
    displayAggregateSeq++;

    if (testOnceMode && testOnceRxDone && !testOnceAggDone) {
      testOnceAggDone = true;
      testOnceLocalSeq = localRecordSeq;
      Serial.println();
      Serial.println(F("╔════════════ TEST-ONCE AGGREGATION ════════════╗"));
      Serial.printf("[TEST] 1 record agregasi siap. localSeq=%lu, samples=%u\n",
                    (unsigned long)testOnceLocalSeq, out.samples);
      Serial.println(F("╚════════════════════════════════════════════════╝"));
      printAggregatedParameterReport(out);

      // Paksa loop utama segera menjalankan SD save, MQTT publish, dan update nilai TFT
      // tanpa menunggu sisa interval sebelumnya dan tanpa full redraw halaman.
      lastLocalSave = 0;
      lastPublish = 0;
      lastDraw = 0;
      displayUpdateNow = true;
    }

    // Aggregate baru harus segera muncul di LCD dan server. Jangan tunggu sisa
    // interval publish/draw sebelumnya; loop utama akan menjalankan publish
    // realtime MQTT, simpan lokal, dan update nilai berubah pada siklus berikutnya.
    lastPublish = millis() - publishInterval;
    // SD tetap mengikuti localSaveInterval agar kartu tidak dipaksa write 2x/detik.
    // Realtime MQTT dan LCD tetap dipercepat oleh lastPublish/lastDraw.
    if (millis() - lastLocalSave >= localSaveInterval) {
      lastLocalSave = millis() - localSaveInterval;
    }
    lastDraw = millis() - drawInterval;
    displayUpdateNow = true;

    fastAggCompleted++;
    lastFastAggSamples = out.samples;
    lastAggReadyMs = nowMs;

    if (out.samples < 3) fastAggUnderfilled++;

    if (serialLogAggregationEnabled) {
      printAggregatedParameterReport(out);
    }
  }

  resetAccumulator();
  perfAggregationUs = micros() - aggStart;
  perfUpdateStat(acqMon.aggregationUs, perfAggregationUs);
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
      acqMon.newSeqSamples++;
      lastAggregatedSeq = sample.seq;
    } else if (!hasSample) {
      acqMon.noDataCycles++;
    }

    if (millis() - lastAggMs >= AGGREGATION_INTERVAL_MS) {
      lastAggMs = millis();
      finalizeFastAggregate();
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
  String json = "{";
  json += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  json += "\"dataSendMode\":\"" + String(getDataSendModeText()) + "\",";
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
  json += "\"freqGrid\":" + String(a.freqGridAvg, 3) + ",";
  json += "\"volt\":" + String(a.voltAvg, 2) + ",";
  json += "\"voltGrid\":" + String(a.voltGridAvg, 2) + ",";
  json += "\"currentA\":" + String(a.currentAvg, 2) + ",";
  json += "\"powerKW\":" + String(a.powerAvg, 3) + ",";
  json += "\"phase_diff\":" + String(a.phaseAngleAvg, 2) + ",";
  json += "\"sync\":\"" + String(getSyncTextFromAggregate(a)) + "\",";
  json += "\"powerSource\":\"" + String(getPowerSourceFromAggregate(a)) + "\"";
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
  return buildJsonRecordParametersOnly(r);
}

String buildMqttRealtimeFlatPayload() {
  // Payload khusus MQTT realtime ke dashboard.
  // Format dibuat flat: timestamp + parameter langsung di root JSON.
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
  String json = "{";
  json += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  json += "\"dataSendMode\":\"" + String(getDataSendModeText()) + "\",";
  json += "\"recordId\":\"" + r.recordId + "\",";
  json += "\"localSeq\":" + String(r.localSeq) + ",";
  json += "\"samples\":" + String(a.samples) + ",";
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
  json += "\"sync\":\"" + String(getSyncTextFromAggregate(a)) + "\",";
  json += "\"powerSource\":\"" + String(getPowerSourceFromAggregate(a)) + "\"";

  json += "}";

  perfJsonBuildUs = micros() - buildStart;
  return json;
}

String buildMqttHistoryWrapperPayload() {
  // Payload wrapper lama dipertahankan hanya untuk kompatibilitas command/debug.
  // Pengiriman utama ke MongoDB memakai record tunggal realtime tiap 1 detik.
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
  Serial.println(F("MQTT topic gen/realtime buffermongo every 1 sec"));

  Serial.print(F("║ Realtime status : "));
  Serial.println(realtimeOk ? F("PUBLISH OK") : F("PUBLISH FAIL / NOT SENT"));

  Serial.print(F("║ MongoDB realtime: "));
  Serial.println(historyOk ? F("PUBLISH OK") : F("PUBLISH FAIL / NOT SENT"));

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
    Serial.println(F("║ Tunggu publish 0,5 detik, atau pakai ║"));
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
  Serial.print(F("║ Mongo topic     : ")); Serial.println(MQTT_TOPIC);
  Serial.print(F("║ Save interval   : ")); Serial.print(localSaveInterval); Serial.println(F(" ms"));
  Serial.print(F("║ Mongo interval  : ")); Serial.print(MONGODB_BATCH_INTERVAL_MS / 1000UL); Serial.println(F(" s"));
  Serial.print(F("║ Target batch    : ")); Serial.println(MONGODB_BUFFER_RECORDS);
  Serial.print(F("║ Buffer count    : ")); Serial.print(mongoDbBufferCount); Serial.print(F(" / ")); Serial.println(MONGODB_BUFFER_RECORDS);

  if (!hasLastDatabasePayloadCache) {
    Serial.println(F("║ Status          : belum ada record agregasi yang disimpan."));
    Serial.println(F("║ Tunggu minimal 0,5 detik setelah RX UART valid."));
    Serial.println(F("╚════════════════════════════════════════════════════════════╝"));
    return;
  }

  Serial.print(F("║ LocalSeq        : ")); Serial.println(lastDatabaseLocalSeqCache);
  Serial.print(F("║ Cache age       : ")); Serial.print(millis() - lastDatabasePayloadCacheAtMs); Serial.println(F(" ms"));
  Serial.print(F("║ CSV row bytes   : ")); Serial.println(lastDatabaseCsvBytesCache);
  Serial.print(F("║ JSON row bytes  : ")); Serial.println(lastDatabaseJsonBytesCache);
  {
    uint32_t recBytes = getMongoRecordBytes();
    uint32_t avgSentBytes = getMongoAvgSentRecordBytes();
    Serial.print(F("║ Mongo record    : ")); Serial.print(recBytes); Serial.println(F(" B/record"));
    Serial.print(F("║ Avg sent record : ")); Serial.print(avgSentBytes); Serial.println(F(" B/record"));
    Serial.print(F("║ Est. storage 10y: ")); Serial.println(formatBytes(estimateMongoPayloadBytes10Years(avgSentBytes)));
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
    Serial.println(F("║ Tunggu publish 0,5 detik setelah agregasi valid."));
    Serial.println(F("╚════════════════════════════════════════════════════════════╝"));
    return;
  }

  Serial.print(F("║ Last publish age: ")); Serial.print(millis() - lastMqttPayloadCacheAtMs); Serial.println(F(" ms"));
  Serial.print(F("║ Last payload    : ")); Serial.print(lastMqttPayloadCache.length()); Serial.println(F(" B"));
  Serial.print(F("║ Records         : ")); Serial.println(lastMqttPayloadRecordsCache);
  Serial.print(F("║ Realtime status : ")); Serial.println(lastMqttRealtimeOkCache ? F("PUBLISH OK") : F("PUBLISH FAIL"));
  Serial.println(F("║ History/MongoDB : MQTT gen/realtime mode buffermongo."));

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
  Serial.println(F("║ 4) MONGODB REALTIME 1S                              ║"));
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
  uint32_t latestPayloadSeq = 0;
  for (uint8_t i = 0; i < STORAGE_BATCH_SIZE; i++) {
    if (storageBatch[i].valid) {
      hasData = true;
      recordsInPayload++;
      if (storageBatch[i].localSeq > latestPayloadSeq) latestPayloadSeq = storageBatch[i].localSeq;
    }
  }
  if (!hasData) return;

  // MQTT publish langsung hanya untuk dashboard realtime.
  // History/cloud MongoDB masuk ke server via gen/realtime; ESP32 tidak mengirim batch MongoDB.
  String realtimePayload = buildMqttRealtimeFlatPayload();
  String parameterOnlyPayload = buildJsonParameterBatchPayload();

  mqttLastPayloadBytes = realtimePayload.length();
  mqttLastParameterPayloadBytes = parameterOnlyPayload.length();
  mqttLastRecordsSent = recordsInPayload;

  uint32_t pubStart = micros();
  bool realtimeOk = false;
  bool historyOk = false;
  if (mqttMutex && xSemaphoreTake(mqttMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
    realtimeOk = mqtt.publish(MQTT_REALTIME_TOPIC, realtimePayload.c_str());
    mqtt.loop();
    historyOk = realtimeOk; // history disimpan server dari gen/realtime (buffermongo).
    xSemaphoreGive(mqttMutex);
  } else if (mqttMutex == NULL) {
    realtimeOk = mqtt.publish(MQTT_REALTIME_TOPIC, realtimePayload.c_str());
    mqtt.loop();
    historyOk = realtimeOk; // history disimpan server dari gen/realtime (buffermongo).
  }
  bool ok = realtimeOk;
  perfMqttPublishUs = micros() - pubStart;
  perfUpdateStat(acqMon.mqttPublishUs, perfMqttPublishUs);

  mqttOK = ok;

  // Cache payload terakhir untuk command: mqtt payload / json mqtt.
  lastMqttPayloadCache = realtimePayload;
  lastMqttParameterOnlyPayloadCache = parameterOnlyPayload;
  lastMqttRealtimeTopicCache = MQTT_REALTIME_TOPIC;
  lastMqttHistoryTopicCache = MQTT_REALTIME_TOPIC;
  lastMqttRealtimeOkCache = realtimeOk;
  lastMqttHistoryOkCache = historyOk;
  lastMqttPayloadCacheAtMs = millis();
  lastMqttPayloadRecordsCache = recordsInPayload;
  hasLastMqttPayloadCache = true;

  Serial.print(F("Publish time ="));
  for (uint8_t i = 0; i < STORAGE_BATCH_SIZE; i++) {
    if (storageBatch[i].valid) {
      Serial.print(storageBatch[i].timestamp);
      Serial.print(F(" espLocalMs="));
      Serial.print(storageBatch[i].timestampMs);
      break;
    }
  }
  Serial.print(F(" publishMillis="));
  Serial.print(millis());
  Serial.print(F(" realtimeOk="));
  Serial.print(realtimeOk ? F("1") : F("0"));
  Serial.print(F(" historyOk="));
  Serial.print(historyOk ? F("1") : F("0"));
  Serial.print(F(" publishUs="));
  Serial.println(perfMqttPublishUs);

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
      Serial.println(F("[TEST] Realtime terkirim; MongoDB/history menunggu buffer batch 10 menit."));
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
  // Dibuat sengaja mengikuti sketch SD test yang terbukti berhasil:
  // 3 attempt, delay 20 ms sebelum create, re-init 100/50 ms, dan verifikasi
  // dengan membaca baris header pertama. Perbedaan utama sketch besar adalah
  // ada TFT/WiFi/MQTT/task lain, jadi timing SD dibuat sedikit lebih longgar
  // agar create file baru tidak kalah oleh kondisi bus/FS yang belum settle.
  const char* altPath = (path[0] == '/') ? path + 1 : path;

  Serial.println();
  Serial.print(F("========== CREATE "));
  Serial.print(path);
  Serial.println(F(" =========="));

  for (uint8_t attempt = 1; attempt <= 3; attempt++) {
    Serial.print(F("[SD] Create attempt "));
    Serial.print(attempt);
    Serial.println(F("/3"));

    deselectAllSPI();
    delay(20);

    if (SD.exists(path)) {
      Serial.print(F("[SD] "));
      Serial.print(path);
      Serial.println(F(" sudah ada, akan dihapus/truncate."));
      if (!SD.remove(path)) {
        Serial.println(F("[SD] WARNING: remove gagal, coba buka mode write."));
      }
      delay(20);
    }

    File f = SD.open(path, "w");
    if (!f) f = SD.open(path, FILE_WRITE);
    if (!f && altPath != path) f = SD.open(altPath, "w");
    if (!f && altPath != path) f = SD.open(altPath, FILE_WRITE);

    if (f) {
      size_t written = f.println(header);
      f.flush();
      f.close();

      delay(20);
      deselectAllSPI();

      File verify = SD.open(path, FILE_READ);
      if (!verify && altPath != path) verify = SD.open(altPath, FILE_READ);

      bool verified = false;
      if (verify) {
        String firstLine = verify.readStringUntil('\n');
        firstLine.trim();

        Serial.print(F("[SD] Verify first line: "));
        Serial.println(firstLine);
        Serial.print(F("[SD] File size after header: "));
        Serial.print(verify.size());
        Serial.println(F(" bytes"));

        String expectedHeader = String(header);
        expectedHeader.trim();
        verified = (firstLine == expectedHeader) && verify.size() > 0;
        verify.close();
      }

      if (written > 0 && verified) {
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

      Serial.print(F("[SD] "));
      Serial.print(path);
      Serial.println(F(" terbuka tetapi verifikasi header gagal."));
    } else {
      Serial.print(F("[SD] Gagal membuka "));
      Serial.print(path);
      Serial.println(F(" untuk create/truncate."));
    }

    SD.end();
    delay(100);
    deselectAllSPI();
    sdSPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
    delay(50);
    SD.begin(SD_CS, sdSPI, SD_SPI_FREQ_INIT);
  }

  sdDatabaseCreateFailCount++;
  sdLastFileErrorMs = millis();
  Serial.print(F("[SD] GAGAL membuat "));
  Serial.print(path);
  Serial.println(F(". Test sederhana bisa berhasil karena belum ada TFT/WiFi/MQTT/task lain. Di sketch utama, kegagalan biasanya karena bus/FS belum settle, file lama tidak bisa dihapus, root FAT bermasalah, atau supply/adaptor SD tidak stabil. Coba command 'sd reinit' atau format FAT32 MBR allocation 32KB jika masih gagal."));
  return false;
}

bool createFreshDatabaseCsv() {
  return createFreshCsvFile(DB_FILE, DB_CSV_HEADER, "CSV database");
}

bool createFreshFftCsv() {
  return true;
}

bool canAppendExistingCsvNoLock(const char* path) {
  File appendTest = SD.open(path, FILE_APPEND);
  if (!appendTest) appendTest = SD.open(path, FILE_WRITE);
  if (!appendTest) return false;

  appendTest.close();
  return true;
}

void printLegacyDatabaseCsvNoticeNoLock(const char* path) {
  if (strcmp(path, DB_FILE) == 0 && SD.exists(DB_LEGACY_FILE) && !SD.exists(DB_FILE)) {
    Serial.println(F("[SD] INFO: /database.csv lama ditemukan tetapi tidak dipakai; sketch sekarang membuat /sdDatabase.csv baru."));
  }
}

bool ensureCsvFileExistsNoLock(const char* path,
                               const char* header,
                               const char* requiredHeaderToken,
                               bool (*createFreshFn)()) {
  deselectAllSPI();
  printLegacyDatabaseCsvNoticeNoLock(path);

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
    Serial.println(F(" lama/tidak sesuai. File dibuat ulang agar kolom CSV mengikuti format terbaru."));
    SD.remove(path);
    return createFreshFn();
  }

  sdLastFileOkMs = millis();
  return true;
}

bool ensureDatabaseCsvExistsNoLock() {
  return ensureCsvFileExistsNoLock(DB_FILE, DB_CSV_HEADER, "phase_diff", createFreshDatabaseCsv);
}

bool ensureFftCsvExistsNoLock() {
  return true;
}

bool ensureSdCsvFilesExistNoLock() {
  bool dbOk = ensureDatabaseCsvExistsNoLock();
  return dbOk;
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
    Serial.println(F("[SD] WARNING: SD init OK, tetapi /sdDatabase.csv belum berhasil dibuat."));
  }
}

void initSDCard() {
  Serial.println();
  Serial.println("════════════ SD CARD INIT ════════════");

  sdOK = false;
  SD.end();

  // Ikuti urutan init yang terbukti stabil pada test sketch:
  // 1) pastikan TFT dan SD sama-sama deselect,
  // 2) beri waktu modul SD settle sebelum HSPI begin,
  // 3) init lambat 400 kHz sampai kartu benar-benar terdeteksi,
  // 4) langsung uji open/write agar dari awal terbukti siap dipakai.
  deselectAllSPI();
  delay(1000);
  sdSPI.end();
  delay(50);
  sdSPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  delay(300);

  bool begun = false;
  for (uint8_t attempt = 1; attempt <= 10; attempt++) {
    Serial.print(F("[SD] Init attempt "));
    Serial.print(attempt);
    Serial.print(F("/10 ... "));
    SD.end();
    deselectAllSPI();
    delay(100);
    if (SD.begin(SD_CS, sdSPI, SD_SPI_FREQ_INIT) && SD.cardType() != CARD_NONE) {
      begun = true;
      Serial.println(F("OK"));
      break;
    }
    Serial.println(F("FAILED"));
    SD.end();
    delay(500);
  }

  if (!begun) {
    sdOK = false;
    Serial.println("[SD] GAGAL FINAL. Cek CS=26, MOSI=13, MISO=19, SCK=14, FAT32.");
    Serial.println("══════════════════════════════════════");
    return;
  }

  sdOK = true;
  Serial.println("[SD] OK.");

  if (sdMutex == NULL || xSemaphoreTake(sdMutex, pdMS_TO_TICKS(3000)) == pdTRUE) {
    ensureDatabaseCsvHeader();
    if (sdMutex != NULL) xSemaphoreGive(sdMutex);
  } else {
    Serial.println(F("[SD] WARNING: mutex masih sibuk saat init; header CSV akan dipastikan saat append berikutnya."));
  }

  updateStorageCache();

  if (sdOK) {
    File testFile = SD.open("/sd_boot_test.txt", FILE_WRITE);
    if (testFile) {
      testFile.println(F("SD boot write OK"));
      testFile.close();
      Serial.println(F("[SD] Boot write test OK."));
    } else {
      sdOK = false;
      sdLastFileErrorMs = millis();
      Serial.println(F("[SD] Boot write test FAILED; SD marked offline."));
    }
  }

  Serial.println("══════════════════════════════════════");
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
  line += getPowerSourceFromAggregate(a);

  return line;
}

bool retrySDCardOnceFast() {
  if (sdOK) return true;

  // Retry runtime dibuat jarang dan hanya 1 attempt agar tidak terjadi retry cepat
  // terus-menerus saat kartu belum terpasang/tegangan belum stabil.
  if (sdMutex != NULL && xSemaphoreTake(sdMutex, pdMS_TO_TICKS(50)) != pdTRUE) {
    return false;
  }

  SD.end();
  deselectAllSPI();
  sdSPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  delay(300);

  bool ok = false;
  if (SD.begin(SD_CS, sdSPI, SD_SPI_FREQ_INIT) && SD.cardType() != CARD_NONE) {
    File testFile = SD.open("/sd_retry_test.txt", FILE_WRITE);
    if (testFile) {
      testFile.println(F("SD retry OK"));
      testFile.close();
      sdOK = true;
      sdConsecutiveOpenFail = 0;
      sdLastFileOkMs = millis();
      ensureDatabaseCsvHeader();
      ok = true;
      Serial.println(F("[SD] Runtime retry OK; sdDatabase.csv siap."));
    }
  }

  if (!ok) {
    sdOK = false;
    sdLastFileErrorMs = millis();
    SD.end();
  }

  if (sdMutex != NULL) xSemaphoreGive(sdMutex);

  if (ok) updateStorageCache();
  return ok;
}


void saveSnapshotToSD() {
  // Fungsi SD tetap dipanggil setiap 1 detik untuk arsip lokal saja.
  // Tidak ada sinkronisasi SD/RAM ESP32 ke MongoDB; MongoDB memakai buffermongo server.
  //
  // SD tidak dipakai sebagai antrean MongoDB.

  if (testOnceMode && (!testOnceAggDone || testOnceSdDone)) return;

  bool hasData = false;
  for (uint8_t i = 0; i < STORAGE_BATCH_SIZE; i++) {
    if (storageBatch[i].valid) hasData = true;
  }
  if (!hasData) return;

  uint32_t saveStart = micros();

  // Mode buffermongo: ESP32 hanya publish gen/realtime; server yang buffer 600 record dan simpan MongoDB.

  bool backupNeeded = true; // User requirement: sdDatabase.csv ditulis tiap 1 detik walaupun online.
  uint8_t validRecords = 0;
  uint8_t unsavedSdRecords = 0;

  for (uint8_t i = 0; i < STORAGE_BATCH_SIZE; i++) {
    if (!storageBatch[i].valid) continue;
    validRecords++;
    if (storageBatch[i].localSeq > lastSdSavedLocalSeq) unsavedSdRecords++;

    if ((WiFi.status() != WL_CONNECTED) || !wifiOK || !mqtt.connected()) {
      sdBackupBecauseNetworkCount++;
    }
  }

  if (!backupNeeded || unsavedSdRecords == 0) {
    if (!backupNeeded) sdBackupSkipOnlineCount += validRecords;

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
    if (!file) {
      // Fallback untuk core/SD library yang tidak membuka FILE_APPEND pada file
      // root setelah re-init SPI; FILE_WRITE tetap append pada ESP32 SD.
      file = SD.open(DB_FILE, FILE_WRITE);
    }
    if (!file) {
      sdSaveFailCount++;
      sdConsecutiveOpenFail++;
      sdLastFileErrorMs = millis();

      if (file) file.close();

      Serial.print(F("[SD-BACKUP] Gagal membuka CSV append (database). consecutiveFail="));
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
      if (storageBatch[i].localSeq <= lastSdSavedLocalSeq) continue;

      String line = buildCsvLine(storageBatch[i]);
      String queueJson = buildJsonRecordParametersOnly(storageBatch[i]);

      file.println(line);

      dbLastLineBytes = line.length() + 2;
      dbTotalWrittenBytes += dbLastLineBytes;
      sdBackupRecordCount++;
      lastSdSavedLocalSeq = storageBatch[i].localSeq;
      cacheLastDatabasePayload(storageBatch[i], line, queueJson);
    }

    file.flush();
    file.close();

    sdSaveSuccessCount++;

    if (serialDatabasePayloadEnabled && hasLastDatabasePayloadCache) {
      Serial.println(SD_SAVE_ONLINE_FOR_DB_TEST == 1
        ? F("[SD-BACKUP] TEST DB: record tetap disimpan walaupun jaringan/MQTT normal.")
        : F("[SD-BACKUP] Record disimpan karena jaringan/MQTT/server/buffer bermasalah."));
    }

    if (testOnceMode && !testOnceSdDone) {
      testOnceSdDone = true;
      Serial.println();
      Serial.println(F("╔════════════ TEST-ONCE LOCAL SD BACKUP ════════════╗"));
      Serial.printf("[TEST] 1 record backup tersimpan ke %s. lastRow=%lu bytes\n",
                    DB_FILE, (unsigned long)dbLastLineBytes);
      Serial.println(F("[TEST] SD_SAVE_ONLINE_FOR_DB_TEST=1: SD tetap ditulis walaupun WiFi/MQTT normal."));
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

void applyWiFiCountryConfig() {
  wifi_country_t wifiCountry;
  memset(&wifiCountry, 0, sizeof(wifiCountry));
  strncpy(wifiCountry.cc, WIFI_COUNTRY_CC, sizeof(wifiCountry.cc));
  wifiCountry.schan = 1;
  wifiCountry.nchan = WIFI_COUNTRY_CHANNELS;
  wifiCountry.policy = WIFI_COUNTRY_POLICY_MANUAL;

  // Beberapa core ESP32 mengembalikan err=258 saat driver WiFi belum siap
  // atau ketika mode AP/STA sedang berpindah. Kondisi ini tidak fatal; scan
  // dan koneksi tetap dapat berjalan, jadi jangan penuhi Serial Monitor dengan
  // warning yang membuat operator mengira ada error kritis.
  (void)esp_wifi_set_country(&wifiCountry);
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
  applyWiFiCountryConfig();
  WiFi.setSleep(false);
  esp_wifi_set_ps(WIFI_PS_NONE);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
}

void normalizeMqttEndpoint() {
  String endpoint = String(MQTT_HOST);
  endpoint.trim();
  mqttHostHadScheme = false;
  mqttResolvedPort = MQTT_PORT;

  int schemePos = endpoint.indexOf("://");
  if (schemePos >= 0) {
    String scheme = endpoint.substring(0, schemePos);
    scheme.toLowerCase();
    mqttHostHadScheme = true;
    endpoint = endpoint.substring(schemePos + 3);

    if (scheme == "mqtts" && mqttResolvedPort == 1883) {
      mqttResolvedPort = 8883;
    }
  }

  int pathPos = endpoint.indexOf('/');
  if (pathPos >= 0) endpoint = endpoint.substring(0, pathPos);

  int atPos = endpoint.lastIndexOf('@');
  if (atPos >= 0) endpoint = endpoint.substring(atPos + 1);

  int colonPos = endpoint.lastIndexOf(':');
  if (colonPos > 0) {
    String portPart = endpoint.substring(colonPos + 1);
    endpoint = endpoint.substring(0, colonPos);
    uint16_t parsedPort = (uint16_t)portPart.toInt();
    if (parsedPort > 0) mqttResolvedPort = parsedPort;
  }

  endpoint.trim();
  if (endpoint.length() == 0) endpoint = F("rmq230.smartsystem.id");

  strncpy(mqttResolvedHost, endpoint.c_str(), sizeof(mqttResolvedHost) - 1);
  mqttResolvedHost[sizeof(mqttResolvedHost) - 1] = '\0';
}

void applyMqttStabilityConfig() {
  normalizeMqttEndpoint();
  mqtt.setServer(mqttResolvedHost, mqttResolvedPort);
  mqtt.setBufferSize(MQTT_BUFFER_SIZE_BYTES);
  mqtt.setKeepAlive(MQTT_KEEPALIVE_SEC);
  mqtt.setSocketTimeout(MQTT_SOCKET_TIMEOUT_SEC);
}

const char* wifiStatusText(wl_status_t st);

int scanWiFiNetworksReliable(const __FlashStringHelper* label) {
  // ESP32 hanya 2.4 GHz. Pastikan country/channel 1-13 aktif dan lakukan
  // scan sinkron aktif dengan hidden SSID agar daftar di WiFiManager tidak kosong
  // karena channel 12/13, SSID hidden, atau sisa state WPA2-Enterprise.
  WiFi.scanDelete();
  WiFi.mode(WIFI_STA);
  applyWiFiCountryConfig();
  delay(250);

  int networkCount = WiFi.scanNetworks(false, true);
  if (networkCount == WIFI_SCAN_FAILED || networkCount < 0) {
    Serial.print(label);
    Serial.print(F(" first scan failed, retry result="));
    Serial.println(networkCount);
    WiFi.scanDelete();
    delay(500);
    networkCount = WiFi.scanNetworks(false, true);
  }
  return networkCount;
}

void debugScanWiFiBeforePortal() {
#if WIFI_MANAGER_SCAN_DEBUG
  Serial.println(F("[WIFI MANAGER] Pre-scan visible 2.4GHz networks..."));

  int networkCount = scanWiFiNetworksReliable(F("[WIFI MANAGER]"));
  if (networkCount < 0) {
    Serial.print(F("[WIFI MANAGER] Pre-scan failed, result="));
    Serial.println(networkCount);
    return;
  }

  Serial.print(F("[WIFI MANAGER] Pre-scan found "));
  Serial.print(networkCount);
  Serial.println(F(" network(s)."));

  for (int i = 0; i < networkCount; i++) {
    String ssid = WiFi.SSID(i);
    Serial.print(F("[WIFI MANAGER] #"));
    Serial.print(i + 1);
    Serial.print(F(" SSID='"));
    if (ssid.length()) {
      Serial.print(ssid);
    } else {
      Serial.print(F("<hidden>"));
    }
    Serial.print(F("' RSSI="));
    Serial.print(WiFi.RSSI(i));
    Serial.print(F(" dBm CH="));
    Serial.print(WiFi.channel(i));
    Serial.print(F(" ENC="));
    Serial.println((int)WiFi.encryptionType(i));
  }

  WiFi.scanDelete();
#else
  return;
#endif
}

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
  Serial.println("[EDUROAM] Cleaning enterprise mode before manual WiFi command...");

  // Setelah gagal, bersihkan EAP satu kali lalu tunggu command Serial.
  // Jangan coba eduroam ulang dalam loop karena dapat membuat driver EAP tidak stabil.
  prepareNormalWiFiMode();

  Serial.println("[EDUROAM] WiFiManager tidak dibuka otomatis; gunakan Serial command wifi portal jika diperlukan.");
  Serial.println("╚═══════════════════════════════════════════════════════════╝");

  return false;
#else
  return false;
#endif
}

void drawWiFiPortalInfo(const char* statusText) {
  // Tidak lagi mengganti layar LCD menjadi halaman WiFi config portal.
  // WiFiManager tetap berjalan untuk konfigurasi dari HP/browser, sedangkan
  // LCD cukup mempertahankan splash/status agar boot terlihat konsisten.
  Serial.print(F("[WIFI LCD] "));
  Serial.println(statusText);

  tft.fillRect(40, 306, 400, 14, C_WHITE);
  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextDatum(MC_DATUM);
  tft.setTextSize(1);
  tft.drawString(statusText, SW / 2, 313);
  tft.setTextDatum(TL_DATUM);
}


void drawWiFiLcdSelectionPage(const char* statusText) {
  tft.fillScreen(C_BG);
  tft.fillRect(0, 0, SW, 38, C_PRIMARY);
  tft.setTextColor(C_WHITE, C_PRIMARY);
  tft.setTextSize(2);
  tft.setCursor(12, 11);
  tft.print("PILIH WIFI");

  tft.setTextColor(C_MUTED, C_BG);
  tft.setTextSize(1);
  tft.setCursor(220, 15);
  tft.print(statusText);

  for (uint8_t i = 0; i < wifiLcdNetworkCount; i++) {
    int y = 48 + i * 34;
    bool openNetwork = wifiLcdEncryptions[i] == WIFI_AUTH_OPEN;
    tft.fillRoundRect(14, y, 452, 28, 6, C_WHITE);
    tft.drawRoundRect(14, y, 452, 28, 6, C_BORDER);
    tft.setTextColor(C_DARK, C_WHITE);
    tft.setTextSize(1);
    tft.setCursor(26, y + 10);
    String name = wifiLcdSsids[i];
    if (name.length() > 28) name = name.substring(0, 28);
    tft.print(i + 1);
    tft.print(". ");
    tft.print(name);
    tft.setCursor(315, y + 10);
    tft.print(wifiLcdRssis[i]);
    tft.print(" dBm");
    tft.setCursor(402, y + 10);
    tft.print(openNetwork ? "OPEN" : "LOCK");
  }

  if (wifiLcdNetworkCount == 0) {
    tft.setTextColor(C_RED, C_BG);
    tft.setCursor(24, 92);
    tft.print("Tidak ada SSID terdeteksi. Tekan RESCAN atau OFFLINE.");
  }

  tft.fillRoundRect(14, 262, 140, 40, 8, C_WHITE);
  tft.drawRoundRect(14, 262, 140, 40, 8, C_PRIMARY);
  tft.setTextColor(C_PRIMARY, C_WHITE);
  tft.setCursor(55, 277);
  tft.print("RESCAN");

  tft.fillRoundRect(170, 262, 140, 40, 8, C_PRIMARY);
  tft.drawRoundRect(170, 262, 140, 40, 8, C_PRIMARY);
  tft.setTextColor(C_WHITE, C_PRIMARY);
  tft.setCursor(210, 277);
  tft.print("OFFLINE");

  tft.fillRoundRect(326, 262, 140, 40, 8, C_WHITE);
  tft.drawRoundRect(326, 262, 140, 40, 8, C_PRIMARY);
  tft.setTextColor(C_PRIMARY, C_WHITE);
  tft.setCursor(370, 277);
  tft.print("OFFLINE");
}

uint8_t scanWiFiForLcdSelection() {
  wifiLcdNetworkCount = 0;
  for (uint8_t i = 0; i < WIFI_LCD_MAX_NETWORKS; i++) {
    wifiLcdSsids[i] = "";
    wifiLcdRssis[i] = -127;
    wifiLcdEncryptions[i] = WIFI_AUTH_OPEN;
  }

  drawWiFiLcdSelectionPage("Scanning...");
  WiFi.mode(WIFI_STA);
  applyWiFiCountryConfig();
  delay(200);

  int n = WiFi.scanNetworks(false, true);
  if (n <= 0) {
    WiFi.scanDelete();
    drawWiFiLcdSelectionPage("No SSID found");
    return 0;
  }

  for (int i = 0; i < n; i++) {
    String ssid = WiFi.SSID(i);
    if (!ssid.length()) continue;

    bool duplicate = false;
    for (uint8_t j = 0; j < wifiLcdNetworkCount; j++) {
      if (wifiLcdSsids[j] == ssid) {
        duplicate = true;
        if (WiFi.RSSI(i) > wifiLcdRssis[j]) {
          wifiLcdRssis[j] = WiFi.RSSI(i);
          wifiLcdEncryptions[j] = WiFi.encryptionType(i);
        }
        break;
      }
    }
    if (duplicate) continue;

    if (wifiLcdNetworkCount < WIFI_LCD_MAX_NETWORKS) {
      wifiLcdSsids[wifiLcdNetworkCount] = ssid;
      wifiLcdRssis[wifiLcdNetworkCount] = WiFi.RSSI(i);
      wifiLcdEncryptions[wifiLcdNetworkCount] = WiFi.encryptionType(i);
      wifiLcdNetworkCount++;
    }
  }

  WiFi.scanDelete();
  drawWiFiLcdSelectionPage("Tap SSID / OFFLINE");
  return wifiLcdNetworkCount;
}

int waitForWiFiLcdSelection() {
  unsigned long startedAt = millis();
  static unsigned long lastTouchMs = 0;

  while (millis() - startedAt < WIFI_LCD_SELECT_TIMEOUT_MS) {
    if (touchDetected && ts.touched() && millis() - lastTouchMs > 220UL) {
      int x, y, rawX, rawY;
      readTouchMapped(x, y, rawX, rawY);
      lastTouchMs = millis();

      for (uint8_t i = 0; i < wifiLcdNetworkCount; i++) {
        int rowY = 48 + i * 34;
        if (x >= 14 && x <= 466 && y >= rowY && y <= rowY + 28) {
          return i;
        }
      }

      if (y >= 262 && y <= 310) {
        if (x >= 14 && x <= 154) return -2;   // rescan
        if (x >= 170 && x <= 310) return -4;  // offline
        if (x >= 326 && x <= 466) return -4;  // offline
      }
    }

    delay(20);
    yield();
  }

  return -4; // timeout: stay offline; WiFiManager is handled by setupWiFiManager(), not the LCD page.
}

bool connectSelectedWiFiFromLcd(uint8_t index) {
  if (index >= wifiLcdNetworkCount) return false;

  const String ssid = wifiLcdSsids[index];
  bool openNetwork = wifiLcdEncryptions[index] == WIFI_AUTH_OPEN;

  tft.fillRect(0, 0, SW, 38, C_PRIMARY);
  tft.setTextColor(C_WHITE, C_PRIMARY);
  tft.setTextSize(2);
  tft.setCursor(12, 11);
  tft.print("CONNECT WIFI");
  tft.fillRect(14, 210, 452, 36, C_BG);
  tft.setTextColor(C_DARK, C_BG);
  tft.setTextSize(1);
  tft.setCursor(24, 218);
  tft.print("Mencoba SSID: ");
  tft.print(ssid);
  tft.setCursor(24, 236);
  tft.print(openNetwork ? "Jaringan open." : "Jaringan terkunci: mencoba credential tersimpan.");

  Serial.print(F("[WIFI LCD] Selected SSID: "));
  Serial.println(ssid);
  Serial.println(openNetwork ? F("[WIFI LCD] Open network, direct connect.") : F("[WIFI LCD] Locked network, trying saved credential first."));

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  applyWiFiStabilityConfig();

  if (openNetwork) {
    WiFi.begin(ssid.c_str());
  } else {
    // ESP32 can reconnect here only if this SSID/password was already saved in NVS.
    // If it fails, fallback WiFiManager portal is shown for password entry.
    WiFi.begin(ssid.c_str());
  }

  if (waitForWiFiConnection(F("[WIFI LCD]"), WIFI_LCD_CONNECT_TIMEOUT_MS)) {
    wifiOK = true;
    wifiConnectionMode = WIFI_MODE_MANAGER;
    printWiFiConnectedInfo(F("[WIFI LCD]"));
    return true;
  }

  WiFi.disconnect(false, false);
  wifiOK = false;
  Serial.println(F("[WIFI LCD] Connect failed. Password mungkin belum tersimpan; fallback ke portal."));
  drawWiFiPortalInfo("SSID terkunci/gagal. Lanjutkan lewat Configure WiFi.");
  delay(1200);
  return false;
}

bool connectWiFiFromLcdSelection() {
  if (!touchDetected) {
    Serial.println(F("[WIFI LCD] Touch tidak terdeteksi, skip pilihan LCD."));
    return false;
  }

  while (true) {
    scanWiFiForLcdSelection();
    int choice = waitForWiFiLcdSelection();

    if (choice >= 0) {
      if (connectSelectedWiFiFromLcd((uint8_t)choice)) return true;
      return false;
    }

    if (choice == -2) continue;
    if (choice == -4) {
      Serial.println(F("[WIFI LCD] User chose OFFLINE."));
      return false;
    }

    Serial.println(F("[WIFI LCD] Selection timeout; no portal page is drawn on LCD."));
    drawWiFiPortalInfo("WiFiManager berjalan tanpa halaman portal di LCD.");
    delay(700);
    return false;
  }
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
  applyWiFiCountryConfig();
  delay(1000);

  debugScanWiFiBeforePortal();

  // Biarkan WiFiManager sendiri yang mengaktifkan AP+STA. Jika mode AP_STA
  // dipaksa sebelum startConfigPortal(), beberapa core ESP32 menampilkan
  // halaman Configure WiFi putih/kosong karena captive portal dan scan web
  // handler tidak terpasang bersih setelah EAP eduroam gagal.
  WiFi.mode(WIFI_STA);
  delay(300);

  WiFiManager wm;
  wm.setDebugOutput(false);
  wm.setConfigPortalTimeout(WIFI_MANAGER_TIMEOUT_SEC);
  wm.setConnectTimeout(30);
  wm.setConnectRetries(2);
  wm.setMinimumSignalQuality(0);
  wm.setRemoveDuplicateAPs(false);

#if FORCE_WIFI_PORTAL
  wm.resetSettings();
#endif

  Serial.print(F("[WIFI MANAGER] AP SSID : "));
  Serial.println(WIFI_MANAGER_AP_NAME);
  Serial.print(F("[WIFI MANAGER] AP PASS : "));
  Serial.println(WIFI_MANAGER_AP_PASS);
  Serial.println(F("[WIFI MANAGER] Portal URL: http://192.168.4.1"));
  Serial.println(F("[WIFI MANAGER] Jika Configure WiFi tidak terbuka, akses IP langsung dan matikan mobile data."));
  Serial.println(F("[WIFI MANAGER] Starting config portal now (LCD tetap menampilkan boot splash)."));

  wm.setAPCallback([](WiFiManager *manager) {
    (void)manager;
    Serial.println(F("[WIFI MANAGER] AP portal aktif; LCD tidak dialihkan ke halaman konfigurasi."));
  });

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


bool connectFallbackHomeWiFi() {
  Serial.println();
  Serial.println(F("╔════════════ STATIC WIFI FALLBACK ════════════╗"));
  Serial.print(F("[WIFI HAI] SSID    : "));
  Serial.println(FALLBACK_WIFI_SSID);
  Serial.print(F("[WIFI HAI] Timeout : "));
  Serial.print(FALLBACK_WIFI_TIMEOUT_MS / 1000UL);
  Serial.println(F(" s"));

  mqttOK = false;
  wifiOK = false;

  // Pastikan state WPA2-Enterprise sudah bersih sebelum mencoba WPA2-PSK biasa.
  prepareNormalWiFiMode();
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  applyWiFiCountryConfig();
  applyWiFiStabilityConfig();
  delay(300);

  WiFi.begin(FALLBACK_WIFI_SSID, FALLBACK_WIFI_PASS);

  if (waitForWiFiConnection(F("[WIFI HAI]"), FALLBACK_WIFI_TIMEOUT_MS)) {
    wifiOK = true;
    wifiConnectionMode = WIFI_MODE_MANAGER;
    printWiFiConnectedInfo(F("[WIFI HAI]"));
    Serial.println(F("╚══════════════════════════════════════════════╝"));
    return true;
  }

  WiFi.disconnect(false, false);
  wifiOK = false;
  wifiConnectionMode = WIFI_MODE_OFFLINE;
  Serial.println(F("[WIFI HAI] Gagal konek ke SSID fallback. Lanjut membuka WiFiManager."));
  Serial.print(F("[WIFI HAI] Final status: "));
  Serial.print((int)WiFi.status());
  Serial.print(F(" / "));
  Serial.println(wifiStatusText(WiFi.status()));
  Serial.println(F("╚══════════════════════════════════════════════╝"));
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
  // Jika gagal, sistem tidak menampilkan pilihan di LCD; operator memilih
  // wifi portal / wifi eduroam dari Serial Monitor.
  if (connectEduroam(true)) {
    Serial.println(F("[WIFI] Mode koneksi: EDUROAM WPA2-ENTERPRISE"));
    Serial.println(F("╚══════════════════════════════════════════════╝"));
    return;
  }

  Serial.println(F("[WIFI] Eduroam gagal saat boot. Mencoba SSID fallback hai."));
#else
  Serial.println(F("[WIFI] USE_EDUROAM_FIRST=0, mencoba SSID fallback hai."));
  prepareNormalWiFiMode();
#endif

  if (connectFallbackHomeWiFi()) {
    Serial.println(F("[WIFI] Mode koneksi: FALLBACK SSID hai"));
    activePage = PAGE_GENERATOR;
    needFullRedraw = true;
    Serial.println(F("[DISPLAY] Masuk ke halaman Generator/Engine setelah koneksi WiFi."));
    Serial.println(F("╚══════════════════════════════════════════════╝"));
    return;
  }

  Serial.println(F("[WIFI] SSID hai gagal. Membuka AP WiFiManager fallback otomatis."));
  if (connectWiFiManagerFallback()) {
    Serial.println(F("[WIFI] Mode koneksi: WIFI MANAGER FALLBACK"));
    activePage = PAGE_GENERATOR;
    needFullRedraw = true;
    Serial.println(F("[DISPLAY] Masuk ke halaman Generator/Engine setelah koneksi WiFi."));
    Serial.println(F("╚══════════════════════════════════════════════╝"));
    return;
  }

  Serial.println(F("[WIFI] WiFiManager timeout/gagal. Sistem berjalan offline; halaman Generator/Engine tetap aktif."));
  wifiOK = false;
  wifiConnectionMode = WIFI_MODE_OFFLINE;
  activePage = PAGE_GENERATOR;
  needFullRedraw = true;
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
  Serial.print(F("[MQTT] Host raw   : ")); Serial.println(MQTT_HOST);
  Serial.print(F("[MQTT] Host used  : ")); Serial.println(mqttResolvedHost);
  Serial.print(F("[MQTT] Port used  : ")); Serial.println(mqttResolvedPort);
  Serial.print(F("[MQTT] Client     : ")); Serial.println(clientId);
  Serial.print(F("[MQTT] VHost      : ")); Serial.println(MQTT_VHOST);
  Serial.print(F("[MQTT] Login user : ")); Serial.println(MQTT_LOGIN_USER);
  if (mqttHostHadScheme) Serial.println(F("[MQTT] Catatan    : skema mqtt:// dibuang sebelum koneksi PubSubClient."));
  Serial.print(F("[MQTT] Attempt    : ")); Serial.println(mqttReconnectAttemptCount);
  Serial.print(F("[MQTT] Backoff ms : ")); Serial.println(mqttReconnectBackoffMs);
  Serial.print(F("[MQTT] WiFi RSSI  : ")); Serial.print(WiFi.RSSI()); Serial.println(F(" dBm"));
  Serial.print(F("[MQTT] Free heap  : ")); Serial.println(ESP.getFreeHeap());
  Serial.print(F("[MQTT] Max alloc  : ")); Serial.println(ESP.getMaxAllocHeap());
  Serial.print(F("[MQTT] Connecting : "));

  bool ok = mqtt.connect(clientId.c_str(), MQTT_LOGIN_USER, MQTT_PASS);

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
void drawThickArc(int cx, int cy, int r, int thick, int startDeg, int endDeg, uint16_t color) {
  for (int a = startDeg; a <= endDeg; a += 4) {
    float rad = a * PI / 180.0f;
    int x = cx + (int)(cos(rad) * r);
    int y = cy + (int)(sin(rad) * r);
    tft.fillCircle(x, y, thick / 2, color);
  }
}

void drawFilledRingSegment(int cx, int cy, int outerR, int innerR, int startDeg, int endDeg, uint16_t color) {
  if (endDeg < startDeg) endDeg += 360;
  for (int a = startDeg; a <= endDeg; a += 2) {
    float rad = a * PI / 180.0f;
    int x1 = cx + (int)(cos(rad) * innerR);
    int y1 = cy + (int)(sin(rad) * innerR);
    int x2 = cx + (int)(cos(rad) * outerR);
    int y2 = cy + (int)(sin(rad) * outerR);
    tft.drawLine(x1, y1, x2, y2, color);
  }
}

void drawThickLine(int x1, int y1, int x2, int y2, uint16_t color, int width) {
  for (int o = -(width / 2); o <= (width / 2); o++) {
    tft.drawLine(x1, y1 + o, x2, y2 + o, color);
    tft.drawLine(x1 + o, y1, x2 + o, y2, color);
  }
}

void drawPulseLine(int cx, int cy, uint16_t color) {
  const int points[][2] = {
    {-70, 0}, {-32, 0}, {-22, -18}, {-8, 24}, {10, -82},
    {32, 78}, {52, -42}, {68, 0}, {104, 0}
  };

  for (uint8_t i = 0; i < 8; i++) {
    drawThickLine(cx + points[i][0], cy + points[i][1],
                  cx + points[i + 1][0], cy + points[i + 1][1],
                  color, 7);
  }
  tft.fillCircle(cx + points[0][0], cy + points[0][1], 4, color);
  tft.fillCircle(cx + points[8][0], cy + points[8][1], 4, color);
}

uint16_t bootLogoColor(uint16_t rgb565) {
  // Modul TFT ini menampilkan warna boot logo tertukar byte untuk primitive
  // drawing (biru menjadi kuning/hijau dan oranye menjadi cyan). Fallback logo
  // memakai warna referensi yang dibalik byte-nya agar hasil fisik LCD kembali
  // navy/biru/oranye seperti gambar GENSYS yang diberikan.
  return (uint16_t)((rgb565 << 8) | (rgb565 >> 8));
}

void drawGensysLogoMark(int cx, int cy, int r, uint16_t fg, uint16_t bg) {
  (void)fg;
  // Fallback ini dibuat sebagai versi vektor dari logo referensi: gear/navy
  // di kiri, panah circular biru di kanan-atas dan kiri-bawah, heartbeat
  // oranye di tengah, dan gap huruf G yang bersih.
  const uint16_t darkBlue = bootLogoColor(0x0015);
  const uint16_t brightBlue = bootLogoColor(0x04BF);
  const uint16_t orange = bootLogoColor(0xFD20);

  const int outerR = r;
  const int innerR = r - 23;

  // Gigi gear kiri, dibuat lebih besar dan menempel ke ring seperti logo asli.
  for (int a = 126; a <= 242; a += 29) {
    float rad = a * PI / 180.0f;
    int tx = cx + (int)(cos(rad) * (outerR - 1));
    int ty = cy + (int)(sin(rad) * (outerR - 1));
    tft.fillRoundRect(tx - 15, ty - 14, 30, 28, 5, darkBlue);
  }

  // Ring utama: kiri navy, kanan atas dan kiri bawah biru. Segment dibuat
  // solid, bukan titik-titik, agar tidak tampak pixelated/berbeda warna.
  drawFilledRingSegment(cx, cy, outerR, innerR, 124, 270, darkBlue);
  drawFilledRingSegment(cx, cy, outerR, innerR, 272, 360, brightBlue);
  drawFilledRingSegment(cx, cy, outerR, innerR, 0, 62, brightBlue);
  drawFilledRingSegment(cx, cy, outerR, innerR, 205, 270, brightBlue);
  drawFilledRingSegment(cx, cy, outerR, innerR, 28, 64, darkBlue);

  // Kepala panah referensi.
  tft.fillTriangle(cx + outerR - 4, cy - 31, cx + outerR + 37, cy - 41, cx + outerR + 17, cy + 4, brightBlue);
  tft.fillTriangle(cx - outerR - 3, cy + 39, cx - outerR + 34, cy + 30, cx - outerR + 7, cy + 72, brightBlue);

  // Bersihkan lubang tengah dan celah huruf G.
  tft.fillCircle(cx, cy, innerR - 2, bg);
  tft.fillRect(cx + innerR - 2, cy - 11, outerR - innerR + 58, 23, bg);
  tft.fillRect(cx + 3, cy - outerR - 4, 15, outerR - innerR + 18, bg);
  tft.fillRect(cx + 3, cy + innerR - 8, 15, outerR - innerR + 22, bg);

  // Heartbeat oranye dengan proporsi lebih dekat ke logo contoh.
  const int p[][2] = {
    {-54, 0}, {-25, 0}, {-15, -15}, {-2, 20}, {12, -64},
    {31, 66}, {49, -34}, {64, 0}, {86, 0}
  };
  for (uint8_t i = 0; i < 8; i++) {
    drawThickLine(cx + p[i][0], cy + p[i][1], cx + p[i + 1][0], cy + p[i + 1][1], orange, 6);
  }
  tft.fillCircle(cx + p[0][0], cy + p[0][1], 3, orange);
  tft.fillCircle(cx + p[8][0], cy + p[8][1], 3, orange);
}


#if GENSYS_HAS_PNGDEC
PNG bootLogoPng;
File bootLogoFile;
int bootLogoX = 0;
int bootLogoY = 0;
int bootLogoScale = 1;
int bootLogoDrawW = 0;
int bootLogoDrawH = 0;
uint16_t bootLogoSrcLine[SW];
uint16_t bootLogoDrawLine[SW];

void *pngSdOpen(const char *filename, int32_t *size) {
  bootLogoFile = SD.open(filename, FILE_READ);
  if (!bootLogoFile) return NULL;
  *size = bootLogoFile.size();
  return &bootLogoFile;
}

void pngSdClose(void *handle) {
  File *f = static_cast<File*>(handle);
  if (f && *f) f->close();
}

int32_t pngSdRead(PNGFILE *page, uint8_t *buffer, int32_t length) {
  File *f = static_cast<File*>(page->fHandle);
  if (!f || !*f) return 0;
  return f->read(buffer, length);
}

int32_t pngSdSeek(PNGFILE *page, int32_t position) {
  File *f = static_cast<File*>(page->fHandle);
  if (!f || !*f) return 0;
  return f->seek(position) ? position : 0;
}

void pngDrawToTft(PNGDRAW *pDraw) {
  uint16_t srcW = pDraw->iWidth;
  if (srcW > SW) srcW = SW;

  bootLogoPng.getLineAsRGB565(pDraw, bootLogoSrcLine, PNG_RGB565_BIG_ENDIAN, 0xffffffff);

  if (bootLogoScale <= 1) {
    tft.pushImage(bootLogoX, bootLogoY + pDraw->y, srcW, 1, bootLogoSrcLine);
    return;
  }

  if ((pDraw->y % bootLogoScale) != 0) return;

  int outY = bootLogoY + (pDraw->y / bootLogoScale);
  if (outY < bootLogoY || outY >= bootLogoY + bootLogoDrawH) return;

  int outW = min(bootLogoDrawW, SW);
  for (int x = 0; x < outW; x++) {
    int srcX = x * bootLogoScale;
    if (srcX >= srcW) srcX = srcW - 1;
    bootLogoDrawLine[x] = bootLogoSrcLine[srcX];
  }
  tft.pushImage(bootLogoX, outY, outW, 1, bootLogoDrawLine);
}
#endif

bool drawBootLogoFromSd(int cx, int cy, int maxW, int maxH) {
  if (!sdOK) return false;

#if GENSYS_HAS_PNGDEC
  if (!SD.exists(BOOT_LOGO_PNG_FILE)) return false;
  if (sdMutex != NULL && xSemaphoreTake(sdMutex, pdMS_TO_TICKS(500)) != pdTRUE) return false;

  bool ok = false;
  deselectAllSPI();
  int rc = bootLogoPng.open(BOOT_LOGO_PNG_FILE, pngSdOpen, pngSdClose, pngSdRead, pngSdSeek, pngDrawToTft);
  if (rc == PNG_SUCCESS) {
    int pngW = bootLogoPng.getWidth();
    int pngH = bootLogoPng.getHeight();

    if (pngW > 0 && pngH > 0 && pngW <= SW) {
      bootLogoScale = max(1, max((pngW + maxW - 1) / maxW, (pngH + maxH - 1) / maxH));
      bootLogoDrawW = max(1, pngW / bootLogoScale);
      bootLogoDrawH = max(1, pngH / bootLogoScale);
      bootLogoX = cx - (bootLogoDrawW / 2);
      bootLogoY = cy - (bootLogoDrawH / 2);

      tft.fillRect(cx - maxW / 2, cy - maxH / 2, maxW, maxH, C_WHITE);
      ok = bootLogoPng.decode(NULL, 0) == PNG_SUCCESS;

      Serial.print(F("[BOOT LOGO] /logo.png drawn from SD: "));
      Serial.print(pngW);
      Serial.print('x');
      Serial.print(pngH);
      Serial.print(F(" -> "));
      Serial.print(bootLogoDrawW);
      Serial.print('x');
      Serial.println(bootLogoDrawH);
    }
    bootLogoPng.close();
  }

  if (sdMutex != NULL) xSemaphoreGive(sdMutex);
  if (!ok) {
    Serial.println(F("[BOOT LOGO] /logo.png tidak bisa digambar. Pakai PNG RGB/RGBA dengan lebar <=480 px; gambar akan diskalakan ke area boot."));
  }
  return ok;
#else
  static bool warned = false;
  if (!warned) {
    Serial.println(F("[BOOT LOGO] PNGdec tidak tersedia saat compile; /logo.png tidak bisa dibaca dan memakai logo vektor fallback."));
    warned = true;
  }
  return false;
#endif
}


// ============================================================
// BOOT LOGO FROM ESP32 FLASH
// ============================================================
// Logo GENSYS disimpan di program flash sebagai RGB565 PROGMEM.
// Tujuan:
// - Boot logo tetap muncul walaupun SD card gagal init.
// - Tidak perlu membaca /logo.png dari SD saat boot.
// - SD tetap boleh dipakai untuk database/logging tanpa mempengaruhi tampilan logo.
bool drawBootLogoFromFlash(int cx, int cy) {
  static uint16_t lineBuf[GENSYS_LOGO_W];

  int x0 = cx - (GENSYS_LOGO_W / 2);
  int y0 = cy - (GENSYS_LOGO_H / 2);

  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;

  tft.fillRect(x0 - 4, y0 - 4, GENSYS_LOGO_W + 8, GENSYS_LOGO_H + 8, C_WHITE);

  for (int y = 0; y < GENSYS_LOGO_H; y++) {
    for (int x = 0; x < GENSYS_LOGO_W; x++) {
      // Header menyimpan warna RGB565 normal.
      // bootLogoColor() dipakai agar byte order warna sama dengan logo PNG/primitive
      // pada konfigurasi TFT yang digunakan di kode ini.
      lineBuf[x] = bootLogoColor(pgm_read_word(&gensysLogoRgb565[y * GENSYS_LOGO_W + x]));
    }
    tft.pushImage(x0, y0 + y, GENSYS_LOGO_W, 1, lineBuf);
  }

  Serial.print(F("[BOOT LOGO] Logo drawn from ESP32 flash: "));
  Serial.print(GENSYS_LOGO_W);
  Serial.print('x');
  Serial.println(GENSYS_LOGO_H);
  return true;
}


void drawBootSplashStep(const char* statusText, int progress) {
  static bool bootBaseDrawn = false;
  static int lastProgress = -1;
  static String lastStatus = "";

  const int logoCx = SW / 2;
  const int logoCy = 126;

  const int barX = 90;
  const int barY = 274;
  const int barW = 300;
  const int barH = 16;

  progress = constrain(progress, 0, 100);

  if (!bootBaseDrawn || progress <= 0) {
    tft.fillScreen(C_WHITE);

    // Prioritas utama: logo dari flash ESP32.
    bool logoDrawn = drawBootLogoFromFlash(logoCx, logoCy);

    if (!logoDrawn) {
      drawGensysLogoMark(SW / 2, 108, 78, C_GENSYS_BLUE, C_WHITE);
      tft.setTextDatum(MC_DATUM);
      tft.setTextSize(4);
      tft.setTextColor(bootLogoColor(0x0015), C_WHITE);
      tft.drawString("GEN", (SW / 2) - 36, 214);
      tft.setTextColor(bootLogoColor(0x04BF), C_WHITE);
      tft.drawString("SYS", (SW / 2) + 36, 214);
    }

    tft.setTextDatum(MC_DATUM);
    tft.setTextSize(1);
    // Teks menggunakan warna Navy
    tft.setTextColor(C_GENSYS_NAVY, C_WHITE); 
    tft.drawString("GENERATOR SYNCHRONIZATION AND MONITORING SYSTEM", SW / 2, logoCy + 115);
    
    // Bingkai progress bar menggunakan warna Navy
    tft.drawRoundRect(barX, barY, barW, barH, 8, C_GENSYS_NAVY);
    tft.fillRoundRect(barX + 2, barY + 2, barW - 4, barH - 4, 6, C_WHITE);

    bootBaseDrawn = true;
    lastProgress = -1;
    lastStatus = "";
  }

  if (progress != lastProgress) {
    int innerW = barW - 4;
    int fillW = map(progress, 0, 100, 0, innerW);

    // Bersihkan isi loading bar
    tft.fillRoundRect(barX + 2, barY + 2, innerW, barH - 4, 6, C_WHITE);
    if (fillW > 0) {
      // Isi bar animasi menggunakan warna ORANYE
      tft.fillRoundRect(barX + 2, barY + 2, fillW, barH - 4, 6, C_GENSYS_ORANGE);
    }
    lastProgress = progress;
  }

  if (lastStatus != String(statusText)) {
    tft.fillRect(40, 300, 400, 18, C_WHITE);
    // Teks status menggunakan warna Navy
    tft.setTextColor(C_GENSYS_NAVY, C_WHITE);
    tft.setTextDatum(MC_DATUM);
    tft.setTextSize(1);
    tft.drawString(statusText, SW / 2, 309);
    tft.setTextDatum(TL_DATUM);
    lastStatus = String(statusText);
  }
}

void drawHeaderClock(bool force) {
  static String lastClock = "";
  String clockText = getClockWIBms();

  if (force || clockText != lastClock) {
    tft.fillRect(10, 28, 118, 12, C_PRIMARY);
    tft.setTextColor(C_WHITE, C_PRIMARY);
    tft.setTextSize(1);
    tft.setCursor(10, 30);
    tft.print(clockText);
    lastClock = clockText;
  }
}

void drawHeader(const char* title) {
  // 40 pixel atas menggunakan warna biru (C_PRIMARY)
  tft.fillRect(0, 0, SW, 40, C_PRIMARY);
  
  // 2 pixel strip bawah sebagai aksen menggunakan warna oranye logo
  tft.fillRect(0, 40, SW, 2, C_GENSYS_ORANGE);

  tft.setTextColor(C_WHITE, C_PRIMARY);
  tft.setTextSize(2);
  tft.setCursor(10, 7);
  tft.print(title);

  drawHeaderClock(true);

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
  tft.setCursor(x + w - 26, y + 35);
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
  tft.drawString(unit, x + w / 2, y + h - 5);
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
  tft.print(value, 2);
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

  drawHeaderClock(force);

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

  uint16_t colors[2] = {
    activePage == PAGE_GENERATOR ? C_PRIMARY : C_WHITE,
    activePage == PAGE_ENGINE ? C_PRIMARY : C_WHITE
  };

  uint16_t texts[2] = {
    activePage == PAGE_GENERATOR ? C_WHITE : C_PRIMARY,
    activePage == PAGE_ENGINE ? C_WHITE : C_PRIMARY
  };

  const char* labels[2] = {"GENERATOR", "ENGINE"};
  int xs[2] = {10, 245};

  for (int i = 0; i < 2; i++) {
    tft.fillRoundRect(xs[i], y, 225, h, 8, colors[i]);
    tft.drawRoundRect(xs[i], y, 225, h, 8, C_PRIMARY);
    tft.setTextColor(texts[i], colors[i]);
    tft.setTextSize(1);
    tft.setCursor(xs[i] + 82, y + 9);
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
  static String lastSyncStatus = "";
  static uint32_t lastDrawnAggregateSeq = 0;

  AggregatedData d;
  uint32_t currentAggregateSeq = displayAggregateSeq;
  bool forceValueUpdate = full || currentAggregateSeq != lastDrawnAggregateSeq;

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
    lastSyncStatus = "";
  } else {
    drawHeaderStatusDots(false);
  }

  if (forceValueUpdate || changedFloat(lastVoltGen, d.voltAvg, 0.05f)) {
    drawSemiGauge(14, 52, 46, d.voltAvg, 180.0f, 250.0f, "VOLT GEN", fmtF(d.voltAvg, 1), "V",
                  valColor(d.voltAvg, THRESH_VOLT_WARN_HI, THRESH_VOLT_CRIT_HI, THRESH_VOLT_WARN_LO, THRESH_VOLT_CRIT_LO));
    lastVoltGen = d.voltAvg;
  }

  if (forceValueUpdate || changedFloat(lastFreqGen, d.freqAvg, 0.02f)) {
    drawSemiGauge(170, 52, 46, d.freqAvg, 45.0f, 55.0f, "FREQ GEN", fmtF(d.freqAvg, 2), "Hz",
                  valColor(d.freqAvg, THRESH_FREQ_WARN_HI, THRESH_FREQ_CRIT_HI, THRESH_FREQ_WARN_LO, THRESH_FREQ_CRIT_LO));
    lastFreqGen = d.freqAvg;
  }

  if (forceValueUpdate || changedFloat(lastVoltGrid, d.voltGridAvg, 0.05f)) {
    drawSemiGauge(14, 170, 46, d.voltGridAvg, 180.0f, 250.0f, "VOLT GRID", fmtF(d.voltGridAvg, 1), "V",
                  valColor(d.voltGridAvg, THRESH_VOLT_WARN_HI, THRESH_VOLT_CRIT_HI, THRESH_VOLT_WARN_LO, THRESH_VOLT_CRIT_LO));
    lastVoltGrid = d.voltGridAvg;
  }

  if (forceValueUpdate || changedFloat(lastFreqGrid, d.freqGridAvg, 0.02f)) {
    drawSemiGauge(170, 170, 46, d.freqGridAvg, 45.0f, 55.0f, "FREQ GRID", fmtF(d.freqGridAvg, 2), "Hz",
                  valColor(d.freqGridAvg, THRESH_FREQ_WARN_HI, THRESH_FREQ_CRIT_HI, THRESH_FREQ_WARN_LO, THRESH_FREQ_CRIT_LO));
    lastFreqGrid = d.freqGridAvg;
  }

  // Right-side cards: PHASE, POWER, CURRENT, SYNC STATUS.
  // Semua card hanya di-render ulang jika nilainya berubah atau saat ganti page.
  if (forceValueUpdate || changedFloat(lastPhase, d.phaseAngleAvg, 0.1f)) {
    // Menambahkan \n agar teks deg dicetak lebih bawah
    drawValueBox(326, 50, 140, 50, "PHASE", fmtF(d.phaseAngleAvg, 1), "deg",
                 abs(d.phaseAngleAvg) < THRESH_PHASE_WARN_ABS ? C_GREEN : abs(d.phaseAngleAvg) < THRESH_PHASE_CRIT_ABS ? C_YELLOW : C_RED);
    lastPhase = d.phaseAngleAvg;
  }

  if (forceValueUpdate || changedFloat(lastPowerKW, d.powerAvg, 0.02f)) {
    // Menambahkan \n agar teks kW dicetak lebih bawah
    drawValueBox(326, 106, 140, 50, "POWER", fmtF(d.powerAvg, 2), "kW",
                 valColor(d.powerAvg, THRESH_POWER_WARN_HI, THRESH_POWER_CRIT_HI, -1e9, -1e9));
    lastPowerKW = d.powerAvg;
  }

  if (forceValueUpdate || changedFloat(lastCurrentA, d.currentAvg, 0.1f)) {
    // Menambahkan \n agar teks A dicetak lebih bawah
    drawValueBox(326, 162, 140, 50, "CURRENT", fmtF(d.currentAvg, 1), "A",
                 valColor(d.currentAvg, THRESH_CURRENT_WARN_HI, THRESH_CURRENT_CRIT_HI, -1e9, -1e9));
    lastCurrentA = d.currentAvg;
  }

  const char* syncStatus = getDisplaySyncTextFromAggregate(d);
  if (forceValueUpdate || full || d.synced != lastSynced || lastSyncStatus != String(syncStatus)) {
    uint16_t syncColor = strcmp(syncStatus, "OFF") == 0 ? C_RED : (strcmp(syncStatus, "GENSET") == 0 ? C_YELLOW : (strcmp(syncStatus, "GRID") == 0 ? C_BLUE2 : C_GREEN));
    drawValueBox(326, 218, 140, 56, "SYNC STATUS", syncStatus, "", syncColor);
    lastSynced = d.synced;
    lastSyncStatus = syncStatus;
  }

  lastDrawnAggregateSeq = currentAggregateSeq;
}

void drawEnginePage(bool full) {
  static bool initialized = false;
  static float lastRpm = NAN, lastAfr = NAN, lastMap = NAN;
  static float lastTps = NAN, lastFuel = NAN, lastClt = NAN, lastIat = NAN, lastBatt = NAN;
  static uint32_t lastDrawnAggregateSeq = 0;

  AggregatedData d;
  uint32_t currentAggregateSeq = displayAggregateSeq;
  bool forceValueUpdate = full || currentAggregateSeq != lastDrawnAggregateSeq;

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

  if (forceValueUpdate || changedFloat(lastRpm, d.rpmAvg, 5.0f)) {
    drawSemiGauge(14, 52, 46, d.rpmAvg, 0.0f, 6000.0f, "ENGINE RPM", fmtF(d.rpmAvg, 0), "rpm",
                  valColor(d.rpmAvg, THRESH_RPM_WARN_HI, THRESH_RPM_CRIT_HI, -1e9, -1e9));
    lastRpm = d.rpmAvg;
  }

  if (forceValueUpdate || changedFloat(lastAfr, d.afrAvg, 0.05f)) {
    drawSemiGauge(170, 52, 46, d.afrAvg, 10.0f, 20.0f, "AFR", fmtF(d.afrAvg, 1), "",
                  valColor(d.afrAvg, THRESH_AFR_WARN_HI, THRESH_AFR_CRIT_HI, THRESH_AFR_WARN_LO, THRESH_AFR_CRIT_LO));
    lastAfr = d.afrAvg;
  }

  if (forceValueUpdate || changedFloat(lastMap, d.mapAvg, 0.5f)) {
    drawSemiGauge(326, 52, 46, d.mapAvg, 20.0f, 105.0f, "MAP", fmtF(d.mapAvg, 0), "kPa",
                  valColor(d.mapAvg, THRESH_MAP_WARN_HI, THRESH_MAP_CRIT_HI, -1e9, -1e9));
    lastMap = d.mapAvg;
  }

  // Panel frame dibuat hanya pada full redraw/first draw. Setelah itu,
  // update hanya bar/card yang nilainya berubah agar TFT tidak menggambar ulang
  // satu panel penuh untuk perubahan kecil.
  if (forceValueUpdate || full || isnan(lastTps) || isnan(lastFuel)) {
    drawPanel(14, 172, 220, 102, "FUEL & THROTTLE");
  }

  if (forceValueUpdate || changedFloat(lastTps, d.tpsAvg, 0.5f)) {
    // Menambahkan indikator (%) pada label TPS
    drawLineBar(28, 214, 145, 12, d.tpsAvg, 0.0f, 100.0f, C_GREEN, "TPS (%)");
    lastTps = d.tpsAvg;
  }

  if (forceValueUpdate || changedFloat(lastFuel, d.fuelAvg, 0.5f)) {
    // Menambahkan indikator (%) pada label Fuel
    drawLineBar(28, 253, 145, 12, d.fuelAvg, 0.0f, 100.0f,
                d.fuelAvg > THRESH_FUEL_WARN_LO ? C_GREEN : d.fuelAvg > THRESH_FUEL_CRIT_LO ? C_YELLOW : C_RED, "Fuel (%)");
    lastFuel = d.fuelAvg;
  }

  if (forceValueUpdate || full || isnan(lastBatt) || isnan(lastIat) || isnan(lastClt)) {
    drawPanel(246, 172, 220, 102, "THERMAL & POWER");
  }

  if (forceValueUpdate || changedFloat(lastBatt, d.battAvg, 0.05f)) {
    drawValueCard(256, 205, 62, 58, "Battery", fmtF(d.battAvg, 1), "",
                  valColor(d.battAvg, THRESH_BATT_WARN_HI, THRESH_BATT_CRIT_HI, THRESH_BATT_WARN_LO, THRESH_BATT_CRIT_LO));
    lastBatt = d.battAvg;
  }

  if (forceValueUpdate || changedFloat(lastIat, d.iatAvg, 0.5f)) {
    // Menambahkan spasi ganda sebelum C agar unit terdorong ke kanan
    drawValueCard(326, 205, 62, 58, "IAT", fmtF(d.iatAvg, 0), "C",
                  valColor(d.iatAvg, THRESH_IAT_WARN_HI, THRESH_IAT_CRIT_HI, -1e9, -1e9));
    lastIat = d.iatAvg;
  }

  if (forceValueUpdate || changedFloat(lastClt, d.cltAvg, 0.5f)) {
    // Menambahkan spasi ganda sebelum C agar unit terdorong ke kanan
    drawValueCard(396, 205, 62, 58, "Coolant", fmtF(d.cltAvg, 0), "C",
                  valColor(d.cltAvg, THRESH_CLT_WARN_HI, THRESH_CLT_CRIT_HI, -1e9, -1e9));
    lastClt = d.cltAvg;
  }

  lastDrawnAggregateSeq = currentAggregateSeq;
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
    drawEnginePage(full);
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

  auto navHit = [](int tx, int ty) -> int {
    // Area navbar bawah layar dibuat sedikit lebih tinggi agar tap tetap masuk
    // walaupun mapping touch FT6206 bergeser beberapa piksel.
    if (ty < 270 || ty > 320) return -1;
    if (tx >= 0 && tx <= 240) return PAGE_GENERATOR;
    if (tx >= 240 && tx <= 480) return PAGE_ENGINE;
    return -1;
  };

  targetPage = navHit(x, y);

  // Fallback untuk modul FT6206 yang orientasi raw-nya berbeda setelah TFT rotation(1).
  // Ini membuat tombol bawah tetap bisa pindah page tanpa harus reflash hanya untuk kalibrasi.
  if (targetPage < 0) targetPage = navHit(rawY, rawX);
  if (targetPage < 0) targetPage = navHit(rawY, 320 - rawX);
  if (targetPage < 0) targetPage = navHit(480 - rawY, rawX);

  if (targetPage >= 0) {
    lastTouchMs = millis();

    if (targetPage != activePage) {
      activePage = targetPage;
      needFullRedraw = true;
      lastDraw = 0;   // paksa redraw segera pada loop berikutnya

      Serial.print(F("[TOUCH] Page changed to "));
      if (activePage == PAGE_GENERATOR) Serial.println(F("GENERATOR"));
      else Serial.println(F("ENGINE"));
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
                          float reservedAvgUs,
                          uint32_t mongoRecordBytes,
                          uint32_t mongoAvgSentRecordBytes,
                          uint64_t mongoPayload10y,
                          uint64_t mongoStorage10y) {
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
  Serial.print(reservedAvgUs, 1); Serial.print(',');
  Serial.print(mongoRecordBytes); Serial.print(',');
  Serial.print(mongoAvgSentRecordBytes); Serial.print(',');
  Serial.print((double)mongoPayload10y / 1024.0 / 1024.0, 2); Serial.print(',');
  Serial.println((double)mongoStorage10y / 1024.0 / 1024.0, 2);
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
  float reservedAvgUs = perfAvgStat(acqMon.reservedComputeUs);

  uint32_t mongoRecordBytes = getMongoRecordBytes();
  uint32_t mongoAvgSentRecordBytes = getMongoAvgSentRecordBytes();
  uint64_t mongoPayload10y = estimateMongoPayloadBytes10Years(mongoAvgSentRecordBytes);
  uint64_t mongoStorage10y = estimateMongoStorageBytes10Years(mongoAvgSentRecordBytes);
  float mongoRecordsPerSec = 1000.0f / (float)localSaveInterval;

  bool uartIntervalPass = (uartAvgMs > 0.0f && uartAvgMs <= 200.0f);
  bool aggregationPass = (AGGREGATION_INTERVAL_MS >= 100UL && AGGREGATION_INTERVAL_MS <= 1000UL);
  bool mqttIntervalPass = (publishInterval <= 1000UL);
  bool sdIntervalPass = (localSaveInterval == 1000UL);
  bool sdReliabilityPass = (sdReliabilityPct >= 99.0f);
  bool mqttReliabilityPass = (mqttReliabilityPct >= 99.0f || (mqttOk == 0 && mqttFail == 0));
  bool packetLossPass = (uartLossPct < 1.0f);
  bool deadlinePass = (sensorMissedDeadlines == 0);
  bool mongoBatchPass = (MONGODB_BATCH_INTERVAL_MS == SPEC_DATABASE_TARGET_MS);
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
  Serial.print  (F("║ SD check interval            : ")); Serial.print(localSaveInterval); Serial.println(F(" ms"));
  Serial.print  (F("║ Expected SD backup records   : ")); Serial.println(expectedSdRecords, 0);
  Serial.print  (F("║ Stored SD backup OK/FAIL     : ")); Serial.print(sdOk); Serial.print(F(" / ")); Serial.println(sdFail);
  Serial.print  (F("║ SD backup records total      : ")); Serial.println(sdBackupRecordCount);
  Serial.print  (F("║ SD skipped online total      : ")); Serial.println(sdBackupSkipOnlineCount);
  Serial.print  (F("║ SD logging reliability       : ")); Serial.print(sdReliabilityPct, 2); Serial.println(F(" %"));
  Serial.print  (F("║ Last CSV row size            : ")); Serial.print(dbLastLineBytes); Serial.println(F(" B/record"));
  Serial.print  (F("║ Current SD Card size         : ")); Serial.println(formatBytes(dbCachedFileSizeBytes));
  Serial.print  (F("║ Estimated SD 7 days          : ")); Serial.println(formatBytes((uint64_t)((float)dbLastLineBytes * 86400.0f * 7.0f)));

  Serial.println(F("╠════════════ COMPUTATION PERFORMANCE ══════════╣"));
  Serial.print  (F("║ Sensor interval avg          : ")); Serial.print(sensorAvgMs, 2); Serial.println(F(" ms"));
  Serial.print  (F("║ SensorTask avg               : ")); Serial.print(sensorTaskAvgUs, 1); Serial.println(F(" us"));
  Serial.print  (F("║ UART read avg                : ")); Serial.print(uartReadAvgUs, 1); Serial.println(F(" us"));
  Serial.print  (F("║ CSV parse avg                : ")); Serial.print(csvParseAvgUs, 1); Serial.println(F(" us"));
  Serial.print  (F("║ Aggregation avg              : ")); Serial.print(aggregationAvgUs, 1); Serial.println(F(" us"));
  Serial.print  (F("║ SD append avg                : ")); Serial.print(sdAvgUs, 1); Serial.println(F(" us"));
  Serial.print  (F("║ MQTT publish avg             : ")); Serial.print(mqttAvgUs, 1); Serial.println(F(" us"));
  Serial.print  (F("║ TFT draw avg                 : ")); Serial.print(tftAvgUs, 1); Serial.println(F(" us"));
  Serial.print  (F("║ Reserved compute avg             : ")); Serial.print(reservedAvgUs, 1); Serial.println(F(" us"));
  Serial.print  (F("║ Missed deadline 20 ms        : ")); Serial.println(sensorMissedDeadlines);


  printPaperCsvSummary(runtimeSec, uartAvgMs, uartMinMs, uartMaxMs, uartLossPct,
                       frameSuccessPct, sdReliabilityPct, mqttReliabilityPct,
                       mongoConsistencyPct, sensorTaskAvgUs, csvParseAvgUs,
                       aggregationAvgUs, sdAvgUs, mqttAvgUs, tftAvgUs, reservedAvgUs,
                       mongoRecordBytes, mongoAvgSentRecordBytes,
                       mongoPayload10y, mongoStorage10y);

  Serial.println(F("╚══════════════════════════════════════════════════════════════╝"));
}

// ============================================================
// SERIAL COMMAND CONSOLE
// ============================================================
void printSerialHelp() {
  Serial.println();
  Serial.println(F("GENSYS CMD: help | paper | paper start | paper ticker on/off | spec/acq | db/database | send now | perf | latest"));
  Serial.println(F("SERIAL    : monitor overview | monitor overview on/off | raw uart | db payload | db payload full"));
  Serial.println(F("SERIAL    : monitoring payload | monitoring payload full | db payload on/off | monitoring payload on/off | mongo ticker on/off"));
  Serial.println(F("SEND MODE : buffermongo only"));
  Serial.println(F("TEST CMD  : test once | test once reset | test once last | test once status | test once off | perf reset"));
  Serial.println(F("LOG CMD   : log acq on | log performance on | log aggregation on | log latest on | log off"));
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
  json += "\"powerSource\":\"" + String(getPowerSourceFromAggregate(a)) + "\"";
  json += "}";
  return json;
}


// Estimasi kapasitas MongoDB untuk kebutuhan tabel Data Management IEEE.
// Perhitungan ini memakai JSON parameter-only yang dikirim ke topic gen/realtime mode buffermongo.
#define MONGODB_ESTIMATION_YEARS 10UL
#define MONGODB_STORAGE_OVERHEAD_FACTOR 1.2f

uint32_t getMongoRecordBytes() {
  // Prioritas 1: ukuran JSON parameter-only yang terakhir benar-benar disimpan ke buffer MongoDB.
  // lastDatabaseJsonBytesCache sudah merepresentasikan record parameter-only dari buildJsonRecordParametersOnly().
  if (lastDatabaseJsonBytesCache > 2) return lastDatabaseJsonBytesCache - 2; // cache menambahkan CR/LF, MQTT tidak mengirim CR/LF

  // Prioritas 2: estimasi dari aggregate terakhir jika belum ada record tersimpan.
  String estimateRecord = buildCloudEstimateRecordOnly();
  return estimateRecord.length();
}

uint32_t getMongoAvgSentRecordBytes() {
  if (mongoDbLastSentRecords > 0 && mongoDbLastPayloadBytes > 0) {
    return mongoDbLastPayloadBytes / mongoDbLastSentRecords;
  }
  if (mongoUploadLastAckedRecords > 0 && mongoUploadLastPayloadBytes > 0) {
    return mongoUploadLastPayloadBytes / mongoUploadLastAckedRecords;
  }
  return getMongoRecordBytes();
}

uint64_t estimateMongoPayloadBytes10Years(uint32_t recordBytes) {
  // SD tetap 1 record per second mengikuti localSaveInterval = 1000 ms.
  // Jika interval berubah, rumus otomatis menyesuaikan recordsPerDay.
  if (recordBytes == 0) return 0;
  double intervalSec = (double)localSaveInterval / 1000.0;
  if (intervalSec <= 0.0) intervalSec = 1.0;

  double recordsPerDay = 86400.0 / intervalSec;
  double totalBytes = (double)recordBytes * recordsPerDay * 365.0 * (double)MONGODB_ESTIMATION_YEARS * MONGODB_STORAGE_OVERHEAD_FACTOR;
  if (totalBytes < 0.0) totalBytes = 0.0;
  return (uint64_t)totalBytes;
}

uint64_t estimateMongoStorageBytes10Years(uint32_t recordBytes) {
  // Payload JSON × faktor overhead MongoDB.
  // Faktor overhead mencakup field metadata BSON, struktur dokumen, dan index dasar.
  double payloadBytes = (double)estimateMongoPayloadBytes10Years(recordBytes);
  return (uint64_t)(payloadBytes * MONGODB_STORAGE_OVERHEAD_FACTOR);
}


void printMongoBufferStatus() {
  uint16_t bufferCount = mongoDbBufferCount;

  Serial.println();
  Serial.println(F("================ MONGODB 10-MIN BUFFER ================"));
  Serial.print  (F("  data mode      : ")); Serial.println(getDataSendModeText());
  Serial.print  (F("  buffer records : ")); Serial.print(bufferCount); Serial.print(F(" / ")); Serial.println(MONGODB_BUFFER_RECORDS);
  Serial.print  (F("  interval       : ")); Serial.print(MONGODB_BATCH_INTERVAL_MS / 1000UL); Serial.println(F(" s"));
  Serial.print  (F("  topic          : ")); Serial.println(MQTT_TOPIC);
  Serial.print  (F("  last sent      : ")); Serial.print(mongoDbLastSentRecords); Serial.println(F(" records"));
  Serial.print  (F("  total sent     : ")); Serial.print(mongoDbTotalSentRecords); Serial.println(F(" records"));
  Serial.print  (F("  last payload   : ")); Serial.print(mongoDbLastPayloadBytes); Serial.println(F(" B"));
  {
    uint32_t recBytes = getMongoRecordBytes();
    uint32_t avgSentBytes = getMongoAvgSentRecordBytes();
    uint64_t payload10y = estimateMongoPayloadBytes10Years(avgSentBytes);
    uint64_t storage10y = estimateMongoStorageBytes10Years(avgSentBytes);
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
  if (isBufferEspMode()) {
    Serial.println(F("STATUS: bufferesp disabled; mode tetap buffermongo."));
  } else {
    Serial.println(F("STATUS: buffermongo aktif; server buffer gen/realtime 10 menit lalu simpan MongoDB."));
  }
  Serial.println(F("NOTE  : Serial monitor menampilkan buffer count, umur buffer, dan record terkirim ke MongoDB/backend."));
  Serial.println(F("======================================================="));
}

void printDatabaseReport() {
  updateStorageCache();
  String cloudParamOnly = buildCloudEstimateRecordOnly();

  const float sdBytesPerSec = (float)dbLastLineBytes * STORAGE_BATCH_SIZE;
  const float sd7d = sdBytesPerSec * 86400.0f * 7.0f;
  const uint32_t cloudRecordBytes = getMongoRecordBytes();
  const uint32_t cloudAvgSentRecordBytes = getMongoAvgSentRecordBytes();
  const float cloudBytesPerSec = (float)cloudAvgSentRecordBytes * (1000.0f / (float)localSaveInterval);
  const uint64_t cloudPayload10y = estimateMongoPayloadBytes10Years(cloudAvgSentRecordBytes);
  const uint64_t cloudStorage10y = estimateMongoStorageBytes10Years(cloudAvgSentRecordBytes);

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
  Serial.print  (F("  backup records  : ")); Serial.println(sdBackupRecordCount);
  Serial.print  (F("  skipped online  : ")); Serial.println(sdBackupSkipOnlineCount);
  Serial.print  (F("  backup reason   : NET=")); Serial.print(sdBackupBecauseNetworkCount);
  Serial.print(F(" BUF=")); Serial.print(sdBackupBecauseBufferFullCount);
  Serial.print(F(" MONGO=")); Serial.println(sdBackupBecauseMongoFailCount);
  Serial.print  (F("  buffer count    : ")); Serial.print(mongoDbBufferCount); Serial.print(F(" / ")); Serial.println(MONGODB_BUFFER_RECORDS);
  Serial.print  (F("  MQTT send OK/FAIL: ")); Serial.print(mongoUploadSuccessRecords); Serial.print(F(" / ")); Serial.println(mongoUploadFailCount);
  Serial.print  (F("  last MQTT state    : ")); Serial.println(mongoUploadLastHttpCode);
  Serial.println();

  Serial.println(F("CLOUD / MONGODB HISTORY - BUFFERMONGO SERVER (MAIN DATABASE FIELDS ONLY)"));
  Serial.print  (F("  realtime topic  : ")); Serial.println(MQTT_REALTIME_TOPIC);
  Serial.print  (F("  mongo topic     : ")); Serial.println(MQTT_TOPIC);
  Serial.print  (F("  publish path    : ")); Serial.println(F("MQTT gen/realtime -> server buffer 600 -> MongoDB"));
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
  Serial.print  (F("║ Reserved compute avg            : ")); Serial.print(perfAvgStat(acqMon.reservedComputeUs), 1); Serial.println(F(" us"));
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
  Serial.print  (F("║ Interval database 10 menit  : ")); Serial.println(passFailText(databaseTargetPass));
  Serial.print  (F("║ OVERALL REAL-TIME MONITOR   : ")); Serial.println(passFailText(realtimePass));

  if (!databaseTargetPass) {
    Serial.println(F("║ CATATAN: MONGODB_BATCH_INTERVAL_MS belum 10 menit. Cek nilai macro timing.       ║"));
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

  const uint32_t cloudRecordBytes = getMongoRecordBytes();
  const uint32_t cloudAvgSentRecordBytes = getMongoAvgSentRecordBytes();
  const float cloudBytesPerSec = (float)cloudAvgSentRecordBytes * (1000.0f / (float)localSaveInterval);
  const float cloudBatchCapacityPer10Min = (float)MONGODB_BATCH_RECORDS;
  const float cloudBatchGeneratedPer10Min = ((float)MONGODB_BATCH_INTERVAL_MS / (float)localSaveInterval) * STORAGE_BATCH_SIZE;
  const float cloudBatchPayloadEstimate = (float)cloudAvgSentRecordBytes * min(cloudBatchGeneratedPer10Min, cloudBatchCapacityPer10Min);
  const uint64_t cloudPayload10y = estimateMongoPayloadBytes10Years(cloudAvgSentRecordBytes);
  const uint64_t cloudStorage10y = estimateMongoStorageBytes10Years(cloudAvgSentRecordBytes);

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
  Serial.print  (F("║ Reserved compute avg             : ")); Serial.print(perfAvgStat(acqMon.reservedComputeUs), 1); Serial.println(F(" us"));
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
  Serial.print  (F("║ Last CSV row                 : ")); Serial.print(dbLastLineBytes); Serial.println(F(" B/record"));
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
  Serial.print  (F("║ MongoDB record size          : ")); Serial.print(cloudRecordBytes); Serial.println(F(" B/record"));
  Serial.print  (F("║ MongoDB avg sent record      : ")); Serial.print(cloudAvgSentRecordBytes); Serial.println(F(" B/record"));
  Serial.print  (F("║ Effective cloud data rate    : ")); Serial.println(formatBytes((uint64_t)cloudBytesPerSec) + F("/s"));
  Serial.print  (F("║ Estimated payload 10 years   : ")); Serial.println(formatBytes(cloudPayload10y));
  Serial.print  (F("║ Estimated MongoDB 10 years   : ")); Serial.print(formatBytes(cloudStorage10y)); Serial.print(F(" @ overhead x")); Serial.println(MONGODB_STORAGE_OVERHEAD_FACTOR, 1);
  Serial.println(F("║ Note: estimation uses parameter-only gen/realtime buffermongo records."));
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

void printSdFileCheck() {
  Serial.println();
  Serial.println(F("╔════════════════ SD FILE CHECK ════════════════╗"));
  Serial.print  (F("║ sdOK                         : ")); Serial.println(sdOK ? F("READY") : F("NOT READY"));
  Serial.print  (F("║ DB_FILE                      : ")); Serial.println(DB_FILE);
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
  Serial.print  (F("║ sdDatabase.csv exist           : ")); Serial.println(dbExists ? F("YES") : F("NO"));

  if (dbExists) {
    File f = SD.open(DB_FILE, FILE_READ);
    if (f) {
      Serial.print(F("║ sdDatabase.csv size            : "));
      Serial.print(f.size());
      Serial.println(F(" bytes"));
      String header = f.readStringUntil('\n');
      header.trim();
      Serial.print(F("║ database header parameter-only: "));
      Serial.println(F("YES"));
      f.close();
    } else {
      Serial.println(F("║ sdDatabase.csv open            : FAILED"));
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
    Serial.println(F("[DB] /sdDatabase.csv siap."));
  } else {
    Serial.println(F("[DB] Gagal membuat/mengecek /sdDatabase.csv."));
  }
}

void reinitSdFromCommand() {
  Serial.println(F("[SD] Manual reinit diminta."));
  sdOK = false;
  sdConsecutiveOpenFail = 0;
  initSDCard();
  displayUpdateNow = true;
}

void resetSDDatabase() {
  if (!sdOK) { Serial.println(F("[DB] SD not ready.")); return; }
  if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
    deselectAllSPI();
    if (SD.exists(DB_FILE)) SD.remove(DB_FILE);
    if (createFreshDatabaseCsv()) {
      dbTotalWrittenBytes = 0; dbLastLineBytes = 0; sdSaveSuccessCount = 0; sdSaveFailCount = 0; sdConsecutiveOpenFail = 0; mongoUploadSuccessRecords = 0; mongoUploadFailCount = 0; mongoUploadLastHttpCode = 0; mongoUploadLastAckedRecords = 0; mongoUploadLastAttemptMs = 0; mongoUploadLastBatchRecords = 0; mongoUploadLastPayloadBytes = 0; mongoUploadLastRunChunks = 0; mongoUploadLastRunRecords = 0; mongoUploadLastAckResponseRecords = 0; hasLastDatabasePayloadCache = false; lastSdCsvLineCache = ""; lastSdQueueJsonCache = ""; mongoDbBufferCount = 0; mongoDbBufferedTotal = 0; mongoDbBufferOverflowCount = 0; lastMongoBufferedLocalSeq = 0; lastSdSavedLocalSeq = 0; mongoDbLastSentRecords = 0; mongoDbTotalSentRecords = 0; mongoDbLastPayloadBytes = 0; mongoDbLastAckResponseRecords = 0; mongoDbLastSendMs = 0;
      Serial.println(F("[DB] sdDatabase.csv reset OK."));
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
  else if (cmd == "send mode" || cmd == "data mode" || cmd == "mode send") printDataSendModeStatus();
  else if (cmd == "send mode bufferesp" || cmd == "data mode bufferesp" || cmd == "mode bufferesp" || cmd == "bufferesp") { Serial.println(F("[MODE] bufferesp disabled. Mode tetap buffermongo.")); setDataSendMode(DATA_SEND_MODE_BUFFERMONGO); }
  else if (cmd == "send mode buffermongo" || cmd == "data mode buffermongo" || cmd == "mode buffermongo" || cmd == "buffermongo") setDataSendMode(DATA_SEND_MODE_BUFFERMONGO);
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
  else if (cmd == "page generator") { if (activePage != PAGE_GENERATOR) { activePage = PAGE_GENERATOR; needFullRedraw = true; } else { displayUpdateNow = true; } Serial.println(F("[DISPLAY] generator")); }
  else if (cmd == "page engine") { if (activePage != PAGE_ENGINE) { activePage = PAGE_ENGINE; needFullRedraw = true; } else { displayUpdateNow = true; } Serial.println(F("[DISPLAY] engine")); }
  else if (cmd == "redraw") { needFullRedraw = true; Serial.println(F("[DISPLAY] redraw")); }
  else if (cmd == "configurewifi" || cmd == "configure wifi" || cmd == "wifi portal") { Serial.println(F("[WIFI] Manual Configure WiFi portal requested from Serial Monitor.")); prepareNormalWiFiMode(); connectWiFiManagerFallback(); needFullRedraw = true; }
  else if (cmd == "wifi eduroam" || cmd == "eduroam") { Serial.println(F("[WIFI] Manual eduroam retry requested from Serial Monitor.")); connectEduroam(false); needFullRedraw = true; }
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
  else if (cmd == "log off") { serialLogEnabled = false; serialLogAllEnabled = false; serialLogDatabaseEnabled = false; serialLogPerformanceEnabled = false; serialLogSensorEnabled = false; serialLogNetworkEnabled = false; serialLogAggregationEnabled = false; serialLogStorageEnabled = false; serialLogLatestEnabled = false; serialMonitorOverviewEnabled = false; serialMongoBufferTickerEnabled = false; Serial.println(F("[LOG] off")); }
  else if (cmd == "log database on") { serialLogEnabled = true; serialLogDatabaseEnabled = true; Serial.println(F("[LOG] database on")); }
  else if (cmd == "log performance on") { serialLogEnabled = true; serialLogPerformanceEnabled = true; Serial.println(F("[LOG] performance on")); }
  else if (cmd == "log aggregation on" || cmd == "log agg on") { serialLogEnabled = true; serialLogAggregationEnabled = true; Serial.println(F("[LOG] aggregation on")); }
  else if (cmd == "log acq on" || cmd == "log spec on") { serialLogEnabled = true; serialLogSensorEnabled = true; Serial.println(F("[LOG] acquisition/spec on")); }
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
  Serial.println("BOOTING GENSYS ESP32-2 INDUSTRIAL HMI - SD STABLE ORDER");

  memset(&latestRaw, 0, sizeof(latestRaw));
  memset(&aggData, 0, sizeof(aggData));
  resetAcquisitionMonitorStats();
  strlcpy(latestRaw.syncText, "off", sizeof(latestRaw.syncText));
    strlcpy(latestRaw.syncStatus, "off", sizeof(latestRaw.syncStatus));
  strlcpy(latestRaw.statusText, "NO-DATA", sizeof(latestRaw.statusText));

  dataMutex = xSemaphoreCreateMutex();
  sdMutex = xSemaphoreCreateMutex();
  mongoBufferMutex = xSemaphoreCreateMutex();
  mqttMutex = xSemaphoreCreateMutex();
  mongoUploadRequestSemaphore = xSemaphoreCreateBinary();


  // ============================================================
  // STRING RESERVE TO REDUCE HEAP FRAGMENTATION
  // ============================================================
  // Jangan reserve seluruh 600 slot karena akan memakai heap besar di awal.
  // Reserve hanya sebesar 1 chunk publish; slot lain dialokasi saat terisi.
  for (uint16_t i = 0; i < MONGODB_UPLOAD_CHUNK_RECORDS && i < MONGODB_BUFFER_RECORDS; i++) {
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
  if (mongoUploadRequestSemaphore == NULL) Serial.println("[ERROR] mongoUploadRequestSemaphore gagal dibuat.");

  deselectAllSPI();

  LinkSerial.setRxBufferSize(LINK_SERIAL_RX_BUFFER_BYTES);
  LinkSerial.begin(LINK_BAUD, SERIAL_8N1, LINK_RX_PIN, LINK_TX_PIN);
  LinkSerial.setTimeout(20);

  // TFT init dulu seperti versi yang terbukti bisa mount SD onboard TFT.
  pinMode(CTP_RST, OUTPUT);
  digitalWrite(CTP_RST, LOW); delay(10);
  digitalWrite(CTP_RST, HIGH); delay(100);

  tft.init();
  tft.setRotation(1);
  tft.setSwapBytes(true);

  // Mount SD sebelum boot splash pertama agar /logo.png bisa langsung tampil
  // dari kartu SD. Jika gagal, drawBootSplashStep() tetap memakai logo vektor.
  drawBootSplashStep("Initializing Local SD Card Database...", 10);
  delay(100); 
  initSDCard();
  drawBootSplashStep(sdOK ? "SD Card Mounted - Database Ready" : "SD Card Offline - Skipping Logging", 35);

  drawBootSplashStep("Initializing touch controller...", 25);
  Wire.begin(CTP_SDA, CTP_SCL);
  if (!ts.begin(40)) {
    touchDetected = false;
    Serial.println("[TOUCH] Tidak terdeteksi.");
  } else {
    touchDetected = true;
    Serial.println("[TOUCH] OK.");
  }

  drawBootSplashStep(sdOK ? "Local SD database ready" : "SD offline - continuing", 50);

  drawBootSplashStep("Loading WiFi.........", 58);
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

  drawBootSplashStep("Starting realtime sensor tasks...", 94);

  xTaskCreatePinnedToCore(
    UartRxTask,
    "UartRxTask",
    LINK_RX_TASK_STACK_WORDS,
    NULL,
    LINK_RX_TASK_PRIORITY,
    NULL,
    1
  );

  xTaskCreatePinnedToCore(
    SensorTask50Hz,
    "SensorTask50Hz",
    12000,
    NULL,
    2,
    NULL,
    1
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


void serviceDisplayAndTouch() {
  // Display/touch diservis sebelum pekerjaan WiFi/MQTT/SD yang bisa blocking.
  // Dengan ini data lokal dari agregasi 0,5 detik tidak menunggu reconnect MQTT
  // atau retry SD runtime.
  handleTouchNavigation();

  static unsigned long lastHeaderClockRefreshMs = 0;
  if (!needFullRedraw && millis() - lastHeaderClockRefreshMs >= 50UL) {
    lastHeaderClockRefreshMs = millis();
    drawHeaderClock(false);
  }

  bool doPartialUpdate = displayUpdateNow || (millis() - lastDraw >= drawInterval);
  if (needFullRedraw || doPartialUpdate) {
    lastDraw = millis();

    drawCurrentPage(needFullRedraw);
    needFullRedraw = false;
    displayUpdateNow = false;

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
}

void loop() {
  handleSerialCommandConsole();
  handlePeriodicSerialLog();
  serviceDisplayAndTouch();

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

  if (!sdOK && millis() - lastSDRetry >= SD_AUTO_RETRY_INTERVAL_MS) {
    lastSDRetry = millis();
    Serial.println("[SD] Runtime retry terjadwal 60 detik (1 attempt, non-spam)...");
    retrySDCardOnceFast();
    displayUpdateNow = true;
  }

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

  serviceDisplayAndTouch();

  delay(1);
}
