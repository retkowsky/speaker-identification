import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

from azure.core import MatchConditions
from azure.core.exceptions import HttpResponseError, ResourceNotFoundError, ServiceResponseError
from azure.core.paging import ItemPaged
from azure.search.documents.indexes.models import (
    HnswAlgorithmConfiguration, HnswParameters, SearchField, SearchFieldDataType, SearchIndex,
    SimpleField, VectorSearch, VectorSearchProfile,
)
import numpy as np

from vector_stores import AZURE_FIELDS, AzureStore, BackendError, QdrantStore, azure_cosine


def embedding():
    vector = np.zeros(192, dtype=np.float32)
    vector[0] = 1
    return vector


def compatible_index(description):
    return SearchIndex(
        name="speaker-identification", description=description,
        fields=[
            SimpleField(name=name, type=SearchFieldDataType.String, key=name == "id")
            for name in AZURE_FIELDS
        ] + [SearchField(name="audio_embeddings", type=SearchFieldDataType.Collection(SearchFieldDataType.Single),
                         searchable=True, hidden=False, vector_search_dimensions=192, vector_search_profile_name="cosine")],
        vector_search=VectorSearch(
            algorithms=[HnswAlgorithmConfiguration(name="hnsw", parameters=HnswParameters(metric="cosine"))],
            profiles=[VectorSearchProfile(name="cosine", algorithm_configuration_name="hnsw")],
        ),
    )


