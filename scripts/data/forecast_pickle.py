"""Explicit constructor allowlist for the verified handoff pandas pickles."""

import pickle

ALLOWED = {
    "numpy._core.numeric": {"_frombuffer"},
    "pandas.arrays": {
        "StringArray",
        "ArrowStringArray",
        "DatetimeArray",
        "NumpyExtensionArray",
    },
    "pandas": {
        "DataFrame",
        "Categorical",
        "Index",
        "RangeIndex",
        "DatetimeIndex",
        "CategoricalDtype",
        "StringDtype",
        "DatetimeTZDtype",
    },
    "pandas.core.frame": {"DataFrame"},
    "pandas.core.internals.managers": {"BlockManager"},
    "pandas._libs.internals": {"_unpickle_block"},
    "numpy._core.multiarray": {"_reconstruct", "scalar"},
    "numpy": {"ndarray", "dtype"},
    "numpy.core.multiarray": {"_reconstruct", "scalar"},
    "builtins": {"slice"},
    "pandas.core.indexes.base": {"_new_Index", "Index"},
    "pandas.core.indexes.range": {"RangeIndex"},
    "pandas._libs.arrays": {"__pyx_unpickle_NDArrayBacked"},
    "pandas.core.arrays.datetimes": {"DatetimeArray"},
    "pandas.core.dtypes.dtypes": {"DatetimeTZDtype"},
    "datetime": {"timezone", "timedelta"},
    "pandas.core.arrays.string_arrow": {"ArrowStringArray"},
    "pyarrow.lib": {
        "_restore_array",
        "type_for_alias",
        "py_buffer",
        "Array",
        "_reconstruct_chunked_array",
    },
}


class Safe(pickle.Unpickler):
    def find_class(self, module, name):
        if name not in ALLOWED.get(module, set()):
            raise ValueError((module, name))
        return super().find_class(module, name)
