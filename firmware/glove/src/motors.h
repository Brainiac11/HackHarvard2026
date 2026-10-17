#pragma once
// Safe ERM actuator: clamp, kick-start, frame TTL, global watchdog, built-in patterns (PLAN.md §4.1, §11).
#include <Arduino.h>
#include "config.h"

struct MotorConfig {
  uint8_t minDuty = DEFAULT_MIN_DUTY;
  uint8_t maxDuty = DEFAULT_MAX_DUTY;
  uint8_t kickMs = DEFAULT_KICK_MS;
  uint8_t kickDuty = DEFAULT_KICK_DUTY;
  uint16_t watchdogMs = DEFAULT_WATCHDOG_MS;
};

class Motors {
 public:
  void begin();
  void setFrame(const uint8_t duty[5], uint16_t ttlMs, uint32_t now);
  void playPattern(uint8_t id, uint8_t mask, uint8_t gain, uint32_t now);
  void stopAll();
  void feedWatchdog(uint32_t now) { lastPacket_ = now; }
  void update(uint32_t now);
  bool watchdogTripped() const { return watchdogTripped_; }
  void selfTest();  // blocking ripple at boot: a dead motor is obvious immediately
  MotorConfig cfg;

 private:
  void write(uint8_t i, uint8_t duty);
  uint8_t target_[5] = {0};
  uint8_t current_[5] = {0};
  uint32_t kickUntil_[5] = {0};
  uint32_t frameExpiry_ = 0;
  uint32_t lastPacket_ = 0;
  bool watchdogTripped_ = false;
  // pattern player
  int8_t patternId_ = 0;
  uint8_t patternMask_ = 0x1F, patternGain_ = 255, patternStep_ = 0;
  uint32_t patternStepEnd_ = 0;
};
