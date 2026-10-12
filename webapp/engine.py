"""Local ECAPA embeddings with separate Qdrant and Azure speaker libraries."""

import hashlib
import io
import logging
import math
from pathlib import Path
import re
import sqlite3
from threading import RLock
import time
import uuid

import numpy as np
from numpy.typing import NDArray
from scipy.signal import resample_poly
import soundfile as sf
import torch
from speechbrain.lobes.features import Fbank
from speechbrain.lobes.models.ECAPA_TDNN import ECAPA_TDNN
from speechbrain.processing.features import InputNormalization
from asset_integrity import verify_model
from vector_stores import AzureStore, BackendError, QdrantStore
from projection import VoiceProjection

LOGGER = logging.getLogger(__name__)
SAMPLE_RATE = 16000
MAX_BYTES = 20 * 1024 * 1024
MIN_SECONDS = 2
MAX_SECONDS = 30
EMBEDDING_SIZE = 192
AZURE_PROJECTION_TTL_SECONDS = 60


class AudioError(ValueError):
    pass


def decode_audio(payload: bytes) -> tuple[NDArray[np.float32], dict]:
    if not payload or len(payload) > MAX_BYTES:
        raise AudioError("Choose a non-empty WAV file smaller than 20 MB.")
    try:
        with sf.SoundFile(io.BytesIO(payload)) as audio:
            if audio.format not in {"WAV", "WAVEX", "RF64"}:
                raise AudioError("Only WAV audio is supported.")
            if not 8000 <= audio.samplerate <= 192000 or audio.channels not in {1, 2}:
                raise AudioError("Use mono or stereo WAV audio sampled at 8-192 kHz.")
            duration = audio.frames / audio.samplerate
            if not MIN_SECONDS <= duration <= MAX_SECONDS:
                raise AudioError("Provide between 2 and 30 seconds of speech.")
            rate = audio.samplerate
            channels = audio.channels
            samples = audio.read(dtype="float32", always_2d=True).mean(axis=1)
    except (sf.LibsndfileError, RuntimeError) as exc:
        raise AudioError("The WAV file could not be decoded. Export it as PCM WAV and retry.") from exc
    if not np.isfinite(samples).all():
        raise AudioError("The recording contains invalid audio samples.")
    rms = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))
    if rms < 0.001:
        raise AudioError("The recording is silent or too quiet. Move closer to the microphone.")
    clipping = float(np.mean(np.abs(samples) >= 0.999))
    if rate != SAMPLE_RATE:
        divisor = math.gcd(rate, SAMPLE_RATE)
        samples = resample_poly(samples, SAMPLE_RATE // divisor, rate // divisor).astype(np.float32)
    metadata = {
        "duration_seconds": round(duration, 2),
        "original_sample_rate": rate,
        "original_channels": channels,
        "model_sample_rate": SAMPLE_RATE,
        "warnings": ["Audio may be clipped. Try a lower recording level."] if clipping > 0.01 else [],
    }
    return samples, metadata


class VoiceEngine:
    def __init__(self, data: Path):
        self.data = data
        self.lock = RLock()
        self._projection: VoiceProjection | None = None
        self._projection_cache: dict[tuple[str, ...], VoiceProjection] = {}
        self._projection_cached_at: dict[tuple[str, ...], float] = {}
        weights = data / "model" / "embedding_model.ckpt"
        if not weights.is_file():
            raise FileNotFoundError("Model weights are missing. Run python prepare_assets.py first.")
        try:
            model_hash = verify_model(weights)
        except ValueError as exc:
            raise RuntimeError(str(exc)) from exc
        torch.set_num_threads(min(4, torch.get_num_threads()))
        self.features = Fbank(n_mels=80).eval()
        self.normalizer = InputNormalization(norm_type="sentence", std_norm=False).eval()
        self.model = ECAPA_TDNN(
            input_size=80,
            channels=[1024, 1024, 1024, 1024, 3072],
            kernel_sizes=[5, 3, 3, 3, 1],
            dilations=[1, 2, 3, 4, 1],
            attention_channels=128,
            lin_neurons=EMBEDDING_SIZE,
        ).eval()
        self.model.load_state_dict(torch.load(weights, map_location="cpu", weights_only=True))
        self.db = sqlite3.connect(data / "voices.sqlite3", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS speakers (
                id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                bundled INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS samples (
                id TEXT PRIMARY KEY, speaker_id TEXT NOT NULL REFERENCES speakers(id) ON DELETE CASCADE,
                embedding BLOB NOT NULL, filename TEXT, digest TEXT
            );
        """)
        existing = self.db.execute("SELECT value FROM settings WHERE key = 'model_hash'").fetchone()
        if existing and existing["value"] != model_hash:
            self.db.close()
            raise RuntimeError("Model weights changed. Back up and remove data/voices.sqlite3 to rebuild the library.")
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO settings VALUES ('model_hash', ?)", (model_hash,))
            # Earlier app versions enrolled both segments; keep notebook test clips held out.
            self.db.execute("""
                DELETE FROM samples WHERE speaker_id IN (SELECT id FROM speakers WHERE bundled = 1)
                AND filename GLOB 'speaker_*_segment_2.wav'
            """)
        self._seed_references()
        self.qdrant = QdrantStore(data / "qdrant")
        self.azure = AzureStore(model_hash)
        saved = dict(self.db.execute("SELECT key, value FROM settings WHERE key IN ('azure_endpoint', 'azure_index_name')"))
        if "azure_endpoint" in saved:
            self.azure.endpoint = saved["azure_endpoint"]
            self.azure.index_name = saved["azure_index_name"]
        self._sync_qdrant()

    def embed(self, samples: NDArray[np.float32]) -> NDArray[np.float32]:
        with self.lock, torch.inference_mode():
            waveform = torch.from_numpy(samples).unsqueeze(0)
            lengths = torch.ones(1)
            features = self.normalizer(self.features(waveform), lengths)
            embedding = self.model(features, lengths).squeeze().cpu().numpy().astype(np.float32)
            norm = float(np.linalg.norm(embedding))
            if not np.isfinite(embedding).all() or norm <= 0:
                raise AudioError("Could not compute a valid embedding. Try a clearer recording.")
            return embedding / norm

    def _seed_references(self) -> None:
        files = sorted((self.data / "references").glob("*_segment_1.wav"))
        if not files:
            raise FileNotFoundError("No reference WAVs found. Run python prepare_assets.py first.")
        with self.lock, self.db:
            for index, file in enumerate(files):
                match = re.fullmatch(r"speaker_(\d+)_segment_1\.wav", file.name)
                if not match:
                    raise ValueError(f"Unrecognized reference filename: {file.name}")
                speaker_id = f"bundled-{match[1]}"
                sample_id = file.stem
                payload = file.read_bytes()
                digest = hashlib.sha256(payload).hexdigest()
                cached = self.db.execute("SELECT digest FROM samples WHERE id = ?", (sample_id,)).fetchone()
                if cached and cached["digest"] == digest:
                    continue
                LOGGER.info("Embedding reference %d/%d: %s", index + 1, len(files), file.name)
                audio, _ = decode_audio(payload)
                embedding = self.embed(audio)
                self.db.execute(
                    "INSERT OR IGNORE INTO speakers (id, name, bundled) VALUES (?, ?, 1)",
                    (speaker_id, f"Speaker {match[1]}"),
                )
                self.db.execute(
                    "INSERT OR REPLACE INTO samples VALUES (?, ?, ?, ?, ?)",
                    (sample_id, speaker_id, embedding.tobytes(), file.name, digest),
                )

    def _reference_rows(self, bundled_only: bool = False) -> list[dict]:
        query = """
            SELECT s.id, s.name, a.id AS sample_id, a.embedding, a.filename
            FROM samples a JOIN speakers s ON s.id = a.speaker_id
        """
        if bundled_only:
            query += " WHERE s.bundled = 1"
        return [dict(row) for row in self.db.execute(query)]

    def _sync_qdrant(self) -> None:
        try:
            self.qdrant.sync(self._reference_rows())
        except (OSError, RuntimeError, ValueError, sqlite3.Error) as exc:
            LOGGER.error("Could not synchronize the local Qdrant collection: %s", type(exc).__name__)
            raise BackendError("qdrantUnavailable", "Local Qdrant storage is unavailable. Check the server logs and data folder.") from exc

    def backend_status(self, backend: str) -> dict:
        with self.lock:
            return self.azure.status() if backend == "azure" else {"ready": True, "configured": True, "reason": None}

    def azure_configuration(self) -> dict:
        with self.lock:
            return {
                "endpoint": self.azure.endpoint, "index_name": self.azure.index_name,
                "authentication": "api_key" if self.azure.key else "entra",
            }

    def configure_azure(self, endpoint: str, index_name: str) -> dict:
        with self.lock:
            endpoint, index_name = self.azure.validate_configuration(endpoint, index_name)
            with self.db:
                self.db.executemany(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                    [("azure_endpoint", endpoint), ("azure_index_name", index_name)],
                )
            self.azure.configure(endpoint, index_name)
            self._invalidate_projection("azure")
            return self.azure_configuration()

    def initialize_azure(self) -> dict:
        with self.lock:
            references = self._reference_rows(bundled_only=True)
            self.azure.initialize(references)
            self._invalidate_projection("azure")
            return {"initialized": True, "references": len(references)}

    def test_audio(self) -> list[dict]:
        samples = []
        for file in sorted((self.data / "references").glob("*_segment_2.wav")):
            match = re.fullmatch(r"speaker_(\d+)_segment_2\.wav", file.name)
            if not match:
                raise ValueError(f"Unrecognized test filename: {file.name}")
            samples.append({
                "id": file.stem, "filename": file.name,
                "expected_speaker": {"id": f"bundled-{match[1]}", "name": f"Speaker {match[1]}"},
            })
        return samples

    def test_audio_path(self, sample_id: str) -> Path:
        sample = next((sample for sample in self.test_audio() if sample["id"] == sample_id), None)
        if sample is None:
            raise KeyError("Test audio not found.")
        return self.data / "references" / sample["filename"]

    def speakers(self, backend: str = "qdrant") -> list[dict]:
        with self.lock:
            if backend == "azure":
                return self.azure.speakers()
            return [dict(row) for row in self.db.execute("""
                SELECT s.id, s.name, s.bundled, s.created_at, COUNT(a.id) AS samples,
                       MIN(CASE WHEN a.filename IS NOT NULL THEN a.id END) AS reference_id
                FROM speakers s LEFT JOIN samples a ON s.id = a.speaker_id
                GROUP BY s.id ORDER BY s.bundled, s.name COLLATE NOCASE
            """)]

    def constellation(self, backend: str = "qdrant", query: NDArray[np.float32] | None = None) -> dict:
        with self.lock:
            try:
                source = (backend, self.azure.endpoint, self.azure.index_name) if backend == "azure" else (backend,)
                self._projection = self._projection_cache.get(source)
                if (
                    backend == "azure" and self._projection is not None
                    and time.monotonic() - self._projection_cached_at[source] >= AZURE_PROJECTION_TTL_SECONDS
                ):
                    self._projection = None
                if self._projection is None:
                    rows = sorted(
                        self.azure.reference_rows() if backend == "azure" else self._reference_rows(),
                        key=lambda row: row["sample_id"],
                    )
                    self._projection = VoiceProjection(rows)
                    self._projection_cache[source] = self._projection
                    self._projection_cached_at[source] = time.monotonic()
                return {**self._projection.snapshot(query), "backend": backend}
            except BackendError as exc:
                LOGGER.error("Embedding projection failed for %s: %s", backend, exc.code)
                raise
            except (ValueError, np.linalg.LinAlgError, sqlite3.Error) as exc:
                LOGGER.error("Embedding projection failed for %s: %s", backend, type(exc).__name__)
                raise BackendError("constellationUnavailable", "The voice projection could not be computed.") from exc

    def identify(self, payload: bytes, threshold: float, min_gap: float, backend: str = "qdrant", top_n: int = 5) -> dict:
        samples, metadata = decode_audio(payload)
        embedding = self.embed(samples)
        search_count = max(2, top_n)
        with self.lock:
            if backend == "azure":
                candidates = self.azure.search(embedding, top_n=search_count)
            else:
                try:
                    candidates = self.qdrant.search(embedding, top_n=search_count)
                except (OSError, RuntimeError, ValueError, sqlite3.Error) as exc:
                    LOGGER.error("Could not query the local Qdrant collection: %s", type(exc).__name__)
                    raise BackendError("qdrantUnavailable", "Local Qdrant storage is unavailable. Check the server logs and data folder.") from exc
            try:
                constellation = self.constellation(backend, embedding)
            except BackendError as exc:
                constellation = {"available": False, "reason": exc.code}
        gap = candidates[0]["score"] - candidates[1]["score"] if len(candidates) > 1 else None
        accepted = bool(candidates and candidates[0]["score"] >= threshold and (gap is None or gap >= min_gap))
        reason = "matched" if accepted else (
            "empty_library" if not candidates else
            "below_threshold" if candidates[0]["score"] < threshold else "ambiguous"
        )
        return {
            "speaker": candidates[0] if accepted else None,
            "reason": reason,
            "candidates": candidates[:top_n],
            "top_n": top_n,
            "gap": gap,
            "threshold": threshold,
            "min_gap": min_gap,
            "audio": metadata,
            "backend": backend,
            "constellation": constellation,
        }

    def enroll(self, name: str, payload: bytes, backend: str = "qdrant") -> dict:
        name = name.strip()
        if not 1 <= len(name) <= 60 or any(ord(character) < 32 for character in name):
            raise ValueError("Enter a speaker name of 1-60 characters without control characters.")
        samples, metadata = decode_audio(payload)
        embedding = self.embed(samples)
        if backend == "azure":
            with self.lock:
                speaker_id = self.azure.enroll(name, embedding)
                self._invalidate_projection("azure")
            return {"id": speaker_id, "name": name, "audio": metadata, "backend": backend}
        speaker_id = str(uuid.uuid4())
        with self.lock, self.db:
            if any(row["name"].casefold() == name.casefold() for row in self.db.execute("SELECT name FROM speakers")):
                raise ValueError("That speaker name already exists. Choose a different name.")
            self.db.execute("INSERT INTO speakers (id, name, bundled) VALUES (?, ?, 0)", (speaker_id, name))
            self.db.execute(
                "INSERT INTO samples VALUES (?, ?, ?, NULL, NULL)",
                (str(uuid.uuid4()), speaker_id, embedding.tobytes()),
            )
            self._sync_qdrant()
            self._invalidate_projection("qdrant")
        return {"id": speaker_id, "name": name, "audio": metadata, "backend": backend}

    def delete(self, speaker_id: str, backend: str = "qdrant") -> None:
        with self.lock, self.db:
            if backend == "azure":
                self.azure.delete(speaker_id)
                self._invalidate_projection("azure")
                return
            row = self.db.execute("SELECT bundled FROM speakers WHERE id = ?", (speaker_id,)).fetchone()
            if row is None:
                raise KeyError("Speaker not found.")
            if row["bundled"]:
                raise ValueError("Bundled reference speakers cannot be deleted from the app.")
            self.db.execute("DELETE FROM speakers WHERE id = ?", (speaker_id,))
            self._sync_qdrant()
            self._invalidate_projection("qdrant")

    def _invalidate_projection(self, backend: str) -> None:
        self._projection_cache = {
            source: projection
            for source, projection in self._projection_cache.items()
            if source[0] != backend
        }
        self._projection_cached_at = {
            source: cached_at
            for source, cached_at in self._projection_cached_at.items()
            if source[0] != backend
        }
        self._projection = None

    def reference_path(self, reference_id: str) -> Path:
        with self.lock:
            row = self.db.execute("SELECT filename FROM samples WHERE id = ?", (reference_id,)).fetchone()
            if row is None or row["filename"] is None:
                raise KeyError("Reference audio not found.")
            return self.data / "references" / row["filename"]

    def close(self) -> None:
        with self.lock:
            self.qdrant.close()
            self.azure.close()
            self.db.close()
