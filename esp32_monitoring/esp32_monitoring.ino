#include <Arduino.h>
#include <SPI.h>
#include <SD.h>

#define TFT_CS 15

#define SD_MISO 12
#define SD_MOSI 13
#define SD_SCK  14
#define SD_CS   26

SPIClass sdSPI(HSPI);

void setup() {
  Serial.begin(115200);
  delay(2000);

  Serial.println("SD TEST START");

  pinMode(TFT_CS, OUTPUT);
  pinMode(SD_CS, OUTPUT);

  digitalWrite(TFT_CS, HIGH);
  digitalWrite(SD_CS, HIGH);

  delay(1000);

  sdSPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  delay(300);

  bool sdOK = false;

  for (int attempt = 1; attempt <= 10; attempt++) {
    Serial.print("SD INIT ATTEMPT ");
    Serial.print(attempt);
    Serial.print("/10 ... ");

    digitalWrite(TFT_CS, HIGH);
    digitalWrite(SD_CS, HIGH);
    delay(100);

    if (SD.begin(SD_CS, sdSPI, 400000)) {
      if (SD.cardType() != CARD_NONE) {
        sdOK = true;
        Serial.println("OK");
        break;
      }
    }

    Serial.println("FAILED");
    SD.end();
    delay(500);
  }

  if (!sdOK) {
    Serial.println("SD INIT FAILED FINAL");
    return;
  }

  File f = SD.open("/test.txt", FILE_WRITE);
  if (!f) {
    Serial.println("OPEN FILE FAILED");
    return;
  }

  f.println("SD card test OK");
  f.close();

  Serial.println("WRITE OK");
}

void loop() {}