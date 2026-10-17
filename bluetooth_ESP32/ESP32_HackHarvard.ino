#include <NimBLEDevice.h>

#define SERVICE_UUID "12345678-1234-1234-1234-123456789000"
#define COMMAND_UUID "12345678-1234-1234-1234-123456789001"

// Vibration motors, thumb..pinky. Same wiring as firmware/glove/src/config.h.
#if CONFIG_IDF_TARGET_ESP32S3
const uint8_t MOTOR_PINS[5] = {4, 5, 6, 7, 15};
#elif CONFIG_IDF_TARGET_ESP32C3
const uint8_t MOTOR_PINS[5] = {3, 4, 5, 6, 7};
#else  // classic ESP32 DevKit
const uint8_t MOTOR_PINS[5] = {25, 26, 27, 32, 33};
#endif
const uint32_t PWM_FREQ_HZ = 20000;  // above hearing
const uint8_t PWM_BITS = 8;          // duty 0-255

void setupMotors() {
  for (uint8_t i = 0; i < 5; i++) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcAttach(MOTOR_PINS[i], PWM_FREQ_HZ, PWM_BITS);
#else
    ledcSetup(i, PWM_FREQ_HZ, PWM_BITS);
    ledcAttachPin(MOTOR_PINS[i], i);
#endif
  }
}

void setMotor(uint8_t i, uint8_t duty) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(MOTOR_PINS[i], duty);
#else
  ledcWrite(i, duty);
#endif
}

void stopMotors() {
  for (uint8_t i = 0; i < 5; i++) setMotor(i, 0);
}

// Vibration command from the hub (--glove espcmd): "d0 d1 d2 d3 d4" sets each finger's duty 0-255,
// thumb..pinky. A single number sets all five, so "0" stops. Anything else is ignored.
void handleVibration(const char* command) {
  int duty[5];
  int n = sscanf(command, "%d %d %d %d %d", &duty[0], &duty[1], &duty[2], &duty[3], &duty[4]);
  if (n != 1 && n != 5) return;
  for (uint8_t i = 0; i < 5; i++) setMotor(i, constrain(duty[n == 1 ? 0 : i], 0, 255));
}

class CommandReceiver : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* characteristic,
               NimBLEConnInfo& info) override {
    auto command = characteristic->getValue();

    Serial.print("Received: ");
    Serial.println(command.c_str());

    // Handle your command here.
    // Keep this callback short.
    handleVibration(command.c_str());
  }
};

class ServerEvents : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* server, NimBLEConnInfo& info) override {
    // 7.5-15 ms interval: every command is a write with response, so this sets the vibration latency.
    server->updateConnParams(info.getConnHandle(), 6, 12, 0, 200);
  }
  void onDisconnect(NimBLEServer* server, NimBLEConnInfo& info, int reason) override {
    stopMotors();  // never leave a motor buzzing when the laptop goes away
  }
};

CommandReceiver receiver;
ServerEvents serverEvents;

void setup() {
  Serial.begin(115200);
  setupMotors();
  stopMotors();

  NimBLEDevice::init("ESPcmd");

  auto* server = NimBLEDevice::createServer();
  server->setCallbacks(&serverEvents, false);
  server->advertiseOnDisconnect(true);

  auto* service = server->createService(SERVICE_UUID);

  auto* command = service->createCharacteristic(
    COMMAND_UUID,
    NIMBLE_PROPERTY::WRITE,
    20 // Maximum command length in bytes
  );

  command->setCallbacks(&receiver);
  service->start();

  auto* advertising = NimBLEDevice::getAdvertising();
  advertising->setName("ESPcmd");
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->start();

  Serial.println("Waiting for laptop...");
}

void loop() {
  delay(10); // Your other application code can run here.
}