import struct

import pytest

from lunarhub.protocol import glove as gp


def test_crc8_check_value():
    # CRC-8/ATM (a.k.a. CRC-8/SMBUS) standard check value
    assert gp.crc8(b"123456789") == 0xF4


def test_frame_layout():
    pkt = gp.frame([0, 120, 255, 300, -5], ttl_ms=150, seq=7)
    assert pkt[:2] == gp.SYNC
    assert pkt[2] == gp.PacketType.FRAME and pkt[3] == 7 and pkt[4] == 7
    assert list(pkt[5:10]) == [0, 120, 255, 255, 0]  # clamped
    assert struct.unpack("<H", pkt[10:12])[0] == 150
    assert len(pkt) == 13  # fits the default 20-byte BLE ATT payload


def test_frame_rejects_wrong_motor_count():
    with pytest.raises(ValueError):
        gp.frame([1, 2, 3])


@pytest.mark.parametrize("pkt", [
    gp.frame([1, 2, 3, 4, 5], 200, 1),
    gp.pattern(gp.BuiltinPattern.WAVE, 0x1F, 200, 2),
    gp.stop(3),
    gp.config(70, 180, 20, 255, 300, 4),
    gp.ping(0xDEADBEEF, 5),
])
def test_round_trip(pkt):
    parsed = gp.Parser().feed(pkt)
    assert len(parsed) == 1
    assert gp.encode(parsed[0].type, parsed[0].payload, parsed[0].seq) == pkt


def test_parser_resyncs_after_garbage_and_split_reads():
    a, b = gp.ping(1, 1), gp.stop(2)
    stream = b"\x00\xA5\xFF" + a + b"\x5A\x13" + b
    parser = gp.Parser()
    out = []
    for i in range(0, len(stream), 3):  # deliver in awkward 3-byte chunks
        out += parser.feed(stream[i : i + 3])
    assert [p.type for p in out] == [gp.PacketType.PING, gp.PacketType.STOP]


def test_parser_drops_bad_crc_and_recovers():
    bad = bytearray(gp.ping(9, 1))
    bad[-1] ^= 0xFF
    parser = gp.Parser()
    out = parser.feed(bytes(bad) + gp.stop(2))
    assert [p.type for p in out] == [gp.PacketType.STOP]
    assert parser.crc_errors == 1


def test_parser_waits_for_truncated_packet():
    pkt = gp.frame([9, 9, 9, 9, 9])
    parser = gp.Parser()
    assert parser.feed(pkt[:6]) == []
    assert len(parser.feed(pkt[6:])) == 1


def test_status_and_pong_decoding():
    payload = struct.pack("<BIIBB", 1, 3600, 180000, 42, 1)
    st = gp.parse_status(gp.Parser().feed(gp.encode(gp.PacketType.STATUS, payload))[0].payload)
    assert (st.fw, st.uptime_s, st.frames, st.last_seq) == (1, 3600, 180000, 42)
    assert st.watchdog_tripped
    assert gp.parse_pong(struct.pack("<I", 77)) == 77
