#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>
#include <HardwareSerial.h>
#include "driver/ledc.h"


// ================= PIN =================
#define LED_PIN   2
#define NO1_PIN   26
#define NO2_PIN   33

#define PWM_PIN   4
#define PWM_CHAN  0
#define PWM_RES   16
#define PWM_FREQ  50

// ================= PWM LEDC ESP32 CORE 3.x COMPATIBLE =================
// Menggunakan driver LEDC IDF agar kompatibel dengan Arduino ESP32 core 3.x
// dan tidak bergantung pada ledcSetup()/ledcAttachPin().
#define PWM_SPEED_MODE   LEDC_LOW_SPEED_MODE
#define PWM_TIMER_ID     LEDC_TIMER_0
#define PWM_CHANNEL_ID   LEDC_CHANNEL_0
#define PWM_DUTY_RES     LEDC_TIMER_16_BIT

#define CS_PIN    5
#define SPI_SCK   18
#define SPI_MISO  19
#define SPI_MOSI  23

// ================= UART ESP32 MONITORING =================
// WAJIB sama dengan parser ESP32-2 monitoring:
// ESP32-1 GPIO25 TX  ---> ESP32-2 GPIO16 RX
// ESP32-1 GPIO27 RX  <--- ESP32-2 GPIO17 TX, optional/tidak wajib dipakai
// GND ESP32-1        ---> GND ESP32-2
#define MONITOR_TX_PIN 25
#define MONITOR_RX_PIN 27
#define MONITOR_BAUD   115200
#define MONITOR_SEND_INTERVAL_MS 100UL

HardwareSerial MonitorSerial(2);

// ================= UART SPEEDUINO / ECU ATMEGA2560 =================
// Parsing mengikuti komunikasi_ver2:
// ESP32-1 mengirim request karakter 'n', lalu Speeduino membalas frame binary header 0x6E.
// PENTING: GPIO25 sudah dipakai TX ke ESP32-2, jadi RX Speeduino TIDAK boleh memakai GPIO25.
// Wiring yang dipakai di kode ini:
// Speeduino TX  ---> ESP32-1 GPIO16 RX
// Speeduino RX  <--- ESP32-1 GPIO17 TX
// GND Speeduino ---> GND ESP32-1
#define ENABLE_DUMMY_SPEEDUINO   true
#define SPEEDUINO_RX_PIN         16
#define SPEEDUINO_TX_PIN         17
#define SPEEDUINO_BAUD           115200
#define SPEEDUINO_HEADER         0x6E
#define SPEEDUINO_FRAME_BYTES    120
#define SPEEDUINO_WAIT_MIN_BYTES 25
#define SPEEDUINO_TIMEOUT_MS     200UL

// ================= DUMMY ELECTRICAL / MCP3008 =================
// true  = data listrik dummy dikirim ke ESP32 monitoring
// false = data listrik asli dari MCP3008 / hasil akuisisi Malam_ADRC
// Mode ini juga bisa diubah lewat Serial Monitor tanpa upload ulang:
//   elec dummy on
//   elec dummy off
//   eon
//   eoff
#define ENABLE_DUMMY_ELECTRICAL true

HardwareSerial SpeeduinoSerial(1);
byte speeduinoBuffer[SPEEDUINO_FRAME_BYTES];

#define ADC1_CH   0
#define ADC2_CH   1

// ================= CONSTANT =================
#define ADC_MAX   1023.0
#define VREF      3.3
#define SAMPLES   1800

#define VOLT_CALIBRATION 120.0
#define MIN_VALID_VOLT 20.0

// ================= FREQUENCY TARGET =================
#define FREQ_TARGET     50.0

// ZONE TARGET TARGET (DEADBAND)
#define TARGET_MIN      49.0
#define TARGET_MAX      51.0

// ================= SAFETY =================
#define MAX_FREQ  60.0
#define MAX_VOLT  400.0

// ================= SERVO =================
#define SERVO_MIN   0.0
#define SERVO_MAX   16.0

// ================= START RAMP =================
#define START_SERVO_TARGET   6.0
#define START_RAMP_TIME      2000
#define START_HOLD_TIME      4000

// ===================================================
// HOLD BOOST FEATURE
// ===================================================
#define HOLD_BOOST_STEP        0.10
#define HOLD_BOOST_TOTAL       0.8
#define HOLD_BOOST_INTERVAL    250
#define HOLD_DROP_THRESHOLD    49.2
#define HOLD_REDUCE_THRESHOLD 50.8

// ===================================================
// PERBAIKAN PARAMETER ADRC
// ===================================================
float z1 = 0;
float z2 = 0;

float beta1 = 1.8;
float beta2 = 0.8;
float kp = 0.25;
float kd = 0.08;
float b0 = 0.25;

// ===================================================
// SERVO RESPONSE
// ===================================================
#define SERVO_STEP_BASE     0.04
#define CONTROL_INTERVAL    500


// ===================================================
// DATA ENGINE UNTUK PAYLOAD MONITORING
// ===================================================
struct EngineData {
  int rpm;
  int tps;
  int map;
  int iat;
  int clt;
  float afr;
  float batt;
  float fuel;
  bool valid;
};

struct ElectricalData {
  float freq;
  float freqGrid;
  float volt;
  float voltGrid;
  float currentA;
  float powerKW;
  float phaseGen;
  float phaseGrid;

  bool genOn;       // true jika generator hidup / tegangan generator valid
  bool gridOn;      // true jika PLN hidup / tegangan PLN valid
  bool engineSync;  // field lama: 1 jika generator hidup
  bool gridSync;    // field lama: 1 jika generator dan PLN sudah memenuhi syarat sinkron
  bool valid;

  String syncStatus; // field baru: sync / genset / grid / off
};

EngineData engineData;
ElectricalData electricalData;

uint32_t monitorSeq = 0;
uint32_t speedRxOk = 0;
uint32_t speedRxFail = 0;
uint32_t lastSpeeduinoRxMs = 0;
uint32_t lastMonitorTxMs = 0;

volatile bool speeduinoDummyEnabled = ENABLE_DUMMY_SPEEDUINO;
volatile bool electricalDummyEnabled = ENABLE_DUMMY_ELECTRICAL;
String serialInputBuffer = "";

// ================= DUMMY STATUS TEST =================
// Default dummy dibuat SYNC terlebih dahulu. Ubah lewat Serial Monitor:
//   dummy sync   -> generator + PLN hidup
//   dummy genset -> hanya generator hidup
//   dummy grid   -> hanya PLN hidup
//   dummy off    -> ECU mati, status off
//   dummy auto   -> berganti otomatis setiap 8 detik
enum DummySyncMode {
  DUMMY_STATUS_SYNC = 0,
  DUMMY_STATUS_GENSET = 1,
  DUMMY_STATUS_GRID = 2,
  DUMMY_STATUS_OFF = 3,
  DUMMY_STATUS_AUTO = 4
};

volatile DummySyncMode dummySyncMode = DUMMY_STATUS_SYNC;

// ================= SERIAL TX MONITOR =================
// Default OFF agar Serial Monitor tidak spam.
// Aktifkan lewat command:
//   tx monitor on  -> tampilkan raw TX + semua parameter + performance
//   tx raw on      -> tampilkan raw TX saja
//   tx param on    -> tampilkan parameter bernama
//   tx perf on     -> tampilkan waktu eksekusi TX
bool txRawMonitorEnabled = false;
bool txParamMonitorEnabled = false;
bool txPerformanceMonitorEnabled = false;

// ================= LAST TX CACHE =================
// Menyimpan frame TX terakhir agar raw TX + parameter tetap bisa ditampilkan
// walaupun mode send once sudah berhenti mengirim frame baru.
bool hasLastTxReport = false;

String lastTxPayload = "";
EngineData lastTxEngineData;
ElectricalData lastTxElectricalData;

uint32_t lastTxSeqCache = 0;
uint32_t lastTxTimestampMsCache = 0;

uint32_t lastTxSpeedReadUsCache = 0;
uint32_t lastTxSpeedParseUsCache = 0;
uint32_t lastTxElectricalUsCache = 0;
uint32_t lastTxPayloadUsCache = 0;
uint32_t lastTxUsCache = 0;
uint32_t lastTxTotalUsCache = 0;

// ================= UART TX TEST MODE =================
// false = kirim terus sesuai MONITOR_SEND_INTERVAL_MS
// true  = hanya kirim 1 frame untuk kebutuhan pengujian
bool txOnceModeEnabled = false;
bool txOnceAlreadySent = false;

