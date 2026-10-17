// Host-side contract test: the firmware parser must accept exactly what the hub's Python codec emits.
// Run: g++ -std=c++17 -I src test/host_protocol_test.cpp -o /tmp/proto_test && /tmp/proto_test < vectors.hex
#include <cstdio>
#include <iostream>
#include <string>
#include <vector>
#include "protocol.h"

int main() {
  std::string line;
  int ok = 0, fail = 0;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    // format: <expected_type_hex> <expected_count> <stream_hex>
    unsigned type = 0, count = 0;
    char hex[4096];
    if (sscanf(line.c_str(), "%x %u %4095s", &type, &count, hex) != 3) continue;
    std::vector<uint8_t> bytes;
    for (size_t i = 0; hex[i] && hex[i + 1]; i += 2) {
      unsigned v;
      sscanf(hex + i, "%2x", &v);
      bytes.push_back((uint8_t)v);
    }
    proto::Parser parser;
    proto::Packet pkt;
    unsigned got = 0, lastType = 0;
    for (uint8_t b : bytes)
      if (parser.push(b, pkt)) { got++; lastType = pkt.type; }
    bool pass = got == count && (count == 0 || lastType == type);
    // re-encode the last packet and compare with the tail of the stream
    if (pass && count) {
      uint8_t out[64];
      size_t n = proto::encode(pkt.type, pkt.seq, pkt.payload, pkt.len, out);
      pass = n <= bytes.size() && memcmp(out, bytes.data() + bytes.size() - n, n) == 0;
    }
    (pass ? ok : fail)++;
    if (!pass) std::cerr << "FAIL: " << line << " got=" << got << "\n";
  }
  printf("%d passed, %d failed\n", ok, fail);
  return fail ? 1 : 0;
}
