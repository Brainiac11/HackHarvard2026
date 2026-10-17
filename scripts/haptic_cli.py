"""Glove bring-up tool: talk to the ESP32 directly (no hub). PLAN.md §5.4.

    uv run --project hub python scripts/haptic_cli.py --serial /dev/ttyUSB0 pattern 1
    uv run --project hub python scripts/haptic_cli.py --serial /dev/ttyUSB0 frame 0,120,0,0,0 --hold 2
    uv run --project hub python scripts/haptic_cli.py --serial /dev/ttyUSB0 sweep 1
    uv run --project hub python scripts/haptic_cli.py --serial /dev/ttyUSB0 calibrate     # writes data/glove_calibration.json
    uv run --project hub python scripts/haptic_cli.py --ble ping
    uv run --project hub python scripts/haptic_cli.py --serial /dev/ttyUSB0 soak 600     # 10-min 50 Hz soak test
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))

from lunarhub.glove.transport import BleTransport, GloveTransport, SerialTransport  # noqa: E402
from lunarhub.protocol import glove as gp  # noqa: E402

FINGERS = ["thumb", "index", "middle", "ring", "pinky"]


async def connect(args) -> tuple[GloveTransport, asyncio.Task]:
    transport: GloveTransport = SerialTransport(args.serial) if args.serial else BleTransport(args.ble_name)
    task = asyncio.create_task(transport.run())
    for _ in range(150):
        if transport.connected:
            await asyncio.sleep(0.3)  # let the ESP32 finish its boot self-test if the port reset it
            return transport, task
        await asyncio.sleep(0.1)
    raise SystemExit(f"could not connect: {transport.detail}")


async def hold_frame(t: GloveTransport, duty: list[int], seconds: float) -> None:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        await t.send_frame(duty, 150)
        await asyncio.sleep(0.02)
    await t.send_frame([0] * 5, 150)


async def cmd_sweep(t: GloveTransport, motor: int, max_duty: int, step: int) -> None:
    print(f"Sweeping {FINGERS[motor]} 0 -> {max_duty}. Note the first duty you can feel.")
    for duty in range(0, max_duty + 1, step):
        frame = [0] * 5
        frame[motor] = duty
        print(f"  duty {duty:3d}", flush=True)
        await hold_frame(t, frame, 0.5)


async def cmd_calibrate(t: GloveTransport, max_duty: int) -> None:
    """Find each motor's dead zone interactively and save it for the hub's perceptual curve."""
    loop = asyncio.get_running_loop()
    mins = []
    for i, name in enumerate(FINGERS):
        print(f"\n{name.upper()}: the motor will ramp up. Press Enter the moment you feel it.")
        await loop.run_in_executor(None, input, "  ready? [Enter] ")
        felt = asyncio.Event()
        loop.run_in_executor(None, lambda: (input(), loop.call_soon_threadsafe(felt.set)))
        duty = 30
        while duty <= max_duty and not felt.is_set():
            frame = [0] * 5
            frame[i] = duty
            await hold_frame(t, frame, 0.25)
            duty += 4
        found = min(duty, max_duty)
        mins.append(found)
        print(f"  {name}: felt at duty {found}")
    path = ROOT / "data" / "glove_calibration.json"
    path.write_text(json.dumps({"min_duty": mins, "max_duty": max_duty, "calibrated_at": time.ctime()}, indent=2))
    print(f"\nSaved {path.relative_to(ROOT)}: min_duty={mins} max_duty={max_duty}")


async def cmd_soak(t: GloveTransport, seconds: int) -> None:
    print(f"Soak: 50 Hz frames for {seconds}s; watching STATUS uptime for resets and BLE drops")
    start = time.monotonic()
    last_uptime, resets, drops, was_connected = None, 0, 0, True
    i = 0
    while time.monotonic() - start < seconds:
        level = 60 + int(60 * (1 + __import__("math").sin(i / 25)))
        await t.send_frame([level] * 5, 150)
        if t.connected != was_connected:
            drops += not t.connected
            was_connected = t.connected
        st = t.status
        if st is not None:
            if last_uptime is not None and st.uptime_s < last_uptime:
                resets += 1
                print(f"  !! ESP32 reset detected (uptime {last_uptime} -> {st.uptime_s})")
            last_uptime = st.uptime_s
        if i % 250 == 0:
            print(f"  t={time.monotonic() - start:5.0f}s rtt={t.rtt_ms} ms uptime={last_uptime} resets={resets} drops={drops}")
        i += 1
        await asyncio.sleep(0.02)
    await t.send_stop()
    print(f"Soak done: resets={resets} drops={drops} -> {'PASS' if not resets and not drops else 'FAIL'}")


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    link = ap.add_mutually_exclusive_group(required=True)
    link.add_argument("--serial", help="serial port, e.g. /dev/ttyUSB0")
    link.add_argument("--ble", action="store_true", help="connect over BLE")
    ap.add_argument("--ble-name", default=gp.BLE_DEVICE_NAME)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pattern"); p.add_argument("id", type=int, help="1=double 2=triple 3=wave 4=warning")
    p.add_argument("--gain", type=int, default=255)
    f = sub.add_parser("frame"); f.add_argument("duty", help="five comma-separated duties 0-255")
    f.add_argument("--hold", type=float, default=1.0)
    s = sub.add_parser("sweep"); s.add_argument("motor", type=int, help="0=thumb .. 4=pinky")
    s.add_argument("--max", type=int, default=180); s.add_argument("--step", type=int, default=10)
    c = sub.add_parser("calibrate"); c.add_argument("--max", type=int, default=180)
    k = sub.add_parser("soak"); k.add_argument("seconds", type=int, nargs="?", default=600)
    sub.add_parser("ping")
    sub.add_parser("stop")
    args = ap.parse_args()

    t, task = await connect(args)
    try:
        if args.cmd == "pattern":
            await t.send(gp.pattern(args.id, 0x1F, args.gain, t.next_seq()))
            await asyncio.sleep(1.0)
        elif args.cmd == "frame":
            await hold_frame(t, [int(x) for x in args.duty.split(",")], args.hold)
        elif args.cmd == "sweep":
            await cmd_sweep(t, args.motor, args.max, args.step)
        elif args.cmd == "calibrate":
            await cmd_calibrate(t, args.max)
        elif args.cmd == "soak":
            await cmd_soak(t, args.seconds)
        elif args.cmd == "ping":
            for _ in range(5):
                await asyncio.sleep(1.1)
                print(f"rtt={t.rtt_ms} ms  status={t.status}")
        elif args.cmd == "stop":
            await t.send_stop()
            await asyncio.sleep(0.2)
    finally:
        task.cancel()


if __name__ == "__main__":
    asyncio.run(main())