// ================= FIXED TX ONCE DATA =================
// Saat command tx once / tx once reset, frame UART selalu dibuat dari data ini.
// RAW TX yang dihasilkan:
// $287,3723883,3031,12,47,34,84,14.61,13.41,46.4,49.94,49.98,221.2,221.9,5.63,1.245,3.41,1,1,1,sync
#define TX_ONCE_FIXED_SEQ          287UL
#define TX_ONCE_FIXED_TIMESTAMP   3723883UL

#define TX_ONCE_FIXED_RPM         3031
#define TX_ONCE_FIXED_TPS         12
#define TX_ONCE_FIXED_MAP         47
#define TX_ONCE_FIXED_IAT         34
#define TX_ONCE_FIXED_CLT         84
#define TX_ONCE_FIXED_AFR         14.61f
#define TX_ONCE_FIXED_BATT        13.41f
#define TX_ONCE_FIXED_FUEL        46.4f

#define TX_ONCE_FIXED_FREQ        49.94f
#define TX_ONCE_FIXED_FREQ_GRID   49.98f
#define TX_ONCE_FIXED_VOLT        221.2f
#define TX_ONCE_FIXED_VOLT_GRID   221.9f
#define TX_ONCE_FIXED_CURRENT_A   5.63f
#define TX_ONCE_FIXED_POWER_KW    1.245f
#define TX_ONCE_FIXED_PHASE       3.41f

#define TX_ONCE_FIXED_ENGINE_SYNC true
#define TX_ONCE_FIXED_GRID_SYNC   true
#define TX_ONCE_FIXED_VALID       true

// Interval cetak ulang cache pada mode TX ONCE.
// Nilai ini hanya mencetak ke Serial Monitor, tidak mengirim ulang UART.
#define TX_ONCE_CACHE_REPORT_INTERVAL_MS 1000UL
uint32_t lastTxOnceCachePrintMs = 0;

// ===================================================
// GLOBAL
// ===================================================
int r1[SAMPLES], r2[SAMPLES];
unsigned long t[SAMPLES];

volatile float shared_freq_gen  = 0;
volatile float shared_freq_grid = 0;

volatile float shared_volt_gen  = 0;
volatile float shared_volt_grid = 0;

volatile float shared_phase = 0;

bool jalan = false;

bool startRampDone = false;
bool startHoldDone = false;

bool sync_mode = false;

float servoPos = 0.0;

unsigned long rampStartTime = 0;
unsigned long holdStartTime = 0;

// HOLD BOOST
unsigned long lastBoostTime = 0;
float holdBoostAccum = 0;

// Dynamic Limit Tracker
float currentServoLimit = SERVO_STEP_BASE;

// Menjaga nilai delta sebelumnya untuk kebutuhan pembatasan step bertahap
float lastDelta = 0.0;

float computeGeneratorCurrentA(const EngineData &e, const ElectricalData &p) {
  if (!e.valid || p.volt < 20.0f || e.rpm < 100) return 0.0f;
  float rpmFactor = e.rpm / 6000.0f;
  if (rpmFactor < 0.0f) rpmFactor = 0.0f;
  if (rpmFactor > 1.0f) rpmFactor = 1.0f;
  float tpsLoad = e.tps * 0.18f;
  float mapLoad = (e.map - 35.0f) * 0.08f;
  if (mapLoad < 0.0f) mapLoad = 0.0f;
  float current = 1.5f + tpsLoad + mapLoad + 2.0f * rpmFactor;
  if (current < 0.0f) current = 0.0f;
  if (current > 60.0f) current = 60.0f;
  return current;
}

float computeGeneratorPowerKW(float volt, float currentA) {
  if (volt < 20.0f || currentA <= 0.0f) return 0.0f;
  return (volt * currentA) / 1000.0f;
}

DummySyncMode getActiveDummySyncMode() {
  if (dummySyncMode != DUMMY_STATUS_AUTO) {
    return dummySyncMode;
  }

  uint32_t slot = (millis() / 8000UL) % 4;
  if (slot == 0) return DUMMY_STATUS_SYNC;
  if (slot == 1) return DUMMY_STATUS_GENSET;
  if (slot == 2) return DUMMY_STATUS_GRID;
  return DUMMY_STATUS_OFF;
}

const char* dummySyncModeToText(DummySyncMode mode) {
  switch (mode) {
    case DUMMY_STATUS_SYNC:   return "sync";
    case DUMMY_STATUS_GENSET: return "genset";
    case DUMMY_STATUS_GRID:   return "grid";
    case DUMMY_STATUS_OFF:    return "off";
    case DUMMY_STATUS_AUTO:   return "auto";
    default:                  return "unknown";
  }
}

String getSyncStatusText(const EngineData &e, const ElectricalData &p) {
  // Requirement utama:
  // - sync   : generator dan PLN hidup bersamaan
  // - genset : hanya generator hidup
  // - grid   : hanya PLN hidup
  // - off    : ECU mati
  if (!e.valid) {
    return "off";
  }

  if (p.genOn && p.gridOn) {
    return "sync";
  }

  if (p.genOn && !p.gridOn) {
    return "genset";
  }

  if (!p.genOn && p.gridOn) {
    return "grid";
  }

  return "off";
}

// ===================================================
// MCP3008 READ
// ===================================================
int readMCP3008(byte ch) {
  SPI.beginTransaction(
    SPISettings(1000000, MSBFIRST, SPI_MODE0)
  );

  digitalWrite(CS_PIN, LOW);
  SPI.transfer(0x01);

  byte high = SPI.transfer(0x80 | (ch << 4));
  byte low  = SPI.transfer(0x00);

  digitalWrite(CS_PIN, HIGH);
  SPI.endTransaction();

  return ((high & 0x03) << 8) | low;
}

// ===================================================
// VRMS
// ===================================================
float calculateVRMS(int *data, int size) {
  long mean = 0;
  for (int i = 0; i < size; i++)
    mean += data[i];

  mean /= size;

  float sum = 0;
  for (int i = 0; i < size; i++) {
    float v = data[i] - mean;
    if (abs(v) < 5)
      v = 0;
    sum += v * v;
  }

  float rms = sqrt(sum / size);
  float voltage = rms * (VREF / ADC_MAX);

  if (voltage < 0.02)
    voltage = 0;

  return voltage;
}

// ===================================================
// SERVO MECHANICAL INTERFACE
// ===================================================
uint32_t angleToDuty(float angle) {
  return (uint32_t)(7800.0 - (angle / 180.0) * 5800.0);
}

void setupServoPwm() {
  ledc_timer_config_t timer = {};
  timer.speed_mode = PWM_SPEED_MODE;
  timer.timer_num = PWM_TIMER_ID;
  timer.duty_resolution = PWM_DUTY_RES;
  timer.freq_hz = PWM_FREQ;
  timer.clk_cfg = LEDC_AUTO_CLK;
  ledc_timer_config(&timer);

  ledc_channel_config_t channel = {};
  channel.gpio_num = PWM_PIN;
  channel.speed_mode = PWM_SPEED_MODE;
  channel.channel = PWM_CHANNEL_ID;
  channel.intr_type = LEDC_INTR_DISABLE;
  channel.timer_sel = PWM_TIMER_ID;
  channel.duty = 0;
  channel.hpoint = 0;
  ledc_channel_config(&channel);
}

void hold(float angle) {
  if (isnan(angle)) {
    angle = servoPos;
  }

  if (angle < SERVO_MIN)  angle = SERVO_MIN;
  if (angle > SERVO_MAX)  angle = SERVO_MAX;

  ledc_set_duty(PWM_SPEED_MODE, PWM_CHANNEL_ID, angleToDuty(angle));
  ledc_update_duty(PWM_SPEED_MODE, PWM_CHANNEL_ID);
  servoPos = angle;
}

