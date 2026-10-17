#include <NimBLEDevice.h>

#define SERVICE_UUID "12345678-1234-1234-1234-123456789000"
#define COMMAND_UUID "12345678-1234-1234-1234-123456789001"

class CommandReceiver : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* characteristic,
               NimBLEConnInfo& info) override {
    auto command = characteristic->getValue();

    Serial.print("Received: ");
    Serial.println(command.c_str());

    // Handle your command here.
    // Keep this callback short.
  }
};

CommandReceiver receiver;

void setup() {
  Serial.begin(115200);

  NimBLEDevice::init("ESPcmd");

  auto* server = NimBLEDevice::createServer();
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