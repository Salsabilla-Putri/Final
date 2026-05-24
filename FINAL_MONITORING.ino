// ============================================================
// GENSYS ESP32-2 MONITORING FINAL
// Industrial TFT HMI + Touch Navigation + Serial Command Console
// CSV UART + 0.5s Aggregation Batch + SD CSV + MQTT + FFT Page
//
// RX CSV dari ESP32-1:
// $seq,timestampMs,rpm,tps,iat,clt,afr,batt,fuel,freq,freqGrid,volt,voltGrid,phaseAngle,engineSync,gridSync,valid
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
#define EDUROAM_PASSWORD   "akun.STEI.11"
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

// ============================================================
// TIMING
// ============================================================
#define SENSOR_SAMPLE_HZ          50
#define SENSOR_SAMPLE_INTERVAL_MS 20
#define AGGREGATION_INTERVAL_MS   500
#define STORAGE_BATCH_SIZE        2

const unsigned long publishInterval   = 1000;
const unsigned long localSaveInterval = 1000;
const unsigned long drawInterval      = 500;

// ============================================================
// FFT EDGE
// ============================================================
#define ENABLE_FFT_EDGE        1
#define FFT_SAMPLE_RATE_HZ     50.0f
#define FFT_SAMPLES            64
#define FFT_BINS_TO_SEND       32

// 1 = volt generator, 2 = freq generator, 3 = rpm
#define FFT_SOURCE_SIGNAL      1

// ============================================================
// DATA STRUCT
// ============================================================
struct RawData {
  uint32_t seq = 0;
  uint32_t timestampMs = 0;
  uint32_t sourceSampleHz = SENSOR_SAMPLE_HZ;

  int rpm = 0;
  int tps = 0;
  int iat = 0;
  int clt = 0;

  float batt = 0;
  float afr = 0;
  float fuel = 0;

  float freq = 0;
  float freqGrid = 0;
  float volt = 0;
  float voltGrid = 0;
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
  float iatAvg = 0; int iatMin = 0; int iatMax = 0;
  float cltAvg = 0; int cltMin = 0; int cltMax = 0;

  float afrAvg = 0; float afrMin = 0; float afrMax = 0;
  float battAvg = 0; float battMin = 0; float battMax = 0;
  float fuelAvg = 0; float fuelMin = 0; float fuelMax = 0;

  float freqAvg = 0; float freqMin = 0; float freqMax = 0;
  float freqGridAvg = 0; float freqGridMin = 0; float freqGridMax = 0;
  float voltAvg = 0; float voltMin = 0; float voltMax = 0;
  float voltGridAvg = 0; float voltGridMin = 0; float voltGridMax = 0;
  float phaseAngleAvg = 0; float phaseAngleMin = 0; float phaseAngleMax = 0;

  bool synced = false;
  bool valid = false;
};

struct AggAccumulator {
  uint16_t count = 0;

  float rpmSum = 0; int rpmMin = 999999; int rpmMax = -999999;
  float tpsSum = 0; int tpsMin = 999999; int tpsMax = -999999;
  float iatSum = 0; int iatMin = 999999; int iatMax = -999999;
  float cltSum = 0; int cltMin = 999999; int cltMax = -999999;

  float afrSum = 0; float afrMin = 999999; float afrMax = -999999;
  float battSum = 0; float battMin = 999999; float battMax = -999999;
  float fuelSum = 0; float fuelMin = 999999; float fuelMax = -999999;

  float freqSum = 0; float freqMin = 999999; float freqMax = -999999;
  float freqGridSum = 0; float freqGridMin = 999999; float freqGridMax = -999999;
  float voltSum = 0; float voltMin = 999999; float voltMax = -999999;
  float voltGridSum = 0; float voltGridMin = 999999; float voltGridMax = -999999;
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
FFTData fftData;
StorageRecord storageBatch[STORAGE_BATCH_SIZE];

float fftBuffer[FFT_SAMPLES];
uint16_t fftIndex = 0;
bool fftBufferFull = false;

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

uint32_t storageBatchSeq = 0;
uint8_t storageBatchCount = 0;

unsigned long sdSaveSuccessCount = 0;
unsigned long sdSaveFailCount = 0;
uint64_t dbTotalWrittenBytes = 0;
uint32_t dbLastLineBytes = 0;
uint64_t dbCachedFileSizeBytes = 0;
uint64_t sdCachedCardSizeBytes = 0;
uint64_t sdCachedUsedBytes = 0;
uint64_t sdCachedFreeBytes = 0;
unsigned long dbCachedAtMs = 0;

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
  return "VOLT";
#elif FFT_SOURCE_SIGNAL == 2
  return "FREQ";
#elif FFT_SOURCE_SIGNAL == 3
  return "RPM";
#else
  return "VOLT";
#endif
}