// ===================================================
// ADRC CONTROLLER
// ===================================================
float ADRC(float ref, float y) {
  static float prevError = 0;
  float dt = CONTROL_INTERVAL / 1000.0;
  float e = 0;

  if (isnan(y)) return 0.0;

  float realError = ref - y;
  float absRealError = abs(realError);

  if (absRealError <= 0.25) {
    e = 0.0;
  } else {
    e = realError;
  }

  if (isnan(z1) || isnan(z2)) {
    z1 = y;
    z2 = 0;
  }

  z1 += dt * (z2 - beta1 * (z1 - y));
  z2 += dt * (-beta2 * (z1 - y));

  if (isnan(z1) || isnan(z2) || isinf(z1) || isinf(z2)) {
    z1 = y;
    z2 = 0;
  }

  float derivative = 0;
  if (dt > 0 && abs(e - prevError) > 0.001) {
    derivative = (e - prevError) / dt;
  }

  float u = kp * e + kd * derivative;

  float disturbance_comp = -z2 / b0;
  u += disturbance_comp;

  prevError = e;

  if (absRealError > 2.0) {
    currentServoLimit = SERVO_STEP_BASE * 2.0;
  } else {
    currentServoLimit = SERVO_STEP_BASE;
  }

  if (u > currentServoLimit)  u = currentServoLimit;
  if (u < -currentServoLimit) u = -currentServoLimit;

  if (realError < 0 && u > 0) {
    u = -u;
  } else if (realError > 0 && u < 0) {
    u = abs(u);
  }

  float maxStepChange = 0.02;

  if (absRealError > 2.0) {
    maxStepChange = 0.05;
  }

  if (isnan(lastDelta)) lastDelta = 0.0;

  float deltaChange = u - lastDelta;

  if (deltaChange > maxStepChange) {
    u = lastDelta + maxStepChange;
  } else if (deltaChange < -maxStepChange) {
    u = lastDelta - maxStepChange;
  }

  lastDelta = u;

  if (isnan(u)) return 0.0;

  return u;
}

// ===================================================
// START RAMP + HOLD
// ===================================================
void startRampControl() {
  if (!startRampDone) {
    unsigned long elapsed = millis() - rampStartTime;

    if (elapsed >= START_RAMP_TIME) {
      hold(START_SERVO_TARGET);
      startRampDone = true;
      holdStartTime = millis();
      Serial.println("START RAMP DONE");
      return;
    }

    float target = (elapsed / (float)START_RAMP_TIME) * START_SERVO_TARGET;
    hold(target);

    Serial.printf("START RAMP | Servo: %.2f\n", target);
    return;
  }

  if (!startHoldDone) {
    hold(START_SERVO_TARGET);
    unsigned long holdElapsed = millis() - holdStartTime;

    Serial.printf("START HOLD | Servo: 11.2 | %lu ms\n", holdElapsed);

    if (holdElapsed >= START_HOLD_TIME) {
      startHoldDone = true;
      Serial.println("START HOLD DONE");
    }
    return;
  }
}

// ===================================================
// SOLO CONTROL ADRC EXECUTION
// ===================================================
void soloControlADRC() {
  static unsigned long lastControl = 0;

  if (millis() - lastControl < CONTROL_INTERVAL)
    return;

  lastControl = millis();
  float f = shared_freq_gen;

  if (shared_volt_gen > MAX_VOLT || f > MAX_FREQ) {
    hold(0);
    jalan = false;
    Serial.println("CRITICAL SAFETY TRIP ENGAGED! SYSTEM STOPPED.");
    return;
  }

  if (f < 10 || isnan(f))
    return;

  float delta = ADRC(FREQ_TARGET, f);

  if (!isnan(delta)) {
    float targetServo = servoPos + delta;
    hold(targetServo);
  }

  Serial.printf("ADRC | F: %.2f | LIMIT STATUS | dServo: %.3f\n", f, delta);
}

// ===================================================
// SYNC MODE MONITOR
// ===================================================
void syncControl() {
  Serial.printf("SYNC MONITOR | dF: %.3f Hz | Phase: %.2f deg\n",
                shared_freq_gen - shared_freq_grid, shared_phase);
}

// ===================================================
// DATA ACQUISITION & FILTERING
// ===================================================
void SyncLoop(void *pv) {
  float f1 = 0;
  float f2 = 0;
  float phase = 0;

  while (1) {
    if (electricalDummyEnabled) {
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }

    for (int i = 0; i < SAMPLES; i++) {
      t[i] = micros();
      r1[i] = readMCP3008(ADC1_CH);
      r2[i] = readMCP3008(ADC2_CH);
      delayMicroseconds(80);
    }

    float vrms1 = calculateVRMS(r1, SAMPLES);
    float vrms2 = calculateVRMS(r2, SAMPLES);

    float volt_gen  = vrms1 * VOLT_CALIBRATION * 9.24;
    float volt_grid = vrms2 * VOLT_CALIBRATION * 9.24;

    long s1 = 0; long s2 = 0;
    for (int i = 0; i < SAMPLES; i++) {
      s1 += r1[i];
      s2 += r2[i];
    }

    int mid1 = s1 / SAMPLES;
    int mid2 = s2 / SAMPLES;

    float tc1[5]; float tc2[5];
    int c1 = 0; int c2 = 0;

    for (int i = 1; i < SAMPLES; i++) {
      if (r1[i - 1] < mid1 && r1[i] >= mid1 && c1 < 5) {
        tc1[c1++] = t[i];
      }
      if (r2[i - 1] < mid2 && r2[i] >= mid2 && c2 < 5) {
        tc2[c2++] = t[i];
      }
    }

    bool gen_valid  = volt_gen  > MIN_VALID_VOLT;
    bool grid_valid = volt_grid > MIN_VALID_VOLT;

    if (gen_valid && c1 >= 2) {
      f1 = 1e6 / ((tc1[c1 - 1] - tc1[0]) / (c1 - 1));
    } else {
      f1 = 0;
    }

    if (grid_valid && c2 >= 2) {
      f2 = 1e6 / ((tc2[c2 - 1] - tc2[0]) / (c2 - 1));
    } else {
      f2 = 0;
    }

    if (f1 < 40 || f1 > 70) f1 = 0;
    if (f2 < 40 || f2 > 70) f2 = 0;

    if (gen_valid && grid_valid && c1 && c2) {
      float dt_phase = tc2[0] - tc1[0];
      phase = dt_phase * f1 * 360.0 / 1e6;

      while (phase > 180)  phase -= 360;
      while (phase < -180) phase += 360;
    } else {
      phase = 0;
    }

    shared_freq_gen =  0.7 * shared_freq_gen + 0.3 * f1;
    shared_freq_grid = 0.7 * shared_freq_grid + 0.3 * f2;

    shared_volt_gen  = volt_gen;
    shared_volt_grid = volt_grid;
    shared_phase = phase;

    sync_mode = (gen_valid && grid_valid);

    digitalWrite(LED_PIN, sync_mode);
    digitalWrite(NO1_PIN, sync_mode);
    digitalWrite(NO2_PIN, sync_mode);

    vTaskDelay(pdMS_TO_TICKS(10));
  }
}


// ===================================================
// DUMMY / PARSING SPEEDUINO UNTUK PAYLOAD MONITORING
// ===================================================
EngineData getDummySpeeduinoData() {
  EngineData d;
  DummySyncMode activeMode = getActiveDummySyncMode();
  float tm = millis() / 1000.0f;

  d.rpm  = (int)(3000.0f + 80.0f * sin(tm * 0.35f));
  d.tps  = (int)(14.0f + 2.0f * sin(tm * 0.45f));
  d.map  = (int)(45.0f + 5.0f * sin(tm * 0.40f));
  d.iat  = (int)(35.0f + 2.0f * sin(tm * 0.20f));
  d.clt  = (int)(82.0f + 3.0f * sin(tm * 0.12f));
  d.afr  = 14.70f + 0.15f * sin(tm * 0.60f);
  d.batt = 13.50f + 0.10f * sin(tm * 0.30f);
  d.fuel = 65.0f - 0.005f * tm;
  if (d.fuel < 0.0f) d.fuel = 0.0f;

  // Mode dummy off mensimulasikan ECU mati.
  if (activeMode == DUMMY_STATUS_OFF) {
    d.rpm = 0;
    d.tps = 0;
    d.map = 0;
    d.iat = 0;
    d.clt = 0;
    d.afr = 0.0f;
    d.batt = 0.0f;
    d.fuel = 0.0f;
    d.valid = false;
  } else {
    d.valid = true;
  }

  return d;
}

