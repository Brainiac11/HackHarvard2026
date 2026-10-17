"""Haptic distinguishability test (PLAN.md §13): can a person tell the sensations apart?

Plays the REAL engine output for each stimulus on the glove, in random order, and asks the wearer to
identify it. Target: >= 85 % correct. Results append to data/abx_results.csv (used in the pitch).

    uv run --project hub python scripts/haptic_abx.py --serial /dev/ttyUSB0 --name alex --trials 20
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

from lunarhub.glove.transport import BleTransport, SerialTransport  # noqa: E402
from lunarhub.haptics import patterns  # noqa: E402
from lunarhub.haptics.engine import HapticEngine  # noqa: E402
from lunarhub.protocol.messages import DrillState, RoverState, SimState, TerrainState, Wheel  # noqa: E402

STIMULI = {
    "1": ("soft drilling", "drill", SimState(mode="drill", drill=DrillState(held=True, trigger=1, contact=True,
                                                                             hardness=0.25, target="soft"))),
    "2": ("hard drilling", "drill", SimState(mode="drill", drill=DrillState(held=True, trigger=1, contact=True,
                                                                             hardness=0.9, target="hard"))),
    "3": ("rover, smooth & slow", "rover", SimState(mode="rover", rover=RoverState(speed=1.2, rough=0.05),
                                                    terrain=TerrainState(lola_slope_deg=3))),
    "4": ("rover, rough left side", "rover", SimState(mode="rover", rover=RoverState(
        speed=3.0, rough=0.8, wheels=[Wheel(vel=0.9), Wheel(vel=0.05), Wheel(vel=0.8), Wheel(vel=0.05)]),
        terrain=TerrainState(lola_slope_deg=5))),
    "5": ("warning", None, None),
}
DURATION_S = 2.5


async def play(engine: HapticEngine, transport, key: str) -> None:
    _, equipment, state = STIMULI[key]
    engine.stop_all()
    engine.set_active_equipment(equipment)
    engine.update_state(state or SimState())
    if key == "5":
        engine.play(patterns.warning("ui.test"))
    end = time.monotonic() + DURATION_S
    while time.monotonic() < end:
        out = engine.tick(0.01)
        out = engine.tick(0.01)
        await transport.send_frame(out.duty, 150)
        await asyncio.sleep(0.02)
    await transport.send_frame([0] * 5, 150)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--serial")
    ap.add_argument("--ble", action="store_true")
    ap.add_argument("--name", required=True)
    ap.add_argument("--trials", type=int, default=20)
    args = ap.parse_args()
    transport = SerialTransport(args.serial) if args.serial else BleTransport()
    task = asyncio.create_task(transport.run())
    while not transport.connected:
        await asyncio.sleep(0.1)
    engine = HapticEngine(seed=int(time.time()))
    loop = asyncio.get_running_loop()

    print("Training: each sensation once.")
    for key, (label, _, _) in STIMULI.items():
        print(f"  [{key}] {label}")
        await play(engine, transport, key)
        await asyncio.sleep(0.8)

    keys = list(STIMULI) * ((args.trials + len(STIMULI) - 1) // len(STIMULI))
    random.shuffle(keys)
    keys = keys[: args.trials]
    correct, rows = 0, []
    menu = "  ".join(f"{k}={v[0]}" for k, v in STIMULI.items())
    for i, key in enumerate(keys, 1):
        await loop.run_in_executor(None, input, f"\nTrial {i}/{len(keys)} - press Enter to feel it ")
        await play(engine, transport, key)
        answer = (await loop.run_in_executor(None, input, f"What was it? {menu}\n> ")).strip()
        ok = answer == key
        correct += ok
        rows.append([time.strftime("%Y-%m-%d %H:%M:%S"), args.name, i, STIMULI[key][0],
                     STIMULI.get(answer, ("?",))[0], int(ok)])
        print("  correct" if ok else f"  it was: {STIMULI[key][0]}")
    path = ROOT / "data" / "abx_results.csv"
    new = not path.exists()
    with path.open("a", newline="") as fh:
        w = csv.writer(fh)
        if new:
            w.writerow(["time", "subject", "trial", "stimulus", "answer", "correct"])
        w.writerows(rows)
    print(f"\n{args.name}: {correct}/{len(keys)} = {100 * correct / len(keys):.0f}% (target >= 85%)  -> {path.name}")
    task.cancel()


if __name__ == "__main__":
    asyncio.run(main())
