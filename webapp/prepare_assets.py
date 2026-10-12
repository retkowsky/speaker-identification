"""Copy only the bundled ECAPA weights and reference WAVs into local app storage."""

from pathlib import Path
import shutil
import zipfile
import zlib

from asset_integrity import EXPECTED_MODEL_SHA256, verify_model

ROOT = Path(__file__).resolve().parent
MODEL_FILE = "voice embeddings/pretrained_models/spkrec-ecapa-voxceleb/embedding_model.ckpt"

def file_crc32(path: Path) -> int:
    checksum = 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum = zlib.crc32(chunk, checksum)
    return checksum


def prepare(
    archive: Path = ROOT / "voices embeddings.zip",
    expected_model_sha256: str = EXPECTED_MODEL_SHA256,
) -> None:
    with zipfile.ZipFile(archive) as source:
        selected = [
            item for item in source.infolist()
            if item.filename == MODEL_FILE
            or (
                item.filename.startswith("voice embeddings/voices/")
                and item.filename.endswith(".wav")
                and len(Path(item.filename).parts) == 3
            )
        ]
        if not any(item.filename == MODEL_FILE for item in selected):
            raise ValueError("The ZIP does not contain the expected ECAPA model weights.")
        if not any(item.filename != MODEL_FILE for item in selected):
            raise ValueError("The ZIP does not contain reference WAVs.")
        for item in selected:
            directory = ROOT / "data" / ("model" if item.filename == MODEL_FILE else "references")
            directory.mkdir(parents=True, exist_ok=True)
            target = directory / Path(item.filename).name
            if target.exists():
                if target.stat().st_size != item.file_size or file_crc32(target) != item.CRC:
                    raise ValueError(f"Existing asset differs from the ZIP: {target.name}")
                if item.filename == MODEL_FILE:
                    verify_model(target, expected_model_sha256)
                continue
            temporary = target.with_suffix(".tmp")
            try:
                with source.open(item) as src, temporary.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
                if item.filename == MODEL_FILE:
                    verify_model(temporary, expected_model_sha256)
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
    print(f"Prepared {len(selected)} local assets. Environment files were not extracted.")


if __name__ == "__main__":
    prepare()