// Format UART Speeduino mengikuti komunikasi_ver2:
// 1) ESP32 kirim request karakter 'n'
// 2) Speeduino membalas header 0x6E, lalu minimal 120 byte payload
// 3) Mapping:
//    MAP  = (buffer[7]  << 8) | buffer[6]
//    IAT  = buffer[8]  - 40
//    CLT  = buffer[9]  - 40
//    BATT = buffer[11] / 10.0
//    AFR  = buffer[12] / 10.0
//    RPM  = (buffer[17] << 8) | buffer[16]
//    TPS  = buffer[26] / 2
bool parseSpeeduinoFrame(const byte *buffer, size_t len, EngineData &out) {
  if (len < SPEEDUINO_FRAME_BYTES) return false;

  int mapVal = ((int)buffer[7] << 8) | buffer[6];

  int iat = (int)buffer[8] - 40;
  int clt = (int)buffer[9] - 40;
  float batt = buffer[11] / 10.0f;
  float afr = buffer[12] / 10.0f;
  int rpm = ((int)buffer[17] << 8) | buffer[16];
  int tps = buffer[26] / 2;

  if (rpm < 0 || rpm > 12000) return false;
  if (tps < 0 || tps > 100) return false;
  if (mapVal < 0 || mapVal > 300) return false;
  if (iat < -40 || iat > 150) return false;
  if (clt < -40 || clt > 150) return false;
  if (batt < 0.0f || batt > 30.0f) return false;
  if (afr < 0.0f || afr > 30.0f) return false;

  out.rpm  = rpm;
  out.tps  = tps;
  out.map  = mapVal;
  out.iat  = iat;
  out.clt  = clt;
  out.afr  = afr;
  out.batt = batt;

  if (engineData.valid && engineData.fuel >= 0.0f && engineData.fuel <= 100.0f) {
    out.fuel = engineData.fuel;
  } else {
    out.fuel = 65.0f;
  }

  out.valid = true;
  return true;
}

bool waitSpeeduinoBytes(size_t minBytes, uint32_t timeoutMs) {
  unsigned long startMs = millis();
  while (SpeeduinoSerial.available() < (int)minBytes) {
    if (millis() - startMs > timeoutMs) return false;
    delay(1);
  }
  return true;
}

bool lockSpeeduinoHeader(uint32_t timeoutMs) {
  unsigned long startMs = millis();

  while (millis() - startMs <= timeoutMs) {
    while (SpeeduinoSerial.available()) {
      if ((uint8_t)SpeeduinoSerial.peek() == SPEEDUINO_HEADER) {
        return true;
      }
      SpeeduinoSerial.read();
    }
    delay(1);
  }

  return false;
}

bool readSpeeduinoUART(EngineData &out, uint32_t &readTimeUs, uint32_t &parseTimeUs) {
  uint32_t readStart = micros();

  while (SpeeduinoSerial.available()) SpeeduinoSerial.read();

  SpeeduinoSerial.write('n');

  if (!waitSpeeduinoBytes(SPEEDUINO_WAIT_MIN_BYTES, SPEEDUINO_TIMEOUT_MS)) {
    readTimeUs = micros() - readStart;
    parseTimeUs = 0;
    speedRxFail++;
    return false;
  }

  if (!lockSpeeduinoHeader(SPEEDUINO_TIMEOUT_MS)) {
    readTimeUs = micros() - readStart;
    parseTimeUs = 0;
    speedRxFail++;
    return false;
  }

  if (SpeeduinoSerial.read() != SPEEDUINO_HEADER) {
    readTimeUs = micros() - readStart;
    parseTimeUs = 0;
    speedRxFail++;
    return false;
  }

  size_t got = SpeeduinoSerial.readBytes(speeduinoBuffer, SPEEDUINO_FRAME_BYTES);
  readTimeUs = micros() - readStart;

  uint32_t parseStart = micros();
  bool ok = parseSpeeduinoFrame(speeduinoBuffer, got, out);
  parseTimeUs = micros() - parseStart;

  if (ok) {
    speedRxOk++;
    lastSpeeduinoRxMs = millis();
  } else {
    speedRxFail++;
  }

  return ok;
}

// ===================================================
// BUILD DATA LISTRIK: DUMMY ATAU MCP3008 / MALAM_ADRC
// ===================================================
ElectricalData getDummyElectricalData() {
  ElectricalData d;
  DummySyncMode activeMode = getActiveDummySyncMode();
  float tm = millis() / 1000.0f;

  d.freq     = 50.00f + 0.08f * sin(tm * 0.70f);
  d.freqGrid = 50.00f + 0.03f * sin(tm * 0.45f + 1.20f);
  d.volt     = 220.0f + 3.0f * sin(tm * 0.35f);
  d.voltGrid = 221.0f + 2.0f * sin(tm * 0.28f + 0.80f);
  d.currentA = 0.0f;
  d.powerKW  = 0.0f;
  d.phaseGen = 4.0f * sin(tm * 0.50f);
  d.phaseGrid = 0.0f;

  // Simulasi 4 status dummy.
  if (activeMode == DUMMY_STATUS_SYNC) {
    // Generator + PLN hidup.
  } else if (activeMode == DUMMY_STATUS_GENSET) {
    // Hanya generator hidup.
    d.freqGrid = 0.0f;
    d.voltGrid = 0.0f;
    d.phaseGen = 0.0f;
  } else if (activeMode == DUMMY_STATUS_GRID) {
    // Hanya PLN hidup.
    d.freq = 0.0f;
    d.volt = 0.0f;
    d.phaseGen = 0.0f;
  } else if (activeMode == DUMMY_STATUS_OFF) {
    // ECU mati. Data listrik dibuat mati juga supaya display jelas off.
    d.freq = 0.0f;
    d.freqGrid = 0.0f;
    d.volt = 0.0f;
    d.voltGrid = 0.0f;
    d.currentA = 0.0f;
    d.powerKW = 0.0f;
    d.phaseGen = 0.0f;
    d.phaseGrid = 0.0f;
  }

  bool genValid  = (d.volt > MIN_VALID_VOLT && d.freq > 40.0f && d.freq < 70.0f);
  bool gridValid = (d.voltGrid > MIN_VALID_VOLT && d.freqGrid > 40.0f && d.freqGrid < 70.0f);

  d.genOn = genValid;
  d.gridOn = gridValid;

  // Field lama tetap dikirim untuk kompatibilitas parser lama.
  d.engineSync = genValid;
  d.gridSync = genValid && gridValid &&
               fabs(d.freq - d.freqGrid) < 0.20f &&
               fabs(d.volt - d.voltGrid) < 10.0f &&
               fabs(d.phaseGen) < 10.0f;

  d.valid = genValid || gridValid;
  d.syncStatus = "off"; // final diisi setelah status ECU diketahui.
  return d;
}
ElectricalData getElectricalDataFromADRC() {
  ElectricalData d;

  d.freq     = shared_freq_gen;
  d.freqGrid = shared_freq_grid;
  d.volt     = shared_volt_gen;
  d.voltGrid = shared_volt_grid;
  d.currentA = 0.0f;
  d.powerKW  = 0.0f;

  d.phaseGen  = shared_phase;
  d.phaseGrid = 0.0f;

  bool genValid  = (d.volt > MIN_VALID_VOLT && d.freq > 40.0f && d.freq < 70.0f);
  bool gridValid = (d.voltGrid > MIN_VALID_VOLT && d.freqGrid > 40.0f && d.freqGrid < 70.0f);

  d.genOn = genValid;
  d.gridOn = gridValid;

  // Field lama tetap dikirim untuk kompatibilitas parser lama.
  d.engineSync = genValid;

  d.gridSync = genValid && gridValid &&
               fabs(d.freq - d.freqGrid) < 0.20f &&
               fabs(d.volt - d.voltGrid) < 10.0f &&
               fabs(shared_phase) < 10.0f;

  d.valid = genValid || gridValid;
  d.syncStatus = "off"; // final diisi setelah status ECU diketahui.

  return d;
}
ElectricalData getElectricalData() {
  if (electricalDummyEnabled) {
    return getDummyElectricalData();
  }
  return getElectricalDataFromADRC();
}

