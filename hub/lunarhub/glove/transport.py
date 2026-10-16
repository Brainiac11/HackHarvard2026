"""Glove transports: null (simulated), USB serial, BLE. Same packet bytes on every link (PLAN.md §4.1).

Each transport runs a supervised `run()` loop that (re)connects forever with backoff, and exposes
`send()`, which silently drops packets while disconnected (the firmware watchdog keeps motors safe).
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from abc import ABC, abstractmethod

from ..protocol import glove as gp

log = logging.getLogger("lunarhub.glove")
PING_INTERVAL_S = 1.0
BACKOFF_S = (1.0, 2.0, 4.0, 5.0)


class GloveTransport(ABC):
    name = "base"

    def __init__(self) -> None:
        self.connected = False
        self.rtt_ms: float | None = None
        self.status: gp.Status | None = None
        self.tx_packets = 0
        self.detail = ""
        self._parser = gp.Parser()
        self._seq = 0
        self._pings: dict[int, float] = {}

    def next_seq(self) -> int:
        self._seq = (self._seq + 1) & 0xFF
        return self._seq

    async def send_frame(self, duty: list[int], ttl_ms: int = 150) -> None:
        await self.send(gp.frame(duty, ttl_ms, self.next_seq()))

    async def send_stop(self) -> None:
        await self.send(gp.stop(self.next_seq()))

    async def send(self, packet: bytes) -> None:
        if not self.connected:
            return
        try:
            await self._write(packet)
            self.tx_packets += 1
        except Exception as exc:  # link dropped mid-write; run() will reconnect
            log.warning("%s write failed: %s", self.name, exc)
            self.connected = False

    def on_bytes(self, data: bytes) -> None:
        for pkt in self._parser.feed(data):
            if pkt.type == gp.PacketType.PONG:
                sent = self._pings.pop(gp.parse_pong(pkt.payload), None)
                if sent is not None:
                    self.rtt_ms = round((time.monotonic() - sent) * 1000, 1)
            elif pkt.type == gp.PacketType.STATUS:
                self.status = gp.parse_status(pkt.payload)

    async def _ping_loop(self) -> None:
        while self.connected:
            nonce = random.getrandbits(32)
            self._pings = {k: v for k, v in self._pings.items() if time.monotonic() - v < 5}
            self._pings[nonce] = time.monotonic()
            await self.send(gp.ping(nonce, self.next_seq()))
            await asyncio.sleep(PING_INTERVAL_S)

    def view(self) -> dict:
        st = self.status
        return {"transport": self.name, "connected": self.connected, "rtt_ms": self.rtt_ms, "detail": self.detail,
                "fw": st.fw if st else None, "uptime_s": st.uptime_s if st else None}

    @abstractmethod
    async def run(self) -> None: ...

    @abstractmethod
    async def _write(self, packet: bytes) -> None: ...


class NullTransport(GloveTransport):
    """No hardware: keeps the last frame so the HUD/tests can see what would be sent."""

    name = "null"

    def __init__(self) -> None:
        super().__init__()
        self.last_packet: bytes | None = None
        self.detail = "simulated glove (no hardware)"

    async def run(self) -> None:
        self.connected = True
        await asyncio.Event().wait()

    async def _write(self, packet: bytes) -> None:
        self.last_packet = packet


class SerialTransport(GloveTransport):
    name = "serial"

    def __init__(self, port: str, baud: int = 921600) -> None:
        super().__init__()
        self.port, self.baud = port, baud
        self._ser = None

    async def run(self) -> None:
        import serial  # pyserial

        attempt = 0
        while True:
            try:
                self._ser = serial.Serial(self.port, self.baud, timeout=0.05, write_timeout=0.05)
                self.connected, attempt = True, 0
                self.detail = self.port
                log.info("serial glove connected on %s", self.port)
                pinger = asyncio.create_task(self._ping_loop())
                try:
                    while self.connected:
                        data = await asyncio.to_thread(self._ser.read, 256)
                        if data:
                            self.on_bytes(data)
                finally:
                    pinger.cancel()
            except Exception as exc:
                self.detail = f"{self.port}: {exc}"
                log.warning("serial glove: %s", exc)
            finally:
                self.connected = False
                if self._ser is not None:
                    try:
                        self._ser.close()
                    except Exception:
                        pass
            await asyncio.sleep(BACKOFF_S[min(attempt, len(BACKOFF_S) - 1)])
            attempt += 1

    async def _write(self, packet: bytes) -> None:
        self._ser.write(packet)


class BleTransport(GloveTransport):
    name = "ble"

    def __init__(self, device_name: str = gp.BLE_DEVICE_NAME) -> None:
        super().__init__()
        self.device_name = device_name
        self._client = None

    async def run(self) -> None:
        from bleak import BleakClient, BleakScanner

        attempt = 0
        while True:
            try:
                self.detail = f"scanning for {self.device_name}"
                device = await BleakScanner.find_device_by_name(self.device_name, timeout=5.0)
                if device is None:
                    raise RuntimeError(f"{self.device_name} not found")
                lost = asyncio.Event()
                async with BleakClient(device, disconnected_callback=lambda _c: lost.set()) as client:
                    self._client = client
                    await client.start_notify(gp.BLE_TX_UUID, lambda _h, data: self.on_bytes(bytes(data)))
                    self.connected, attempt = True, 0
                    self.detail = f"{device.address}"
                    log.info("BLE glove connected: %s", device.address)
                    pinger = asyncio.create_task(self._ping_loop())
                    try:
                        await lost.wait()
                    finally:
                        pinger.cancel()
            except Exception as exc:
                self.detail = str(exc)
                log.warning("BLE glove: %s", exc)
            finally:
                self.connected = False
                self._client = None
            await asyncio.sleep(BACKOFF_S[min(attempt, len(BACKOFF_S) - 1)])
            attempt += 1

    async def _write(self, packet: bytes) -> None:
        await self._client.write_gatt_char(gp.BLE_RX_UUID, packet, response=False)


def make_transport(spec: str) -> GloveTransport:
    """'null' | 'ble' | 'ble:<name>' | 'serial:<port>'."""
    kind, _, arg = spec.partition(":")
    if kind == "null":
        return NullTransport()
    if kind == "ble":
        return BleTransport(arg or gp.BLE_DEVICE_NAME)
    if kind == "serial":
        if not arg:
            raise ValueError("serial transport needs a port, e.g. serial:/dev/ttyUSB0")
        return SerialTransport(arg)
    raise ValueError(f"unknown glove transport '{spec}'")
