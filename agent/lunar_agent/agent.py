"""Chalk Function: the deployed Mission Assistant (PLAN.md §10B.8).

Importing this module registers/deploys the function with Chalk (that's how @chalkcompute.function works),
so ONLY lunar_agent.deploy / evals import it. The hub calls it by name via RemoteFunction.from_name.
Keep this module's top level to definitions only: Chalk re-imports it inside every worker.
"""

import chalkcompute
from chalkcompute import Secret

IMAGE = chalkcompute.Image.debian_slim().pip_install(["openai>=1.40", "pydantic>=2.7"])
# read from the deployer's local env (.env) and upserted as Chalk secrets at deploy time
SECRETS = [Secret.from_local_env(name) for name in ("CHALK_ROUTER_API_KEY", "CHALK_ENV_ID", "AGENT_MODEL")]


@chalkcompute.function(image=IMAGE, secrets=SECRETS, min_replicas=1, retries=1)
def mission_assistant(context_json: str, question: str = "", variant: str = "v2+guard") -> str:
    from lunar_agent.core import run_agent
    from lunar_agent.llm import completer_from_env

    complete, model = completer_from_env(alt=variant.startswith("v2-alt-model"))
    return run_agent(context_json, question, variant, complete, model).model_dump_json()


@chalkcompute.function(image=IMAGE)
def baseline_rules(context_json: str, question: str = "", variant: str = "baseline-rules") -> str:
    from lunar_agent import baseline
    from lunar_agent.schema import ContextPacket

    return baseline.run(ContextPacket.model_validate_json(context_json)).model_dump_json()