// ===================================================
// FIXED DATA UNTUK TX ONCE
// ===================================================
void getFixedTxOnceData(EngineData &e, ElectricalData &p) {
  e.rpm   = TX_ONCE_FIXED_RPM;
  e.tps   = TX_ONCE_FIXED_TPS;
  e.map   = TX_ONCE_FIXED_MAP;
  e.iat   = TX_ONCE_FIXED_IAT;
  e.clt   = TX_ONCE_FIXED_CLT;
  e.afr   = TX_ONCE_FIXED_AFR;
  e.batt  = TX_ONCE_FIXED_BATT;
  e.fuel  = TX_ONCE_FIXED_FUEL;
  e.valid = TX_ONCE_FIXED_VALID;

  p.freq       = TX_ONCE_FIXED_FREQ;
  p.freqGrid   = TX_ONCE_FIXED_FREQ_GRID;
  p.volt       = TX_ONCE_FIXED_VOLT;
  p.voltGrid   = TX_ONCE_FIXED_VOLT_GRID;
  p.currentA   = TX_ONCE_FIXED_CURRENT_A;
  p.powerKW    = TX_ONCE_FIXED_POWER_KW;
  p.phaseGen   = TX_ONCE_FIXED_PHASE;
  p.phaseGrid  = 0.0f;
  p.genOn      = true;
  p.gridOn     = true;
  p.engineSync = TX_ONCE_FIXED_ENGINE_SYNC;
  p.gridSync   = TX_ONCE_FIXED_GRID_SYNC;
  p.valid      = TX_ONCE_FIXED_VALID;
  p.syncStatus = "sync";
}

// ===================================================
// PAYLOAD UART KE ESP32 MONITORING
// ===================================================
// Harus sama dengan parser ESP32-2 monitoring:
// $seq,timestampMs,rpm,tps,map,iat,clt,afr,batt,fuel,
// freq,freqGrid,volt,voltGrid,currentA,powerKW,phaseAngle,engineSync,gridSync,valid,syncStatus
String buildPayloadForMonitoring(const EngineData &e,
                                const ElectricalData &p,
                                uint32_t seq,
                                uint32_t timestampMs) {
  String line = "$";

  line += String(seq);
  line += ",";
  line += String(timestampMs);

  line += ",";
  line += String(e.rpm);
  line += ",";
  line += String(e.tps);
  line += ",";
  line += String(e.map);
  line += ",";
  line += String(e.iat);
  line += ",";
  line += String(e.clt);

  line += ",";
  line += String(e.afr, 2);
  line += ",";
  line += String(e.batt, 2);
  line += ",";
  line += String(e.fuel, 1);

  line += ",";
  line += String(p.freq, 2);
  line += ",";
  line += String(p.freqGrid, 2);
  line += ",";
  line += String(p.volt, 1);
  line += ",";
  line += String(p.voltGrid, 1);
  line += ",";
  line += String(p.currentA, 2);
  line += ",";
  line += String(p.powerKW, 3);
  line += ",";
  line += String(p.phaseGen, 2);

  line += ",";
  line += String(p.engineSync ? 1 : 0);
  line += ",";
  line += String(p.gridSync ? 1 : 0);
  line += ",";
  line += String((e.valid && p.valid) ? 1 : 0);

  line += ",";
  line += p.syncStatus;

  return line;
}


void printTxParameterReport(const String &payload,
                            const EngineData &e,
                            const ElectricalData &p,
                            uint32_t seq,
                            uint32_t timestampMs,
                            uint32_t speedReadUs,
                            uint32_t speedParseUs,
                            uint32_t electricalUs,
                            uint32_t payloadUs,
                            uint32_t txUs,
                            uint32_t totalUs) {
  Serial.println();
  Serial.println(F("║------------UART TX PARAMETER MONITOR ESP32-1---------------║"));
  Serial.println();

  if (txRawMonitorEnabled) {
    Serial.print(F("║ RAW TX       : "));
    Serial.println(payload);
  }

  if (txParamMonitorEnabled) {
    Serial.println(F("║ PAYLOAD ORDER:"));
    Serial.println(F("║ $seq,timestampMs,rpm,tps,map,iat,clt,afr,batt,fuel,"));
    Serial.println(F("║ freq,freqGrid,volt,voltGrid,currentA,powerKW,phaseAngle,"));
    Serial.println(F("║ engineSync,gridSync,valid,syncStatus"));
    Serial.println(F("╟─────────────────── FRAME METADATA ────────────────────────╢"));
    Serial.printf("║ %-14s: %lu\n", "seq", (unsigned long)seq);
    Serial.printf("║ %-14s: %lu ms\n", "timestampMs", (unsigned long)timestampMs);

    Serial.println(F("╟─────────────────── ENGINE PARAMETER ──────────────────────╢"));
    Serial.printf("║ %-14s: %d rpm\n", "rpm", e.rpm);
    Serial.printf("║ %-14s: %d %%\n", "tps", e.tps);
    Serial.printf("║ %-14s: %d kPa\n", "map", e.map);
    Serial.printf("║ %-14s: %d C\n", "iat", e.iat);
    Serial.printf("║ %-14s: %d C\n", "clt", e.clt);
    Serial.printf("║ %-14s: %.2f\n", "afr", e.afr);
    Serial.printf("║ %-14s: %.2f V\n", "batt", e.batt);
    Serial.printf("║ %-14s: %.1f %%\n", "fuel", e.fuel);
    Serial.printf("║ %-14s: %d\n", "engineValid", e.valid ? 1 : 0);

    Serial.println(F("╟──────────────── ELECTRICAL PARAMETER ─────────────────────╢"));
    Serial.printf("║ %-14s: %.2f Hz\n", "freq", p.freq);
    Serial.printf("║ %-14s: %.2f Hz\n", "freqGrid", p.freqGrid);
    Serial.printf("║ %-14s: %.1f V\n", "volt", p.volt);
    Serial.printf("║ %-14s: %.1f V\n", "voltGrid", p.voltGrid);
    Serial.printf("║ %-14s: %.2f A\n", "currentA", p.currentA);
    Serial.printf("║ %-14s: %.3f kW\n", "powerKW", p.powerKW);
    Serial.printf("║ %-14s: %.2f deg\n", "phaseAngle", p.phaseGen);
    Serial.printf("║ %-14s: %d\n", "genOn", p.genOn ? 1 : 0);
    Serial.printf("║ %-14s: %d\n", "gridOn", p.gridOn ? 1 : 0);
    Serial.printf("║ %-14s: %d\n", "electricalValid", p.valid ? 1 : 0);

    Serial.println(F("╟──────────────────── STATUS PARAMETER ─────────────────────╢"));
    Serial.printf("║ %-14s: %s\n", "Speeduino", speeduinoDummyEnabled ? "DUMMY" : "UART BINARY 0x6E");
    Serial.printf("║ %-14s: %s\n", "Electrical", electricalDummyEnabled ? "DUMMY" : "MCP3008 Malam_ADRC");
    Serial.printf("║ %-14s: %d\n", "engineSync", p.engineSync ? 1 : 0);
    Serial.printf("║ %-14s: %d\n", "gridSync", p.gridSync ? 1 : 0);
    Serial.printf("║ %-14s: %d\n", "valid", (e.valid && p.valid) ? 1 : 0);
    Serial.printf("║ %-14s: %s\n", "syncStatus", p.syncStatus.c_str());
    Serial.printf("║ %-14s: %lu\n", "speedRxOk", (unsigned long)speedRxOk);
    Serial.printf("║ %-14s: %lu\n", "speedRxFail", (unsigned long)speedRxFail);
    Serial.printf("║ %-14s: %lu ms\n", "lastSpeedRx", (unsigned long)lastSpeeduinoRxMs);
  }

  if (txPerformanceMonitorEnabled) {
    Serial.println(F("╟──────────────────── TX PERFORMANCE ───────────────────────╢"));
    Serial.printf("║ %-20s: %lu us / %.3f ms\n", "Speeduino read", (unsigned long)speedReadUs, speedReadUs / 1000.0);
    Serial.printf("║ %-20s: %lu us / %.3f ms\n", "Speeduino parse", (unsigned long)speedParseUs, speedParseUs / 1000.0);
    Serial.printf("║ %-20s: %lu us / %.3f ms\n", "Electrical process", (unsigned long)electricalUs, electricalUs / 1000.0);
    Serial.printf("║ %-20s: %lu us / %.3f ms\n", "Build CSV", (unsigned long)payloadUs, payloadUs / 1000.0);
    Serial.printf("║ %-20s: %lu us / %.3f ms\n", "UART println", (unsigned long)txUs, txUs / 1000.0);
    Serial.printf("║ %-20s: %lu us / %.3f ms\n", "Total routine", (unsigned long)totalUs, totalUs / 1000.0);
  }

  Serial.println(F("╚════════════════════════════════════════════════════════════╝"));
}