// ============================================================
// CSV PARSER
// ============================================================
bool parseBridgeCsv(const String &line, RawData &out) {
  if (!line.startsWith("$")) return false;

  String data = line.substring(1);
  String fields[17];
  int fieldIndex = 0;
  int start = 0;

  for (int i = 0; i <= data.length(); i++) {
    if (i == data.length() || data[i] == ',') {
      if (fieldIndex < 17) {
        fields[fieldIndex] = data.substring(start, i);
        fields[fieldIndex].trim();
        fieldIndex++;
      }
      start = i + 1;
    }
  }

  if (fieldIndex < 16) return false;

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

  if (fieldIndex >= 17) {
    out.phaseAngle = fields[13].toFloat();
    out.speeduinoSync = fields[14].toInt() == 1;
    out.gridSync = fields[15].toInt() == 1;
    out.valid = fields[16].toInt() == 1;
  } else {
    out.phaseAngle = 0.0f;
    out.speeduinoSync = fields[13].toInt() == 1;
    out.gridSync = fields[14].toInt() == 1;
    out.valid = fields[15].toInt() == 1;
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
      Serial.printf("[RX OK] seq=%lu rpm=%d freq=%.2f volt=%.1f phase=%.2f gridSync=%d valid=%d\n",
                    (unsigned long)parsed.seq, parsed.rpm, parsed.freq, parsed.volt,
                    parsed.phaseAngle, parsed.gridSync ? 1 : 0, parsed.valid ? 1 : 0);
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
  acc.iatSum += d.iat; acc.iatMin = min(acc.iatMin, d.iat); acc.iatMax = max(acc.iatMax, d.iat);
  acc.cltSum += d.clt; acc.cltMin = min(acc.cltMin, d.clt); acc.cltMax = max(acc.cltMax, d.clt);

  acc.afrSum += d.afr; acc.afrMin = min(acc.afrMin, d.afr); acc.afrMax = max(acc.afrMax, d.afr);
  acc.battSum += d.batt; acc.battMin = min(acc.battMin, d.batt); acc.battMax = max(acc.battMax, d.batt);
  acc.fuelSum += d.fuel; acc.fuelMin = min(acc.fuelMin, d.fuel); acc.fuelMax = max(acc.fuelMax, d.fuel);

  acc.freqSum += d.freq; acc.freqMin = min(acc.freqMin, d.freq); acc.freqMax = max(acc.freqMax, d.freq);
  acc.freqGridSum += d.freqGrid; acc.freqGridMin = min(acc.freqGridMin, d.freqGrid); acc.freqGridMax = max(acc.freqGridMax, d.freqGrid);
  acc.voltSum += d.volt; acc.voltMin = min(acc.voltMin, d.volt); acc.voltMax = max(acc.voltMax, d.volt);
  acc.voltGridSum += d.voltGrid; acc.voltGridMin = min(acc.voltGridMin, d.voltGrid); acc.voltGridMax = max(acc.voltGridMax, d.voltGrid);
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
  out.iatAvg = acc.iatSum / acc.count; out.iatMin = acc.iatMin; out.iatMax = acc.iatMax;
  out.cltAvg = acc.cltSum / acc.count; out.cltMin = acc.cltMin; out.cltMax = acc.cltMax;

  out.afrAvg = acc.afrSum / acc.count; out.afrMin = acc.afrMin; out.afrMax = acc.afrMax;
  out.battAvg = acc.battSum / acc.count; out.battMin = acc.battMin; out.battMax = acc.battMax;
  out.fuelAvg = acc.fuelSum / acc.count; out.fuelMin = acc.fuelMin; out.fuelMax = acc.fuelMax;

  out.freqAvg = acc.freqSum / acc.count; out.freqMin = acc.freqMin; out.freqMax = acc.freqMax;
  out.freqGridAvg = acc.freqGridSum / acc.count; out.freqGridMin = acc.freqGridMin; out.freqGridMax = acc.freqGridMax;
  out.voltAvg = acc.voltSum / acc.count; out.voltMin = acc.voltMin; out.voltMax = acc.voltMax;
  out.voltGridAvg = acc.voltGridSum / acc.count; out.voltGridMin = acc.voltGridMin; out.voltGridMax = acc.voltGridMax;
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

    if (out.samples < 15) fastAggUnderfilled++;
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

  float signal = getFFTInputSignal(d);
  if (isnan(signal) || isinf(signal)) return;

  fftBuffer[fftIndex] = signal;
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

  float ordered[FFT_SAMPLES];
  for (uint16_t i = 0; i < FFT_SAMPLES; i++) {
    uint16_t idx = (fftIndex + i) % FFT_SAMPLES;
    ordered[i] = fftBuffer[idx];
  }

  float mean = 0;
  for (uint16_t i = 0; i < FFT_SAMPLES; i++) mean += ordered[i];
  mean /= FFT_SAMPLES;

  float sumSq = 0;
  for (uint16_t i = 0; i < FFT_SAMPLES; i++) {
    float x = ordered[i] - mean;
    sumSq += x * x;
  }

  FFTData local;
  local.valid = true;
  local.samples = FFT_SAMPLES;
  local.sampleRateHz = FFT_SAMPLE_RATE_HZ;
  local.resolutionHz = FFT_SAMPLE_RATE_HZ / FFT_SAMPLES;
  local.rms = sqrt(sumSq / FFT_SAMPLES);

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

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    fftData = local;
    xSemaphoreGive(dataMutex);
  }

  perfFftComputeUs = micros() - fftStart;
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

    if (hasSample) {
      addSampleToAccumulator(sample);
      addSampleToFFTBuffer(sample);
    }

    if (millis() - lastAggMs >= AGGREGATION_INTERVAL_MS) {
      lastAggMs = millis();
      finalizeFastAggregate();
      computeFFTIfReady();
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
String buildJsonRecord(const StorageRecord &r) {
  const AggregatedData &a = r.agg;
  const FFTData &f = r.fft;

  String json = "{";
  json += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  json += "\"timestamp\":\"" + r.timestamp + "\",";
  json += "\"timestampMs\":" + String(r.timestampMs) + ",";
  json += "\"batchSeq\":" + String(r.batchSeq) + ",";
  json += "\"slot\":" + String(r.slotIndex) + ",";
  json += "\"sampleWindowMs\":500,";
  json += "\"samples\":" + String(a.samples) + ",";

  json += "\"rpm\":" + String(a.rpmAvg, 1) + ",";
  json += "\"tps\":" + String(a.tpsAvg, 1) + ",";
  json += "\"iat\":" + String(a.iatAvg, 1) + ",";
  json += "\"clt\":" + String(a.cltAvg, 1) + ",";
  json += "\"afr\":" + String(a.afrAvg, 2) + ",";
  json += "\"batt\":" + String(a.battAvg, 2) + ",";
  json += "\"fuel\":" + String(a.fuelAvg, 1) + ",";

  json += "\"freq\":" + String(a.freqAvg, 3) + ",";
  json += "\"freqGrid\":" + String(a.freqGridAvg, 3) + ",";
  json += "\"volt\":" + String(a.voltAvg, 2) + ",";
  json += "\"voltGrid\":" + String(a.voltGridAvg, 2) + ",";
  json += "\"phaseAngle\":" + String(a.phaseAngleAvg, 2) + ",";
  json += "\"synced\":" + String(a.synced ? "true" : "false") + ",";

  json += "\"fft\":{";
  json += "\"valid\":" + String(f.valid ? "true" : "false") + ",";
  json += "\"source\":\"" + String(getFFTSourceName()) + "\",";
  json += "\"sampleRateHz\":" + String(f.sampleRateHz, 1) + ",";
  json += "\"resolutionHz\":" + String(f.resolutionHz, 3) + ",";
  json += "\"peakHz\":" + String(f.peakHz, 3) + ",";
  json += "\"peakMagnitude\":" + String(f.peakMagnitude, 5) + ",";
  json += "\"rms\":" + String(f.rms, 5) + ",";
  json += "\"bins\":[";
  for (uint16_t i = 0; i < FFT_BINS_TO_SEND; i++) {
    if (i) json += ",";
    json += "{\"f\":" + String(f.freqBins[i], 3) + ",\"m\":" + String(f.magBins[i], 5) + "}";
  }
  json += "]}";

  json += "}";
  return json;
}

String buildJsonBatchPayload() {
  uint32_t buildStart = micros();

  String json = "{";
  json += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  json += "\"type\":\"batch_0_5s\",";
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

  bool hasData = false;
  for (uint8_t i = 0; i < STORAGE_BATCH_SIZE; i++) {
    if (storageBatch[i].valid) hasData = true;
  }
  if (!hasData) return;

  String payload = buildJsonBatchPayload();

  uint32_t pubStart = micros();
  bool ok = mqtt.publish(MQTT_TOPIC, payload.c_str());
  perfMqttPublishUs = micros() - pubStart;

  mqttOK = ok;
  if (ok) lastMqttPublishMs = millis();
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
      f.println("timestamp,batchSeq,slot,timestampMs,samples,rpm,tps,iat,clt,afr,batt,fuel,freq,freqGrid,volt,voltGrid,phaseAngle,synced,fftPeakHz,fftPeakMag,fftRms");
      f.close();
    }
  }

  updateStorageCache();
  Serial.println("══════════════════════════════════════");
}

