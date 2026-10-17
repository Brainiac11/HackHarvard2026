"""Build eval datasets (PLAN.md §10B.6) as JSONL under evals/data/, optionally uploading them to Chalk.

    uv run --project hub python -m lunar_agent.evals.build_dataset                 # build locally
    uv run --project hub --extra chalk python -m lunar_agent.evals.build_dataset --upload

Datasets: lh-synthetic (auto-labelled from the real engine), lh-adversarial, lh-replay (recorded sessions),
lh-questions (human labels from docs/LABEL_QUESTIONS.md; only filled-in rows).
"""

from __future__ import annotations

import argparse
import glob
import json
from pathlib import Path

from .scenarios import ROOT, summary

DATA_DIR = Path(__file__).parent / "data"


def write(name: str, rows: list[dict]) -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / f"{name}.jsonl"
    with path.open("w") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    return path


def load(name: str) -> list[dict]:
    path = DATA_DIR / f"{name}.jsonl"
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()] if path.exists() else []


def replay_rows(max_rows: int = 80) -> list[dict]:
    """Salient moments from recorded sessions (hub --log-telemetry): dominant-sensation changes and alerts."""
    from lunarhub.assistant.context import context_from_parts
    from lunarhub.profiles.store import ProfileStore
    from lunarhub.protocol.messages import SimState
    from lunarhub.terrain import TerrainGrid

    from .scenarios import TERRAIN_DIR, label_row

    store = ProfileStore(ROOT / "data" / "profiles.json")
    grid = TerrainGrid(TERRAIN_DIR)
    rows, last_dominant, seen_alerts = [], None, set()
    for path in sorted(glob.glob(str(ROOT / "data" / "sessions" / "telemetry-*.jsonl"))):
        for line in Path(path).read_text().splitlines():
            rec = json.loads(line)
            snap = rec["haptics"]
            alert_ids = {e.get("id") for e in snap["recent"] if e["layer"] == "alert"}
            salient = snap["dominant"] != last_dominant or (alert_ids - seen_alerts)
            last_dominant = snap["dominant"]
            seen_alerts |= alert_ids
            if not salient or not snap["dominant"]:
                continue
            state = SimState.model_validate(rec["state"])
            active = rec.get("active_equipment")
            ctx = context_from_parts(state, snap, store.get(rec.get("profile_id")), active,
                                     [active] if active else [], state.near, grid)
            row = label_row(ctx, question="", intended="replay", labeller="rules")
            row["id"] = f"rep-{len(rows):03d}"
            rows.append(row)
            if len(rows) >= max_rows:
                return rows
    return rows


def build(per_situation: int) -> dict[str, list[dict]]:
    from . import adversarial, questions, scenarios

    datasets = {
        "lh-synthetic": scenarios.generate(per_situation=per_situation),
        "lh-adversarial": adversarial.generate(),
        "lh-replay": replay_rows(),
        "lh-questions": questions.labelled_rows(),
    }
    for name, rows in datasets.items():
        if rows:
            path = write(name, rows)
            print(f"{name:15s} {len(rows):4d} rows -> {path.relative_to(ROOT)}")
        else:
            print(f"{name:15s}    0 rows (skipped)")
    print("synthetic by situation:", summary(datasets["lh-synthetic"]))
    return datasets


def upload(datasets: dict[str, list[dict]]) -> None:
    import chalkcompute

    client = chalkcompute.DatasetClient()
    for name, rows in datasets.items():
        if rows:
            ref = client.upload(name, rows)
            print(f"uploaded {name}: {ref}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-situation", type=int, default=20)
    ap.add_argument("--upload", action="store_true")
    args = ap.parse_args()
    built = build(args.per_situation)
    if args.upload:
        upload(built)