void cacheLastTxReport(const String &payload,
                       const EngineData &e,
                       const ElectricalData &p,
                       uint32_t seq,
                       uint32_t timestampMs,
                       uint32_t speedReadUs,
                       uint32_t speedParseUs,
                       uint32_t electricalUs,
                       uint32_t payloadUs,
                       uint32_t txUs,
                       uint32_t totalUs) {
  lastTxPayload = payload;
  lastTxEngineData = e;
  lastTxElectricalData = p;

  lastTxSeqCache = seq;
  lastTxTimestampMsCache = timestampMs;

  lastTxSpeedReadUsCache = speedReadUs;
  lastTxSpeedParseUsCache = speedParseUs;
  lastTxElectricalUsCache = electricalUs;
  lastTxPayloadUsCache = payloadUs;
  lastTxUsCache = txUs;
  lastTxTotalUsCache = totalUs;

  hasLastTxReport = true;
}

void printLastTxReportFromCache() {
  if (!hasLastTxReport) {
    Serial.println();
    Serial.println(F("╔════════════ UART TX CACHE ════════════╗"));
    Serial.println(F("║ Belum ada frame TX yang pernah dikirim.║"));
    Serial.println(F("║ Gunakan: tx once reset                 ║"));
    Serial.println(F("║ atau tunggu TX continuous berjalan.    ║"));
    Serial.println(F("╚═══════════════════════════════════════╝"));
    return;
  }

  Serial.println();
  Serial.println(F("╔════════════ LAST UART TX FRAME ════════════╗"));
  Serial.println(F("║ Menampilkan frame TX terakhir dari cache.  ║"));
  Serial.println(F("║ Tetap muncul walaupun send once berhenti.  ║"));
  Serial.println(F("╚════════════════════════════════════════════╝"));

  printTxParameterReport(lastTxPayload,
                         lastTxEngineData,
                         lastTxElectricalData,
                         lastTxSeqCache,
                         lastTxTimestampMsCache,
                         lastTxSpeedReadUsCache,
                         lastTxSpeedParseUsCache,
                         lastTxElectricalUsCache,
                         lastTxPayloadUsCache,
                         lastTxUsCache,
                         lastTxTotalUsCache);
}

void sendDataToEspMonitoring() {
  // ===============================================================
  // TX ONCE HOLD MODE
  // ===============================================================
  // Jika mode test once sudah pernah mengirim 1 frame:
  // 1) JANGAN kirim ulang ke ESP32-2.
  // 2) JANGAN build payload baru.
  // 3) JANGAN increment sequence.
  // 4) JANGAN update timestamp TX.
  // 5) Cukup tampilkan ulang data terakhir dari cache pada Serial Monitor.
  //
  // Dengan demikian seq dan timestamp akan tetap sama sampai command:
  //   tx once reset
  // ===============================================================
  if (txOnceModeEnabled && txOnceAlreadySent) {
    if ((txRawMonitorEnabled || txParamMonitorEnabled || txPerformanceMonitorEnabled) &&
        hasLastTxReport &&
        millis() - lastTxOnceCachePrintMs >= TX_ONCE_CACHE_REPORT_INTERVAL_MS) {
      lastTxOnceCachePrintMs = millis();

      Serial.println();
      Serial.println(F("╔════════════ UART TX ONCE HOLD ════════════╗"));
      Serial.println(F("║ Tidak ada frame baru yang dikirim.         ║"));
      Serial.println(F("║ Menampilkan ulang data TX terakhir.        ║"));
      Serial.println(F("║ Seq dan timestamp sengaja dipertahankan.   ║"));
      Serial.println(F("║ Command: tx once reset = kirim data baru.  ║"));
      Serial.println(F("╚════════════════════════════════════════════╝"));

      printLastTxReportFromCache();
    }
    return;
  }

  if (millis() - lastMonitorTxMs < MONITOR_SEND_INTERVAL_MS) return;
  lastMonitorTxMs = millis();

  uint32_t totalStartUs = micros();
  uint32_t speedReadUs = 0;
  uint32_t speedParseUs = 0;
  uint32_t electricalUs = 0;

  uint32_t txSeq = 0;
  uint32_t timestampMs = 0;

  if (txOnceModeEnabled) {
    // Mode TX once memakai data fixed agar raw TX selalu sama.
    // Tidak mengambil Speeduino, tidak mengambil dummy bergerak, tidak increment monitorSeq.
    txSeq = TX_ONCE_FIXED_SEQ;
    timestampMs = TX_ONCE_FIXED_TIMESTAMP;

    uint32_t fixedStartUs = micros();
    getFixedTxOnceData(engineData, electricalData);
    electricalData.syncStatus = getSyncStatusText(engineData, electricalData);
    speedParseUs = micros() - fixedStartUs;
    speedReadUs = 0;
    electricalUs = 0;
  } else {
    // Mode normal tetap memakai sequence, timestamp, dan data berjalan.
    monitorSeq++;
    txSeq = monitorSeq;
    timestampMs = millis();

    uint32_t speedStartUs = micros();
    if (speeduinoDummyEnabled) {
      engineData = getDummySpeeduinoData();
      speedParseUs = micros() - speedStartUs;
    } else {
      EngineData temp;
      bool ok = readSpeeduinoUART(temp, speedReadUs, speedParseUs);
      if (ok) {
        engineData = temp;
      } else {
        engineData.valid = false;
      }
    }

    uint32_t electricalStartUs = micros();
    electricalData = getElectricalData();
    electricalData.currentA = computeGeneratorCurrentA(engineData, electricalData);
    electricalData.powerKW  = computeGeneratorPowerKW(electricalData.volt, electricalData.currentA);
    electricalData.syncStatus = getSyncStatusText(engineData, electricalData);
    electricalUs = micros() - electricalStartUs;
  }

  uint32_t payloadStartUs = micros();
  String payload = buildPayloadForMonitoring(engineData, electricalData, txSeq, timestampMs);
  uint32_t payloadUs = micros() - payloadStartUs;

  uint32_t txStartUs = micros();
  MonitorSerial.println(payload);
  uint32_t txUs = micros() - txStartUs;

  uint32_t totalUs = micros() - totalStartUs;

  cacheLastTxReport(payload,
                    engineData,
                    electricalData,
                    txSeq,
                    timestampMs,
                    speedReadUs,
                    speedParseUs,
                    electricalUs,
                    payloadUs,
                    txUs,
                    totalUs);

  if (txRawMonitorEnabled || txParamMonitorEnabled || txPerformanceMonitorEnabled) {
    printTxParameterReport(payload,
                           engineData,
                           electricalData,
                           txSeq,
                           timestampMs,
                           speedReadUs,
                           speedParseUs,
                           electricalUs,
                           payloadUs,
                           txUs,
                           totalUs);
  }

  if (txOnceModeEnabled) {
    txOnceAlreadySent = true;
    lastTxOnceCachePrintMs = millis();

    Serial.println();
    Serial.println(F("╔════════════ UART TX ONCE TEST ════════════╗"));
    Serial.println(F("║ Satu frame UART fixed sudah dikirim.      ║"));
    Serial.println(F("║ Setelah ini TX UART dihentikan.           ║"));
    Serial.println(F("║ Serial hanya menampilkan data terakhir.   ║"));
    Serial.println(F("║ Seq dan timestamp tidak akan bertambah.   ║"));
    Serial.println(F("║ Command: tx once reset = kirim data sama. ║"));
    Serial.println(F("║ Command: tx continuous = mode normal.     ║"));
    Serial.println(F("╚═══════════════════════════════════════════╝"));
  }
}


