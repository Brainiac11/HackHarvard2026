import itertools
import json
from pathlib import Path

import numpy as np
import pytest

from lunarhub.commands.tools import TEST_PATTERN_ENUM
from lunarhub.haptics import patterns
from lunarhub.haptics.effects import MAX_ACCENT_MS, N, Keyframes
from lunarhub.haptics.engine import (ACCENT_DUTY, DUCK, DUCK_RELEASE_S, HapticEngine, OutputCalibration,
                                     ShapingProfile, ThermalBudget, soft_sum)
from lunarhub.haptics.mappers import DrillMapper, RoverMapper
from lunarhub.haptics.vocabulary import MEANINGS
from lunarhub.protocol.messages import DrillState, RoverState, SimEvent, SimState, TerrainState, Wheel

DT = 0.01
ROOT = Path(__file__).resolve().parents[2]


def run(engine: HapticEngine, seconds: float) -> list:
    return [engine.tick(DT) for _ in range(int(round(seconds / DT)))]


def duties(outs) -> np.ndarray:
    return np.array([o.duty for o in outs], dtype=float)


def drilling(hardness: float, stalled: bool = False, trigger: float = 1.0, contact: bool = True,
             held: bool = True, through: bool = False) -> SimState:
    target = "hard" if hardness >= 0.5 else "soft"
    return SimState(mode="drill", drill=DrillState(held=held, trigger=trigger, target=target, contact=contact,
                                                   hardness=hardness, stalled=stalled, through=through))


def driving(speed: float, rough: float = 0.0, slope: float | None = 5.0, wheel_vel=(0, 0, 0, 0)) -> SimState:
    return SimState(mode="rover",
                    rover=RoverState(speed=speed, rough=rough, wheels=[Wheel(vel=v) for v in wheel_vel]),
                    terrain=TerrainState(lola_slope_deg=slope))


def engine_with(state: SimState, equipment: str | None, seed: int = 1) -> HapticEngine:
    e = HapticEngine(seed=seed)
    e.set_active_equipment(equipment)
    e.update_state(state)
    return e


def play_alone(pattern: Keyframes) -> np.ndarray:
    """Duty per tick while the pattern plays on an otherwise idle glove."""
    e = HapticEngine()
    e.play(pattern)
    out = []
    while e.oneshots:
        out.append(e.tick(DT).duty)
    return np.array(out, dtype=float)


def rolling_mean(duty: np.ndarray, window: int) -> np.ndarray:
    padded = np.concatenate([np.zeros(window - 1), duty])
    return np.convolve(padded, np.ones(window), "valid") / window


def worst_hold(duty: np.ndarray, hold: int) -> np.ndarray:
    """Upper bound on what the motor sees if any frame may stay on it for `hold` ticks."""
    return np.array([duty[max(0, t - hold + 1): t + 1].max() for t in range(len(duty))])


def runs_above(duty: np.ndarray, level: float) -> list[int]:
    return [len(list(g)) for over, g in itertools.groupby(duty > level) if over]


# ---------------------------------------------------------------- compositor basics

def test_soft_sum_never_exceeds_one():
    v = soft_sum([np.full(N, 0.9), np.full(N, 0.9), np.full(N, 0.9)])
    assert np.all(v <= 1.0) and np.all(v > 0.99)


def test_idle_is_silent():
    e = HapticEngine()
    outs = run(e, 0.5)
    assert all(o.duty == [0] * N for o in outs)


def test_seeded_determinism():
    a = [o.duty for o in run(engine_with(drilling(0.9), "drill", seed=5), 1.0)]
    b = [o.duty for o in run(engine_with(drilling(0.9), "drill", seed=5), 1.0)]
    assert a == b


# ---------------------------------------------------------------- perceptual curve

def test_perceptual_curve_endpoints():
    cal = OutputCalibration(min_duty=[60, 70, 80, 90, 100], max_duty=180)
    assert cal.to_duty(np.zeros(N)) == [0] * N
    assert cal.to_duty(np.full(N, 0.02)) == [0] * N  # below silence threshold
    assert cal.to_duty(np.ones(N)) == [180] * N
    assert cal.to_duty(np.full(N, 1.7)) == [180] * N  # never above the sustained ceiling
    low = cal.to_duty(np.full(N, 0.03))
    assert low == sorted(low) and all(abs(d - m) <= 3 for d, m in zip(low, [60, 70, 80, 90, 100]))


