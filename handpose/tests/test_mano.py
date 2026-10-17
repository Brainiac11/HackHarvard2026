"""The cleaner must read chumpy pickles without chumpy. Build one the way chumpy does (a Ch pickles as its __dict__
minus the weakref caches, array in `x`) using a throwaway module named chumpy.ch, then unload it before cleaning."""

import pickle
import sys
import types

import numpy as np
import pytest
from scipy import sparse

from lunarhand import mano


@pytest.fixture
def chumpy_pickle(tmp_path):
    pkg, ch = types.ModuleType("chumpy"), types.ModuleType("chumpy.ch")

    class Ch:
        def __init__(self, x):
            self.x, self._parents, self._cache, self._itr = x, {}, {}, None

        def __getstate__(self):
            state = dict(self.__dict__)
            del state["_parents"], state["_cache"]
            return state

    Ch.__module__, Ch.__qualname__ = "chumpy.ch", "Ch"
    ch.Ch, pkg.ch = Ch, ch
    sys.modules.update({"chumpy": pkg, "chumpy.ch": ch})
    data = {"shapedirs": Ch(np.arange(24.0).reshape(2, 3, 4)), "f": np.array([[0, 1, 2]], dtype=np.uint32),
            "J_regressor": sparse.csc_matrix(np.eye(3)), "hands_mean": Ch(Ch(np.ones(45))), "bs_type": "lrotmin"}
    path = tmp_path / "MANO_RIGHT.pkl"
    path.write_bytes(pickle.dumps(data, protocol=2))  # Python 2 era protocol, as in the MANO download
    del sys.modules["chumpy"], sys.modules["chumpy.ch"]
    return path


def test_clean_strips_chumpy_and_sparse(chumpy_pickle, tmp_path):
    assert "chumpy" not in sys.modules
    assert mano.has_chumpy(mano.load(chumpy_pickle))
    out = tmp_path / "clean.pkl"
    converted = mano.clean(chumpy_pickle, out)
    assert set(converted) == {"shapedirs", "hands_mean", "J_regressor"}
    data = pickle.loads(out.read_bytes())  # plain pickle, no stub classes needed
    assert np.array_equal(data["shapedirs"], np.arange(24.0).reshape(2, 3, 4))
    assert np.array_equal(data["hands_mean"], np.ones(45))
    assert isinstance(data["J_regressor"], np.ndarray) and np.array_equal(data["J_regressor"], np.eye(3))
    assert data["bs_type"] == "lrotmin" and data["f"].dtype == np.uint32
    assert not mano.has_chumpy(mano.load(out))
