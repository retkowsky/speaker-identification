"""Reference-fitted PCA computed locally for either backend's embedding map."""

import numpy as np
from numpy.typing import NDArray


class VoiceProjection:
    def __init__(self, rows: list[dict]):
        self.rows = sorted(rows, key=lambda row: row["sample_id"])
        self.vectors = np.array(
            [np.frombuffer(row["embedding"], dtype=np.float32) for row in self.rows], dtype=np.float64,
        ) if rows else np.empty((0, 192), dtype=np.float64)
        if self.vectors.shape != (len(rows), 192) or not np.isfinite(self.vectors).all():
            raise ValueError("Invalid reference embeddings for projection.")
        self.mean = self.vectors.mean(axis=0) if rows else np.zeros(192)
        self.components = np.zeros((3, 192))
        self.variance = 0.0
        self.variance_3d = 0.0
        self.rank = 0
        if len(rows) > 1:
            centered = self.vectors - self.mean
            _, singular, components = np.linalg.svd(centered, full_matrices=False)
            tolerance = np.finfo(np.float64).eps * max(centered.shape) * singular[0]
            self.rank = min(3, int(np.count_nonzero(singular > tolerance)))
            for index in range(self.rank):
                axis = components[index]
                # Resolve the arbitrary SVD sign so unchanged libraries stay oriented consistently.
                self.components[index] = axis if axis[np.argmax(np.abs(axis))] >= 0 else -axis
            energy = float(np.sum(singular ** 2))
            self.variance = float(np.sum(singular[:2] ** 2) / energy) if energy else 0.0
            self.variance_3d = float(np.sum(singular[:3] ** 2) / energy) if energy else 0.0
        self.coordinates = (self.vectors - self.mean) @ self.components.T

    def snapshot(self, query: NDArray[np.float32] | None = None) -> dict:
        points = [
            {"id": row["id"], "name": row["name"], "sample_id": row["sample_id"],
             "x": float(xy[0]), "y": float(xy[1]), "z": float(xy[2])}
            for row, xy in zip(self.rows, self.coordinates)
        ]
        position = None
        if query is not None:
            if query.shape != (192,) or not np.isfinite(query).all():
                raise ValueError("Invalid query embedding for projection.")
            xy = (query - self.mean) @ self.components.T
            position = {"x": float(xy[0]), "y": float(xy[1]), "z": float(xy[2])}
            # Use the same maximum-sample cosine rule as recognition, not projected distance.
            scores = self.vectors @ query
            for point, score in zip(points, scores):
                point["score"] = float(np.clip(score, -1, 1))
        return {
            "available": True, "method": "pca", "dimensions": 192,
            "points": points, "query": position, "explained_variance": self.variance,
            "rank": self.rank, "explained_variance_3d": self.variance_3d,
        }