def test_perceptual_curve_is_equal_ratio_per_level_step():
    # ERM felt strength ~ 40·log10(duty): equal level steps must be equal duty ratios (equal dB steps)
    cal = OutputCalibration(min_duty=[70] * N, max_duty=180)
    xs = np.linspace(0.1, 1.0, 10)
    d = np.array([cal.to_duty(np.full(N, x))[0] for x in xs], dtype=float)
    ratios = d[1:] / d[:-1]
    assert np.all(np.diff(d) > 0)
    assert ratios.max() - ratios.min() < 0.02
    assert abs(cal.to_duty(np.full(N, 0.5))[0] - np.sqrt(70 * 180)) <= 1  # midpoint = geometric mean


def test_perceptual_curve_widens_range_vs_old_power_curve():
    cal = OutputCalibration()
    old = lambda x: round(70 + 110 * x ** 0.8)  # noqa: E731  (the previous curve)
    for x in (0.1, 0.2, 0.3, 0.5, 0.7, 0.9):
        assert cal.to_duty(np.full(N, x))[0] < old(x)  # quiet states are quieter...
    # ...and the top 20 % of levels now spans far more of the duty range than the bottom 20 %
    span = lambda a, b: cal.to_duty(np.full(N, b))[0] - cal.to_duty(np.full(N, a))[0]  # noqa: E731
    assert span(0.8, 1.0) > 2 * span(0.03, 0.23)


# ---------------------------------------------------------------- thermal budget

def test_budget_passes_anything_at_or_below_the_ceiling_untouched():
    rng = np.random.default_rng(0)
    b = ThermalBudget()
    req = rng.integers(0, 181, 2000).tolist()
    assert [b.apply([r] * N)[0] for r in req] == req


def test_budget_grants_a_prepaid_accent_then_caps_its_length_and_rests():
    b = ThermalBudget()
    for _ in range(50):
        b.apply([0] * N)
    out = [b.apply([ACCENT_DUTY] * N)[0] for _ in range(20)]
    assert out[:6] == [ACCENT_DUTY] * 6  # a full 60 ms accent after silence
    assert all(d <= 180 for d in out[6:12])  # then at least a 60 ms rest at or below the ceiling
    assert max(runs_above(np.array(out), 180)) <= 6


def test_budget_refuses_accents_when_the_window_is_already_at_the_ceiling():
    b = ThermalBudget()
    for _ in range(100):
        b.apply([180] * N)
    assert b.apply([ACCENT_DUTY] * N) == [180] * N


@pytest.mark.parametrize("seed", range(6))
def test_budget_rolling_average_never_exceeds_ceiling(seed):
    """Adversarial requests: accents on top of a saturated base, long accent runs, random noise."""
    rng = np.random.default_rng(seed)
    b = ThermalBudget()
    req = []
    for _ in range(300):
        kind = rng.integers(4)
        n = int(rng.integers(1, 40))
        req += ([180] * n if kind == 0 else [ACCENT_DUTY] * n if kind == 1 else [0] * n if kind == 2
                else rng.integers(0, 256, n).tolist())
    out = np.array([b.apply([r] * N)[0] for r in req], dtype=float)
    w, ceiling = b.window_ticks, b.ceiling
    assert out.max() <= ACCENT_DUTY and (out > 180).any()
    assert max(runs_above(out, 180)) <= b.max_run_ticks
    assert rolling_mean(out, w).max() <= ceiling + 1e-9
    # what the motor can actually receive: a frame held up to hold_ticks, or the 50 Hz sender's even/odd ticks
    assert rolling_mean(worst_hold(out, b.hold_ticks), w).max() <= ceiling + 1e-9
    for phase in (0, 1):
        held = np.repeat(out[phase::2], 2)[: len(out) - phase]
        assert rolling_mean(held, w).max() <= ceiling + 1e-9


