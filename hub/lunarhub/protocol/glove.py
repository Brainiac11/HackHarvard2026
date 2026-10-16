"""Glove binary protocol v1 (PLAN.md §4.1). Identical bytes over BLE and USB serial.

    +------+------+------+-----+-----+--------------+------+
    | 0xA5 | 0x5A | type | seq | len | payload[len] | crc8 |
    +------+------+------+-----+-----+--------------+------+

CRC-8/ATM (poly 0x07, init 0x00) over type..payload. Integers little-endian.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from enum import IntEnum
from typing import Sequence

SYNC = b"\xA5\x5A"
NUM_MOTORS = 5
MAX_PAYLOAD = 32

# BLE GATT identifiers (must match firmware/glove/src/protocol.h)
BLE_DEVICE_NAME = "LunarGlove"
BLE_SERVICE_UUID = "6c756e61-0001-4c48-8000-68617074696b"
BLE_RX_UUID = "6c756e61-0002-4c48-8000-68617074696b"  # hub -> glove, write without response
BLE_TX_UUID = "6c756e61-0003-4c48-8000-68617074696b"  # glove -> hub, notify


class PacketType(IntEnum):
    FRAME = 0x01
    PATTERN = 0x02
    STOP = 0x03
    CONFIG = 0x04
    PING = 0x05
    PONG = 0x81
    STATUS = 0x82


class BuiltinPattern(IntEnum):
    DOUBLE = 1
    TRIPLE = 2
    WAVE = 3
    WARNING = 4


def crc8(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


@dataclass(frozen=True)
class Packet:
    type: int
    seq: int
    payload: bytes


def encode(ptype: int, payload: bytes = b"", seq: int = 0) -> bytes:
    if len(payload) > MAX_PAYLOAD:
        raise ValueError(f"payload too long: {len(payload)}")
    body = bytes([ptype & 0xFF, seq & 0xFF, len(payload)]) + payload
    return SYNC + body + bytes([crc8(body)])


def frame(duty: Sequence[int], ttl_ms: int = 150, seq: int = 0) -> bytes:
    if len(duty) != NUM_MOTORS:
        raise ValueError(f"expected {NUM_MOTORS} duties, got {len(duty)}")
    clamped = bytes(max(0, min(255, int(d))) for d in duty)
    return encode(PacketType.FRAME, clamped + struct.pack("<H", max(0, min(0xFFFF, ttl_ms))), seq)


def pattern(pattern_id: int, mask: int = 0x1F, gain: int = 255, seq: int = 0) -> bytes:
    return encode(PacketType.PATTERN, bytes([pattern_id & 0xFF, mask & 0x1F, gain & 0xFF]), seq)


def stop(seq: int = 0) -> bytes:
    return encode(PacketType.STOP, b"", seq)


def config(min_duty: int, max_duty: int, kick_ms: int, kick_duty: int, watchdog_ms: int, seq: int = 0) -> bytes:
    payload = bytes([min_duty & 0xFF, max_duty & 0xFF, kick_ms & 0xFF, kick_duty & 0xFF])
    return encode(PacketType.CONFIG, payload + struct.pack("<H", watchdog_ms & 0xFFFF), seq)


def ping(nonce: int, seq: int = 0) -> bytes:
    return encode(PacketType.PING, struct.pack("<I", nonce & 0xFFFFFFFF), seq)


@dataclass(frozen=True)
class Status:
    fw: int
    uptime_s: int
    frames: int
    last_seq: int
    flags: int

    @property
    def watchdog_tripped(self) -> bool:
        return bool(self.flags & 0x01)


def parse_status(payload: bytes) -> Status:
    fw, uptime, frames, last_seq, flags = struct.unpack("<BIIBB", payload[:11])
    return Status(fw, uptime, frames, last_seq, flags)


def parse_pong(payload: bytes) -> int:
    return struct.unpack("<I", payload[:4])[0]


class Parser:
    """Incremental byte-stream parser; resynchronises on the A5 5A sync word."""

    def __init__(self) -> None:
        self._buf = bytearray()
        self.crc_errors = 0

    def feed(self, data: bytes) -> list[Packet]:
        self._buf.extend(data)
        packets: list[Packet] = []
        while True:
            start = self._buf.find(SYNC)
            if start < 0:
                # keep a trailing 0xA5 in case the sync word is split across reads
                del self._buf[: max(0, len(self._buf) - 1)]
                return packets
            if start:
                del self._buf[:start]
            if len(self._buf) < 5:
                return packets
            length = self._buf[4]
            if length > MAX_PAYLOAD:
                del self._buf[:2]  # corrupt header; skip this sync word
                continue
            total = 2 + 3 + length + 1
            if len(self._buf) < total:
                return packets
            body = bytes(self._buf[2 : 5 + length])
            if crc8(body) == self._buf[5 + length]:
                packets.append(Packet(body[0], body[1], body[3:]))
                del self._buf[:total]
            else:
                self.crc_errors += 1
                del self._buf[:2]
