from contextlib import asynccontextmanager
import hmac
import logging
import os
from pathlib import Path
import secrets
import time
from typing import Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from engine import AudioError, MAX_BYTES, VoiceEngine
from vector_stores import BackendError

ROOT = Path(__file__).resolve().parent
LOGGER = logging.getLogger(__name__)
Backend = Literal["qdrant", "azure"]
ACCESS_TOKEN = os.environ.get("VOICE_APP_TOKEN") or secrets.token_urlsafe(32)
ACCESS_COOKIE = "voice_access"


@asynccontextmanager
async def lifespan(application: FastAPI):
    load_dotenv(ROOT / ".env")
    engine = await run_in_threadpool(VoiceEngine, ROOT / "data")
    application.state.engine = engine
    try:
        yield
    finally:
        engine.close()


app = FastAPI(title="Speaker Identification", lifespan=lifespan, docs_url=None, redoc_url=None)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "[::1]", "testserver"])


@app.middleware("http")
async def local_requests(request: Request, call_next):
    origin = request.headers.get("origin")
    if origin and urlsplit(origin).netloc != request.url.netloc:
        return JSONResponse({"detail": "Cross-origin access is not allowed."}, status_code=403)
    if request.url.path.startswith("/api/"):
        supplied = request.cookies.get(ACCESS_COOKIE, "")
        if not hmac.compare_digest(supplied, ACCESS_TOKEN):
            return JSONResponse({"detail": "Authentication required."}, status_code=401)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; "
        "media-src 'self' blob:; connect-src 'self'; worker-src 'self'; "
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    )
    return response


@app.exception_handler(AudioError)
async def audio_error(request: Request, exc: AudioError):
    LOGGER.info("Rejected audio for %s: %s", request.url.path, exc)
    return JSONResponse({"detail": str(exc)}, status_code=422)

@app.exception_handler(BackendError)
async def backend_error(request: Request, exc: BackendError):
    LOGGER.error("Backend request failed for %s: %s", request.url.path, exc.code)
    return JSONResponse({"detail": str(exc), "code": exc.code}, status_code=503)


async def read_audio(request: Request) -> bytes:
    if request.headers.get("content-type", "").split(";")[0].lower() not in {"audio/wav", "audio/wave", "audio/x-wav"}:
        raise HTTPException(415, "Send WAV audio with Content-Type: audio/wav.")
    payload = bytearray()
    async for chunk in request.stream():
        if len(payload) + len(chunk) > MAX_BYTES:
            raise HTTPException(413, "The audio exceeds the 20 MB limit.")
        payload.extend(chunk)
    return bytes(payload)


@app.get("/")
def home(request: Request):
    supplied = request.cookies.get(ACCESS_COOKIE, "")
    if hmac.compare_digest(supplied, ACCESS_TOKEN):
        return FileResponse(ROOT / "static" / "index.html")
    token = request.query_params.get("token", "")
    if not hmac.compare_digest(token, ACCESS_TOKEN):
        raise HTTPException(401, "Open the private URL printed by start.ps1.")
    response = RedirectResponse("/", status_code=303)
    response.set_cookie(
        ACCESS_COOKIE, ACCESS_TOKEN, httponly=True, samesite="strict", path="/",
    )
    return response


@app.get("/api/status")
def status(request: Request, backend: Backend = "qdrant"):
    engine = request.app.state.engine
    backend_status = engine.backend_status(backend)
    speakers = engine.speakers(backend) if backend_status["ready"] else []
    return {
        **backend_status,
        "model": "ECAPA-TDNN",
        "sample_rate": 16000,
        "embedding_dimensions": 192,
        "speakers": len(speakers),
        "samples": sum(speaker["samples"] for speaker in speakers),
        "library": speakers,
        "processing": "cloud" if backend == "azure" else "local",
        "backend": backend,
        "embedding_processing": "local",
    }

class InitializeAzure(BaseModel):
    consent: Literal[True]

class AzureConfiguration(BaseModel):
    endpoint: str = Field(max_length=2048)
    index_name: str = Field(min_length=2, max_length=128)


@app.get("/api/backends/azure/configuration")
def azure_configuration(request: Request):
    return request.app.state.engine.azure_configuration()


@app.put("/api/backends/azure/configuration")
def configure_azure(body: AzureConfiguration, request: Request):
    return request.app.state.engine.configure_azure(body.endpoint, body.index_name)


@app.post("/api/backends/azure/initialize")
def initialize_azure(body: InitializeAzure, request: Request):
    return request.app.state.engine.initialize_azure()


@app.get("/api/test-audio")
def test_audio(request: Request):
    return request.app.state.engine.test_audio()


@app.get("/api/test-audio/{sample_id}")
def test_audio_file(sample_id: str, request: Request):
    try:
        path = request.app.state.engine.test_audio_path(sample_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc.args[0])) from exc
    return FileResponse(path, media_type="audio/wav", filename=path.name)


@app.get("/api/speakers")
def speakers(request: Request, backend: Backend = "qdrant"):
    return request.app.state.engine.speakers(backend)

@app.get("/api/constellation")
def constellation(request: Request, backend: Backend = "qdrant"):
    return request.app.state.engine.constellation(backend)


@app.post("/api/identify")
async def identify(request: Request, threshold: float = Query(0.5, ge=0, le=1), min_gap: float = Query(0.05, ge=0, le=1), backend: Backend = "qdrant", top_n: int = Query(5, ge=1)):
    payload = await read_audio(request)
    started = time.perf_counter()
    result = await run_in_threadpool(request.app.state.engine.identify, payload, threshold, min_gap, backend, top_n)
    elapsed = time.perf_counter() - started
    result["elapsed_seconds"] = round(elapsed, 6)
    result["elapsed_ms"] = round(elapsed * 1000, 3)
    return result


@app.post("/api/speakers", status_code=201)
async def enroll(request: Request, name: str = Query(min_length=1, max_length=60), backend: Backend = "qdrant"):
    payload = await read_audio(request)
    try:
        return await run_in_threadpool(request.app.state.engine.enroll, name, payload, backend)
    except AudioError:
        raise
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.delete("/api/speakers/{speaker_id}", status_code=204)
def delete_speaker(speaker_id: str, request: Request, backend: Backend = "qdrant"):
    try:
        request.app.state.engine.delete(speaker_id, backend)
    except KeyError as exc:
        raise HTTPException(404, str(exc.args[0])) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/api/references/{reference_id}")
def reference(reference_id: str, request: Request):
    try:
        path = request.app.state.engine.reference_path(reference_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc.args[0])) from exc
    return FileResponse(path, media_type="audio/wav", filename=path.name)


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