def test_accents_never_lower_a_calibration_above_the_accent_peak():
    e = HapticEngine(calibration=OutputCalibration(max_duty=240))
    e.play(patterns.drill_stall())
    assert duties(run(e, 1.1)).max() == 240 and e.budget.peak == 240


def test_engine_stays_within_budget_under_repeated_alerts_and_hits():
    e = engine_with(drilling(0.9), "drill")
    outs = []
    for i in range(40):  # an alert or a hit every 0.2 s over hard drilling, far more than real use
        e.play(patterns.drill_stall() if i % 2 else patterns.impact("left", 1.0))
        outs += run(e, 0.2)
    d = duties(outs)
    assert d.max() == ACCENT_DUTY  # accents still get through
    for i in range(N):
        assert rolling_mean(d[:, i], e.budget.window_ticks).max() <= 180 + 1e-9
        assert max(runs_above(d[:, i], 180), default=0) <= 6


# ---------------------------------------------------------------- patterns

def all_patterns() -> dict[str, Keyframes]:
    return {
        "double": patterns.double(), "triple": patterns.triple(), "wave": patterns.wave(),
        "equipment_drill": patterns.equipment_drill(), "equipment_rover": patterns.equipment_rover(),
        "confirm": patterns.confirm(), "setting_up": patterns.setting_up(), "setting_down": patterns.setting_down(),
        "denied": patterns.denied(), "drill_stall": patterns.drill_stall(), "slope": patterns.slope(),
        "impact_left": patterns.impact("left"), "impact_right": patterns.impact("right"),
        "breakthrough": patterns.breakthrough(),
        **{f"test:{k}": f() for k, f in patterns.TEST_PATTERNS.items()},
    }


def test_every_pattern_meaning_is_in_vocabulary():
    for name, p in all_patterns().items():
        assert p.meaning in MEANINGS, name
    assert patterns.warning("alert.slope").meaning == "alert.slope"
    assert patterns.warning("alert.drill_stall").meaning == "alert.drill_stall"


def test_pattern_names_used_elsewhere_still_work():
    assert set(patterns.AUTH_PATTERNS) == {"double", "triple", "wave"}
    profiles = json.loads((ROOT / "data" / "profiles.json").read_text())["profiles"]
    assert {p["auth_pattern"] for p in profiles} <= set(patterns.AUTH_PATTERNS)
    assert set(TEST_PATTERN_ENUM) <= set(patterns.TEST_PATTERNS)
    for f in patterns.TEST_PATTERNS.values():
        assert f().meaning == "ui.test"


def test_double_pulse_timing():
    on = play_alone(patterns.double()).max(axis=1) > 0
    # 70 ms on, 80 ms off, 70 ms on, then silent
    assert on[:7].all() and not on[7:15].any() and on[15:22].all() and not on[22:].any()


def test_patterns_are_short():
    for name, p in all_patterns().items():
        if p.layer == "alert":
            assert 0.8 <= p.duration_s <= 1.1, name
        else:
            assert p.duration_s <= 0.5, name


def test_accents_are_transient_and_only_on_events_and_alerts():
    for name, p in all_patterns().items():
        for s in p.steps:
            assert not s.accent.any() or s.ms <= MAX_ACCENT_MS, name
        d = play_alone(p)
        ui = p.meaning.startswith("ui.") and not name.startswith("test:")
        if ui:
            assert d.max() <= 180, name  # identity and settings feedback never overdrive
        else:
            assert max(runs_above(d.max(axis=1), 180), default=0) <= 6, name
    for p in (patterns.drill_stall(), patterns.slope(), patterns.impact("right", 1.0), patterns.breakthrough()):
        assert play_alone(p).max() > 180, p.meaning  # played after silence, the accent gets through
    assert play_alone(patterns.impact("left", 0.4)).max() <= 180  # a small knock stays small