class QdrantTests(unittest.TestCase):
    def test_top_n_can_exceed_five_and_counts_distinct_speakers(self):
        with tempfile.TemporaryDirectory() as directory:
            store = QdrantStore(Path(directory))
            rows = [
                {"id": f"speaker-{index}", "name": f"Speaker {index}", "sample_id": f"sample-{index}",
                 "embedding": embedding().tobytes()}
                for index in range(8)
            ]
            rows.append({**rows[0], "sample_id": "second-sample"})
            try:
                store.sync(rows)
                self.assertEqual(len(store.search(embedding())), 5)
                for top_n in (1, 3, 7, 8, 1000):
                    candidates = store.search(embedding(), top_n=top_n)
                    self.assertEqual(len(candidates), min(top_n, 8))
                    self.assertEqual(len({candidate["id"] for candidate in candidates}), len(candidates))
            finally:
                store.close()

    def test_real_qdrant_search_persistence_and_stale_removal(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            rows = [{"id": "one", "name": "First", "sample_id": "a", "embedding": embedding().tobytes()}]
            store = QdrantStore(path)
            try:
                store.sync(rows)
                candidates = store.search(embedding())
                self.assertEqual(candidates[0]["id"], "one")
                self.assertAlmostEqual(candidates[0]["score"], 1)
            finally:
                store.close()
            restored = QdrantStore(path)
            try:
                self.assertEqual(restored.search(embedding())[0]["id"], "one")
                restored.sync([])
                self.assertEqual(restored.search(embedding()), [])
            finally:
                restored.close()


class AzureStoreTests(unittest.TestCase):
    def setUp(self):
        with patch.dict("os.environ", {"AZURE_SEARCH_ENDPOINT": "https://unit.search.windows.net",
                                      "AZURE_SEARCH_INDEX": "speaker-identification", "AZURE_SEARCH_API_KEY": ""}):
            self.store = AzureStore("model-hash")
        self.store.client = MagicMock()
        self.store.client.get_document_count.return_value = 41
        self.store.index_client = MagicMock()
        self.store.index_client.get_index.return_value = compatible_index(self.store.description)
        self.store.client.upload_documents.side_effect = lambda documents: [SimpleNamespace(succeeded=True) for _ in documents]
        self.store.client.get_document.side_effect = ResourceNotFoundError("missing")

    def tearDown(self):
        self.store.close()

    def test_score_conversion(self):
        for cosine in (-1, 0, 0.65, 0.9, 1):
            self.assertAlmostEqual(azure_cosine(1 / (2 - cosine)), cosine)
        for invalid in (0, -1, float("nan"), float("inf"), 1.2):
            with self.assertRaises(BackendError):
                azure_cosine(invalid)

    def test_reconfiguration_closes_clients_without_connecting(self):
        client, index_client = self.store.client, self.store.index_client
        with patch.object(self.store, "_connect") as connect:
            self.store.configure(" https://next.search.windows.net/ ", " next-speakers ")
            self.assertEqual(self.store.endpoint, "https://next.search.windows.net")
            self.assertEqual(self.store.index_name, "next-speakers")
            self.assertIsNone(self.store.client)
            self.assertIsNone(self.store.index_client)
            client.close.assert_called_once()
            index_client.close.assert_called_once()
            connect.assert_not_called()
        self.store.configure("", "speaker-identification")
        self.assertFalse(self.store.configured)

    def test_server_key_cannot_be_forwarded_to_another_service(self):
        self.store.key = "unit-test-key"
        with self.assertRaises(BackendError) as failure:
            self.store.configure("https://another.search.windows.net", "speaker-identification")
        self.assertEqual(failure.exception.code, "azureKeyEndpoint")
        self.assertEqual(self.store.endpoint, "https://unit.search.windows.net")
        self.store.client.close.assert_not_called()
        self.store.configure("https://unit.search.windows.net", "another-index")

    def test_vector_query_and_scores(self):
        self.store.client.search.return_value = [
            {"id": "bundled-0001", "speaker_name": "Speaker 0001", "@search.score": 1 / (2 - 0.8)},
        ]
        candidates = self.store.search(embedding())
        self.assertAlmostEqual(candidates[0]["score"], 0.8)
        kwargs = self.store.client.search.call_args.kwargs
        self.assertIsNone(kwargs["search_text"])
        query = kwargs["vector_queries"][0]
        self.assertEqual(query.fields, "audio_embeddings")
        self.assertTrue(query.exhaustive)
        self.assertEqual(query.k_nearest_neighbors, 5)
        self.assertEqual(len(query.vector), 192)

    def test_top_n_sets_azure_vector_k_and_result_count(self):
        self.store.client.search.return_value = [
            {"id": f"speaker-{index}", "speaker_name": f"Speaker {index}", "@search.score": 1 / (2 - 0.8)}
            for index in range(7)
        ]
        candidates = self.store.search(embedding(), top_n=7)
        self.assertEqual(len(candidates), 7)
        kwargs = self.store.client.search.call_args.kwargs
        self.assertEqual(kwargs["vector_queries"][0].k_nearest_neighbors, 7)
        self.assertEqual(kwargs["top"], 7)
        self.store.search(embedding(), top_n=1000)
        kwargs = self.store.client.search.call_args.kwargs
        self.assertEqual(kwargs["vector_queries"][0].k_nearest_neighbors, 41)
        self.assertEqual(kwargs["top"], 41)
        self.store.client.get_document_count.return_value = 1
        self.store.search(embedding(), top_n=2)
        self.assertEqual(self.store.client.search.call_args.kwargs["top"], 2)

    def test_initialize_creates_dedicated_cosine_index(self):
        self.store.index_client.get_index.side_effect = ResourceNotFoundError("missing")
        self.store.initialize([{
            "id": "bundled-0001", "name": "Speaker 0001",
            "filename": "speaker_0001_segment_1.wav", "embedding": embedding().tobytes(),
        }])
        index = self.store.index_client.create_index.call_args.args[0]
        self.assertEqual(index.description, self.store.description)
        self.assertEqual(index.vector_search.algorithms[0].parameters.metric, "cosine")
        self.assertFalse(next(field for field in index.fields if field.name == "audio_embeddings").hidden)
        documents = self.store.client.upload_documents.call_args.kwargs["documents"]
        self.assertTrue(documents[0]["bundled"])
        self.assertEqual(documents[0]["id"], "bundled-0001")
        self.assertEqual(len(documents[0]["audio_embeddings"]), 192)
        self.assertNotIn("audio", documents[0])

    def test_never_overwrites_unrelated_index(self):
        self.store.index_client.get_index.return_value.description = "another-app"
        with self.assertRaisesRegex(BackendError, "dedicated index"):
            self.store.initialize([])
        self.store.index_client.create_index.assert_not_called()
        self.store.client.upload_documents.assert_not_called()

    def test_existing_index_is_not_recreated(self):
        self.store.initialize([])
        self.store.index_client.create_index.assert_not_called()

    def test_reference_rows_retrieve_all_pages_and_normalize_real_cloud_vectors(self):
        first = {"id": "cloud-one", "speaker_name": "Cloud one", "audio_embeddings": (embedding() * 2).tolist()}
        second = {"id": "cloud-two", "speaker_name": "Cloud two", "audio_embeddings": (-embedding()).tolist()}
        pages = iter([("next", [first]), (None, [second])])
        tokens = []
        def get_next(token):
            tokens.append(token)
            return next(pages)
        self.store.client.search.return_value = ItemPaged(get_next, lambda response: response)
        rows = self.store.reference_rows()
        self.assertEqual(tokens, [None, "next"])
        self.assertEqual([row["sample_id"] for row in rows], ["cloud-one", "cloud-two"])
        self.assertEqual([row["name"] for row in rows], ["Cloud one", "Cloud two"])
        np.testing.assert_array_equal(np.frombuffer(rows[0]["embedding"], dtype=np.float32), embedding())
        np.testing.assert_array_equal(np.frombuffer(rows[1]["embedding"], dtype=np.float32), -embedding())
        self.store.client.search.assert_called_once_with(search_text="*", select=["id", "speaker_name", "audio_embeddings"])
        self.store.index_client.create_or_update_index.assert_not_called()

    def test_hidden_vectors_are_enabled_without_recreating_or_uploading_documents(self):
        index = self.store.index_client.get_index.return_value
        index.e_tag = "test-etag"
        field = next(field for field in index.fields if field.name == "audio_embeddings")
        field.hidden = True
        self.store.client.search.return_value = []
        self.assertEqual(self.store.reference_rows(), [])
        self.assertFalse(field.hidden)
        self.store.index_client.create_or_update_index.assert_called_once_with(index, match_condition=MatchConditions.IfNotModified)
        self.store.index_client.create_index.assert_not_called()
        self.store.client.upload_documents.assert_not_called()
        self.store.client.delete_documents.assert_not_called()
        self.assertEqual(index.e_tag, "test-etag")

    def test_unstored_or_unrelated_indexes_are_not_modified_for_projection(self):
        for incompatible in ("unstored", "unrelated"):
            with self.subTest(incompatible=incompatible):
                index = compatible_index(self.store.description)
                if incompatible == "unstored":
                    next(field for field in index.fields if field.name == "audio_embeddings").stored = False
                else:
                    index.description = "different-app"
                self.store.index_client.get_index.return_value = index
                with self.assertRaises(BackendError) as failure:
                    self.store.reference_rows()
                self.assertEqual(failure.exception.code, "azureProjectionStorage" if incompatible == "unstored" else "azureSchema")
        self.store.index_client.create_or_update_index.assert_not_called()
        self.store.client.search.assert_not_called()

    def test_invalid_cloud_vectors_or_duplicate_ids_never_return_partial_reference_rows(self):
        valid = {"id": "cloud-one", "speaker_name": "Cloud one", "audio_embeddings": embedding().tolist()}
        invalid_documents = [
            {**valid, "id": None}, {**valid, "speaker_name": None},
            {**valid, "audio_embeddings": None}, {**valid, "audio_embeddings": [1, 2]},
            {**valid, "audio_embeddings": [0] * 192}, {**valid, "audio_embeddings": [float("nan")] * 192},
            {**valid, "audio_embeddings": [float("inf")] * 192},
            {**valid, "audio_embeddings": ["invalid"] * 192},
        ]
        for document in invalid_documents:
            with self.subTest(document=document["id"]), self.assertRaises(BackendError) as failure:
                self.store.client.search.return_value = [{**valid, "id": "first"}, document]
                self.store.reference_rows()
            self.assertEqual(failure.exception.code, "azureProjectionData")
        self.store.client.search.return_value = [valid, valid]
        with self.assertRaises(BackendError) as failure:
            self.store.reference_rows()
        self.assertEqual(failure.exception.code, "azureProjectionData")

    def test_later_page_or_schema_update_failures_are_explicit(self):
        calls = 0
        def get_next(token):
            nonlocal calls
            calls += 1
            if token:
                raise ServiceResponseError("page unavailable")
            return "next", [{"id": "one", "speaker_name": "One", "audio_embeddings": embedding().tolist()}]
        self.store.client.search.return_value = ItemPaged(get_next, lambda response: response)
        with self.assertRaises(BackendError) as failure:
            self.store.reference_rows()
        self.assertEqual(calls, 2)
        self.assertEqual(failure.exception.code, "azureRequestFailed")
        field = next(field for field in self.store.index_client.get_index.return_value.fields if field.name == "audio_embeddings")
        field.hidden = True
        self.store.index_client.create_or_update_index.side_effect = HttpResponseError("schema permissions denied")
        self.store.client.search.reset_mock()
        with self.assertRaises(BackendError) as failure:
            self.store.reference_rows()
        self.assertEqual(failure.exception.code, "azureRequestFailed")
        self.store.client.search.assert_not_called()

    def test_partial_upload_and_auth_errors_are_not_success(self):
        self.store.client.upload_documents.side_effect = None
        self.store.client.upload_documents.return_value = [SimpleNamespace(succeeded=False)]
        with self.assertRaises(BackendError) as failure:
            self.store.enroll("Test", embedding())
        self.assertEqual(failure.exception.code, "azureUploadFailed")
        self.store.index_client.get_index.side_effect = HttpResponseError("unauthorized")
        with self.assertRaises(BackendError) as failure:
            self.store.status()
        self.assertEqual(failure.exception.code, "azureRequestFailed")

    def test_enrollment_and_cloud_only_library(self):
        speaker_id = self.store.enroll("O'Brien", embedding())
        self.store.client.get_document.assert_called_once_with(speaker_id, selected_fields=["id"])
        document = self.store.client.upload_documents.call_args.kwargs["documents"][0]
        self.assertEqual(document["speaker_name"], "O'Brien")
        self.assertFalse(document["bundled"])
        self.store.client.search.return_value = [document]
        speakers = self.store.speakers()
        self.assertEqual(speakers[0]["id"], speaker_id)
        self.assertIsNone(speakers[0]["reference_id"])
        self.store.client.get_document.side_effect = None
        self.store.client.get_document.return_value = {"id": speaker_id}
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.store.enroll("O'Brien", embedding())
        self.store.client.upload_documents.assert_called_once()

    def test_delete_protects_bundled_and_confirms_write(self):
        self.store.client.get_document.side_effect = None
        self.store.client.get_document.return_value = {"id": "bundled-1", "bundled": True}
        with self.assertRaises(ValueError):
            self.store.delete("bundled-1")
        self.store.client.delete_documents.assert_not_called()
        self.store.client.get_document.return_value = {"id": "custom", "bundled": False}
        self.store.client.delete_documents.return_value = [SimpleNamespace(succeeded=True)]
        self.store.delete("custom")
        self.store.client.delete_documents.assert_called_once_with(documents=[{"id": "custom"}])
        self.store.client.delete_documents.return_value = [SimpleNamespace(succeeded=False)]
        with self.assertRaises(BackendError):
            self.store.delete("custom")

    def test_missing_configuration_never_connects(self):
        self.store.endpoint = ""
        self.assertEqual(self.store.status()["reason"], "azureNotConfigured")
        self.store.index_client.get_index.assert_not_called()
        with self.assertRaises(BackendError):
            self.store.search(embedding())

    def test_invalid_endpoint_rejected(self):
        self.store.endpoint = "https://not-a-search-service.example"
        with self.assertRaises(BackendError):
            self.store.status()
        self.store.index_client.get_index.assert_not_called()


if __name__ == "__main__":
    unittest.main()
