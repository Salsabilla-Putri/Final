JSON BUILD

  String json = "{";
  json += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  json += "\"recordId\":\"" + r.recordId + "\",";
  json += "\"localSeq\":" + String(r.localSeq) + ",";
  json += "\"timestamp\":\"" + r.timestamp + "\",";
  json += "\"espSentAtMs\":" + String(r.timestampMs) + ",";
  json += "\"ecuConnected\":" + String(linkOK ? "true" : "false") + ",";
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
  json += "\"sync\":\"" + String(getSyncTextFromSynced(a.synced)) + "\",";
  json += "\"powerSource\":\"" + String(getPowerSourceFromSynced(a.synced)) + "\",";
  json += "\"synced\":" + String(a.synced ? "true" : "false");
  json += "}";
  return json;
}

EX:
{
  "deviceId": "ESP32_GENERATOR_01",
  "recordId": "ESP32_GENERATOR_01_1024",
  "localSeq": 1024,
  "timestamp": "2026-06-09T13:25:10",
  "espSentAtMs": 582340,
  "ecuConnected": true,
  "rpm": 1520.5,
  "tps": 18.2,
  "map": 96.4,
  "iat": 32.1,
  "clt": 78.5,
  "afr": 14.72,
  "batt": 12.61,
  "fuel": 65.0,
  "freq": 50.012,
  "volt": 220.45,
  "currentA": 4.82,
  "powerKW": 1.061,
  "phase_diff": 2.35,
  "sync": "ON-GRID",
  "powerSource": "GRID",
  "synced": true
}