def test_alert_hushes_the_base_then_ducks_it_and_releases():
    e = engine_with(driving(3.0), "rover")
    base = np.mean([o.levels for o in run(e, 0.5)], axis=0)
    e.play(patterns.slope())
    lead = run(e, 0.06)
    assert all(o.duty == [0] * N and o.alert_active for o in lead)  # silence before the siren
    body = run(e, 0.86)
    assert all(o.alert_active for o in body)
    assert max(o.levels[2] for o in body) <= DUCK["alert"] * base[2] * 1.3 + 0.01  # middle: rumble ducked
    run(e, 0.08)
    after = run(e, DUCK_RELEASE_S + 0.3)
    assert not after[-1].alert_active
    assert np.mean([o.levels[2] for o in after[-20:]]) > 0.8 * base[2]  # rumble back


def test_stall_alert_beats_are_separated_by_true_silence():
    e = engine_with(drilling(0.9), "drill")
    run(e, 0.3)
    e.play(patterns.drill_stall())
    d = duties(run(e, 1.0))
    beats = runs_above(d[:, 2], 0)
    assert len(beats) == 3 and all(18 <= b <= 21 for b in beats)  # three ~200 ms beats on the grip
    on = d.max(axis=1) > 0
    gaps = [len(list(g)) for v, g in itertools.groupby(on) if not v]
    assert sorted(gaps)[-3:] == [8, 12, 12]  # 80 ms lead-in and two 120 ms gaps with the glove fully quiet


def test_event_ducks_base_less_than_an_alert():
    e = engine_with(driving(3.0), "rover")
    base = np.mean([o.levels for o in run(e, 0.5)], axis=0)
    e.on_event(SimEvent(name="impact", mag=1.0, side="right"))
    lead = run(e, 0.03)
    assert all(o.duty == [0] * N for o in lead)
    hit = run(e, 0.1)
    assert hit[0].duty[4] == ACCENT_DUTY  # pre-paid by the rumble's headroom and the hush
    assert max(o.levels[0] for o in hit[2:]) <= DUCK["event"] * base[0] * 1.3 + 0.01


# ---------------------------------------------------------------- distinctness

def felt(duty: np.ndarray) -> np.ndarray:
    """Sensation level in dB above the dead zone (ERM acceleration ~ duty²), 0 when off."""
    return np.where(duty > 0, 40 * np.log10(np.maximum(duty, 1) / 70.0) + 1.0, 0.0)


def turns(path: np.ndarray, hysteresis: float) -> int:
    """Direction reversals along a trajectory, ignoring wiggles smaller than `hysteresis`."""
    n, direction, lo, hi = 0, 0, path[0], path[0]
    for x in path:
        if direction == 0:
            lo, hi = min(lo, x), max(hi, x)
            if hi - lo >= hysteresis:
                direction, ext = (1 if x == hi else -1), x
        elif direction * (x - ext) > 0:
            ext = x
        elif abs(x - ext) > hysteresis:
            n, direction, ext = n + 1, -direction, x
    return n


