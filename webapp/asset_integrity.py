"""Trusted hashes for bundled model assets."""

import hashlib
from pathlib import Path

EXPECTED_MODEL_SHA256 = "0575cb64845e6b9a10db9bcb74d5ac32b326b8dc90352671d345e2ee3d0126a2"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_model(path: Path, expected: str = EXPECTED_MODEL_SHA256) -> str:
    actual = sha256_file(path)
    if actual != expected:
        raise ValueError(
            "The ECAPA model checkpoint failed trusted SHA-256 verification. "
            "Replace it with the original bundled asset."
        )
    return actual