String buildCsvLine(const StorageRecord &r) {
  const AggregatedData &a = r.agg;
  const FFTData &f = r.fft;

  String line = "";
  line += getCsvTimestampWIBms(); line += ",";
  line += String(r.batchSeq); line += ",";
  line += String(r.slotIndex); line += ",";
  line += String(r.timestampMs); line += ",";
  line += String(a.samples); line += ",";
  line += String(a.rpmAvg, 1); line += ",";
  line += String(a.tpsAvg, 1); line += ",";
  line += String(a.iatAvg, 1); line += ",";
  line += String(a.cltAvg, 1); line += ",";
  line += String(a.afrAvg, 2); line += ",";
  line += String(a.battAvg, 2); line += ",";
  line += String(a.fuelAvg, 1); line += ",";
  line += String(a.freqAvg, 3); line += ",";
  line += String(a.freqGridAvg, 3); line += ",";
  line += String(a.voltAvg, 2); line += ",";
  line += String(a.voltGridAvg, 2); line += ",";
  line += String(a.phaseAngleAvg, 2); line += ",";
  line += String(a.synced ? 1 : 0); line += ",";
  line += String(f.peakHz, 3); line += ",";
  line += String(f.peakMagnitude, 5); line += ",";
  line += String(f.rms, 5);
  return line;
}

void saveSnapshotToSD() {
  if (!sdOK) return;

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
    sdSaveSuccessCount++;
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
  Serial.print("[MQTT] Topic : "); Serial.println(MQTT_TOPIC);
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
  tft.fillScreen(C_PRIMARY);
  drawGensysLogoMark(SW / 2, 108, 78, C_WHITE, C_PRIMARY);

  tft.setTextColor(C_WHITE, C_PRIMARY);
  tft.setTextDatum(MC_DATUM);
  tft.setTextSize(4);
  tft.drawString("GENSYS", SW / 2, 213);

  tft.setTextSize(1);
  tft.drawString("GENERATOR SYNCHRONIZATION", SW / 2, 246);
  tft.drawString("& MONITORING SYSTEM", SW / 2, 262);

  int barX = 80;
  int barY = 288;
  int barW = 320;
  int barH = 14;

  tft.drawRoundRect(barX, barY, barW, barH, 7, C_WHITE);
  int fillW = map(progress, 0, 100, 0, barW - 4);
  tft.fillRoundRect(barX + 2, barY + 2, fillW, barH - 4, 5, C_GREEN);

  tft.setTextSize(1);
  tft.drawString(statusText, SW / 2, 310);
  tft.setTextDatum(TL_DATUM);
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
  tft.setCursor(x + w - 38, y + 35);
  tft.print(unit);
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

  tft.setTextColor(C_DARK, C_WHITE);
  tft.setCursor(x + w + 8, y - 1);
  tft.print(value, 1);
}

void drawSemiGauge(int x, int y, int r, float value, float minVal, float maxVal,
                   const char* label, const char* valueText, const char* unit,
                   uint16_t color) {
  tft.fillRoundRect(x, y, 140, 112, 10, C_WHITE);
  tft.drawRoundRect(x, y, 140, 112, 10, C_BORDER);

  int cx = x + 70;
  int cy = y + 76;

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

  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextSize(1);
  tft.setCursor(x + 10, y + 8);
  tft.print(label);

  tft.setTextColor(color, C_WHITE);
  tft.setTextSize(2);
  tft.setCursor(x + 18, y + 56);
  tft.print(valueText);

  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextSize(1);
  tft.setCursor(x + 90, y + 62);
  tft.print(unit);
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
  AggregatedData d;
  FFTData f;

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    d = aggData;
    f = fftData;
    xSemaphoreGive(dataMutex);
  }

  if (full) {
    tft.fillScreen(C_BG);
  }

  drawHeader("GENERATOR MONITOR");

  drawSemiGauge(14, 55, 50, d.freqAvg, 45.0f, 55.0f, "FREQ GEN", fmtF(d.freqAvg, 2), "Hz",
                valColor(d.freqAvg, 51.0, 52.0, 49.0, 48.0));
  drawSemiGauge(170, 55, 50, d.voltAvg, 180.0f, 250.0f, "VOLT GEN", fmtF(d.voltAvg, 0), "V",
                valColor(d.voltAvg, 240, 250, 200, 180));
  drawSemiGauge(326, 55, 50, d.phaseAngleAvg, -30.0f, 30.0f, "PHASE", fmtF(d.phaseAngleAvg, 1), "deg",
                abs(d.phaseAngleAvg) < 10 ? C_GREEN : abs(d.phaseAngleAvg) < 20 ? C_ORANGE : C_RED);

  drawPanel(14, 178, 220, 100, "GRID COMPARISON");
  drawLineBar(28, 218, 145, 12, d.freqGridAvg, 45.0f, 55.0f,
              valColor(d.freqGridAvg, 51.0, 52.0, 49.0, 48.0), "PLN Frequency");
  drawLineBar(28, 252, 145, 12, d.voltGridAvg, 180.0f, 250.0f,
              valColor(d.voltGridAvg, 240, 250, 200, 180), "PLN Voltage");

  drawPanel(246, 178, 220, 100, "SYNCHRONIZATION");
  uint16_t syncColor = d.synced ? C_GREEN : C_RED;
  tft.setTextColor(syncColor, C_WHITE);
  tft.setTextSize(2);
  tft.setCursor(270, 208);
  tft.print(d.synced ? "ON-GRID" : "OFF-GRID");

  tft.setTextColor(C_MUTED, C_WHITE);
  tft.setTextSize(1);
  tft.setCursor(270, 238);
  tft.print("Delta F : ");
  tft.print(abs(d.freqAvg - d.freqGridAvg), 2);
  tft.print(" Hz");

  tft.setCursor(270, 254);
  tft.print("FFT     : ");
  tft.print(f.valid ? "READY" : "BUFFER");

  drawBottomNav();
}

void drawEnginePage(bool full) {
  AggregatedData d;

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    d = aggData;
    xSemaphoreGive(dataMutex);
  }

  if (full) {
    tft.fillScreen(C_BG);
  }

  drawHeader("ENGINE MONITOR");

  drawSemiGauge(14, 55, 50, d.rpmAvg, 0.0f, 6000.0f, "ENGINE RPM", fmtF(d.rpmAvg, 0), "rpm",
                valColor(d.rpmAvg, 4500, 5500, -1e9, -1e9));
  drawSemiGauge(170, 55, 50, d.cltAvg, 20.0f, 120.0f, "COOLANT", fmtF(d.cltAvg, 0), "C",
                valColor(d.cltAvg, 90, 105, -1e9, -1e9));
  drawSemiGauge(326, 55, 50, d.afrAvg, 10.0f, 20.0f, "AFR", fmtF(d.afrAvg, 1), "",
                valColor(d.afrAvg, 16.0, 18.0, 12.0, 10.5));

  drawPanel(14, 178, 220, 100, "ENGINE PARAMETERS");
  drawLineBar(28, 218, 145, 12, d.tpsAvg, 0.0f, 100.0f, C_GREEN, "Throttle Position");
  drawLineBar(28, 252, 145, 12, d.fuelAvg, 0.0f, 100.0f,
              d.fuelAvg > 30 ? C_GREEN : d.fuelAvg > 15 ? C_ORANGE : C_RED, "Fuel Level");

  drawPanel(246, 178, 220, 100, "ELECTRICAL SUPPORT");
  drawValueCard(262, 206, 85, 56, "Battery", fmtF(d.battAvg, 1), "V",
                valColor(d.battAvg, 14.5, 15.5, 11.5, 10.5));
  drawValueCard(360, 206, 85, 56, "IAT", fmtF(d.iatAvg, 0), "C",
                valColor(d.iatAvg, 55, 70, -1e9, -1e9));

  drawBottomNav();
}