def oneshot_features(duty: np.ndarray) -> dict:
    f = felt(duty)
    env = f.max(axis=1)
    peak = env.max()
    on = env > 0.3 * peak
    idx = np.flatnonzero(on)
    per_motor = f.max(axis=0)
    w = f[idx] / np.maximum(f[idx].sum(axis=1, keepdims=True), 1e-9)
    pos = np.arange(N)
    centroid = w @ pos
    spread = np.sqrt((w * (pos - centroid[:, None]) ** 2).sum(axis=1))
    reversals = turns(centroid, 1.0)
    net = centroid[-3:].mean() - centroid[:3].mean()
    if reversals >= 3:
        motion = "alternating"
    elif reversals >= 1 and abs(net) < 1.0:
        motion = "out-and-back"
    elif abs(net) >= 1.5:
        motion = "rightward" if net > 0 else "leftward"
    elif spread[-5:].mean() - spread[:5].mean() >= 0.5:
        motion = "spreading"
    else:
        motion = "static"
    third = max(1, len(idx) // 3)
    first, last = env[idx[:third]].mean(), env[idx[-third:]].mean()
    envelope = "rising" if last > 1.25 * first else "falling" if first > 1.25 * last else "flat"
    onsets = np.flatnonzero(np.diff(on.astype(int), prepend=0) > 0)
    return {"footprint": frozenset(np.flatnonzero(per_motor >= 0.5 * per_motor.max())),
            "beats": len(onsets), "ms": (idx[-1] - idx[0] + 1) * 10,
            "beat_ms": float(np.diff(onsets).mean() * 10) if len(onsets) > 1 else None,
            "motion": motion, "envelope": envelope, "level": float(env[idx].mean()), "accent": bool(duty.max() > 180),
            "continuous": False}


def texture_features(levels_by_tick: np.ndarray) -> dict:
    cal = OutputCalibration()
    f = felt(np.array([cal.to_duty(v) for v in levels_by_tick], dtype=float))
    mean = f.mean(axis=1)
    active = (f.max(axis=1) > 0).mean()
    x = mean - mean.mean()
    lags = range(8, 61)  # 1.7..12.5 Hz
    ac = [float(np.dot(x[:-k], x[k:]) / max(np.dot(x, x), 1e-9)) for k in lags]
    if mean.std() < 0.3:
        texture = "flat"
    elif active < 0.8:
        texture = "sparse"
    elif max(ac) > 0.5:
        texture = "periodic"
    else:
        texture = "irregular"
    per_motor = f.mean(axis=0)
    return {"footprint": frozenset(np.flatnonzero(per_motor >= 0.5 * per_motor.max())), "texture": texture,
            "tempo_hz": 100.0 / lags[int(np.argmax(ac))] if texture == "periodic" else None,
            "level": float(mean[mean > 0].mean()) if (mean > 0).any() else 0.0, "continuous": True}


def strong_axes(a: dict, b: dict) -> list[str]:
    axes = []
    if a["continuous"] != b["continuous"]:
        return ["continuity"]
    if len(a["footprint"] & b["footprint"]) / len(a["footprint"] | b["footprint"]) <= 0.5:
        axes.append("location")
    if abs(a["level"] - b["level"]) >= 4.0:
        axes.append("intensity")
    if a["continuous"]:
        if a["texture"] != b["texture"]:
            axes.append("texture")
        elif a["tempo_hz"] and b["tempo_hz"] and max(a["tempo_hz"], b["tempo_hz"]) >= 1.8 * min(a["tempo_hz"],
                                                                                                 b["tempo_hz"]):
            axes.append("tempo")
        return axes
    if a["beats"] != b["beats"] and min(a["beats"], b["beats"]) <= 4:
        axes.append("rhythm")
    elif a["beat_ms"] and b["beat_ms"] and max(a["beat_ms"], b["beat_ms"]) >= 1.8 * min(a["beat_ms"], b["beat_ms"]):
        axes.append("tempo")
    if max(a["ms"], b["ms"]) >= 1.5 * min(a["ms"], b["ms"]):
        axes.append("duration")
    if a["motion"] != b["motion"]:
        axes.append("motion")
    if a["envelope"] != b["envelope"]:
        axes.append("envelope")
    if a["accent"] != b["accent"]:
        axes.append("attack")  # an overdriven punch against a soft onset
    return axes


def isolated_texture(meaning: str, state: SimState | None = None) -> np.ndarray:
    """2 s of one continuous meaning on its own, straight from its mapper, in a typical situation."""
    rng = np.random.default_rng(7)
    drill, rover = DrillMapper(rng), RoverMapper(rng)
    states = {
        "drill.free_spin": drilling(0.0, contact=False), "drill.soft": drilling(0.25),
        "drill.hard": drilling(0.9), "rover.speed": driving(2.5),
        "rover.terrain_left": driving(3.0, 0.6, wheel_vel=(0.8, 0.05, 0.7, 0.05)),
        "rover.terrain_right": driving(3.0, 0.6, wheel_vel=(0.05, 0.8, 0.05, 0.7)),
        "rover.terrain": driving(3.0, 0.6, wheel_vel=(0.5, 0.5, 0.5, 0.5)),
    }
    s = state or states[meaning]
    settings = {"mapping": "uniform" if meaning == "rover.terrain" else "split"}
    out = []
    for i in range(200):
        drill.update(s.drill, 1.0, "resistance", s.mode == "drill", DT, lambda *_: None)
        rover.update(s.rover, s.terrain, settings, s.mode == "rover", DT, lambda *_: None)
        vs = [e.sample(i * DT, DT) for e in drill.effects + rover.effects if e.meaning == meaning]
        out.append(soft_sum(vs))
    return np.array(out[20:])


def vocabulary_renderings() -> dict[str, list[dict]]:
    """Every meaning (ui.test excepted: it replays the others) -> features of each way it can sound."""
    oneshots = {
        "alert.drill_stall": [patterns.drill_stall()], "alert.slope": [patterns.slope()],
        "event.breakthrough": [patterns.breakthrough()],
        "event.impact_left": [patterns.impact("left", 1.0), patterns.impact("left", 0.5)],
        "event.impact_right": [patterns.impact("right", 1.0), patterns.impact("right", 0.5)],
        "ui.auth": [f() for f in patterns.AUTH_PATTERNS.values()],
        "ui.equipment_drill": [patterns.equipment_drill()], "ui.equipment_rover": [patterns.equipment_rover()],
        "ui.confirm": [patterns.confirm()], "ui.setting_up": [patterns.setting_up()],
        "ui.setting_down": [patterns.setting_down()], "ui.denied": [patterns.denied()],
    }
    out = {m: [oneshot_features(play_alone(p)) for p in ps] for m, ps in oneshots.items()}
    for m in MEANINGS:
        if MEANINGS[m].layer == "base":
            out[m] = [texture_features(isolated_texture(m))]
    out["rover.speed"].append(texture_features(isolated_texture("rover.speed", driving(0.5))))  # slowest throb
    return out


def test_every_vocabulary_meaning_is_rendered():
    assert set(vocabulary_renderings()) == set(MEANINGS) - {"ui.test"}


def test_every_pair_of_meanings_differs_on_a_strong_axis():
    r = vocabulary_renderings()
    for a, b in itertools.combinations(sorted(r), 2):
        for fa in r[a]:
            for fb in r[b]:
                assert strong_axes(fa, fb), f"{a} {fa} feels like {b} {fb}"


CONTEXTS = {"drill": ("drill.", "alert.drill_stall", "event.breakthrough"),
            "rover": ("rover.", "alert.slope", "event.impact"), "ui": ("ui.",)}
MIRRORS = {frozenset({"event.impact_left", "event.impact_right"}),
           frozenset({"rover.terrain_left", "rover.terrain_right"})}  # the same cue on opposite sides


def test_one_shots_that_can_meet_differ_on_two_axes():
    r = vocabulary_renderings()
    for prefixes in CONTEXTS.values():
        group = [m for m in r if m.startswith(prefixes) and not r[m][0]["continuous"]]
        for a, b in itertools.combinations(sorted(group), 2):
            if frozenset({a, b}) in MIRRORS:
                assert all("location" in strong_axes(fa, fb) for fa in r[a] for fb in r[b])
                continue
            for fa in r[a]:
                for fb in r[b]:
                    assert len(strong_axes(fa, fb)) >= 2, f"{a} vs {b}: {strong_axes(fa, fb)}"


def test_the_two_alerts_are_unmistakable():
    stall = oneshot_features(play_alone(patterns.drill_stall()))
    slope = oneshot_features(play_alone(patterns.slope()))
    assert stall["beats"] == 3 and stall["motion"] == "static" and stall["footprint"] == {1, 2, 3}
    assert slope["motion"] == "alternating" and slope["envelope"] == "rising" and 2 not in slope["footprint"]
    assert len(strong_axes(stall, slope)) >= 3


def test_ui_signatures():
    f = {k: oneshot_features(play_alone(p)) for k, p in all_patterns().items() if not k.startswith("test:")}
    assert (f["double"]["beats"], f["triple"]["beats"]) == (2, 3)
    assert f["wave"]["motion"] == "out-and-back"
    assert f["setting_up"]["motion"] == "rightward" and f["setting_up"]["envelope"] == "rising"
    assert f["setting_down"]["motion"] == "leftward" and f["setting_down"]["envelope"] == "falling"
    assert f["equipment_drill"]["footprint"] == {1, 2} and f["equipment_rover"]["footprint"] == {0, 1, 3, 4}
    assert f["confirm"]["footprint"] == {2} and f["confirm"]["ms"] <= 80
    assert f["denied"]["beats"] >= 5 and f["denied"]["envelope"] == "falling" and f["denied"]["level"] < 9
    assert f["breakthrough"]["motion"] == "spreading" and f["breakthrough"]["envelope"] == "falling"
    assert f["impact_left"]["footprint"] == {0, 1} and f["impact_right"]["footprint"] == {3, 4}


def test_continuous_textures_differ_in_texture_not_only_level():
    t = {m: texture_features(isolated_texture(m))["texture"]
         for m in ("drill.free_spin", "drill.soft", "drill.hard", "rover.speed", "rover.terrain")}
    assert t == {"drill.free_spin": "flat", "drill.soft": "periodic", "drill.hard": "irregular",
                 "rover.speed": "periodic", "rover.terrain": "sparse"}


# ---------------------------------------------------------------- drill press mapper

@pytest.mark.parametrize("state", [drilling(0.9, held=False), drilling(0.9, trigger=0.0),
                                   drilling(0.9, trigger=0.02, stalled=True)])
def test_drill_silent_when_nobody_operates_or_spindle_stopped(state):
    e = engine_with(state, "drill")
    outs = run(e, 1.5)
    assert all(o.duty == [0] * N for o in outs) and not e.recent


def test_drill_situations_map_to_the_right_sensation():
    cases = {"drill.free_spin": [drilling(0.0, contact=False), drilling(0.9, contact=False, through=True)],
             "drill.soft": [drilling(0.25)], "drill.hard": [drilling(0.9)]}
    for meaning, states in cases.items():
        for s in states:
            outs = run(engine_with(s, "drill"), 1.0)[20:]
            assert {m for o in outs for m in o.contributions} == {meaning}
            assert all(o.dominant == meaning for o in outs)


def test_drill_spread_free_spin_soft_hard():
    free = duties(run(engine_with(drilling(0.0, contact=False), "drill"), 2.0)[20:])
    soft = duties(run(engine_with(drilling(0.25), "drill"), 2.0)[20:])
    hard = duties(run(engine_with(drilling(0.9), "drill"), 2.0)[20:])
    assert free.max() <= 90  # barely there
    assert soft.mean() >= 1.2 * free.mean() and hard.mean() >= 1.4 * soft.mean()
    assert hard.mean() >= 150 and hard.max() <= 180  # strong, but never overdriven by a continuous state
    assert soft.max() - soft.min() >= 15  # the throb is felt


def test_hard_vs_soft_contrast():
    soft = run(engine_with(drilling(0.25), "drill"), 2.0)
    hard = run(engine_with(drilling(0.9), "drill"), 2.0)
    soft_mean = np.mean([o.levels.mean() for o in soft])
    hard_mean = np.mean([o.levels.mean() for o in hard])
    assert hard_mean >= 1.6 * soft_mean
    # hard is rough and irregular, soft a smooth even throb
    s, h = (np.array([o.levels.mean() for o in x[20:]]) for x in (soft, hard))
    assert np.abs(np.diff(h)).mean() > 3 * np.abs(np.diff(s)).mean()
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


@pytest.mark.parametrize("state,expect", [
    (drilling(0.9, stalled=True), True),  # pushing on basalt with no progress
    (drilling(0.9, stalled=True, contact=False), False),  # not touching the sample
    (drilling(0.9, stalled=True, trigger=0.4), False),  # spindle not at speed
    (drilling(0.9, stalled=False), False),  # hard but advancing (or the feed was released)
])
def test_stall_alert_only_while_feeding_against_a_stalled_bit(state, expect):
    e = engine_with(state, "drill")
    run(e, 1.5)
    assert any(ev.meaning == "alert.drill_stall" for ev in e.recent) is expect


def test_stall_shorter_than_threshold_does_not_alert():
    e = engine_with(drilling(0.9, stalled=True), "drill")
    run(e, 0.6)
    e.update_state(drilling(0.9))  # the operator opens the hand: the sim clears `stalled` at once
    run(e, 1.0)
    assert not any(ev.meaning == "alert.drill_stall" for ev in e.recent)


def test_breakthrough_only_on_the_active_drill():
    e = engine_with(drilling(0.25), "drill")
    e.on_event(SimEvent(name="breakthrough"))
    assert e.recent[-1].meaning == "event.breakthrough"
    e = engine_with(driving(2.0), "rover")
    e.on_event(SimEvent(name="breakthrough"))
    assert not e.recent


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


def test_rumble_spans_a_wide_range_and_quickens():
    crawl = run(engine_with(driving(0.5), "rover"), 1.0)[10:]
    flat_out = run(engine_with(driving(4.0), "rover"), 1.0)[10:]
    assert duties(crawl).max() <= 90 and duties(flat_out).mean() >= 120 and duties(flat_out).max() <= 140
    throbs = lambda outs: turns(np.array([o.levels[0] for o in outs]), 0.01) // 2  # noqa: E731
    assert throbs(flat_out) >= 2 * throbs(crawl)


def test_rover_silent_when_stopped_or_not_active():
    stopped = run(engine_with(driving(0.0, rough=0.9, wheel_vel=(1, 1, 1, 1)), "rover"), 1.0)
    assert all(o.duty == [0] * N for o in stopped)
    elsewhere = run(engine_with(driving(3.0, rough=0.9, slope=25.0), "drill"), 1.0)
    assert all(o.duty == [0] * N for o in elsewhere)


def test_terrain_taps_grow_denser_and_stronger_with_roughness():
    def taps(rough):
        e = engine_with(driving(3.0, rough=rough, wheel_vel=(0.5, 0.5, 0.5, 0.5)), "rover")
        e.set_profile(ShapingProfile(rover={"mapping": "uniform"}))
        outs = run(e, 6.0)
        tap = np.array([o.contributions.get("rover.terrain", 0.0) for o in outs])
        on = tap > 0
        return int(np.sum(on[1:] & ~on[:-1])), float(tap[on].mean())
    (n_lo, amp_lo), (n_hi, amp_hi) = taps(0.1), taps(0.9)
    assert n_hi > 1.8 * n_lo and amp_hi > 1.8 * amp_lo
    smooth = run(engine_with(driving(3.0, rough=0.01), "rover"), 1.0)
    assert not any("rover.terrain" in m for o in smooth for m in o.contributions)


def test_terrain_taps_stand_out_over_the_full_speed_rumble():
    smooth = duties(run(engine_with(driving(4.0), "rover"), 2.0)).max()
    e = engine_with(driving(4.0, rough=0.9, wheel_vel=(0.5, 0.5, 0.5, 0.5)), "rover")
    e.set_profile(ShapingProfile(rover={"mapping": "uniform"}))
    taps = duties(run(e, 4.0))
    assert np.percentile(taps, 90) >= 1.2 * smooth  # >= ~3 dB above the rumble's peak, on top of a sharp onset


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


def test_slope_alert_feels_like_the_siren_not_the_stall():
    e = engine_with(driving(2.0, slope=17.0), "rover")
    d = duties(run(e, 1.1))
    left, right = d[:, :2].max(axis=1), d[:, 3:].max(axis=1)
    turns = np.sign(left - right)
    assert np.sum(turns[1:] * turns[:-1] < 0) >= 6  # the sides take turns


def test_impact_event_side():
    e = engine_with(driving(2.0), "rover")
    run(e, 0.2)
    e.on_event(SimEvent(name="impact", mag=1.0, side="right"))
    out = run(e, 0.06)[-1]
    assert out.levels[4] > out.levels[0]
    assert e.snapshot()["recent"][-1]["meaning"] == "event.impact_right"


def test_impact_only_on_the_active_rover():
    e = engine_with(drilling(0.9), "drill")
    e.on_event(SimEvent(name="impact", mag=1.0, side="left"))
    assert not e.recent


def test_snapshot_shape():
    e = engine_with(drilling(0.9), "drill")
    run(e, 0.5)
    snap = e.snapshot()
    assert snap["dominant"] == "drill.hard"
    assert set(snap) == {"dominant", "levels", "duty", "alert_active", "recent"}
