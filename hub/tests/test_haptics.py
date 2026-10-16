import numpy as np
import pytest

from lunarhub.haptics import patterns
from lunarhub.haptics.effects import Keyframes, N
from lunarhub.haptics.engine import DUCK_FACTOR, HapticEngine, OutputCalibration, ShapingProfile, soft_sum
from lunarhub.haptics.vocabulary import MEANINGS
from lunarhub.protocol.messages import DrillState, RoverState, SimEvent, SimState, TerrainState, Wheel

DT = 0.01


def run(engine: HapticEngine, seconds: float) -> list:
    return [engine.tick(DT) for _ in range(int(round(seconds / DT)))]


def drilling(hardness: float, stalled: bool = False) -> SimState:
    target = "hard" if hardness >= 0.5 else "soft"
    return SimState(mode="drill", drill=DrillState(held=True, trigger=1.0, target=target, contact=True,
                                                   hardness=hardness, stalled=stalled))


def driving(speed: float, rough: float = 0.0, slope: float | None = 5.0, wheel_vel=(0, 0, 0, 0)) -> SimState:
    return SimState(mode="rover",
                    rover=RoverState(speed=speed, rough=rough, wheels=[Wheel(vel=v) for v in wheel_vel]),
                    terrain=TerrainState(lola_slope_deg=slope))


def engine_with(state: SimState, equipment: str, seed: int = 1) -> HapticEngine:
    e = HapticEngine(seed=seed)
    e.set_active_equipment(equipment)
    e.update_state(state)
    return e


# ---------------------------------------------------------------- compositor basics

def test_soft_sum_never_exceeds_one():
    v = soft_sum([np.full(N, 0.9), np.full(N, 0.9), np.full(N, 0.9)])
    assert np.all(v <= 1.0) and np.all(v > 0.99)


def test_idle_is_silent():
    e = HapticEngine()
    outs = run(e, 0.5)
    assert all(o.duty == [0] * N for o in outs)


def test_perceptual_curve_endpoints():
    cal = OutputCalibration(min_duty=[60, 70, 80, 90, 100], max_duty=180)
    assert cal.to_duty(np.zeros(N)) == [0] * N
    assert cal.to_duty(np.full(N, 0.02)) == [0] * N  # below silence threshold
    assert cal.to_duty(np.ones(N)) == [180] * N
    low = cal.to_duty(np.full(N, 0.05))
    assert low == sorted(low) and low[0] >= 60  # starts at each motor's dead zone


def test_seeded_determinism():
    a = [o.duty for o in run(engine_with(drilling(0.9), "drill", seed=5), 1.0)]
    b = [o.duty for o in run(engine_with(drilling(0.9), "drill", seed=5), 1.0)]
    assert a == b


# ---------------------------------------------------------------- patterns

def test_double_pulse_timing():
    e = HapticEngine()
    e.play(patterns.double())
    outs = run(e, 0.4)
    on = [o.levels.max() > 0 for o in outs]
    # 80 ms on, 90 ms off, 80 ms on, then silent (±1 tick)
    assert sum(on[:8]) == 8 and not any(on[9:16]) and sum(on[17:25]) >= 7 and not any(on[27:])


def test_every_pattern_meaning_is_in_vocabulary():
    pats: list[Keyframes] = [patterns.double(), patterns.triple(), patterns.wave(), patterns.equipment_drill(),
                             patterns.equipment_rover(), patterns.confirm(), patterns.setting_up(),
                             patterns.setting_down(), patterns.denied(), patterns.warning("alert.slope"),
                             patterns.warning("alert.drill_stall"), patterns.impact("left"),
                             patterns.impact("right"), patterns.breakthrough(),
                             *(f() for f in patterns.TEST_PATTERNS.values())]
    for p in pats:
        assert p.meaning in MEANINGS, p.meaning


def test_alert_ducks_base_layer():
    e = engine_with(driving(3.0), "rover")
    base = run(e, 0.3)[-1].levels.mean()
    e.play(patterns.warning("alert.slope"))
    first = e.tick(DT)
    assert first.alert_active and first.levels.min() > 0.9  # warning dominates
    # during the warning's off-gap the rumble continues but ducked
    gap = run(e, 0.2)[-1]
    assert gap.alert_active
    assert gap.levels.mean() <= base * DUCK_FACTOR + 0.05


# ---------------------------------------------------------------- drill mapper

