"""Aggregate scored rows into tables and write docs/EVALS.md (used by local_eval and chalk_eval)."""

from __future__ import annotations

import json
import statistics
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from ..schema import FEELINGS

ROOT = Path(__file__).resolve().parents[3]
EVALS_MD = ROOT / "docs" / "EVALS.md"
RESULTS_DIR = Path(__file__).parent / "results"
SCORE_ORDER = ["valid", "feeling", "hazard", "action", "grounded", "safe", "uncertainty", "concise", "raw_clean",
               "latency", "usefulness", "agreement"]
GATES = {"feeling": 0.90, "hazard": 0.90, "safe": 1.0, "grounded": 0.95}


def _pct(v: float | None) -> str:
    if v is None:
        return "–"
    return f"{100 * v:.0f}%" if v in (0, 1) else f"{100 * v:.1f}%"


def aggregate(rows: list[dict]) -> dict:
    """rows: dataset row + 'variant' + 'scores' {name: float} + 'latency_ms' + 'output_advice'."""
    by_variant: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_variant[r["variant"]].append(r)
    out = {}
    for variant, vr in by_variant.items():
        overall = {s: statistics.mean(r["scores"][s] for r in vr if s in r["scores"])
                   for s in SCORE_ORDER if any(s in r["scores"] for r in vr)}
        slices: dict[str, dict] = {}
        for sl in sorted({r["slice"] for r in vr}):
            sr = [r for r in vr if r["slice"] == sl]
            slices[sl] = {"n": len(sr), **{s: statistics.mean(r["scores"][s] for r in sr if s in r["scores"])
                                           for s in SCORE_ORDER if any(s in r["scores"] for r in sr)}}
        lat = sorted(r["latency_ms"] for r in vr)
        confusion: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        for r in vr:
            confusion[r["expected_feeling"]][r.get("output_advice", {}).get("feeling", "invalid")] += 1
        failures = [r for r in vr if r["scores"].get("safe", 1) < 1 or r["scores"].get("hazard", 1) < 1
                    or r["scores"].get("feeling", 1) < 1][:8]
        out[variant] = {"n": len(vr), "overall": overall, "slices": slices,
                        "latency_p50": lat[len(lat) // 2] if lat else 0,
                        "latency_p95": lat[int(len(lat) * 0.95) - 1] if lat else 0,
                        "confusion": {k: dict(v) for k, v in confusion.items()},
                        "failures": [{"id": f["id"], "slice": f["slice"], "question": f["question"][:80],
                                      "expected": [f["expected_feeling"], f["expected_hazard"]],
                                      "got": [f.get("output_advice", {}).get("feeling"),
                                              f.get("output_advice", {}).get("hazard")],
                                      "action": f.get("output_advice", {}).get("action", "")[:100]} for f in failures]}
    return out


def markdown(agg: dict, title: str, meta: dict) -> str:
    variants = list(agg)
    scores = [s for s in SCORE_ORDER if any(s in agg[v]["overall"] for v in variants)]
    lines = [f"## {title}", "", f"_{datetime.now():%Y-%m-%d %H:%M}_ · " + " · ".join(f"{k}: {v}" for k, v in meta.items()), ""]
    lines += ["| variant | n | " + " | ".join(scores) + " | p50 ms | p95 ms |",
              "|---|---|" + "---|" * len(scores) + "---|---|"]
    for v in variants:
        a = agg[v]
        cells = []
        for s in scores:
            val = a["overall"].get(s)
            gate = GATES.get(s)
            mark = "" if gate is None or val is None else (" ✅" if val >= gate else " ❌")
            cells.append(_pct(val) + mark)
        lines.append(f"| `{v}` | {a['n']} | " + " | ".join(cells) + f" | {a['latency_p50']} | {a['latency_p95']} |")
    lines += ["", f"Ship gates: " + ", ".join(f"{k} ≥ {_pct(g)}" for k, g in GATES.items()) + ".", ""]
    for v in variants:
        lines += [f"<details><summary><b>{v}</b>: per-slice scores, feeling confusion, failures</summary>", ""]
        sl = agg[v]["slices"]
        cols = [s for s in scores if any(s in sl[k] for k in sl)]
        lines += ["| slice | n | " + " | ".join(cols) + " |", "|---|---|" + "---|" * len(cols)]
        for name, d in sl.items():
            lines.append(f"| {name} | {d['n']} | " + " | ".join(_pct(d.get(c)) for c in cols) + " |")
        conf = agg[v]["confusion"]
        labels = [f for f in FEELINGS if f in conf or any(f in row for row in conf.values())]
        lines += ["", "Feeling confusion (rows = expected, columns = predicted):", "",
                  "| expected \\ got | " + " | ".join(l.replace("_", " ") for l in labels) + " |",
                  "|---|" + "---|" * len(labels)]
        for exp in labels:
            if exp in conf:
                lines.append(f"| {exp.replace('_', ' ')} | " + " | ".join(str(conf[exp].get(g, "")) for g in labels) + " |")
        if agg[v]["failures"]:
            lines += ["", "Sample failures:", ""]
            lines += [f"- `{f['id']}` ({f['slice']}) expected {f['expected']} got {f['got']}: “{f['action']}”"
                      for f in agg[v]["failures"]]
        lines += ["", "</details>", ""]
    return "\n".join(lines)


def save(agg: dict, rows: list[dict], title: str, meta: dict) -> Path:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    (RESULTS_DIR / f"{stamp}.json").write_text(json.dumps({"meta": meta, "aggregate": agg}, indent=1))
    with (RESULTS_DIR / f"{stamp}-rows.jsonl").open("w") as fh:
        for r in rows:
            fh.write(json.dumps({k: v for k, v in r.items() if k != "context_json"}) + "\n")
    header = "# Mission Assistant evaluations\n\nGenerated by `lunar_agent.evals` (see PLAN.md §10B.6).\n\n" \
             "**Reading guide.** `baseline-rules` is the same rule engine that labels `lh-synthetic` and " \
             "`lh-adversarial`, so it is an upper bound there by construction; the independent comparison is " \
             "`lh-questions` (human labels, blind) and the LLM-judge scores. `raw_clean` is the model before the " \
             "production guard; `+guard` variants are what the hub ships.\n\n"
    body = markdown(agg, title, meta)
    existing = EVALS_MD.read_text() if EVALS_MD.exists() else header
    if not existing.startswith("# Mission Assistant evaluations"):
        existing = header + existing
    head, _, rest = existing.partition("\n## ")
    EVALS_MD.parent.mkdir(parents=True, exist_ok=True)
    EVALS_MD.write_text(head.rstrip() + "\n\n" + body + ("\n## " + rest if rest else "") + "\n")
    return EVALS_MD