void drawFFTPage(bool full) {
  FFTData f;

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    f = fftData;
    xSemaphoreGive(dataMutex);
  }

  if (full) {
    tft.fillScreen(C_BG);
  }

  drawHeader("FFT EDGE MONITOR");

  drawPanel(14, 55, 452, 222, "FFT SPECTRUM");

  int gx = 36;
  int gy = 92;
  int gw = 400;
  int gh = 145;

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
    tft.print("  Peak=");
    tft.print(f.peakHz, 2);
    tft.print("Hz  Mag=");
    tft.print(f.peakMagnitude, 4);
    tft.print("  RMS=");
    tft.print(f.rms, 3);
  } else {
    tft.setTextColor(C_MUTED, C_WHITE);
    tft.setTextSize(2);
    tft.setCursor(130, 150);
    tft.print("FFT BUFFERING...");
  }

  drawBottomNav();
}

void drawCurrentPage(bool full) {
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
  Serial.println("╔════════════════════ GENSYS SERIAL COMMAND ════════════════════╗");
  Serial.println("║ BASIC                                                       ║");
  Serial.println("║ help              : daftar command lengkap                  ║");
  Serial.println("║ all               : print semua report satu kali            ║");
  Serial.println("║ status            : ringkasan network + performance         ║");
  Serial.println("║ database/db       : status SD + database lokal              ║");
  Serial.println("║ performance/perf  : runtime + performance                   ║");
  Serial.println("║ sensor            : sensor task + sampling                  ║");
  Serial.println("║ network/wifi/mqtt : WiFi + MQTT + link                      ║");
  Serial.println("║ wifi auto         : coba eduroam lalu fallback WiFiManager   ║");
  Serial.println("║ wifi eduroam      : paksa koneksi eduroam WPA2-Enterprise   ║");
  Serial.println("║ wifi manager      : paksa portal/saved WiFiManager          ║");
  Serial.println("║ wifi disconnect   : putuskan WiFi                           ║");
  Serial.println("║ mqtt reconnect    : reconnect MQTT manual                   ║");
  Serial.println("║ latest/data       : raw data + aggregate terakhir           ║");
  Serial.println("║ aggregation/agg   : status agregasi 0.5 detik               ║");
  Serial.println("║ storage/batch     : isi batch 2 data per detik              ║");
  Serial.println("║ fft               : status dan bin FFT                      ║");
  Serial.println("║ touch             : status touch + toggle touch debug       ║");
  Serial.println("║ calibrate         : mode kalibrasi touch                    ║");
  Serial.println("║ display           : status display page                     ║");
  Serial.println("║                                                            ║");
  Serial.println("║ PAGE CONTROL                                                ║");
  Serial.println("║ page generator    : pindah display generator                ║");
  Serial.println("║ page engine       : pindah display engine                   ║");
  Serial.println("║ page fft          : pindah display FFT                      ║");
  Serial.println("║ redraw            : paksa full redraw display               ║");
  Serial.println("║                                                            ║");
  Serial.println("║ CONTINUOUS / LEGACY SERIAL LOG                              ║");
  Serial.println("║ log on            : aktifkan serial print periodik          ║");
  Serial.println("║ log off           : matikan serial print periodik           ║");
  Serial.println("║ log all           : aktifkan semua log periodik             ║");
  Serial.println("║ log minimal       : network+sensor+performance periodik     ║");
  Serial.println("║ log clear         : nonaktifkan semua kategori periodik     ║");
  Serial.println("║ log status        : tampilkan konfigurasi serial log        ║");
  Serial.println("║ log interval 1000 : ubah interval print periodik dalam ms   ║");
  Serial.println("║ log database on/off                                         ║");
  Serial.println("║ log performance on/off                                      ║");
  Serial.println("║ log sensor on/off                                           ║");
  Serial.println("║ log network on/off                                          ║");
  Serial.println("║ log aggregation on/off                                      ║");
  Serial.println("║ log storage on/off                                          ║");
  Serial.println("║ log fft on/off                                              ║");
  Serial.println("║ log latest on/off                                           ║");
  Serial.println("║ rx raw on/off      : tampilkan CSV mentah dari UART         ║");
  Serial.println("║ rx ok on/off       : tampilkan ringkasan setiap RX valid    ║");
  Serial.println("╚══════════════════════════════════════════════════════════════╝");
}

void printDatabaseReport() {
  updateStorageCache();

  Serial.println();
  Serial.println("╔════════════ DATA MANAGEMENT STATUS ════════════╗");
  Serial.print("[SD] Ready              : "); Serial.println(sdOK ? "YES" : "NO");
  Serial.print("[DB] File               : "); Serial.println(DB_FILE);
  Serial.print("[DB] Cached size        : "); Serial.println(formatBytes(dbCachedFileSizeBytes));
  Serial.print("[SD] Card size          : "); Serial.println(formatBytes(sdCachedCardSizeBytes));
  Serial.print("[SD] Used               : "); Serial.println(formatBytes(sdCachedUsedBytes));
  Serial.print("[SD] Free               : "); Serial.println(formatBytes(sdCachedFreeBytes));
  Serial.print("[DB] Last line bytes    : "); Serial.println(dbLastLineBytes);
  Serial.print("[DB] Total written      : "); Serial.println(formatBytes(dbTotalWrittenBytes));
  Serial.print("[DB] Save success       : "); Serial.println(sdSaveSuccessCount);
  Serial.print("[DB] Save fail          : "); Serial.println(sdSaveFailCount);
  Serial.print("[DB] Last SD save time  : "); Serial.print(perfSdSaveUs); Serial.println(" us");
  Serial.println("╚════════════════════════════════════════════════╝");
}

void printPerformanceReport() {
  Serial.println();
  Serial.println("╔════════════ RUNTIME + PERFORMANCE STATUS ════════════╗");
  Serial.print("[LINK] "); Serial.println(linkOK ? "OK" : "FAIL");
  Serial.print("[WIFI] "); Serial.println(WiFi.status() == WL_CONNECTED ? "OK" : "FAIL");
  Serial.print("[MQTT] "); Serial.println(mqtt.connected() ? "OK" : "FAIL");
  Serial.print("[SD] "); Serial.println(sdOK ? "READY" : "NOT READY");

  Serial.print("UART read time          : "); Serial.print(perfUartReadUs); Serial.println(" us");
  Serial.print("CSV parse time          : "); Serial.print(perfCsvParseUs); Serial.println(" us");
  Serial.print("Aggregation 0.5s time   : "); Serial.print(perfAggregationUs); Serial.println(" us");
  Serial.print("FFT compute time        : "); Serial.print(perfFftComputeUs); Serial.println(" us");
  Serial.print("JSON build time         : "); Serial.print(perfJsonBuildUs); Serial.println(" us");
  Serial.print("MQTT publish time       : "); Serial.print(perfMqttPublishUs); Serial.println(" us");
  Serial.print("SD save time            : "); Serial.print(perfSdSaveUs); Serial.println(" us");
  Serial.print("TFT draw time           : "); Serial.print(perfTftDrawUs); Serial.println(" us");
  Serial.print("Sensor task runtime     : "); Serial.print(perfSensorTaskUs); Serial.println(" us");

  Serial.print("RX OK                   : "); Serial.println((uint32_t)parseOKCount);
  Serial.print("RX FAIL                 : "); Serial.println((uint32_t)parseFailCount);
  Serial.print("RX buffer reset         : "); Serial.println((uint32_t)rxBufferResetCount);
  Serial.print("Last RX age             : "); Serial.print(perfLastRxAgeMs); Serial.println(" ms");
  Serial.println("╚═══════════════════════════════════════════════════════╝");
}

