#pragma once
// Glove binary protocol v1 (PLAN.md §4.1). Must match hub/lunarhub/protocol/glove.py.
//   A5 5A | type | seq | len | payload[len] | crc8(type..payload)   CRC-8/ATM poly 0x07 init 0x00
#ifdef ARDUINO
#include <Arduino.h>
#else  // host build for test/host_protocol_test.cpp
#include <cstddef>
#include <cstdint>
#include <cstring>
#endif

namespace proto {

constexpr const char* BLE_NAME = "LunarGlove";
constexpr const char* SERVICE_UUID = "6c756e61-0001-4c48-8000-68617074696b";
constexpr const char* RX_UUID = "6c756e61-0002-4c48-8000-68617074696b";  // hub -> glove (write w/o response)
constexpr const char* TX_UUID = "6c756e61-0003-4c48-8000-68617074696b";  // glove -> hub (notify)

enum Type : uint8_t {
  FRAME = 0x01, PATTERN = 0x02, STOP = 0x03, CONFIG = 0x04, PING = 0x05,
  PONG = 0x81, STATUS = 0x82,
};

static const uint8_t MAX_PAYLOAD = 32;

inline uint8_t crc8(const uint8_t* data, size_t len) {
  uint8_t crc = 0;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (int b = 0; b < 8; b++) crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x07) : (uint8_t)(crc << 1);
  }
  return crc;
}

struct Packet {
  uint8_t type;
  uint8_t seq;
  uint8_t len;
  uint8_t payload[MAX_PAYLOAD];
};

// Byte-at-a-time state machine; resynchronises on the sync word after any error.
class Parser {
 public:
  // Returns true when `out` holds a complete, CRC-valid packet.
  bool push(uint8_t b, Packet& out) {
    switch (state_) {
      case 0: state_ = (b == 0xA5) ? 1 : 0; return false;
      case 1: state_ = (b == 0x5A) ? 2 : (b == 0xA5 ? 1 : 0); return false;
      case 2: pkt_.type = b; state_ = 3; return false;
      case 3: pkt_.seq = b; state_ = 4; return false;
      case 4:
        if (b > MAX_PAYLOAD) { state_ = 0; errors++; return false; }
        pkt_.len = b; idx_ = 0; state_ = b ? 5 : 6; return false;
      case 5:
        pkt_.payload[idx_++] = b;
        if (idx_ >= pkt_.len) state_ = 6;
        return false;
      case 6: {
        state_ = 0;
        uint8_t body[3 + MAX_PAYLOAD];
        body[0] = pkt_.type; body[1] = pkt_.seq; body[2] = pkt_.len;
        memcpy(body + 3, pkt_.payload, pkt_.len);
        if (crc8(body, 3 + pkt_.len) != b) { errors++; return false; }
        out = pkt_;
        return true;
      }
    }
    state_ = 0;
    return false;
  }
  uint32_t errors = 0;

 private:
  uint8_t state_ = 0, idx_ = 0;
  Packet pkt_{};
};

inline size_t encode(uint8_t type, uint8_t seq, const uint8_t* payload, uint8_t len, uint8_t* out) {
  out[0] = 0xA5; out[1] = 0x5A; out[2] = type; out[3] = seq; out[4] = len;
  if (len) memcpy(out + 5, payload, len);
  out[5 + len] = crc8(out + 2, 3 + len);
  return 6 + len;
}

}  // namespace proto