// ===================================================
// SERIAL COMMAND HANDLER
// ===================================================
void printCommandHelp() {
  Serial.println();
  Serial.println("╔════════════ SERIAL COMMANDS ════════════╗");
  Serial.println("║ s / start          : Start control       ║");
  Serial.println("║ x / stop           : Stop control        ║");
  Serial.println("║ speed dummy on     : Speeduino = dummy   ║");
  Serial.println("║ speed dummy off    : Speeduino = UART    ║");
  Serial.println("║ elec dummy on      : Electrical = dummy  ║");
  Serial.println("║ elec dummy off     : Electrical = MCP3008║");
  Serial.println("║ eon                : Electrical dummy ON ║");
  Serial.println("║ eoff               : Electrical dummy OFF║");
  Serial.println("║ dummy sync         : Dummy status sync   ║");
  Serial.println("║ dummy genset       : Dummy status genset ║");
  Serial.println("║ dummy grid         : Dummy status grid   ║");
  Serial.println("║ dummy off          : Dummy status off    ║");
  Serial.println("║ dummy auto         : Dummy status auto   ║");
  Serial.println("║ tx monitor on/off  : Raw TX + parameter  ║");
  Serial.println("║ tx raw on/off      : Raw TX only         ║");
  Serial.println("║ tx param on/off    : Named parameters    ║");
  Serial.println("║ tx perf on/off     : TX timing report    ║");
  Serial.println("║ tx once            : Kirim fixed 1 frame ║");
  Serial.println("║ tx once reset      : Kirim fixed ulang   ║");
  Serial.println("║ tx last            : Tampilkan TX cache  ║");
  Serial.println("║ tx continuous      : Kirim terus normal  ║");
  Serial.println("║ status             : Print mode status   ║");
  Serial.println("║ help               : Show commands       ║");
  Serial.println("╚══════════════════════════════════════════╝");
}

void printModeStatus() {
  Serial.println();
  Serial.println("╔════════════ CURRENT MODE STATUS ════════════╗");
  Serial.printf("[ENGINE]     Speeduino source  : %s\n",
                speeduinoDummyEnabled ? "DUMMY" : "UART BINARY 0x6E");
  Serial.printf("[ELECTRICAL] Electrical source : %s\n",
                electricalDummyEnabled ? "DUMMY" : "MCP3008 Malam_ADRC");
  Serial.printf("[DUMMY]      Sync test status  : %s\n", dummySyncModeToText(dummySyncMode));
  Serial.printf("[DUMMY]      Active status     : %s\n", dummySyncModeToText(getActiveDummySyncMode()));
  Serial.printf("[UART]       Monitor interval  : %lu ms\n", (unsigned long)MONITOR_SEND_INTERVAL_MS);
  Serial.printf("[PAYLOAD]    Format            : 20 fields, includes MAP + current + power + phaseAngle\n");
  Serial.printf("[TX MONITOR] Raw               : %s\n", txRawMonitorEnabled ? "ON" : "OFF");
  Serial.printf("[TX MONITOR] Parameter         : %s\n", txParamMonitorEnabled ? "ON" : "OFF");
  Serial.printf("[TX MONITOR] Performance       : %s\n", txPerformanceMonitorEnabled ? "ON" : "OFF");
  Serial.printf("[UART TX]    Send mode         : %s\n", txOnceModeEnabled ? "ONCE FIXED TEST" : "CONTINUOUS");
  Serial.printf("[UART TX]    Once sent         : %s\n", txOnceAlreadySent ? "YES" : "NO");
  Serial.printf("[UART TX]    Fixed once seq    : %lu\n", (unsigned long)TX_ONCE_FIXED_SEQ);
  Serial.printf("[UART TX]    Fixed once time   : %lu ms\n", (unsigned long)TX_ONCE_FIXED_TIMESTAMP);
  Serial.printf("[UART TX]    Cache available   : %s\n", hasLastTxReport ? "YES" : "NO");
  if (hasLastTxReport) {
    Serial.printf("[UART TX]    Last cache seq    : %lu\n", (unsigned long)lastTxSeqCache);
    Serial.printf("[UART TX]    Last cache time   : %lu ms\n", (unsigned long)lastTxTimestampMsCache);
  }
  Serial.println("╚═════════════════════════════════════════════╝");
}

void setSpeeduinoDummyMode(bool enabled) {
  speeduinoDummyEnabled = enabled;

  Serial.println();
  Serial.println("╔════════════ SPEEDUINO SOURCE UPDATED ════════════╗");
  Serial.printf("[ENGINE] Mode sekarang: %s\n",
                speeduinoDummyEnabled ? "DUMMY" : "UART BINARY 0x6E");
  Serial.println("╚══════════════════════════════════════════════════╝");
}

void setElectricalDummyMode(bool enabled) {
  electricalDummyEnabled = enabled;

  if (enabled) {
    digitalWrite(LED_PIN, HIGH);
    digitalWrite(NO1_PIN, HIGH);
    digitalWrite(NO2_PIN, HIGH);
  }

  Serial.println();
  Serial.println("╔════════════ ELECTRICAL SOURCE UPDATED ════════════╗");
  Serial.printf("[ELECTRICAL] Mode sekarang: %s\n",
                electricalDummyEnabled ? "DUMMY" : "MCP3008 Malam_ADRC");
  Serial.println("╚═══════════════════════════════════════════════════╝");
}

void setDummySyncMode(DummySyncMode mode) {
  dummySyncMode = mode;

  // Saat menguji status dummy, sumber dummy otomatis aktif.
  speeduinoDummyEnabled = true;
  electricalDummyEnabled = true;

  Serial.println();
  Serial.println(F("╔════════════ DUMMY STATUS UPDATED ════════════╗"));
  Serial.printf("[DUMMY] Mode status sekarang : %s\n", dummySyncModeToText(dummySyncMode));
  Serial.println(F("[DUMMY] Speeduino dan electrical dummy otomatis ON."));
  Serial.println(F("[DUMMY] Payload field terakhir: syncStatus."));
  Serial.println(F("╚══════════════════════════════════════════════╝"));
}

void startControlSystem() {
  jalan = true;
  startRampDone = false;
  startHoldDone = false;
  rampStartTime = millis();
  hold(0);
  z1 = 0;
  z2 = 0;
  holdBoostAccum = 0;
  currentServoLimit = SERVO_STEP_BASE;
  lastDelta = 0.0;
  Serial.println("START");
}

void stopControlSystem() {
  jalan = false;
  startRampDone = false;
  startHoldDone = false;
  hold(0);
  Serial.println("STOP");
}


void setTxMonitorMode(bool enabled) {
  txRawMonitorEnabled = enabled;
  txParamMonitorEnabled = enabled;
  txPerformanceMonitorEnabled = enabled;

  Serial.println();
  Serial.println(F("╔════════════ UART TX MONITOR UPDATED ════════════╗"));
  Serial.printf("[TX MONITOR] Raw TX      : %s\n", txRawMonitorEnabled ? "ON" : "OFF");
  Serial.printf("[TX MONITOR] Parameter   : %s\n", txParamMonitorEnabled ? "ON" : "OFF");
  Serial.printf("[TX MONITOR] Performance : %s\n", txPerformanceMonitorEnabled ? "ON" : "OFF");
  Serial.println(F("╚══════════════════════════════════════════════════╝"));

  if (enabled) {
    printLastTxReportFromCache();
    lastTxOnceCachePrintMs = millis();
  }
}


void setTxRawMode(bool enabled) {
  txRawMonitorEnabled = enabled;
  Serial.printf("[TX RAW] %s\n", enabled ? "ON" : "OFF");
  if (enabled) printLastTxReportFromCache();
}

void setTxParamMode(bool enabled) {
  txParamMonitorEnabled = enabled;
  Serial.printf("[TX PARAM] %s\n", enabled ? "ON" : "OFF");
  if (enabled) printLastTxReportFromCache();
}

void setTxPerfMode(bool enabled) {
  txPerformanceMonitorEnabled = enabled;
  Serial.printf("[TX PERF] %s\n", enabled ? "ON" : "OFF");
  if (enabled) printLastTxReportFromCache();
}

void setTxOnceMode(bool enabled) {
  txOnceModeEnabled = enabled;
  txOnceAlreadySent = false;
  lastMonitorTxMs = 0;
  lastTxOnceCachePrintMs = 0;

  if (enabled) {
    txRawMonitorEnabled = true;
    txParamMonitorEnabled = true;
    txPerformanceMonitorEnabled = true;
  }

  Serial.println();
  Serial.println(F("╔════════════ UART TX MODE UPDATED ════════════╗"));
  Serial.printf("[UART TX] Mode sekarang : %s\n", enabled ? "ONCE FIXED TEST" : "CONTINUOUS");
  Serial.printf("[UART TX] Status sent   : %s\n", txOnceAlreadySent ? "SUDAH TERKIRIM" : "BELUM TERKIRIM");
  Serial.printf("[TX MONITOR] Raw TX     : %s\n", txRawMonitorEnabled ? "ON" : "OFF");
  Serial.printf("[TX MONITOR] Parameter  : %s\n", txParamMonitorEnabled ? "ON" : "OFF");
  Serial.printf("[TX MONITOR] Performance: %s\n", txPerformanceMonitorEnabled ? "ON" : "OFF");
  if (enabled) {
    Serial.println(F("[UART TX] Fixed payload : $287,3723883,3031,12,47,34,84,14.61,13.41,46.4,49.94,49.98,221.2,221.9,5.63,1.245,3.41,1,1,1,sync"));
  }
  Serial.println(F("╚══════════════════════════════════════════════╝"));
}