void printSensorReport() {
  Serial.println();
  Serial.println("╔════════════ SENSOR TASK STATUS ════════════╗");
  Serial.print("Sensor executions       : "); Serial.println((uint32_t)sensorExecutions);
  Serial.print("Missed deadlines        : "); Serial.println((uint32_t)sensorMissedDeadlines);
  Serial.print("Fast agg completed      : "); Serial.println((uint32_t)fastAggCompleted);
  Serial.print("Fast agg underfilled    : "); Serial.println((uint32_t)fastAggUnderfilled);
  Serial.print("Last fast samples       : "); Serial.println((uint16_t)lastFastAggSamples);
  Serial.print("Fast agg interval       : "); Serial.print((uint32_t)lastFastAggIntervalMs); Serial.println(" ms");
  Serial.print("Storage batch count     : "); Serial.println(storageBatchCount);
  Serial.print("Storage batch seq       : "); Serial.println(storageBatchSeq);
  Serial.println("╚════════════════════════════════════════════╝");
}

void printNetworkReport() {
  Serial.println();
  Serial.println("╔════════════ NETWORK STATUS ════════════╗");
  Serial.print("WiFi mode       : "); Serial.println(wifiModeText());
  Serial.print("WiFi status     : "); Serial.print((int)WiFi.status()); Serial.print(" / "); Serial.println(wifiStatusText(WiFi.status()));
  Serial.print("SSID            : "); Serial.println(WiFi.SSID());
  Serial.print("IP address      : "); Serial.println(WiFi.localIP());
  Serial.print("RSSI            : "); Serial.print(WiFi.RSSI()); Serial.println(" dBm");
  Serial.print("Eduroam SSID    : "); Serial.println(EDUROAM_SSID);
  Serial.print("Eduroam user    : "); Serial.println(EDUROAM_USERNAME);
  Serial.print("WiFiManager AP  : "); Serial.println(WIFI_MANAGER_AP_NAME);
  Serial.print("MQTT connected  : "); Serial.println(mqtt.connected() ? "YES" : "NO");
  Serial.print("MQTT host       : "); Serial.println(MQTT_HOST);
  Serial.print("MQTT port       : "); Serial.println(MQTT_PORT);
  Serial.print("MQTT user       : "); Serial.println(MQTT_USER);
  Serial.print("MQTT pass       : "); Serial.println("********");
  Serial.print("MQTT topic      : "); Serial.println(MQTT_TOPIC);
  Serial.print("ESP32-1 link    : "); Serial.println(linkOK ? "OK" : "LOST");
  Serial.println("╚═══════════════════════════════════════╝");
}

void startTouchCalibration() {
  touchCalibrationMode = true;
  serialTouchDebug = true;
  calIndex = 0;

  Serial.println();
  Serial.println("╔════════════ TOUCH CALIBRATION MODE ════════════╗");
  Serial.println("Sentuh titik yang diminta pada layar.");
  Serial.println("Data raw X/Y akan dicetak untuk bahan mapping.");
  Serial.println("Urutan:");
  for (uint8_t i = 0; i < sizeof(calPoints) / sizeof(calPoints[0]); i++) {
    Serial.print(" - ");
    Serial.print(calPoints[i].name);
    Serial.print(" screen=(");
    Serial.print(calPoints[i].sx);
    Serial.print(",");
    Serial.print(calPoints[i].sy);
    Serial.println(")");
  }
  Serial.println("╚════════════════════════════════════════════════╝");
}


void printLatestDataReport() {
  RawData r;
  AggregatedData a;
  FFTData f;

  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    r = latestRaw;
    a = aggData;
    f = fftData;
    xSemaphoreGive(dataMutex);
  }

  Serial.println();
  Serial.println("╔════════════ LATEST RAW + AGGREGATED DATA ════════════╗");
  Serial.print("[RAW] seq              : "); Serial.println(r.seq);
  Serial.print("[RAW] timestampMs      : "); Serial.println(r.timestampMs);
  Serial.print("[RAW] valid            : "); Serial.println(r.valid ? "YES" : "NO");
  Serial.print("[RAW] status           : "); Serial.println(r.statusText);
  Serial.print("[RAW] syncText         : "); Serial.println(r.syncText);
  Serial.print("[RAW] rpm              : "); Serial.println(r.rpm);
  Serial.print("[RAW] tps              : "); Serial.println(r.tps);
  Serial.print("[RAW] iat              : "); Serial.println(r.iat);
  Serial.print("[RAW] clt              : "); Serial.println(r.clt);
  Serial.print("[RAW] afr              : "); Serial.println(r.afr, 3);
  Serial.print("[RAW] batt             : "); Serial.println(r.batt, 3);
  Serial.print("[RAW] fuel             : "); Serial.println(r.fuel, 3);
  Serial.print("[RAW] freq             : "); Serial.println(r.freq, 4);
  Serial.print("[RAW] freqGrid         : "); Serial.println(r.freqGrid, 4);
  Serial.print("[RAW] volt             : "); Serial.println(r.volt, 3);
  Serial.print("[RAW] voltGrid         : "); Serial.println(r.voltGrid, 3);
  Serial.print("[RAW] phaseAngle       : "); Serial.println(r.phaseAngle, 3);
  Serial.print("[RAW] speeduinoSync    : "); Serial.println(r.speeduinoSync ? "YES" : "NO");
  Serial.print("[RAW] gridSync         : "); Serial.println(r.gridSync ? "YES" : "NO");

  Serial.println("────────────────────────────────────────────────────────");
  Serial.print("[AGG] valid            : "); Serial.println(a.valid ? "YES" : "NO");
  Serial.print("[AGG] samples          : "); Serial.println(a.samples);
  Serial.print("[AGG] rpm avg/min/max  : "); Serial.print(a.rpmAvg, 1); Serial.print(" / "); Serial.print(a.rpmMin); Serial.print(" / "); Serial.println(a.rpmMax);
  Serial.print("[AGG] tps avg/min/max  : "); Serial.print(a.tpsAvg, 1); Serial.print(" / "); Serial.print(a.tpsMin); Serial.print(" / "); Serial.println(a.tpsMax);
  Serial.print("[AGG] iat avg/min/max  : "); Serial.print(a.iatAvg, 1); Serial.print(" / "); Serial.print(a.iatMin); Serial.print(" / "); Serial.println(a.iatMax);
  Serial.print("[AGG] clt avg/min/max  : "); Serial.print(a.cltAvg, 1); Serial.print(" / "); Serial.print(a.cltMin); Serial.print(" / "); Serial.println(a.cltMax);
  Serial.print("[AGG] afr avg/min/max  : "); Serial.print(a.afrAvg, 3); Serial.print(" / "); Serial.print(a.afrMin, 3); Serial.print(" / "); Serial.println(a.afrMax, 3);
  Serial.print("[AGG] batt avg/min/max : "); Serial.print(a.battAvg, 3); Serial.print(" / "); Serial.print(a.battMin, 3); Serial.print(" / "); Serial.println(a.battMax, 3);
  Serial.print("[AGG] fuel avg/min/max : "); Serial.print(a.fuelAvg, 3); Serial.print(" / "); Serial.print(a.fuelMin, 3); Serial.print(" / "); Serial.println(a.fuelMax, 3);
  Serial.print("[AGG] freq avg/min/max : "); Serial.print(a.freqAvg, 4); Serial.print(" / "); Serial.print(a.freqMin, 4); Serial.print(" / "); Serial.println(a.freqMax, 4);
  Serial.print("[AGG] PLN f avg/min/max: "); Serial.print(a.freqGridAvg, 4); Serial.print(" / "); Serial.print(a.freqGridMin, 4); Serial.print(" / "); Serial.println(a.freqGridMax, 4);
  Serial.print("[AGG] volt avg/min/max : "); Serial.print(a.voltAvg, 3); Serial.print(" / "); Serial.print(a.voltMin, 3); Serial.print(" / "); Serial.println(a.voltMax, 3);
  Serial.print("[AGG] PLN v avg/min/max: "); Serial.print(a.voltGridAvg, 3); Serial.print(" / "); Serial.print(a.voltGridMin, 3); Serial.print(" / "); Serial.println(a.voltGridMax, 3);
  Serial.print("[AGG] phase avg/min/max: "); Serial.print(a.phaseAngleAvg, 3); Serial.print(" / "); Serial.print(a.phaseAngleMin, 3); Serial.print(" / "); Serial.println(a.phaseAngleMax, 3);
  Serial.print("[AGG] synced           : "); Serial.println(a.synced ? "YES" : "NO");

  Serial.println("────────────────────────────────────────────────────────");
  Serial.print("[FFT] valid            : "); Serial.println(f.valid ? "YES" : "NO");
  Serial.print("[FFT] source           : "); Serial.println(getFFTSourceName());
  Serial.print("[FFT] samples          : "); Serial.println(f.samples);
  Serial.print("[FFT] sampleRateHz     : "); Serial.println(f.sampleRateHz, 3);
  Serial.print("[FFT] resolutionHz     : "); Serial.println(f.resolutionHz, 5);
  Serial.print("[FFT] peakHz           : "); Serial.println(f.peakHz, 5);
  Serial.print("[FFT] peakMagnitude    : "); Serial.println(f.peakMagnitude, 6);
  Serial.print("[FFT] rms              : "); Serial.println(f.rms, 6);
  Serial.println("╚════════════════════════════════════════════════════════╝");
}

