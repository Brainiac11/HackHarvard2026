// LunarHaptics glove: dumb, safe actuator. The hub renders all haptics and streams FRAME packets at 50 Hz
// over BLE (NimBLE) or USB serial; this firmware clamps, kick-starts, and stops everything if the stream stops.
#include <Arduino.h>
#include <NimBLEDevice.h>

#include "config.h"
#include "motors.h"
#include "protocol.h"

static Motors motors;
static proto::Parser serialParser;
static proto::Parser bleParser;
static NimBLECharacteristic* txChar = nullptr;
static volatile bool bleConnected = false;
static uint32_t framesReceived = 0;
static uint8_t lastSeq = 0;
static uint8_t txSeq = 0;

// BLE writes arrive on the NimBLE host task; hand bytes to loop() through a small locked ring buffer.
static portMUX_TYPE rxMux = portMUX_INITIALIZER_UNLOCKED;
static uint8_t rxRing[512];
static volatile uint16_t rxHead = 0, rxTail = 0;

static void ringPush(const uint8_t* data, size_t len) {
  portENTER_CRITICAL(&rxMux);
  for (size_t i = 0; i < len; i++) {
    uint16_t next = (rxHead + 1) % sizeof(rxRing);
    if (next == rxTail) break;  // full: drop (the hub resends every 20 ms anyway)
    rxRing[rxHead] = data[i];
    rxHead = next;
  }
  portEXIT_CRITICAL(&rxMux);
}

static bool ringPop(uint8_t& b) {
  bool ok = false;
  portENTER_CRITICAL(&rxMux);
  if (rxTail != rxHead) {
    b = rxRing[rxTail];
    rxTail = (rxTail + 1) % sizeof(rxRing);
    ok = true;
  }
  portEXIT_CRITICAL(&rxMux);
  return ok;
}

static void sendPacket(uint8_t type, const uint8_t* payload, uint8_t len) {
  uint8_t buf[6 + proto::MAX_PAYLOAD];
  size_t n = proto::encode(type, txSeq++, payload, len, buf);
  Serial.write(buf, n);
  if (bleConnected && txChar) {
    txChar->setValue(buf, n);
    txChar->notify();
  }
}

static void handle(const proto::Packet& p) {
  uint32_t now = millis();
  motors.feedWatchdog(now);
  lastSeq = p.seq;
  switch (p.type) {
    case proto::FRAME:
      if (p.len >= 7) {
        uint16_t ttl = p.payload[5] | (p.payload[6] << 8);
        motors.setFrame(p.payload, ttl, now);
        framesReceived++;
      }
      break;
    case proto::PATTERN:
      if (p.len >= 3) motors.playPattern(p.payload[0], p.payload[1], p.payload[2], now);
      break;
    case proto::STOP:
      motors.stopAll();
      break;
    case proto::CONFIG:
      if (p.len >= 6) {
        motors.cfg.minDuty = p.payload[0];
        motors.cfg.maxDuty = p.payload[1];
        motors.cfg.kickMs = p.payload[2];
        motors.cfg.kickDuty = p.payload[3];
        motors.cfg.watchdogMs = max<uint16_t>(50, p.payload[4] | (p.payload[5] << 8));
      }
      break;
    case proto::PING:
      if (p.len >= 4) sendPacket(proto::PONG, p.payload, 4);
      break;
  }
}

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* server, ble_gap_conn_desc* desc) override {
    bleConnected = true;
    server->updateConnParams(desc->conn_handle, 6, 12, 0, 200);  // 7.5-15 ms interval, 2 s supervision
  }
  void onDisconnect(NimBLEServer* server) override {
    bleConnected = false;
    motors.stopAll();
    NimBLEDevice::startAdvertising();
  }
};

class RxCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c) override {
    auto value = c->getValue();
    ringPush(reinterpret_cast<const uint8_t*>(value.data()), value.length());
  }
};

static void setupBle() {
  NimBLEDevice::init(proto::BLE_NAME);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);
  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  NimBLEService* svc = server->createService(proto::SERVICE_UUID);
  NimBLECharacteristic* rx = svc->createCharacteristic(proto::RX_UUID, NIMBLE_PROPERTY::WRITE_NR | NIMBLE_PROPERTY::WRITE);
  rx->setCallbacks(new RxCallbacks());
  txChar = svc->createCharacteristic(proto::TX_UUID, NIMBLE_PROPERTY::NOTIFY);
  svc->start();
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(proto::SERVICE_UUID);
  adv->setScanResponse(true);
  adv->start();
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  if (STATUS_LED >= 0) pinMode(STATUS_LED, OUTPUT);
  motors.begin();
  motors.selfTest();
  setupBle();
}

void loop() {
  uint32_t now = millis();
  proto::Packet pkt;
  while (Serial.available()) {
    if (serialParser.push((uint8_t)Serial.read(), pkt)) handle(pkt);
  }
  uint8_t b;
  while (ringPop(b)) {
    if (bleParser.push(b, pkt)) handle(pkt);
  }
  motors.update(now);

  static uint32_t lastStatus = 0;
  if (now - lastStatus >= 1000) {
    lastStatus = now;
    uint8_t payload[11];
    uint32_t uptime = now / 1000;
    payload[0] = FIRMWARE_VERSION;
    memcpy(payload + 1, &uptime, 4);
    memcpy(payload + 5, &framesReceived, 4);
    payload[9] = lastSeq;
    payload[10] = motors.watchdogTripped() ? 0x01 : 0x00;
    sendPacket(proto::STATUS, payload, sizeof(payload));
  }
  if (STATUS_LED >= 0) {  // slow blink = advertising, solid = connected
    digitalWrite(STATUS_LED, bleConnected ? HIGH : ((now / 500) % 2));
  }
  delay(1);
}
