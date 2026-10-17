"""Make the official MANO_RIGHT.pkl loadable without chumpy.

The MANO download pickles some arrays as chumpy objects, and chumpy no longer installs on current Python (its
setup.py needs distutils and pip internals). smplx's tools/clean_ch.py fixes this but needs chumpy to run. Here a
stub class stands in for every chumpy class while unpickling: chumpy pickles a Ch as its __dict__, with the array in
`x`, so the arrays come out intact.

    uv run --project handpose python -m lunarhand.mano third_party/AnyHand/mano_data/MANO_RIGHT.pkl
"""

from __future__ import annotations

import pickle
import sys
from pathlib import Path

import numpy as np


class _ChStub:
    def __setstate__(self, state: dict) -> None:
        self.__dict__.update(state)


class _Unpickler(pickle.Unpickler):
    def find_class(self, module: str, name: str):
        if module.split(".")[0] == "chumpy":
            return _ChStub
        if module in ("scipy.sparse.csc", "scipy.sparse.csr"):  # pre-1.8 private module paths
            module = "scipy.sparse"
        return super().find_class(module, name)


def _plain(value):
    if isinstance(value, _ChStub):
        if "x" not in value.__dict__:
            raise ValueError(f"unsupported chumpy object (fields: {sorted(value.__dict__)})")
        return np.asarray(_plain(value.x))
    if hasattr(value, "toarray"):  # scipy sparse (J_regressor): dense avoids scipy pickle-format drift
        return np.asarray(value.toarray())
    return value


def load(path: Path) -> dict:
    with path.open("rb") as fh:
        return _Unpickler(fh, encoding="latin1").load()


def has_chumpy(data: dict) -> bool:
    return any(isinstance(v, _ChStub) for v in data.values())


def clean(src: Path, dst: Path) -> list[str]:
    """Write a chumpy-free copy of `src` to `dst`; returns the keys that were converted."""
    data = load(src)
    converted = [k for k, v in data.items() if isinstance(v, _ChStub) or hasattr(v, "toarray")]
    out = {k: _plain(v) for k, v in data.items()}
    tmp = dst.with_suffix(".tmp")
    with tmp.open("wb") as fh:
        pickle.dump(out, fh, protocol=pickle.HIGHEST_PROTOCOL)
    tmp.replace(dst)
    return converted


def main() -> None:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "third_party/AnyHand/mano_data/MANO_RIGHT.pkl")
    data = load(path)
    if not has_chumpy(data):
        print(f"{path}: already chumpy-free")
        return
    original = path.with_name(path.stem + ".chumpy.pkl")
    if not original.exists():
        path.replace(original)
    converted = clean(original, path)
    print(f"{path}: converted {', '.join(converted)} (original kept as {original.name})")


if __name__ == "__main__":
    main()
