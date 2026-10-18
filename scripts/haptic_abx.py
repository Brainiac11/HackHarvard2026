"""Haptic distinguishability test (PLAN.md §13): can a person tell the sensations apart?

Plays the REAL engine output for each stimulus on the glove, in random order, and asks the wearer to
identify it. Target: >= 85 % correct. Results append to data/abx_results.csv (used in the pitch).

    uv run --project hub python scripts/haptic_abx.py --serial /dev/ttyUSB0 --name alex --trials 20
    uv run --project hub python scripts/haptic_abx.py --espcmd --name alex --set alerts   # ESPcmd sketch over BLE

Sets: core (default: the two drill textures, two rover textures and both alerts), drill, rover, alerts, ui.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import random
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))

from lunarhub.glove.transport import BleTransport, EspCmdTransport, SerialTransport  # noqa: E402
from lunarhub.haptics import patterns  # noqa: E402
from lunarhub.haptics.engine import HapticEngine  # noqa: E402
from lunarhub.protocol.messages import DrillState, RoverState, SimState, TerrainState, Wheel  # noqa: E402


def drill(hardness: float, contact: bool = True) -> SimState:
    return SimState(mode="drill", drill=DrillState(held=True, trigger=1, contact=contact, hardness=hardness,
                                                   target="hard" if hardness >= 0.5 else "soft"))


def rover(speed: float, rough: float = 0.0, wheels=(0.0, 0.0, 0.0, 0.0)) -> SimState:
    return SimState(mode="rover", rover=RoverState(speed=speed, rough=rough, wheels=[Wheel(vel=v) for v in wheels]),
                    terrain=TerrainState(lola_slope_deg=3))


# label -> (equipment, continuous state) or (None, test pattern name); patterns play alone on an idle glove
STIMULI = {
    "free spin": ("drill", drill(0.0, contact=False)),
    "soft drilling": ("drill", drill(0.25)),
    "hard drilling": ("drill", drill(0.9)),
    "rover, smooth & slow": ("rover", rover(1.2, 0.05)),
    "rover, smooth & fast": ("rover", rover(3.8, 0.05)),
    "rover, rough left side": ("rover", rover(3.0, 0.8, (0.9, 0.05, 0.8, 0.05))),
    "rover, rough right side": ("rover", rover(3.0, 0.8, (0.05, 0.9, 0.05, 0.8))),
    "stall alert": (None, "stall"), "slope alert": (None, "slope"), "breakthrough": (None, "breakthrough"),
    "impact left": (None, "impact_left"), "impact right": (None, "impact_right"),
    "auth double": (None, "double"), "auth triple": (None, "triple"), "auth wave": (None, "wave"),
    "drill selected": (None, "equipment_drill"), "rover selected": (None, "equipment_rover"),
    "confirm": (None, "confirm"), "setting up": (None, "setting_up"), "setting down": (None, "setting_down"),
    "denied": (None, "denied"),
}
SETS = {
    "core": ["soft drilling", "hard drilling", "rover, smooth & slow", "rover, rough left side", "stall alert",
             "slope alert"],
    "drill": ["free spin", "soft drilling", "hard drilling", "stall alert", "breakthrough"],
    "rover": ["rover, smooth & slow", "rover, smooth & fast", "rover, rough left side", "rover, rough right side",
              "impact left", "slope alert"],
    "alerts": ["stall alert", "slope alert", "breakthrough", "impact left", "impact right"],
    "ui": ["auth double", "auth triple", "auth wave", "drill selected", "rover selected", "confirm", "setting up",
           "setting down", "denied"],
}
DURATION_S = 2.5


async def play(engine: HapticEngine, transport, label: str) -> None:
    equipment, what = STIMULI[label]
    engine.stop_all()
    engine.set_active_equipment(equipment)
    engine.update_state(what if equipment else SimState())
    seconds = DURATION_S
    if equipment is None:
        pattern = patterns.TEST_PATTERNS[what]()
        engine.play(pattern)
        seconds = pattern.duration_s + 0.3
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        out = engine.tick(0.01)
        out = engine.tick(0.01)
        await transport.send_frame(out.duty, 150)
        await asyncio.sleep(0.02)
    await transport.send_frame([0] * 5, 150)


async def main() -> None:
    ap = argparse.ArgumentParser()
    link = ap.add_mutually_exclusive_group()
    link.add_argument("--serial")
    link.add_argument("--ble", action="store_true")
    link.add_argument("--espcmd", action="store_true", help="the ESPcmd text-command sketch (bluetooth_ESP32/)")
    ap.add_argument("--name", required=True)
    ap.add_argument("--trials", type=int, default=20)
    ap.add_argument("--set", choices=sorted(SETS), default="core")
    args = ap.parse_args()
    transport = (SerialTransport(args.serial) if args.serial else EspCmdTransport() if args.espcmd
                 else BleTransport())
    task = asyncio.create_task(transport.run())
    while not transport.connected:
        await asyncio.sleep(0.1)
    engine = HapticEngine(seed=int(time.time()))
    loop = asyncio.get_running_loop()

    choices = {str(i): label for i, label in enumerate(SETS[args.set], 1)}
    print(f"Training ({args.set}): each sensation once.")
    for key, label in choices.items():
        print(f"  [{key}] {label}")
        await play(engine, transport, label)
        await asyncio.sleep(0.8)

    keys = list(choices) * ((args.trials + len(choices) - 1) // len(choices))
    random.shuffle(keys)
    keys = keys[: args.trials]
    correct, rows = 0, []
    menu = "  ".join(f"{k}={v}" for k, v in choices.items())
    for i, key in enumerate(keys, 1):
        await loop.run_in_executor(None, input, f"\nTrial {i}/{len(keys)} - press Enter to feel it ")
        await play(engine, transport, choices[key])
        answer = (await loop.run_in_executor(None, input, f"What was it? {menu}\n> ")).strip()
        ok = answer == key
        correct += ok
        rows.append([time.strftime("%Y-%m-%d %H:%M:%S"), args.name, i, choices[key], choices.get(answer, "?"),
                     int(ok)])
        print("  correct" if ok else f"  it was: {choices[key]}")
    path = ROOT / "data" / "abx_results.csv"
    new = not path.exists()
    with path.open("a", newline="") as fh:
        w = csv.writer(fh)
        if new:
            w.writerow(["time", "subject", "trial", "stimulus", "answer", "correct"])
        w.writerows(rows)
    print(f"\n{args.name}: {correct}/{len(keys)} = {100 * correct / len(keys):.0f}% (target >= 85%)  -> {path.name}")
    await transport.send_stop()  # ESPcmd has no watchdog: flush the stop before the writer goes away
    task.cancel()


if __name__ == "__main__":
    asyncio.run(main())