def test_hard_vs_soft_contrast():
    soft = run(engine_with(drilling(0.25), "drill"), 2.0)
    hard = run(engine_with(drilling(0.9), "drill"), 2.0)
    soft_mean = np.mean([o.levels.mean() for o in soft])
    hard_mean = np.mean([o.levels.mean() for o in hard])
    assert hard_mean >= 1.6 * soft_mean
    # hard must feel irregular, soft steady
    assert np.std([o.levels.mean() for o in hard]) > 3 * np.std([o.levels.mean() for o in soft])
    assert soft[-1].dominant == "drill.soft" and hard[-1].dominant == "drill.hard"


def test_drill_silent_when_not_active_equipment():
    outs = run(engine_with(drilling(0.9), "rover"), 0.3)
    assert all(o.duty == [0] * N for o in outs)


def test_stall_alert_fires_once_per_episode():
    e = engine_with(drilling(0.9, stalled=True), "drill")
    run(e, 3.0)
    stalls = [ev for ev in e.recent if ev.meaning == "alert.drill_stall"]
    assert len(stalls) == 1
    e.update_state(drilling(0.9, stalled=False))
    run(e, 0.2)
    e.update_state(drilling(0.9, stalled=True))
    run(e, 1.0)
    assert len([ev for ev in e.recent if ev.meaning == "alert.drill_stall"]) == 2


def test_localized_mapping_emphasises_trigger_fingers():
    e = engine_with(drilling(0.25), "drill")
    e.set_profile(ShapingProfile(drill={"sensitivity": 1.0, "mapping": "localized"}))
    lv = np.mean([o.levels for o in run(e, 1.0)], axis=0)
    assert lv[1] > 2 * lv[0] and lv[2] > 2 * lv[4]


def test_drill_sensitivity_scales_output():
    lo = engine_with(drilling(0.25), "drill")
    lo.set_profile(ShapingProfile(drill={"sensitivity": 0.5, "mapping": "resistance"}))
    hi = engine_with(drilling(0.25), "drill")
    hi.set_profile(ShapingProfile(drill={"sensitivity": 1.5, "mapping": "resistance"}))
    assert np.mean([o.levels.mean() for o in run(hi, 1)]) > 2 * np.mean([o.levels.mean() for o in run(lo, 1)])


# ---------------------------------------------------------------- rover mapper

@pytest.mark.parametrize("seed", [1, 2, 3])
def test_rumble_monotonic_in_speed(seed):
    means = []
    for v in (0.5, 1.5, 3.0, 4.0):
        means.append(np.mean([o.levels.mean() for o in run(engine_with(driving(v), "rover", seed), 1.0)]))
    assert means == sorted(means)


def test_split_mapping_follows_wheel_side():
    # only the left wheels are bouncing
    e = engine_with(driving(3.0, rough=0.8, wheel_vel=(0.9, 0.0, 0.8, 0.0)), "rover")
    outs = run(e, 3.0)
    terrain_left = np.mean([o.contributions.get("rover.terrain_left", 0) for o in outs])
    terrain_right = np.mean([o.contributions.get("rover.terrain_right", 0) for o in outs])
    assert terrain_left > 3 * terrain_right
    lv = np.mean([o.levels for o in outs], axis=0)
    assert lv[0] > lv[4] and lv[1] > lv[3]


def test_slope_alert_from_lola_with_rearm():
    e = engine_with(driving(2.0, slope=17.0), "rover")
    e.set_profile(ShapingProfile(rover={"slope_warn_deg": 15.0}))
    run(e, 1.0)
    assert [ev.meaning for ev in e.recent].count("alert.slope") == 1
    assert "17.0" in e.recent[-1].cause
    e.update_state(driving(2.0, slope=12.0))  # below limit - margin
    run(e, 3.5)
    e.update_state(driving(2.0, slope=18.0))
    run(e, 0.1)
    assert [ev.meaning for ev in e.recent].count("alert.slope") == 2


def test_impact_event_side():
    e = engine_with(driving(2.0), "rover")
    run(e, 0.2)
    e.on_event(SimEvent(name="impact", mag=1.0, side="right"))
    out = e.tick(DT)
    assert out.levels[4] > out.levels[0]
    assert e.snapshot()["recent"][-1]["meaning"] == "event.impact_right"


def test_snapshot_shape():
    e = engine_with(drilling(0.9), "drill")
    run(e, 0.5)
    snap = e.snapshot()
    assert snap["dominant"] == "drill.hard"
    assert set(snap) == {"dominant", "levels", "duty", "alert_active", "recent"}
