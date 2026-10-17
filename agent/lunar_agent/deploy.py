"""Deploy the Mission Assistant to Chalk and smoke-test it.

    cd agent && uv sync --extra chalk
    set -a; source ../.env; set +a
    uv run python -m lunar_agent.deploy            # must run as a module so the whole package ships
"""

import json
import time

from lunar_agent.agent import mission_assistant  # importing deploys the function
from lunar_agent.smoke import CASES

if __name__ == "__main__":
    for name, ctx, question in CASES:
        start = time.perf_counter()
        out = json.loads(mission_assistant.remote(ctx.model_dump_json(), question, "v2+guard"))
        advice = out["advice"]
        print(f"[{name}] {time.perf_counter() - start:.2f}s  model={out['model']}  hazard={advice['hazard']}  "
              f"feeling={advice['feeling']}\n   {advice['explanation']}\n   DO: {advice['action']}"
              f"{'  (repaired)' if out['repaired'] else ''}{'  (guarded)' if out['guarded'] else ''}")
