#include "motors.h"

namespace {
struct Step {
  uint16_t ms;
  uint8_t level;    // 0..255, scaled by pattern gain
  uint8_t fingers;  // bitmask thumb=bit0 .. pinky=bit4 (0x1F = all), further ANDed with the packet mask
};
// Mirrors hub/lunarhub/haptics/patterns.py (used for self-test / hub-less demos)
const Step DOUBLE_P[] = {{80, 230, 0x1F}, {90, 0, 0x1F}, {80, 230, 0x1F}};
const Step TRIPLE_P[] = {{60, 230, 0x1F}, {70, 0, 0x1F}, {60, 230, 0x1F}, {70, 0, 0x1F}, {60, 230, 0x1F}};
const Step WAVE_P[] = {{60, 217, 0x01}, {60, 217, 0x02}, {60, 217, 0x04}, {60, 217, 0x08}, {60, 217, 0x10}};
const Step WARNING_P[] = {{150, 255, 0x1F}, {100, 0, 0x1F}, {150, 255, 0x1F}, {100, 0, 0x1F}, {150, 255, 0x1F}};
struct Pattern { const Step* steps; uint8_t count; };
const Pattern PATTERNS[] = {
    {nullptr, 0},
    {DOUBLE_P, sizeof(DOUBLE_P) / sizeof(Step)},
    {TRIPLE_P, sizeof(TRIPLE_P) / sizeof(Step)},
    {WAVE_P, sizeof(WAVE_P) / sizeof(Step)},
    {WARNING_P, sizeof(WARNING_P) / sizeof(Step)},
};
const uint8_t PATTERN_COUNT = sizeof(PATTERNS) / sizeof(Pattern);
}  // namespace

void Motors::begin() {
  for (uint8_t i = 0; i < 5; i++) {
    ledcSetup(i, PWM_FREQ_HZ, PWM_BITS);  // Arduino-ESP32 core 2.x LEDC API
    ledcAttachPin(MOTOR_PINS[i], i);
    ledcWrite(i, 0);
  }
}

void Motors::write(uint8_t i, uint8_t duty) {
  if (duty != current_[i]) {
    ledcWrite(i, duty);
    current_[i] = duty;
  }
}

void Motors::setFrame(const uint8_t duty[5], uint16_t ttlMs, uint32_t now) {
  for (uint8_t i = 0; i < 5; i++) {
    uint8_t d = duty[i] < cfg.minDuty ? 0 : min(duty[i], cfg.maxDuty);
    if (target_[i] == 0 && d > 0) kickUntil_[i] = now + cfg.kickMs;
    target_[i] = d;
  }
  frameExpiry_ = now + ttlMs;
  watchdogTripped_ = false;
}

void Motors::playPattern(uint8_t id, uint8_t mask, uint8_t gain, uint32_t now) {
  if (id == 0 || id >= PATTERN_COUNT) return;
  patternId_ = id;
  patternMask_ = mask & 0x1F;
  patternGain_ = gain;
  patternStep_ = 0;
  patternStepEnd_ = now + PATTERNS[id].steps[0].ms;
}

void Motors::stopAll() {
  patternId_ = 0;
  for (uint8_t i = 0; i < 5; i++) {
    target_[i] = 0;
    write(i, 0);
  }
  frameExpiry_ = 0;
}

void Motors::update(uint32_t now) {
  // global watchdog: no valid packet recently -> everything off
  if (now - lastPacket_ > cfg.watchdogMs && patternId_ == 0) {
    if (!watchdogTripped_) {
      watchdogTripped_ = true;
      stopAll();
    }
    return;
  }
  // per-frame TTL
  if (frameExpiry_ && (int32_t)(now - frameExpiry_) > 0) {
    for (uint8_t i = 0; i < 5; i++) target_[i] = 0;
    frameExpiry_ = 0;
  }
  // on-device pattern overrides streamed frames while it plays
  if (patternId_) {
    const Pattern& p = PATTERNS[patternId_];
    while ((int32_t)(now - patternStepEnd_) >= 0) {
      if (++patternStep_ >= p.count) {
        patternId_ = 0;
        break;
      }
      patternStepEnd_ += p.steps[patternStep_].ms;
    }
    if (patternId_) {
      const Step& s = p.steps[patternStep_];
      uint8_t level = (uint16_t)s.level * patternGain_ / 255;
      for (uint8_t i = 0; i < 5; i++) {
        bool on = (s.fingers & patternMask_ & (1 << i)) != 0;
        write(i, on ? min(level, cfg.maxDuty) : 0);
      }
      return;
    }
  }
  for (uint8_t i = 0; i < 5; i++) {
    bool kicking = target_[i] > 0 && (int32_t)(kickUntil_[i] - now) > 0;
    write(i, kicking ? max(target_[i], cfg.kickDuty) : target_[i]);
  }
}

void Motors::selfTest() {
  for (uint8_t i = 0; i < 5; i++) {
    write(i, cfg.kickDuty);
    delay(25);
    write(i, cfg.maxDuty);
    delay(75);
    write(i, 0);
  }
}
