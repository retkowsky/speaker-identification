import unittest

import numpy as np

from projection import VoiceProjection


def row(index, x, y, z=0):
    vector = np.zeros(192, dtype=np.float32)
    vector[:3] = [x, y, z]
    return {"id": f"speaker-{index}", "name": f"Speaker {index}", "sample_id": f"sample-{index}",
            "embedding": vector.tobytes()}


class ProjectionTests(unittest.TestCase):
    def test_projection_uses_real_vectors_and_preserves_planar_distances(self):
        rows = [row(1, 1, 0), row(2, -1, 0), row(3, 0, 1), row(4, 0, -1)]
        projection = VoiceProjection(rows)
        result = projection.snapshot()
        self.assertEqual(result["rank"], 2)
        self.assertAlmostEqual(result["explained_variance"], 1)
        coordinates = np.array([[point["x"], point["y"]] for point in result["points"]])
        vectors = projection.vectors
        np.testing.assert_allclose(
            np.linalg.norm(coordinates[:, None] - coordinates[None, :], axis=2),
            np.linalg.norm(vectors[:, None] - vectors[None, :], axis=2), atol=1e-12,
        )
        self.assertEqual(result["dimensions"], 192)
        self.assertNotIn("embedding", result["points"][0])

    def test_query_does_not_refit_or_move_reference_points(self):
        rows = [row(1, 1, 0), row(2, -1, 0), row(3, 0, 1)]
        projection = VoiceProjection(rows)
        before = projection.snapshot()
        query = np.frombuffer(rows[0]["embedding"], dtype=np.float32)
        after = projection.snapshot(query)
        for first, second in zip(before["points"], after["points"]):
            self.assertEqual(tuple(first[axis] for axis in "xyz"), tuple(second[axis] for axis in "xyz"))
        self.assertEqual(after["query"], {axis: after["points"][0][axis] for axis in "xyz"})
        self.assertEqual([point["score"] for point in after["points"]], [1, -1, 0])
        self.assertEqual(VoiceProjection(list(reversed(rows))).snapshot(), before)

    def test_empty_single_and_identical_references_have_explicit_low_rank(self):
        for rows in ([], [row(1, 1, 0)], [row(1, 1, 0), row(2, 1, 0)]):
            result = VoiceProjection(rows).snapshot()
            self.assertEqual(result["rank"], 0)
            self.assertEqual(result["explained_variance"], 0)
            self.assertEqual(len(result["points"]), len(rows))
            self.assertTrue(all(point["x"] == point["y"] == point["z"] == 0 for point in result["points"]))
            self.assertEqual(result["explained_variance_3d"], 0)

    def test_real_third_component_preserves_spatial_distances_and_reports_variance(self):
        rows = [row(1, 1, 0), row(2, -1, 0), row(3, 0, 1), row(4, 0, -1),
                row(5, 0, 0, 1), row(6, 0, 0, -1)]
        projection = VoiceProjection(rows)
        result = projection.snapshot()
        self.assertEqual(result["rank"], 3)
        self.assertAlmostEqual(result["explained_variance"], 2 / 3)
        self.assertAlmostEqual(result["explained_variance_3d"], 1)
        coordinates = np.array([[point[axis] for axis in "xyz"] for point in result["points"]])
        np.testing.assert_allclose(
            np.linalg.norm(coordinates[:, None] - coordinates[None, :], axis=2),
            np.linalg.norm(projection.vectors[:, None] - projection.vectors[None, :], axis=2),
            atol=1e-12,
        )
        self.assertGreater(np.ptp(coordinates[:, 2]), 0)
        self.assertEqual(VoiceProjection(list(reversed(rows))).snapshot(), result)
        for index, source in enumerate(rows):
            snapshot = projection.snapshot(np.frombuffer(source["embedding"], dtype=np.float32))
            self.assertEqual(snapshot["query"], {axis: result["points"][index][axis] for axis in "xyz"})

    def test_nonfinite_or_wrong_sized_vectors_are_rejected(self):
        for vector in (np.zeros(3, dtype=np.float32), np.full(192, np.nan, dtype=np.float32)):
            invalid = {**row(1, 1, 0), "embedding": vector.tobytes()}
            with self.assertRaises(ValueError):
                VoiceProjection([invalid])
        projection = VoiceProjection([row(1, 1, 0)])
        for query in (np.zeros(3), np.full(192, np.inf)):
            with self.assertRaises(ValueError):
                projection.snapshot(query)


if __name__ == "__main__":
    unittest.main()
