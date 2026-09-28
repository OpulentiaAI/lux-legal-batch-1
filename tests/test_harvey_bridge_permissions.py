import importlib.util
import io
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location("harvey_bridge", Path(__file__).resolve().parents[1] / "eval/harvey-bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class HarveyCorpusPermissionsTest(unittest.TestCase):
    def test_private_host_export_is_readable_and_checksum_fails_on_unreadable_file(self):
        with tempfile.TemporaryDirectory(prefix="harvey-corpus-permissions-") as temporary:
            base = Path(temporary)
            root = base / "harvey"
            for name in ("harness/__init__.py", "harness/tools.py", "sandbox/__init__.py",
                         "sandbox/sandbox.py", "sandbox/parsers/parse_doc.py"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture")
            documents = base / "private" / "documents"
            chunks = documents / "chunks"
            old_umask = os.umask(0o077)
            try:
                chunks.mkdir(parents=True)
                files = [documents / "README.txt", documents / "index.json",
                         documents / "documents.json", chunks / "doc-01:a:c0.txt"]
                for path in files:
                    path.write_text("private source")
                self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in files))
                archive = bridge.create_archive(root, documents, files)
                with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
                    corpus = [member for member in tar.getmembers() if member.name.startswith("documents")]
                    self.assertEqual({member.name for member in corpus},
                                     {"documents", "documents/chunks", *(f"documents/{path.relative_to(documents)}" for path in files)})
                    self.assertTrue(all(member.mode == (0o555 if member.isdir() else 0o444) for member in corpus))
                archive_path = base / "corpus.tar.gz"
                archive_path.write_bytes(archive)
                target = base / "unpacked"
                target.mkdir()
                subprocess.run(["tar", "--no-same-owner", "--same-permissions", "--delay-directory-restore", "-xzf", str(archive_path), "-C", str(target)], check=True)
            finally:
                os.umask(old_umask)
            extracted = target / "documents"
            self.assertTrue(all(path.stat().st_mode & 0o777 == 0o555 for path in (extracted, extracted / "chunks")))
            self.assertTrue(all((extracted / path.relative_to(documents)).stat().st_mode & 0o777 == 0o444 for path in files))
            command = bridge.corpus_checksum_command(extracted)
            if os.geteuid() == 0:
                base.chmod(0o755)
                target.chmod(0o755)
                shell = ["runuser", "-u", "nobody", "--", "bash", "-c", command]
            else:
                shell = ["bash", "-c", command]
            readable = subprocess.run(shell, capture_output=True, text=True)
            self.assertEqual(readable.returncode, 0, readable.stderr)
            self.assertEqual(len(readable.stdout.split()[0]), 64)
            unreadable = extracted / "chunks/doc-01:a:c0.txt"
            unreadable.chmod(0o000)
            failed = subprocess.run(shell, capture_output=True, text=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("Permission denied", failed.stderr)


if __name__ == "__main__":
    unittest.main()
