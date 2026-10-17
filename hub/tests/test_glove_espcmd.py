"""Temporary ESPcmd text-command link (bluetooth_ESP32/ESP32_HackHarvard.ino), driven through a fake BLE client."""

import asyncio

import bleak
import pytest

from lunarhub.glove.transport import ESPCMD_COMMAND_UUID, EspCmdTransport, espcmd_command, make_transport


class FakeClient:
    """Write with response: each write takes a couple of connection intervals."""

    instance: "FakeClient"

    def __init__(self, device, disconnected_callback=None) -> None:
        self.writes: list[str] = []
        self.disconnect = lambda: disconnected_callback(self)
        FakeClient.instance = self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def write_gatt_char(self, uuid, data, response):
        assert uuid == ESPCMD_COMMAND_UUID and response
        await asyncio.sleep(0.03)
        self.writes.append(data.decode())


class FakeScanner:
    @staticmethod
    async def find_device_by_name(name, timeout):
        return type("Device", (), {"address": "AA:BB:CC:DD:EE:FF", "name": name})()


@pytest.fixture
async def glove(monkeypatch):
    monkeypatch.setattr(bleak, "BleakClient", FakeClient)
    monkeypatch.setattr(bleak, "BleakScanner", FakeScanner)
    t = make_transport("espcmd")
    task = asyncio.create_task(t.run())
    for _ in range(50):
        if t.connected:
            break
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.05)  # initial sync of the motors to the idle frame
    yield t, FakeClient.instance
    task.cancel()


def test_command_format_fits_the_characteristic():
    assert espcmd_command([0, 120, 255, 300, -5]) == "0 120 255 255 0"
    assert len(espcmd_command([255] * 5).encode()) <= 20


async def test_streams_latest_frame_without_backlog(glove):
    t, client = glove
    assert isinstance(t, EspCmdTransport) and client.writes == ["0 0 0 0 0"]
    frames = [[i * 10, 0, 0, 0, 200] for i in range(1, 16)]
    for duty in frames:  # 50 Hz, faster than writes complete
        await t.send_frame(duty)
        await asyncio.sleep(0.02)
    await asyncio.sleep(0.1)
    sent = client.writes[1:]
    assert sent[-1] == espcmd_command(frames[-1])
    assert len(sent) < len(frames) and all(s in {espcmd_command(f) for f in frames} for s in sent)
    assert t.rtt_ms is not None


async def test_unchanged_frames_are_not_resent(glove):
    t, client = glove
    for _ in range(10):
        await t.send_frame([90, 90, 90, 90, 90])
        await asyncio.sleep(0.02)
    await asyncio.sleep(0.05)
    assert client.writes == ["0 0 0 0 0", "90 90 90 90 90"]


async def test_stop_is_sent_immediately_and_disconnect_is_noticed(glove):
    t, client = glove
    await t.send_frame([200] * 5)
    await asyncio.sleep(0.05)
    await t.send_stop()
    assert client.writes[-1] == "0 0 0 0 0"
    client.disconnect()
    await asyncio.sleep(0)
    assert not t.connected
    await t.send_frame([200] * 5)
    await asyncio.sleep(0.05)
    assert client.writes[-1] == "0 0 0 0 0"
