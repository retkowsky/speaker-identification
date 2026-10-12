import io
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
import numpy as np
import soundfile as sf

from app import ACCESS_COOKIE, ACCESS_TOKEN, app
from engine import AudioError, decode_audio, VoiceEngine
from vector_stores import AzureStore, BackendError
from projection import VoiceProjection

ROOT = Path(__file__).resolve().parents[1]


def wav(samples, rate=16000, format="WAV", subtype="PCM_16"):
    stream = io.BytesIO()
    sf.write(stream, samples, rate, format=format, subtype=subtype)
    return stream.getvalue()


class AudioValidationTests(unittest.TestCase):
    def test_stereo_resampling(self):
        rate = 44100
        tone = (0.1 * np.sin(2 * np.pi * 440 * np.arange(rate * 3) / rate)).astype(np.float32)
        audio, metadata = decode_audio(wav(np.column_stack([tone, tone]), rate))
        self.assertEqual(audio.shape, (48000,))
        self.assertEqual(metadata["original_channels"], 2)
        self.assertEqual(metadata["original_sample_rate"], rate)
        self.assertEqual(metadata["model_sample_rate"], 16000)
        self.assertTrue(np.isfinite(audio).all())

    def test_silence_rejected(self):
        with self.assertRaisesRegex(AudioError, "silent"):
            decode_audio(wav(np.zeros(48000)))

    def test_invalid_file_rejected(self):
        with self.assertRaisesRegex(AudioError, "decoded"):
            decode_audio(b"not an audio file")

    def test_duration_limits(self):
        for seconds in (1, 31):
            with self.subTest(seconds=seconds), self.assertRaisesRegex(AudioError, "2 and 30"):
                decode_audio(wav(np.ones(16000 * seconds) * 0.1))

    def test_non_wav_rejected(self):
        with self.assertRaisesRegex(AudioError, "Only WAV"):
            decode_audio(wav(np.ones(48000) * 0.1, format="FLAC"))

    def test_nonfinite_samples_rejected(self):
        samples = np.ones(48000, dtype=np.float32) * 0.1
        samples[5] = np.nan
        with self.assertRaisesRegex(AudioError, "invalid audio"):
            decode_audio(wav(samples, subtype="FLOAT"))

    def test_clipping_warning(self):
        _, metadata = decode_audio(wav(np.ones(48000)))
        self.assertTrue(metadata["warnings"])

    def test_empty_and_oversize(self):
        for payload in (b"", b"x" * (20 * 1024 * 1024 + 1)):
            with self.assertRaisesRegex(AudioError, "20 MB"):
                decode_audio(payload)


class RecognitionApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.data = Path(cls.temporary.name)
        (cls.data / "model").mkdir()
        (cls.data / "references").mkdir()
        shutil.copy2(ROOT / "data" / "model" / "embedding_model.ckpt", cls.data / "model")
        for filename in ("speaker_0001_segment_1.wav", "speaker_1272_segment_1.wav", "speaker_0001_segment_2.wav"):
            shutil.copy2(ROOT / "data" / "references" / filename, cls.data / "references")
        cls.engine = VoiceEngine(cls.data)
        app.state.engine = cls.engine
        cls.client = TestClient(app)
        cls.client.cookies.set(ACCESS_COOKIE, ACCESS_TOKEN)
        cls.reference = (cls.data / "references" / "speaker_0001_segment_1.wav").read_bytes()
        cls.held_out = (ROOT / "data" / "references" / "speaker_0001_segment_2.wav").read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls.engine.close()
        cls.temporary.cleanup()

    def setUp(self):
        self.engine._projection_cache.clear()
        self.engine._projection_cached_at.clear()
        self.engine._projection = None

    def post_audio(self, url, audio=None, **kwargs):
        return self.client.post(url, content=self.reference if audio is None else audio,
                                headers={"Content-Type": "audio/wav"}, **kwargs)

    def test_status_and_shapes(self):
        response = self.client.get("/api/status")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["speakers"], 2)
        self.assertEqual(response.json()["embedding_dimensions"], 192)
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertIn("frame-ancestors 'none'", response.headers["content-security-policy"])
        self.assertEqual(len(response.json()["library"]), 2)

    def test_api_requires_private_bootstrap_token(self):
        anonymous = TestClient(app)
        try:
            self.assertEqual(anonymous.get("/api/status").status_code, 401)
            self.assertEqual(anonymous.get("/").status_code, 401)
            response = anonymous.get(f"/?token={ACCESS_TOKEN}", follow_redirects=False)
            self.assertEqual(response.status_code, 303)
            self.assertNotIn("token=", response.headers["location"])
            self.assertIn("HttpOnly", response.headers["set-cookie"])
            self.assertEqual(anonymous.get("/api/status").status_code, 200)
        finally:
            anonymous.close()

    def test_constellation_projects_only_the_selected_backends_references(self):
        response = self.client.get("/api/constellation")
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result["method"], "pca")
        self.assertEqual(len(result["points"]), 2)
        self.assertIsNone(result["query"])
        self.assertTrue(all("z" in point for point in result["points"]))
        self.assertGreaterEqual(result["explained_variance_3d"], result["explained_variance"])
        self.assertFalse(any("embedding" in point for point in result["points"]))
        self.assertFalse(any(point["sample_id"].endswith("segment_2") for point in result["points"]))
        self.assertEqual(self.client.get("/api/constellation?backend=invalid").status_code, 422)
        self.assertEqual(result["backend"], "qdrant")
        rows = [{**row, "id": f"cloud-{index}", "sample_id": f"cloud-{index}", "name": f"Cloud {index}"}
                for index, row in enumerate(self.engine._reference_rows())]
        with patch.object(self.engine.azure, "reference_rows", return_value=rows) as references, \
                patch.object(self.engine, "_reference_rows", side_effect=AssertionError("Azure must not read local references")):
            cloud = self.client.get("/api/constellation?backend=azure").json()
        references.assert_called_once()
        self.assertTrue(cloud["available"])
        self.assertEqual(cloud["backend"], "azure")
        self.assertEqual({point["id"] for point in cloud["points"]}, {"cloud-0", "cloud-1"})
        self.assertFalse(any("embedding" in point for point in cloud["points"]))
        self.assertTrue(all("z" in point for point in cloud["points"]))

    def test_azure_projection_cache_tracks_source_and_explicit_invalidation(self):
        rows = self.engine._reference_rows()
        self.engine.constellation()
        local = self.engine._projection
        with patch.object(self.engine.azure, "reference_rows", return_value=rows) as references:
            self.engine.constellation("azure")
            cloud = self.engine._projection
            self.assertIsNot(local, cloud)
            self.engine.constellation("azure")
            self.assertIs(cloud, self.engine._projection)
            references.assert_called_once()
            with patch.object(self.engine.azure, "index_name", "different-index"):
                self.engine.constellation("azure")
                self.assertIsNot(cloud, self.engine._projection)
                cloud = self.engine._projection
                with patch.object(self.engine.azure, "endpoint", "https://different.search.windows.net"):
                    self.engine.constellation("azure")
                    self.assertIsNot(cloud, self.engine._projection)
            self.engine.constellation("azure")
            cloud = self.engine._projection
            with patch.object(self.engine.azure, "reference_rows", return_value=[{**rows[0], "name": "Renamed cloud voice"}]):
                self.engine.constellation("azure")
                self.assertIs(cloud, self.engine._projection)
                self.engine._invalidate_projection("azure")
                result = self.engine.constellation("azure")
                self.assertEqual(len(result["points"]), 1)
                self.assertEqual(result["points"][0]["name"], "Renamed cloud voice")
        self.assertEqual(self.engine.constellation()["backend"], "qdrant")

    def test_cloud_recognition_keeps_results_when_projection_fails_without_local_fallback(self):
        candidates = [{"id": "cloud-match", "name": "Cloud match", "score": .9, "samples": 1}]
        with patch.object(self.engine.azure, "search", return_value=candidates), \
                patch.object(self.engine.azure, "reference_rows", side_effect=BackendError("azureProjectionData", "Invalid test vectors")), \
                patch.object(self.engine, "_reference_rows", side_effect=AssertionError("No local fallback")):
            direct = self.client.get("/api/constellation?backend=azure")
            result = self.post_audio("/api/identify?backend=azure").json()
        self.assertEqual(direct.status_code, 503)
        self.assertEqual(direct.json()["code"], "azureProjectionData")
        self.assertEqual(result["speaker"]["id"], "cloud-match")
        self.assertEqual(result["constellation"], {"available": False, "reason": "azureProjectionData"})

    def test_cloud_identification_projects_its_query_and_never_returns_raw_vectors(self):
        source = self.engine._reference_rows()[0]
        rows = [{**source, "id": "cloud-match", "sample_id": "cloud-match", "name": "Cloud match"}]
        candidates = [{"id": "cloud-match", "name": "Cloud match", "score": .9, "samples": 1}]
        with patch.object(self.engine.azure, "search", return_value=candidates), \
                patch.object(self.engine.azure, "reference_rows", return_value=rows), \
                patch.object(self.engine, "_reference_rows", side_effect=AssertionError("No local fallback")):
            response = self.post_audio("/api/identify?backend=azure")
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result["backend"], "azure")
        self.assertTrue(result["constellation"]["available"])
        self.assertEqual(result["constellation"]["backend"], "azure")
        self.assertEqual(result["constellation"]["points"][0]["id"], result["speaker"]["id"])
        self.assertTrue(all(np.isfinite(value) for value in result["constellation"]["query"].values()))
        self.assertIn("score", result["constellation"]["points"][0])
        self.assertNotIn("audio_embeddings", response.text)
        self.assertNotIn('"embedding"', response.text)

    def test_constellation_cache_tracks_library_changes(self):
        self.engine.constellation()
        original = self.engine._projection
        self.engine.constellation()
        self.assertIs(original, self.engine._projection)
        enrolled = self.post_audio("/api/speakers?name=Map%20test").json()
        try:
            current = self.engine.constellation()
            self.assertIsNot(original, self.engine._projection)
            self.assertEqual(len(current["points"]), 3)
        finally:
            self.client.delete(f"/api/speakers/{enrolled['id']}")
        self.assertEqual(len(self.engine.constellation()["points"]), 2)

    def test_failed_map_is_explicit_without_losing_recognition(self):
        with patch.object(VoiceProjection, "snapshot", side_effect=ValueError("Invalid test vector")):
            response = self.client.get("/api/constellation")
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()["code"], "constellationUnavailable")
            result = self.post_audio("/api/identify").json()
        self.assertEqual(result["reason"], "matched")
        self.assertEqual(result["constellation"], {"available": False, "reason": "constellationUnavailable"})

    def test_identical_reference(self):
        with patch.object(self.engine, "_sync_qdrant", side_effect=AssertionError("Identify must not rebuild Qdrant")):
            response = self.post_audio("/api/identify")
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["speaker"]["name"], "Speaker 0001")
        self.assertGreater(result["candidates"][0]["score"], 0.999)
        self.assertEqual(len(result["candidates"]), 2)
        self.assertGreaterEqual(result["elapsed_seconds"], 0)
        self.assertAlmostEqual(result["elapsed_ms"], result["elapsed_seconds"] * 1000, delta=0.001)
        self.assertEqual(result["threshold"], 0.5)
        self.assertEqual(result["top_n"], 5)
        self.assertTrue(result["constellation"]["available"])
        query = result["constellation"]["query"]
        match = next(point for point in result["constellation"]["points"] if point["id"] == result["speaker"]["id"])
        self.assertAlmostEqual(query["x"], match["x"], places=4)
        self.assertAlmostEqual(query["y"], match["y"], places=4)
        self.assertAlmostEqual(query["z"], match["z"], places=4)
        self.assertIn("audio", result)

    @patch.object(AzureStore, "reference_rows", return_value=[])
    def test_top_n_controls_returned_candidates_for_both_backends(self, references):
        candidates = [
            {"id": f"speaker-{index}", "name": f"Speaker {index}", "score": 0.9 - index * 0.1}
            for index in range(8)
        ]
        for backend in ("qdrant", "azure"):
            for top_n in (1, 3, 5, 8, 1000):
                with self.subTest(backend=backend, top_n=top_n):
                    with patch.object(getattr(self.engine, backend), "search", return_value=candidates) as search:
                        response = self.post_audio(f"/api/identify?backend={backend}&top_n={top_n}")
                    self.assertEqual(response.status_code, 200, response.text)
                    result = response.json()
                    self.assertEqual(result["top_n"], top_n)
                    self.assertEqual(result["candidates"], candidates[:top_n])
                    self.assertEqual(search.call_args.kwargs["top_n"], max(2, top_n))
                    self.assertAlmostEqual(result["gap"], 0.1)
                    self.assertEqual(result["speaker"]["id"], "speaker-0")
                    if backend == "azure":
                        self.assertTrue(result["constellation"]["available"])
                        self.assertEqual(result["constellation"]["points"], [])
                        self.assertEqual(result["constellation"]["backend"], "azure")

    @patch.object(AzureStore, "reference_rows", return_value=[])
    def test_top_one_preserves_ambiguity_rejection(self, references):
        candidates = [
            {"id": "first", "name": "First", "score": 0.9},
            {"id": "second", "name": "Second", "score": 0.89},
        ]
        for backend in ("qdrant", "azure"):
            with self.subTest(backend=backend), patch.object(getattr(self.engine, backend), "search", return_value=candidates) as search:
                result = self.post_audio(f"/api/identify?backend={backend}&top_n=1").json()
                self.assertEqual(len(result["candidates"]), 1)
                self.assertEqual(search.call_args.kwargs["top_n"], 2)
                self.assertIsNone(result["speaker"])
                self.assertEqual(result["reason"], "ambiguous")
                self.assertAlmostEqual(result["gap"], 0.01)

    def test_invalid_top_n_is_rejected_before_inference(self):
        with patch.object(self.engine, "identify") as identify:
            for value in ("0", "-1", "1.5", "abc", ""):
                self.assertEqual(self.post_audio(f"/api/identify?top_n={value}").status_code, 422, value)
            identify.assert_not_called()

    def test_default_threshold_accepts_half_similarity(self):
        candidates = [
            {"id": "bundled-0001", "name": "Speaker 0001", "score": 0.5},
            {"id": "bundled-1272", "name": "Speaker 1272", "score": 0.2},
        ]
        with patch.object(self.engine.qdrant, "search", return_value=candidates):
            result = self.post_audio("/api/identify").json()
            self.assertEqual(result["reason"], "matched")
            self.assertEqual(result["threshold"], 0.5)
            candidates[0]["score"] = 0.499
            self.assertEqual(self.post_audio("/api/identify").json()["reason"], "below_threshold")

    def test_azure_settings_persist_without_cloud_access(self):
        url = "/api/backends/azure/configuration"
        original = self.client.get(url).json()
        config = {"endpoint": "https://unit.search.windows.net", "index_name": "unit-speakers"}
        try:
            with patch.object(AzureStore, "_connect", side_effect=AssertionError("Unexpected cloud access")) as connect:
                with patch.object(self.engine.azure, "key", ""):
                    response = self.client.put(url, json=config)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(set(response.json()), {"endpoint", "index_name", "authentication"})
                self.engine.close()
                type(self).engine = VoiceEngine(self.data)
                app.state.engine = self.engine
                restored = self.client.get(url).json()
                self.assertEqual(restored["endpoint"], config["endpoint"])
                self.assertEqual(restored["index_name"], config["index_name"])
                connect.assert_not_called()
                invalid = self.client.put(url, json={**config, "endpoint": "http://localhost:9000"})
                self.assertEqual(invalid.status_code, 503)
                self.assertEqual(invalid.json()["code"], "azureConfiguration")
                self.assertEqual(self.client.get(url).json(), restored)
                self.assertEqual(self.client.put(url, json=config, headers={"Origin": "https://evil.example"}).status_code, 403)
        finally:
            with patch.object(self.engine.azure, "key", ""):
                self.engine.configure_azure(original["endpoint"], original["index_name"])

    def test_held_out_recording(self):
        response = self.post_audio("/api/identify", self.held_out)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["candidates"][0]["name"], "Speaker 0001")
        self.assertEqual(result["reason"], "matched", result)
        print(f"\nHeld-out speaker_0001 segment 2: similarity={result['candidates'][0]['score']:.4f}, gap={result['gap']:.4f}")

    def test_strict_threshold_rejects_held_out(self):
        result = self.post_audio("/api/identify?threshold=1", self.held_out).json()
        self.assertIsNone(result["speaker"])
        self.assertEqual(result["reason"], "below_threshold")

    def test_enrollment_ambiguity_persistence_and_delete(self):
        response = self.post_audio("/api/speakers?name=Test%20Voice")
        self.assertEqual(response.status_code, 201, response.text)
        speaker_id = response.json()["id"]
        try:
            duplicate = self.post_audio("/api/speakers?name=test%20voice")
            self.assertEqual(duplicate.status_code, 422)
            result = self.post_audio("/api/identify").json()
            self.assertIsNone(result["speaker"])
            self.assertEqual(result["reason"], "ambiguous")
            self.engine.close()
            type(self).engine = VoiceEngine(self.data)
            app.state.engine = self.engine
            self.assertIn("Test Voice", [speaker["name"] for speaker in self.engine.speakers()])
            row = self.engine.db.execute("SELECT filename FROM samples WHERE speaker_id = ?", (speaker_id,)).fetchone()
            self.assertIsNone(row["filename"])
            self.assertEqual(len(list((self.data / "references").glob("*.wav"))), 3)
        finally:
            deleted = self.client.delete(f"/api/speakers/{speaker_id}")
            self.assertEqual(deleted.status_code, 204)
        self.assertEqual(self.client.delete(f"/api/speakers/{speaker_id}").status_code, 404)

    def test_bad_audio_reports_error(self):
        response = self.post_audio("/api/identify", b"invalid")
        self.assertEqual(response.status_code, 422)
        self.assertIn("decoded", response.json()["detail"])

    def test_enrollment_names_use_unicode_casefold_like_azure(self):
        for name, duplicate in [("\u00c9lodie", "\u00e9LODIE"), ("Stra\u00dfe", "STRASSE")]:
            with self.subTest(name=name):
                response = self.post_audio("/api/speakers", params={"name": name})
                self.assertEqual(response.status_code, 201, response.text)
                speaker_id = response.json()["id"]
                try:
                    response = self.post_audio("/api/speakers", params={"name": duplicate})
                    self.assertEqual(response.status_code, 422, response.text)
                    self.assertIn("already exists", response.json()["detail"])
                finally:
                    self.assertEqual(self.client.delete(f"/api/speakers/{speaker_id}").status_code, 204)

    def test_input_constraints(self):
        self.assertEqual(self.post_audio("/api/identify?threshold=2").status_code, 422)
        self.assertEqual(self.post_audio("/api/identify?min_gap=-1").status_code, 422)
        self.assertEqual(self.post_audio("/api/speakers?name=%20%20").status_code, 422)
        self.assertEqual(self.post_audio("/api/speakers?name=Speaker%200001").status_code, 422)
        self.assertEqual(self.client.post("/api/identify", content=self.reference).status_code, 415)
        self.assertEqual(self.post_audio("/api/identify", b"x" * (20 * 1024 * 1024 + 1)).status_code, 413)

    def test_reference_and_delete_protection(self):
        response = self.client.get("/api/references/speaker_0001_segment_1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, self.reference)
        self.assertEqual(self.client.get("/api/references/unknown").status_code, 404)
        self.assertEqual(self.client.delete("/api/speakers/bundled-0001").status_code, 422)

    def test_cross_origin_and_host_protection(self):
        self.assertEqual(self.client.post("/api/identify", headers={"Origin": "https://example.org"}).status_code, 403)
        self.assertEqual(self.client.get("/api/status", headers={"Host": "example.org"}).status_code, 400)

    def test_test_audio_is_held_out_and_playable(self):
        response = self.client.get("/api/test-audio")
        self.assertEqual(response.status_code, 200)
        samples = response.json()
        self.assertEqual(len(samples), 1)
        self.assertEqual(samples[0]["expected_speaker"]["id"], "bundled-0001")
        audio = self.client.get(f"/api/test-audio/{samples[0]['id']}")
        self.assertEqual(audio.content, self.held_out)
        self.assertEqual(self.client.get("/api/test-audio/speaker_0001_segment_1").status_code, 404)
        self.assertEqual(self.client.get("/api/test-audio/unknown").status_code, 404)
        self.assertEqual(self.engine.db.execute("SELECT COUNT(*) FROM samples").fetchone()[0], 2)
        result = self.post_audio("/api/identify?backend=qdrant", audio.content).json()
        self.assertEqual(result["backend"], "qdrant")
        self.assertLess(result["candidates"][0]["score"], 0.99)

    def test_backend_validation_and_unconfigured_azure(self):
        self.assertEqual(self.client.get("/api/status?backend=invalid").status_code, 422)
        with patch.object(self.engine.azure, "endpoint", ""):
            status = self.client.get("/api/status?backend=azure").json()
            self.assertFalse(status["ready"])
            self.assertEqual(status["reason"], "azureNotConfigured")
            with patch.object(self.engine.qdrant, "search") as local_search:
                response = self.post_audio("/api/identify?backend=azure")
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json()["code"], "azureNotConfigured")
                local_search.assert_not_called()
            self.assertEqual(self.client.post("/api/backends/azure/initialize", json={"consent": False}).status_code, 422)
            self.assertEqual(self.client.post("/api/backends/azure/initialize", json={"consent": True}).status_code, 503)

    def test_qdrant_is_used_and_failures_are_explicit(self):
        with patch.object(self.engine.qdrant, "search", wraps=self.engine.qdrant.search) as search, \
                patch.object(self.engine, "_sync_qdrant", side_effect=AssertionError("Identify must not synchronize")):
            self.assertEqual(self.post_audio("/api/identify").status_code, 200)
            search.assert_called_once()
        with patch.object(self.engine.qdrant, "search", side_effect=RuntimeError("query unavailable")), \
                patch.object(self.engine.azure, "search") as cloud_search:
            response = self.post_audio("/api/identify")
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()["code"], "qdrantUnavailable")
            cloud_search.assert_not_called()

    def test_z_migrate_old_segment_two_enrollment(self):
        with self.engine.db:
            row = self.engine.db.execute("SELECT embedding FROM samples WHERE id = 'speaker_0001_segment_1'").fetchone()
            self.engine.db.execute(
                "INSERT INTO samples VALUES (?, ?, ?, ?, ?)",
                ("speaker_0001_segment_2", "bundled-0001", row["embedding"], "speaker_0001_segment_2.wav", "old"),
            )
        self.engine._sync_qdrant()
        self.engine.close()
        type(self).engine = VoiceEngine(self.data)
        app.state.engine = self.engine
        self.assertEqual(self.engine.db.execute("SELECT COUNT(*) FROM samples").fetchone()[0], 2)
        self.assertEqual(self.engine.qdrant.client.count("speaker_embeddings", exact=True).count, 2)
        self.assertEqual(len(self.engine.test_audio()), 1)


if __name__ == "__main__":
    unittest.main()
