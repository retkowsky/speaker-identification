"""Vector search providers. Audio encoding stays local for both providers."""

from contextlib import contextmanager
from datetime import datetime, timezone
import logging
import math
import os
from pathlib import Path
import re
from urllib.parse import urlsplit
import uuid

from azure.core.credentials import AzureKeyCredential
from azure.core import MatchConditions
from azure.core.exceptions import HttpResponseError, ResourceNotFoundError, ServiceRequestError, ServiceResponseError
from azure.identity import DefaultAzureCredential
from azure.search.documents import SearchClient
from azure.search.documents.indexes import SearchIndexClient
from azure.search.documents.indexes.models import (
    HnswAlgorithmConfiguration, HnswParameters, SearchField, SearchFieldDataType,
    SearchIndex, SimpleField, VectorSearch, VectorSearchProfile,
)
from azure.search.documents.models import VectorizedQuery
import numpy as np
from qdrant_client import QdrantClient, models

LOGGER = logging.getLogger(__name__)
DIMENSIONS = 192
COLLECTION = "speaker_embeddings"
AZURE_FIELDS = ["id", "speaker_name", "normalized_name", "bundled", "audio_filename", "created_at"]


class BackendError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class QdrantStore:
    def __init__(self, path: Path):
        self.client = QdrantClient(path=str(path), force_disable_check_same_thread=True)
        if not self.client.collection_exists(COLLECTION):
            self.client.create_collection(
                COLLECTION, vectors_config=models.VectorParams(size=DIMENSIONS, distance=models.Distance.COSINE),
            )
        else:
            vectors = self.client.get_collection(COLLECTION).config.params.vectors
            if not isinstance(vectors, models.VectorParams) or vectors.size != DIMENSIONS or vectors.distance != models.Distance.COSINE:
                self.client.close()
                raise BackendError("qdrantSchema", "The local Qdrant collection has an incompatible schema.")

    def sync(self, rows: list[dict]) -> None:
        sample_counts: dict[str, int] = {}
        for row in rows:
            sample_counts[row["id"]] = sample_counts.get(row["id"], 0) + 1
        points = [
            models.PointStruct(
                id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"speaker-identification:{row['sample_id']}")),
                vector=np.frombuffer(row["embedding"], dtype=np.float32).tolist(),
                payload={
                    "speaker_id": row["id"], "name": row["name"],
                    "samples": sample_counts[row["id"]],
                },
            )
            for row in rows
        ]
        wanted = {point.id for point in points}
        offset = None
        stale = []
        while True:
            records, offset = self.client.scroll(COLLECTION, limit=256, offset=offset, with_payload=False, with_vectors=False)
            stale.extend(record.id for record in records if record.id not in wanted)
            if offset is None:
                break
        if points:
            self.client.upsert(COLLECTION, points=points, wait=True)
        if stale:
            self.client.delete(COLLECTION, points_selector=models.PointIdsList(points=stale), wait=True)

    def search(self, embedding: np.ndarray, top_n: int = 5) -> list[dict]:
        count = self.client.count(COLLECTION, exact=True).count
        if not count:
            return []
        limit = min(max(top_n, 1), count)
        while True:
            hits = self.client.query_points(
                COLLECTION, query=embedding.tolist(), limit=limit, with_payload=True,
            ).points
            candidates = {}
            for hit in hits:
                speaker_id = hit.payload["speaker_id"]
                if speaker_id not in candidates:
                    candidates[speaker_id] = {
                        "id": speaker_id, "name": hit.payload["name"],
                        "score": float(np.clip(hit.score, -1, 1)),
                        "samples": hit.payload["samples"],
                    }
            if len(candidates) >= top_n or limit == count:
                return list(candidates.values())[:top_n]
            limit = min(count, limit * 2)

    def close(self) -> None:
        self.client.close()


