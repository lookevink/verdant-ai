"""Integrity boundaries: HTTP number encoding, missingness, corruption and pickle globals."""

import copy
import io
import pickle
import unittest

from backtest_common import content, digest, reconstruct
from forecast_pickle import Safe


class IntegrityTests(unittest.TestCase):
    def fixture(self):
        dataset = {
            "id": "test",
            "metadata": {"tables": {"study": {"labels": [{"arm": "control"}]}}},
        }
        rows = [
            {
                "id": "one",
                "variable": "yield",
                "value": 1.0,
                "dimensions": {"table": "study", "row": 0},
            }
        ]
        dataset["content_sha256"] = digest(content(dataset, rows))
        return dataset, rows

    def test_http_integral_number_encoding(self):
        dataset, rows = self.fixture()
        rows[0]["value"] = 1
        self.assertEqual(reconstruct(dataset, rows)["study"][0]["yield"], 1)

    def test_null_is_not_zero(self):
        self.assertNotEqual(digest({"value": None}), digest({"value": 0}))

    def test_changed_value_rejected(self):
        dataset, rows = self.fixture()
        rows[0]["value"] = 2
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            reconstruct(dataset, rows)

    def test_duplicate_cells_rejected_even_with_valid_digest(self):
        dataset, rows = self.fixture()
        duplicate = copy.deepcopy(rows[0])
        duplicate["id"] = "two"
        rows.append(duplicate)
        dataset["content_sha256"] = digest(content(dataset, rows))
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            reconstruct(dataset, rows)

    def test_pickle_cannot_invoke_arbitrary_globals(self):
        class Payload:
            def __reduce__(self):
                return eval, ("1 + 1",)

        with self.assertRaises(ValueError):
            Safe(io.BytesIO(pickle.dumps(Payload()))).load()


if __name__ == "__main__":
    unittest.main()
