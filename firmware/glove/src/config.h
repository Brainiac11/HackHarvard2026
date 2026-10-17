#pragma once
#include <Arduino.h>

// Motor order everywhere: thumb, index, middle, ring, pinky (PLAN.md §5.2).
#if defined(GLOVE_BOARD_S3)
static const uint8_t MOTOR_PINS[5] = {4, 5, 6, 7, 15};
static const int STATUS_LED = -1;  // S3 devkit LED is addressable RGB; not used
#elif defined(GLOVE_BOARD_C3)
static const uint8_t MOTOR_PINS[5] = {3, 4, 5, 6, 7};
static const int STATUS_LED = -1;
#else  // classic ESP32-WROOM-32 DevKit
static const uint8_t MOTOR_PINS[5] = {25, 26, 27, 32, 33};
static const int STATUS_LED = 2;
#endif

static const uint32_t PWM_FREQ_HZ = 20000;  // above hearing
static const uint8_t PWM_BITS = 8;
static const uint32_t SERIAL_BAUD = 921600;
static const uint8_t FIRMWARE_VERSION = 1;

// Defaults, adjustable at runtime with the CONFIG packet.
static const uint8_t DEFAULT_MIN_DUTY = 0;     // deadband: duties below this are output as 0
static const uint8_t DEFAULT_MAX_DUTY = 180;   // ~2.8 V average through a ULN2803 on 5 V
static const uint8_t DEFAULT_KICK_MS = 20;     // ERM stiction kick when a motor starts
static const uint8_t DEFAULT_KICK_DUTY = 230;
static const uint16_t DEFAULT_WATCHDOG_MS = 300;