void printAggregationReport() {
  Serial.println();
  Serial.println("╔════════════ AGGREGATION STATUS ════════════╗");
  Serial.print("Aggregation interval       : "); Serial.print(AGGREGATION_INTERVAL_MS); Serial.println(" ms");
  Serial.print("Sensor sample interval     : "); Serial.print(SENSOR_SAMPLE_INTERVAL_MS); Serial.println(" ms");
  Serial.print("Expected samples/window    : "); Serial.println(AGGREGATION_INTERVAL_MS / SENSOR_SAMPLE_INTERVAL_MS);
  Serial.print("Fast agg completed         : "); Serial.println((uint32_t)fastAggCompleted);
  Serial.print("Fast agg underfilled       : "); Serial.println((uint32_t)fastAggUnderfilled);
  Serial.print("Last fast agg samples      : "); Serial.println((uint16_t)lastFastAggSamples);
  Serial.print("Last fast agg interval     : "); Serial.print((uint32_t)lastFastAggIntervalMs); Serial.println(" ms");
  Serial.print("Aggregation runtime        : "); Serial.print(perfAggregationUs); Serial.println(" us");
  Serial.print("Last agg ready age         : "); Serial.print(lastAggReadyMs > 0 ? millis() - lastAggReadyMs : 999999); Serial.println(" ms");
  Serial.println("╚════════════════════════════════════════════╝");
}

void printStorageBatchReport() {
  Serial.println();
  Serial.println("╔════════════ STORAGE BATCH STATUS ════════════╗");
  Serial.print("Batch size              : "); Serial.println(STORAGE_BATCH_SIZE);
  Serial.print("Current batch seq       : "); Serial.println(storageBatchSeq);
  Serial.print("Current batch count     : "); Serial.println(storageBatchCount);

  for (uint8_t i = 0; i < STORAGE_BATCH_SIZE; i++) {
    Serial.print("[SLOT ");
    Serial.print(i);
    Serial.print("] valid=");
    Serial.print(storageBatch[i].valid ? "YES" : "NO");
    Serial.print(" batchSeq=");
    Serial.print(storageBatch[i].batchSeq);
    Serial.print(" slot=");
    Serial.print(storageBatch[i].slotIndex);
    Serial.print(" ts=");
    Serial.print(storageBatch[i].timestamp);
    Serial.print(" samples=");
    Serial.print(storageBatch[i].agg.samples);
    Serial.print(" rpm=");
    Serial.print(storageBatch[i].agg.rpmAvg, 1);
    Serial.print(" freq=");
    Serial.print(storageBatch[i].agg.freqAvg, 3);
    Serial.print(" volt=");
    Serial.println(storageBatch[i].agg.voltAvg, 2);
  }

  Serial.println("╚══════════════════════════════════════════════╝");
}

void printFFTReport() {
  FFTData f;
  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    f = fftData;
    xSemaphoreGive(dataMutex);
  }

  Serial.println();
  Serial.println("╔════════════ FFT STATUS ════════════╗");
  Serial.print("FFT enabled          : "); Serial.println(ENABLE_FFT_EDGE ? "YES" : "NO");
  Serial.print("FFT source           : "); Serial.println(getFFTSourceName());
  Serial.print("FFT samples          : "); Serial.println(FFT_SAMPLES);
  Serial.print("FFT bins sent        : "); Serial.println(FFT_BINS_TO_SEND);
  Serial.print("Buffer full          : "); Serial.println(fftBufferFull ? "YES" : "NO");
  Serial.print("Buffer index         : "); Serial.println(fftIndex);
  Serial.print("Valid result         : "); Serial.println(f.valid ? "YES" : "NO");
  Serial.print("Sample rate          : "); Serial.print(f.sampleRateHz, 2); Serial.println(" Hz");
  Serial.print("Resolution           : "); Serial.print(f.resolutionHz, 5); Serial.println(" Hz/bin");
  Serial.print("Peak frequency       : "); Serial.print(f.peakHz, 5); Serial.println(" Hz");
  Serial.print("Peak magnitude       : "); Serial.println(f.peakMagnitude, 6);
  Serial.print("RMS                  : "); Serial.println(f.rms, 6);
  Serial.print("FFT compute time     : "); Serial.print(perfFftComputeUs); Serial.println(" us");

  Serial.println("Bins:");
  for (uint16_t i = 0; i < FFT_BINS_TO_SEND; i++) {
    Serial.print("  ");
    Serial.print(i);
    Serial.print(" | f=");
    Serial.print(f.freqBins[i], 5);
    Serial.print(" Hz | mag=");
    Serial.println(f.magBins[i], 6);
  }
  Serial.println("╚════════════════════════════════════╝");
}

