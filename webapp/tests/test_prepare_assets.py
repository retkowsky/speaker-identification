import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from prepare_assets import MODEL_FILE, prepare


class PrepareAssetsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.archive = self.root / "assets.zip"
        self.root_patch = patch("prepare_assets.ROOT", self.root)
        self.root_patch.start()

    def tearDown(self):
        self.root_patch.stop()
        self.temporary.cleanup()

    def write_archive(self, references=True):
        with zipfile.ZipFile(self.archive, "w") as archive:
            archive.writestr(MODEL_FILE, b"model-weights")
            if references:
                archive.writestr("voice embeddings/voices/speaker_0001_segment_1.wav", b"wav-data")
            archive.writestr("voice embeddings/.env", b"not-an-asset")

    @property
    def model_hash(self):
        return hashlib.sha256(b"model-weights").hexdigest()

    def test_extracts_only_assets_and_accepts_identical_existing_files(self):
        self.write_archive()
        prepare(self.archive, self.model_hash)
        prepare(self.archive, self.model_hash)
        self.assertEqual((self.root / "data" / "model" / "embedding_model.ckpt").read_bytes(), b"model-weights")
        self.assertEqual((self.root / "data" / "references" / "speaker_0001_segment_1.wav").read_bytes(), b"wav-data")
        self.assertEqual(len(list((self.root / "data").rglob("*.*"))), 2)
        self.assertFalse(list(self.root.rglob("*.tmp")))

    def test_rejects_same_size_corruption_without_overwriting(self):
        self.write_archive()
        prepare(self.archive, self.model_hash)
        target = self.root / "data" / "references" / "speaker_0001_segment_1.wav"
        target.write_bytes(b"bad-data")
        with self.assertRaisesRegex(ValueError, "Existing asset differs"):
            prepare(self.archive, self.model_hash)
        self.assertEqual(target.read_bytes(), b"bad-data")
        self.assertFalse(list(self.root.rglob("*.tmp")))

    def test_missing_references_fail_before_writing_any_assets(self):
        self.write_archive(references=False)
        with self.assertRaisesRegex(ValueError, "reference WAVs"):
            prepare(self.archive, self.model_hash)
        self.assertFalse((self.root / "data").exists())

    def test_rejects_untrusted_model_before_installing_it(self):
        self.write_archive()
        with self.assertRaisesRegex(ValueError, "trusted SHA-256"):
            prepare(self.archive)
        self.assertFalse((self.root / "data" / "model" / "embedding_model.ckpt").exists())


if __name__ == "__main__":
    unittest.main()