void resetTxOnceMode() {
  txOnceModeEnabled = true;
  txOnceAlreadySent = false;
  lastMonitorTxMs = 0;
  lastTxOnceCachePrintMs = 0;

  txRawMonitorEnabled = true;
  txParamMonitorEnabled = true;
  txPerformanceMonitorEnabled = true;

  Serial.println();
  Serial.println(F("╔════════════ UART TX ONCE RESET ════════════╗"));
  Serial.println(F("║ Mode ONCE FIXED TEST aktif kembali.        ║"));
  Serial.println(F("║ Frame berikutnya akan dikirim satu kali.   ║"));
  Serial.println(F("║ Raw TX + parameter otomatis aktif.         ║"));
  Serial.println(F("║ Payload fixed tetap sama setiap reset.     ║"));
  Serial.println(F("╚════════════════════════════════════════════╝"));
}


void processSerialCommand(String cmd) {
  cmd.trim();
  cmd.toLowerCase();
  if (cmd.length() == 0) return;

  if (cmd == "s" || cmd == "start") {
    startControlSystem();
  } else if (cmd == "x" || cmd == "stop") {
    stopControlSystem();
  } else if (cmd == "speed dummy on" || cmd == "speeduino dummy on" || cmd == "son") {
    setSpeeduinoDummyMode(true);
  } else if (cmd == "speed dummy off" || cmd == "speeduino dummy off" || cmd == "soff") {
    setSpeeduinoDummyMode(false);
  } else if (cmd == "elec dummy on" || cmd == "electrical dummy on" || cmd == "eon") {
    setElectricalDummyMode(true);
  } else if (cmd == "elec dummy off" || cmd == "electrical dummy off" || cmd == "eoff") {
    setElectricalDummyMode(false);
  } else if (cmd == "dummy sync") {
    setDummySyncMode(DUMMY_STATUS_SYNC);
  } else if (cmd == "dummy genset") {
    setDummySyncMode(DUMMY_STATUS_GENSET);
  } else if (cmd == "dummy grid") {
    setDummySyncMode(DUMMY_STATUS_GRID);
  } else if (cmd == "dummy off") {
    setDummySyncMode(DUMMY_STATUS_OFF);
  } else if (cmd == "dummy auto") {
    setDummySyncMode(DUMMY_STATUS_AUTO);
  } else if (cmd == "tx monitor on") {
    setTxMonitorMode(true);
  } else if (cmd == "tx monitor off") {
    setTxMonitorMode(false);
  } else if (cmd == "tx raw on") {
    setTxRawMode(true);
  } else if (cmd == "tx raw off") {
    setTxRawMode(false);
  } else if (cmd == "tx param on") {
    setTxParamMode(true);
  } else if (cmd == "tx param off") {
    setTxParamMode(false);
  } else if (cmd == "tx perf on") {
    setTxPerfMode(true);
  } else if (cmd == "tx perf off") {
    setTxPerfMode(false);
  } else if (cmd == "tx once" || cmd == "tx once on" || cmd == "send once") {
    setTxOnceMode(true);
  } else if (cmd == "tx continuous" || cmd == "tx once off" || cmd == "send continuous") {
    setTxOnceMode(false);
  } else if (cmd == "tx once reset" || cmd == "send once reset") {
    resetTxOnceMode();
  } else if (cmd == "tx last" || cmd == "last tx" || cmd == "tx cache") {
    printLastTxReportFromCache();
  } else if (cmd == "status" || cmd == "mode") {
    printModeStatus();
  } else if (cmd == "help" || cmd == "?") {
    printCommandHelp();
  } else {
    Serial.print("[COMMAND] Tidak dikenal: ");
    Serial.println(cmd);
    Serial.println("Ketik 'help' untuk daftar command.");
  }
}

void handleSerialInput() {
  while (Serial.available()) {
    char c = (char)Serial.read();

    if (c == '\r' || c == '\n') {
      if (serialInputBuffer.length() > 0) {
        processSerialCommand(serialInputBuffer);
        serialInputBuffer = "";
      }
      continue;
    }

    serialInputBuffer += c;
    if (serialInputBuffer.length() > 80) {
      serialInputBuffer = "";
      Serial.println("[COMMAND] Buffer reset karena command terlalu panjang.");
    }
  }
}

// ===================================================
// SETUP
// ===================================================
void setup() {
  Serial.begin(115200);
  Serial.setTimeout(5);
  MonitorSerial.begin(MONITOR_BAUD, SERIAL_8N1, MONITOR_RX_PIN, MONITOR_TX_PIN);
  SpeeduinoSerial.begin(SPEEDUINO_BAUD, SERIAL_8N1, SPEEDUINO_RX_PIN, SPEEDUINO_TX_PIN);
  SpeeduinoSerial.setTimeout(SPEEDUINO_TIMEOUT_MS);

  pinMode(LED_PIN, OUTPUT);
  pinMode(NO1_PIN, OUTPUT);
  pinMode(NO2_PIN, OUTPUT);
  pinMode(CS_PIN, OUTPUT);

  SPI.begin(SPI_SCK, SPI_MISO, SPI_MOSI, CS_PIN);

  setupServoPwm();
  hold(0);

  xTaskCreatePinnedToCore(SyncLoop, "sync", 10000, NULL, 1, NULL, 0);
  Serial.println("READY");
  Serial.println("UART ESP32 Monitoring enabled:");
  Serial.println("  TX GPIO25 -> RX GPIO16 ESP32 monitoring");
  Serial.println("  Baud 115200, payload 21 field, prefix '$', includes MAP, current, power, phaseAngle, and syncStatus");
  Serial.println("UART Speeduino enabled:");
  Serial.println("  Speeduino TX -> GPIO16 RX ESP32-1");
  Serial.println("  Speeduino RX <- GPIO17 TX ESP32-1");
  Serial.println("  Binary request/response: request 'n', header 0x6E, 120 bytes");
  Serial.println("Electrical source enabled:");
  Serial.printf("  Default Speeduino mode : %s\n", speeduinoDummyEnabled ? "DUMMY" : "UART BINARY 0x6E");
  Serial.printf("  Default electrical mode: %s\n", electricalDummyEnabled ? "DUMMY" : "MCP3008 Malam_ADRC");
  Serial.println("Fixed TX once enabled:");
  Serial.println("  tx once / tx once reset will always send:");
  Serial.println("  $287,3723883,3031,12,47,34,84,14.61,13.41,46.4,49.94,49.98,221.2,221.9,5.63,1.245,3.41,1,1,1,sync");
  Serial.println("  Commands: speed dummy on/off | elec dummy on/off | tx once | tx once reset | tx continuous | tx monitor on | status | help");
  Serial.println("  Serial Monitor: gunakan Newline atau Both NL & CR agar command dieksekusi.");
}


// ===================================================
// MAIN LOOP
// ===================================================
void loop() {
  handleSerialInput();

  if (jalan) {
    if (!startHoldDone) {
      startRampControl();
    }
    else {
      soloControlADRC();
    }
  }
  else {
    hold(0);
  }

  float printServo = servoPos;
  if (isnan(printServo)) printServo = 0.0;

  static uint32_t lastStatusPrintMs = 0;
  if (millis() - lastStatusPrintMs >= 500UL) {
    lastStatusPrintMs = millis();
    Serial.printf(
      "GEN: %.1fV | PLN: %.1fV | F_GEN: %.2fHz | F_PLN: %.2fHz | dF: %.3fHz | PH: %.1f | Servo:%.2f | MAP:%d kPa | STATUS:%s | ELEC:%s\n",
      electricalData.volt, electricalData.voltGrid, electricalData.freq, electricalData.freqGrid,
      electricalData.freq - electricalData.freqGrid, electricalData.phaseGen, printServo, engineData.map,
      electricalData.syncStatus.c_str(),
      electricalDummyEnabled ? "DUMMY" : "MCP3008"
    );
  }

  sendDataToEspMonitoring();

  delay(5);
}