void printTouchReport() {
  Serial.println();
  Serial.println("╔════════════ TOUCH STATUS ════════════╗");
  Serial.print("Touch detected       : "); Serial.println(touchDetected ? "YES" : "NO");
  Serial.print("Touch debug          : "); Serial.println(serialTouchDebug ? "ON" : "OFF");
  Serial.print("Calibration mode     : "); Serial.println(touchCalibrationMode ? "ON" : "OFF");
  Serial.print("Calibration index    : "); Serial.println(calIndex);
  Serial.println("Mapping function     : readTouchMapped()");
  Serial.println("Jika koordinat terbalik, gunakan command: calibrate");
  Serial.println("╚═════════════════════════════════════╝");
}

void printDisplayReport() {
  Serial.println();
  Serial.println("╔════════════ DISPLAY STATUS ════════════╗");
  Serial.print("Active page          : ");
  if (activePage == PAGE_GENERATOR) Serial.println("GENERATOR");
  else if (activePage == PAGE_ENGINE) Serial.println("ENGINE");
  else if (activePage == PAGE_FFT) Serial.println("FFT");
  else Serial.println("UNKNOWN");
  Serial.print("Need full redraw     : "); Serial.println(needFullRedraw ? "YES" : "NO");
  Serial.print("Draw interval        : "); Serial.print(drawInterval); Serial.println(" ms");
  Serial.print("Last draw runtime    : "); Serial.print(perfTftDrawUs); Serial.println(" us");
  Serial.print("Last draw age        : "); Serial.print(lastTftDrawMs > 0 ? millis() - lastTftDrawMs : 999999); Serial.println(" ms");
  Serial.println("╚═══════════════════════════════════════╝");
}

void printSerialConfigReport() {
  Serial.println();
  Serial.println("╔════════════ SERIAL LOG CONFIG ════════════╗");
  Serial.print("Log enabled             : "); Serial.println(serialLogEnabled ? "ON" : "OFF");
  Serial.print("Log all                 : "); Serial.println(serialLogAllEnabled ? "ON" : "OFF");
  Serial.print("Log interval            : "); Serial.print(serialLogIntervalMs); Serial.println(" ms");
  Serial.print("RX raw                  : "); Serial.println(runtimeDebugRxRaw ? "ON" : "OFF");
  Serial.print("RX OK                   : "); Serial.println(runtimeDebugRxOK ? "ON" : "OFF");
  Serial.print("Log database            : "); Serial.println(serialLogDatabaseEnabled ? "ON" : "OFF");
  Serial.print("Log performance         : "); Serial.println(serialLogPerformanceEnabled ? "ON" : "OFF");
  Serial.print("Log sensor              : "); Serial.println(serialLogSensorEnabled ? "ON" : "OFF");
  Serial.print("Log network             : "); Serial.println(serialLogNetworkEnabled ? "ON" : "OFF");
  Serial.print("Log aggregation         : "); Serial.println(serialLogAggregationEnabled ? "ON" : "OFF");
  Serial.print("Log storage             : "); Serial.println(serialLogStorageEnabled ? "ON" : "OFF");
  Serial.print("Log FFT                 : "); Serial.println(serialLogFFTEnabled ? "ON" : "OFF");
  Serial.print("Log latest data         : "); Serial.println(serialLogLatestEnabled ? "ON" : "OFF");
  Serial.println("╚═══════════════════════════════════════════╝");
}

void printAllReports() {
  printNetworkReport();
  printSensorReport();
  printAggregationReport();
  printLatestDataReport();
  printFFTReport();
  printStorageBatchReport();
  printDatabaseReport();
  printPerformanceReport();
  printTouchReport();
  printDisplayReport();
  printSerialConfigReport();
}

void handlePeriodicSerialLog() {
  if (!serialLogEnabled) return;
  if (millis() - lastSerialLogMs < serialLogIntervalMs) return;
  lastSerialLogMs = millis();

  if (serialLogAllEnabled) {
    printAllReports();
    return;
  }

  if (serialLogNetworkEnabled) printNetworkReport();
  if (serialLogSensorEnabled) printSensorReport();
  if (serialLogAggregationEnabled) printAggregationReport();
  if (serialLogLatestEnabled) printLatestDataReport();
  if (serialLogFFTEnabled) printFFTReport();
  if (serialLogStorageEnabled) printStorageBatchReport();
  if (serialLogDatabaseEnabled) printDatabaseReport();
  if (serialLogPerformanceEnabled) printPerformanceReport();
}

void setAllPeriodicLogs(bool enabled) {
  serialLogDatabaseEnabled = enabled;
  serialLogPerformanceEnabled = enabled;
  serialLogSensorEnabled = enabled;
  serialLogNetworkEnabled = enabled;
  serialLogAggregationEnabled = enabled;
  serialLogStorageEnabled = enabled;
  serialLogFFTEnabled = enabled;
  serialLogLatestEnabled = enabled;
}

