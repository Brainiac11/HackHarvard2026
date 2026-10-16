"""NFC identity readers (PLAN.md §6). Backends: pcsc | hid | serial | none, plus `auto` detection.

Every backend calls `on_uid(uid: str)` from the asyncio loop. Scans are debounced per UID.
The keyboard fallback (sim `N` key) and scripts/fake_nfc.py go through the hub API instead.
"""

from __future__ import annotations

import asyncio
import glob
import logging
import time
from typing import Callable

log = logging.getLogger("lunarhub.nfc")
DEBOUNCE_S = 1.5
GET_UID_APDU = [0xFF, 0xCA, 0x00, 0x00, 0x00]


class NfcService:
    def __init__(self, spec: str, on_uid: Callable[[str], None]) -> None:
        self.spec = spec
        self._on_uid = on_uid
        self.backend = "none"
        self.reader = ""
        self.error = ""
        self._last: dict[str, float] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    def view(self) -> dict:
        return {"backend": self.backend, "reader": self.reader, "error": self.error}

    def emit(self, uid: str) -> None:
        """Debounced delivery; safe to call from the event loop."""
        now = time.monotonic()
        if now - self._last.get(uid, -1e9) < DEBOUNCE_S:
            return
        self._last[uid] = now
        log.info("NFC scan %s via %s", uid, self.backend)
        self._on_uid(uid)

    def _emit_threadsafe(self, uid: str) -> None:
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self.emit, uid)

    async def run(self) -> None:
        self._loop = asyncio.get_running_loop()
        kind, _, arg = self.spec.partition(":")
        if kind == "none":
            self.backend = "none"
            return
        if kind in ("auto", "pcsc") and await self._try_pcsc():
            return
        if kind in ("auto", "hid") and await self._try_hid(arg or None):
            return
        if kind == "serial":
            await self._run_serial(arg)
            return
        self.backend = "keyboard-only"
        if not self.error:
            self.error = "no reader detected; use the N key or scripts/fake_nfc.py"
        log.warning("NFC: %s", self.error)

    # ------------------------------------------------------------- PC/SC (ACR122U etc.)
    async def _try_pcsc(self) -> bool:
        try:
            from smartcard.CardMonitoring import CardMonitor, CardObserver
            from smartcard.System import readers
            from smartcard.util import toHexString
        except ImportError:
            self.error = "pyscard not installed (uv sync --extra nfc)"
            return False
        try:
            found = readers()
        except Exception as exc:
            self.error = f"PC/SC unavailable: {exc}"
            return False
        if not found:
            return False
        service = self

        class Observer(CardObserver):
            def update(self, observable, actions):
                added, _removed = actions
                for card in added:
                    try:
                        conn = card.createConnection()
                        conn.connect()
                        data, sw1, sw2 = conn.transmit(GET_UID_APDU)
                        if (sw1, sw2) == (0x90, 0x00):
                            service._emit_threadsafe(toHexString(data).replace(" ", ""))
                    except Exception as exc:
                        log.warning("PC/SC read failed: %s", exc)

        self.backend, self.reader, self.error = "pcsc", str(found[0]), ""
        monitor = CardMonitor()
        monitor.addObserver(Observer())
        log.info("NFC: PC/SC reader %s", self.reader)
        return True

    # ------------------------------------------------------------- keyboard-wedge readers
    async def _try_hid(self, path: str | None) -> bool:
        try:
            import evdev
        except ImportError:
            return False
        candidates = [path] if path else sorted(
            p for p in glob.glob("/dev/input/by-id/*-event-kbd")
            if any(k in p.lower() for k in ("rfid", "nfc", "reader", "card", "125khz", "id_"))
        )
        for p in candidates:
            try:
                dev = evdev.InputDevice(p)
                dev.grab()  # exclusive: stop the UID being "typed" into the browser
            except Exception as exc:
                self.error = f"cannot open {p}: {exc}"
                continue
            self.backend, self.reader, self.error = "hid", dev.name, ""
            log.info("NFC: keyboard-wedge reader %s (%s)", dev.name, p)
            asyncio.get_running_loop().create_task(self._run_hid(dev, evdev))
            return True
        return False

    async def _run_hid(self, dev, evdev) -> None:
        keymap = {getattr(evdev.ecodes, f"KEY_{c}"): c for c in "0123456789ABCDEF"}
        buf: list[str] = []
        async for event in dev.async_read_loop():
            if event.type != evdev.ecodes.EV_KEY or event.value != 1:  # key down only
                continue
            if event.code in (evdev.ecodes.KEY_ENTER, evdev.ecodes.KEY_KPENTER):
                if buf:
                    self.emit("".join(buf))
                buf = []
            elif event.code in keymap:
                buf.append(keymap[event.code])

    # ------------------------------------------------------------- serial modules
    async def _run_serial(self, port: str) -> None:
        import serial

        self.backend, self.reader = "serial", port
        while True:
            try:
                ser = serial.Serial(port, 115200, timeout=0.2)
                self.error = ""
                while True:
                    line = (await asyncio.to_thread(ser.readline)).decode(errors="ignore").strip()
                    if line.upper().startswith("UID:"):
                        self.emit(line[4:].strip())
            except Exception as exc:
                self.error = f"{port}: {exc}"
                await asyncio.sleep(2.0)