def azure_cosine(score: float) -> float:
    if not math.isfinite(score) or not 1 / 3 - 1e-6 <= score <= 1 + 1e-6:
        raise BackendError("azureScore", "Azure returned an invalid cosine search score.")
    return max(-1.0, min(1.0, 2.0 - 1.0 / score))


class AzureStore:
    def __init__(self, model_hash: str):
        self.endpoint = os.environ.get("AZURE_SEARCH_ENDPOINT", "").strip()
        self.index_name = os.environ.get("AZURE_SEARCH_INDEX", "speaker-identification").strip()
        self.key = os.environ.get("AZURE_SEARCH_API_KEY", "").strip()
        self.key_endpoint = self.endpoint.rstrip("/").lower()
        self.description = f"speaker-identification:v1:{model_hash}"
        self.index_client = None
        self.client = None
        self.credential = None

    @property
    def configured(self) -> bool:
        return bool(self.endpoint)

    def validate_configuration(self, endpoint: str, index_name: str) -> tuple[str, str]:
        endpoint = endpoint.strip().rstrip("/")
        index_name = index_name.strip()
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,126}[a-z0-9]", index_name) or "--" in index_name:
            raise BackendError("azureConfiguration", "Check the Azure AI Search HTTPS endpoint and dedicated index name.")
        if not endpoint:
            return endpoint, index_name
        try:
            url = urlsplit(endpoint)
            port = url.port
        except ValueError as exc:
            raise BackendError("azureConfiguration", "Check the Azure AI Search HTTPS endpoint and dedicated index name.") from exc
        if (
            url.scheme != "https" or not url.hostname
            or not url.hostname.endswith((".search.windows.net", ".search.azure.us", ".search.azure.cn"))
            or url.username or url.password or port not in {None, 443}
            or url.path not in {"", "/"} or url.query or url.fragment
        ):
            raise BackendError("azureConfiguration", "Check the Azure AI Search HTTPS endpoint and dedicated index name.")
        if self.key and endpoint.lower() != self.key_endpoint:
            raise BackendError("azureKeyEndpoint", "The server API key is bound to its configured endpoint. Update server credentials before changing the Azure service, or use Entra ID.")
        return endpoint, index_name

    def configure(self, endpoint: str, index_name: str) -> None:
        endpoint, index_name = self.validate_configuration(endpoint, index_name)
        self.close()
        self.endpoint = endpoint
        self.index_name = index_name

    def _connect(self) -> None:
        if not self.configured:
            raise BackendError("azureNotConfigured", "Azure AI Search is not configured. Enter an endpoint and index in the app.")
        self.validate_configuration(self.endpoint, self.index_name)
        if self.client is None:
            self.credential = AzureKeyCredential(self.key) if self.key else DefaultAzureCredential(exclude_interactive_browser_credential=True)
            self.index_client = SearchIndexClient(
                self.endpoint, self.credential, connection_timeout=10, read_timeout=30, retry_total=2,
            )
            self.client = SearchClient(
                self.endpoint, self.index_name, self.credential, connection_timeout=10, read_timeout=30, retry_total=2,
            )

    @contextmanager
    def operation(self):
        self._connect()
        try:
            yield
        except (HttpResponseError, ServiceRequestError, ServiceResponseError) as exc:
            LOGGER.error("Azure AI Search failed: %s, HTTP status %s", type(exc).__name__, getattr(exc, "status_code", None))
            raise BackendError("azureRequestFailed", "Azure AI Search could not complete the request. Check connectivity, permissions, and configuration.") from exc

    def _get_index(self) -> SearchIndex | None:
        try:
            index = self.index_client.get_index(self.index_name)
        except ResourceNotFoundError:
            return None
        fields = {field.name: field for field in index.fields}
        vector = fields.get("audio_embeddings")
        profile = next((p for p in (index.vector_search.profiles if index.vector_search else [])
                        if vector and p.name == vector.vector_search_profile_name), None)
        algorithm = next((a for a in (index.vector_search.algorithms if index.vector_search else [])
                          if profile and a.name == profile.algorithm_configuration_name), None)
        if (
            index.description != self.description or not set(AZURE_FIELDS).issubset(fields)
            or not fields["id"].key or not vector or vector.vector_search_dimensions != DIMENSIONS
            or not algorithm or not algorithm.parameters or algorithm.parameters.metric != "cosine"
        ):
            raise BackendError("azureSchema", "The Azure index is not a compatible app-managed index. Choose a new dedicated index name.")
        return index

    def _index_exists(self) -> bool:
        return self._get_index() is not None

    def status(self) -> dict:
        if not self.configured:
            return {"ready": False, "configured": False, "reason": "azureNotConfigured"}
        with self.operation():
            exists = self._index_exists()
            return {"ready": exists, "configured": True, "reason": None if exists else "azureIndexMissing"}

    def _require_index(self) -> SearchIndex:
        index = self._get_index()
        if index is None:
            raise BackendError("azureIndexMissing", "Initialize the dedicated Azure index before using cloud processing.")
        return index

    def _upload(self, documents: list[dict]) -> None:
        results = self.client.upload_documents(documents=documents)
        if len(results) != len(documents) or any(not result.succeeded for result in results):
            LOGGER.error("Azure document upload was incomplete.")
            raise BackendError("azureUploadFailed", "Azure did not save every document. Retry the operation; some documents may already have been saved.")

    def initialize(self, references: list[dict]) -> None:
        with self.operation():
            if not self._index_exists():
                fields = [
                    SimpleField(name="id", type=SearchFieldDataType.String, key=True, filterable=True),
                    SimpleField(name="speaker_name", type=SearchFieldDataType.String),
                    SimpleField(name="normalized_name", type=SearchFieldDataType.String, filterable=True),
                    SimpleField(name="bundled", type=SearchFieldDataType.Boolean, filterable=True),
                    SimpleField(name="audio_filename", type=SearchFieldDataType.String),
                    SimpleField(name="created_at", type=SearchFieldDataType.String),
                    SearchField(
                        name="audio_embeddings", type=SearchFieldDataType.Collection(SearchFieldDataType.Single),
                        searchable=True, hidden=False, vector_search_dimensions=DIMENSIONS,
                        vector_search_profile_name="speaker-cosine",
                    ),
                ]
                self.index_client.create_index(SearchIndex(
                    name=self.index_name, description=self.description, fields=fields,
                    vector_search=VectorSearch(
                        algorithms=[HnswAlgorithmConfiguration(name="speaker-hnsw", parameters=HnswParameters(metric="cosine"))],
                        profiles=[VectorSearchProfile(name="speaker-cosine", algorithm_configuration_name="speaker-hnsw")],
                    ),
                ))
            documents = [
                self.document(
                    row["id"], row["name"], np.frombuffer(row["embedding"], dtype=np.float32),
                    bundled=True, filename=row["filename"],
                )
                for row in references
            ]
            if documents:
                self._upload(documents)

    @staticmethod
    def document(speaker_id: str, name: str, embedding: np.ndarray, *, bundled: bool = False, filename: str | None = None) -> dict:
        return {
            "id": speaker_id, "speaker_name": name, "normalized_name": name.casefold(),
            "bundled": bundled, "audio_filename": filename,
            "created_at": datetime.now(timezone.utc).isoformat(), "audio_embeddings": embedding.tolist(),
        }

    def speakers(self) -> list[dict]:
        with self.operation():
            self._require_index()
            documents = self.client.search(search_text="*", select=AZURE_FIELDS)
            return sorted([
                {
                    "id": document["id"], "name": document["speaker_name"], "bundled": document["bundled"],
                    "created_at": document["created_at"], "samples": 1,
                    "reference_id": Path(document["audio_filename"]).stem if document["audio_filename"] else None,
                }
                for document in documents
            ], key=lambda speaker: (speaker["bundled"], speaker["name"].casefold()))

    def reference_rows(self) -> list[dict]:
        with self.operation():
            index = self._require_index()
            vector_field = next(field for field in index.fields if field.name == "audio_embeddings")
            if vector_field.stored is False:
                raise BackendError("azureProjectionStorage", "The Azure index does not store retrievable vectors. Use a dedicated index with stored vectors to enable Spotlight.")
            if vector_field.hidden is not False:
                vector_field.hidden = False
                self.index_client.create_or_update_index(index, match_condition=MatchConditions.IfNotModified)
            documents = self.client.search(search_text="*", select=["id", "speaker_name", "audio_embeddings"])
            rows, seen = [], set()
            # Iteration follows every SDK continuation page; no Top N limit applies to the map.
            for document in documents:
                speaker_id, name = document.get("id"), document.get("speaker_name")
                values = document.get("audio_embeddings")
                if not isinstance(speaker_id, str) or not speaker_id or speaker_id in seen or not isinstance(name, str) or not name or not isinstance(values, list):
                    raise BackendError("azureProjectionData", "Azure returned missing or invalid reference embeddings for Spotlight.")
                try:
                    vector = np.asarray(values, dtype=np.float64)
                except (ValueError, TypeError, OverflowError) as exc:
                    raise BackendError("azureProjectionData", "Azure returned missing or invalid reference embeddings for Spotlight.") from exc
                if vector.shape != (DIMENSIONS,) or not np.isfinite(vector).all():
                    raise BackendError("azureProjectionData", "Azure returned missing or invalid reference embeddings for Spotlight.")
                norm = np.linalg.norm(vector)
                if not np.isfinite(norm) or norm <= 0:
                    raise BackendError("azureProjectionData", "Azure returned missing or invalid reference embeddings for Spotlight.")
                seen.add(speaker_id)
                rows.append({
                    "id": speaker_id, "name": name, "sample_id": speaker_id,
                    "embedding": (vector / norm).astype(np.float32).tobytes(),
                })
            return rows

    def search(self, embedding: np.ndarray, top_n: int = 5) -> list[dict]:
        with self.operation():
            self._require_index()
            count = self.client.get_document_count()
            limit = min(top_n, max(2, count))
            documents = self.client.search(
                search_text=None,
                vector_queries=[VectorizedQuery(vector=embedding.tolist(), fields="audio_embeddings", k_nearest_neighbors=limit, exhaustive=True)],
                select=["id", "speaker_name"], top=limit,
            )
            return [
                {"id": document["id"], "name": document["speaker_name"],
                 "score": azure_cosine(float(document["@search.score"])), "samples": 1}
                for document in documents
            ]

    def enroll(self, name: str, embedding: np.ndarray) -> str:
        with self.operation():
            self._require_index()
            speaker_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"speaker-identification:azure:{name.casefold()}"))
            try:
                self.client.get_document(speaker_id, selected_fields=["id"])
            except ResourceNotFoundError:
                pass
            else:
                raise ValueError("That speaker name already exists. Choose a different name.")
            self._upload([self.document(speaker_id, name, embedding)])
            return speaker_id

    def delete(self, speaker_id: str) -> None:
        with self.operation():
            self._require_index()
            try:
                document = self.client.get_document(speaker_id, selected_fields=["id", "bundled"])
            except ResourceNotFoundError as exc:
                raise KeyError("Speaker not found.") from exc
            if document["bundled"]:
                raise ValueError("Bundled reference speakers cannot be deleted from the app.")
            results = self.client.delete_documents(documents=[{"id": speaker_id}])
            if len(results) != 1 or not results[0].succeeded:
                raise BackendError("azureDeleteFailed", "Azure could not confirm deletion. Refresh the cloud library and retry if needed.")

    def close(self) -> None:
        if self.client:
            self.client.close()
        if self.index_client:
            self.index_client.close()
        if isinstance(self.credential, DefaultAzureCredential):
            self.credential.close()
        self.client = None
        self.index_client = None
        self.credential = None