void processSerialCommand(String cmd) {
  cmd.trim();
  cmd.toLowerCase();

  if (cmd.length() == 0) return;

  if (cmd == "help") {
    printSerialHelp();
  } else if (cmd == "all") {
    printAllReports();
  } else if (cmd == "status") {
    printNetworkReport();
    printPerformanceReport();
  } else if (cmd == "database" || cmd == "db") {
    printDatabaseReport();
  } else if (cmd == "performance" || cmd == "perf") {
    printPerformanceReport();
  } else if (cmd == "sensor") {
    printSensorReport();

  } else if (cmd == "network" || cmd == "wifi" || cmd == "mqtt" || cmd == "link") {
    printNetworkReport();
  } else if (cmd == "wifi auto") {
    Serial.println("[CMD] WiFi auto: eduroam first, WiFiManager fallback.");
    setupWiFiManager();
    if (wifiOK) reconnectMQTT();
    printNetworkReport();
  } else if (cmd == "wifi eduroam" || cmd == "eduroam") {
    Serial.println("[CMD] Manual WiFi mode: EDUROAM.");
    if (connectEduroam()) reconnectMQTT();
    printNetworkReport();
  } else if (cmd == "wifi manager" || cmd == "wifimanager" || cmd == "wifi portal") {
    Serial.println("[CMD] Manual WiFi mode: WiFiManager.");
    if (connectWiFiManagerFallback()) reconnectMQTT();
    printNetworkReport();
  } else if (cmd == "wifi disconnect") {
    Serial.println("[CMD] WiFi disconnect requested.");
    mqtt.disconnect();
    mqttOK = false;
    prepareNormalWiFiMode();
    wifiOK = false;
    wifiConnectionMode = WIFI_MODE_OFFLINE;
    printNetworkReport();
  } else if (cmd == "mqtt reconnect") {
    Serial.println("[CMD] MQTT reconnect requested.");
    mqtt.disconnect();
    mqttOK = false;
    lastReconnect = 0;
    reconnectMQTT();
    printNetworkReport();
  } else if (cmd == "latest" || cmd == "data" || cmd == "sample") {
    printLatestDataReport();
  } else if (cmd == "aggregation" || cmd == "agg") {
    printAggregationReport();
  } else if (cmd == "storage" || cmd == "batch") {
    printStorageBatchReport();
  } else if (cmd == "fft") {
    printFFTReport();
  } else if (cmd == "display") {
    printDisplayReport();
  } else if (cmd == "touch") {
    printTouchReport();
    serialTouchDebug = !serialTouchDebug;
    Serial.print("[TOUCH] Debug mode sekarang: ");
    Serial.println(serialTouchDebug ? "ON" : "OFF");
  } else if (cmd == "calibrate") {
    startTouchCalibration();

  } else if (cmd == "page generator") {
    activePage = PAGE_GENERATOR;
    needFullRedraw = true;
    Serial.println("[DISPLAY] Page changed to GENERATOR");
  } else if (cmd == "page engine") {
    activePage = PAGE_ENGINE;
    needFullRedraw = true;
    Serial.println("[DISPLAY] Page changed to ENGINE");
  } else if (cmd == "page fft") {
    activePage = PAGE_FFT;
    needFullRedraw = true;
    Serial.println("[DISPLAY] Page changed to FFT");
  } else if (cmd == "redraw") {
    needFullRedraw = true;
    Serial.println("[DISPLAY] Full redraw requested.");

  } else if (cmd == "log on") {
    serialLogEnabled = true;
    if (!serialLogAllEnabled &&
        !serialLogDatabaseEnabled &&
        !serialLogPerformanceEnabled &&
        !serialLogSensorEnabled &&
        !serialLogNetworkEnabled &&
        !serialLogAggregationEnabled &&
        !serialLogStorageEnabled &&
        !serialLogFFTEnabled &&
        !serialLogLatestEnabled) {
      serialLogNetworkEnabled = true;
      serialLogSensorEnabled = true;
      serialLogPerformanceEnabled = true;
    }
    Serial.println("[LOG] Periodic serial log ON.");
    printSerialConfigReport();
  } else if (cmd == "log off") {
    serialLogEnabled = false;
    Serial.println("[LOG] Periodic serial log OFF.");
    printSerialConfigReport();
  } else if (cmd == "log all") {
    serialLogEnabled = true;
    serialLogAllEnabled = true;
    setAllPeriodicLogs(true);
    Serial.println("[LOG] ALL periodic reports ON.");
    printSerialConfigReport();
  } else if (cmd == "log minimal") {
    serialLogEnabled = true;
    serialLogAllEnabled = false;
    setAllPeriodicLogs(false);
    serialLogNetworkEnabled = true;
    serialLogSensorEnabled = true;
    serialLogPerformanceEnabled = true;
    Serial.println("[LOG] Minimal periodic reports ON: network + sensor + performance.");
    printSerialConfigReport();
  } else if (cmd == "log clear") {
    serialLogAllEnabled = false;
    setAllPeriodicLogs(false);
    Serial.println("[LOG] All periodic log categories cleared. Gunakan 'log on' + kategori.");
    printSerialConfigReport();
  } else if (cmd == "log status") {
    printSerialConfigReport();

  } else if (cmd.startsWith("log interval ")) {
    String val = cmd.substring(String("log interval ").length());
    val.trim();
    unsigned long n = val.toInt();
    if (n < 200) n = 200;
    serialLogIntervalMs = n;
    Serial.print("[LOG] Interval changed to ");
    Serial.print(serialLogIntervalMs);
    Serial.println(" ms.");
    printSerialConfigReport();

  } else if (cmd == "log database on") {
    serialLogDatabaseEnabled = true; serialLogEnabled = true; printSerialConfigReport();
  } else if (cmd == "log database off") {
    serialLogDatabaseEnabled = false; printSerialConfigReport();
  } else if (cmd == "log performance on") {
    serialLogPerformanceEnabled = true; serialLogEnabled = true; printSerialConfigReport();
  } else if (cmd == "log performance off") {
    serialLogPerformanceEnabled = false; printSerialConfigReport();
  } else if (cmd == "log sensor on") {
    serialLogSensorEnabled = true; serialLogEnabled = true; printSerialConfigReport();
  } else if (cmd == "log sensor off") {
    serialLogSensorEnabled = false; printSerialConfigReport();
  } else if (cmd == "log network on") {
    serialLogNetworkEnabled = true; serialLogEnabled = true; printSerialConfigReport();
  } else if (cmd == "log network off") {
    serialLogNetworkEnabled = false; printSerialConfigReport();
  } else if (cmd == "log aggregation on") {
    serialLogAggregationEnabled = true; serialLogEnabled = true; printSerialConfigReport();
  } else if (cmd == "log aggregation off") {
    serialLogAggregationEnabled = false; printSerialConfigReport();
  } else if (cmd == "log storage on") {
    serialLogStorageEnabled = true; serialLogEnabled = true; printSerialConfigReport();
  } else if (cmd == "log storage off") {
    serialLogStorageEnabled = false; printSerialConfigReport();
  } else if (cmd == "log fft on") {
    serialLogFFTEnabled = true; serialLogEnabled = true; printSerialConfigReport();
  } else if (cmd == "log fft off") {
    serialLogFFTEnabled = false; printSerialConfigReport();
  } else if (cmd == "log latest on") {
    serialLogLatestEnabled = true; serialLogEnabled = true; printSerialConfigReport();
  } else if (cmd == "log latest off") {
    serialLogLatestEnabled = false; printSerialConfigReport();

  } else if (cmd == "rx raw on") {
    runtimeDebugRxRaw = true;
    Serial.println("[RX] RAW UART CSV log ON.");
  } else if (cmd == "rx raw off") {
    runtimeDebugRxRaw = false;
    Serial.println("[RX] RAW UART CSV log OFF.");
  } else if (cmd == "rx ok on") {
    runtimeDebugRxOK = true;
    Serial.println("[RX] OK summary log ON.");
  } else if (cmd == "rx ok off") {
    runtimeDebugRxOK = false;
    Serial.println("[RX] OK summary log OFF.");

  } else {
    Serial.print("[CMD] Unknown command: ");
    Serial.println(cmd);
    Serial.println("Ketik 'help' untuk melihat daftar command.");
  }
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
  strlcpy(latestRaw.syncText, "OFF-GRID", sizeof(latestRaw.syncText));
  strlcpy(latestRaw.statusText, "NO-DATA", sizeof(latestRaw.statusText));

  dataMutex = xSemaphoreCreateMutex();
  sdMutex = xSemaphoreCreateMutex();

  if (dataMutex == NULL) Serial.println("[ERROR] dataMutex gagal dibuat.");
  if (sdMutex == NULL) Serial.println("[ERROR] sdMutex gagal dibuat.");

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

  drawBootSplashStep("Starting sensor task...", 94);
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
  Serial.println("GENSYS READY: CSV RX + 0.5s BATCH + SD + MQTT + TFT HMI + TOUCH");
  Serial.print("LINK_BAUD = ");
  Serial.println(LINK_BAUD);
}

void loop() {
  handleSerialCommandConsole();
  handlePeriodicSerialLog();

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

  handleTouchNavigation();

  if (millis() - lastDraw >= drawInterval) {
    lastDraw = millis();
    drawCurrentPage(needFullRedraw);
    needFullRedraw = false;
  }

  delay(5);
}
