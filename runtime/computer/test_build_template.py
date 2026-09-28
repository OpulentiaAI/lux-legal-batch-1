"""Offline checks of the two image recipes; no E2B credentials or build needed."""

import contextlib
import hashlib
import importlib.util
import io
import json
import pathlib
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch


BUILDER = pathlib.Path(__file__).with_name("build-template.py")


class FakeTemplate:
    steps = []

    def __getattr__(self, name):
        def record(*args, **kwargs):
            self.steps.append((name, args, kwargs))
            return self
        return record

    @staticmethod
    def build(template, **kwargs):
        FakeTemplate.steps.append(("build", (), kwargs))
        return types.SimpleNamespace(template_id="test-template", build_id="test-build")


fake_e2b = types.SimpleNamespace(Template=FakeTemplate, default_build_logger=lambda: None)
with patch.dict(sys.modules, {"e2b": fake_e2b}):
    spec = importlib.util.spec_from_file_location("image_builder", BUILDER)
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)


class ImageBuilderTests(unittest.TestCase):
    def test_minimal_manifest_keeps_historical_contract(self):
        marker = builder.image_manifest("a" * 64)
        self.assertEqual(set(marker), {"schema", "base", "architecture", "python_package",
                                       "vendor_sha256", "bridge_sha256", "apt_packages", "browser"})
        self.assertEqual(marker["schema"], 1)
        self.assertEqual(marker["apt_packages"], builder.APT.split())
        self.assertNotIn("expanded_profile", marker)
        historical = builder.image_manifest("2140dd6318f5f1d1deb994f4acf1414323ef44d9fa3711e8d9577c576b1219dc")
        digest = hashlib.sha256((json.dumps(historical, indent=2) + "\n").encode()).hexdigest()
        self.assertEqual(digest, "f60ce1097ee693a9bfd6281649cabbcf216572f935cfe1f9109c36a56e6dd29b")

    def test_expanded_manifest_pins_inputs_without_credentials(self):
        profile, requirements = builder.expanded_inputs()
        marker = builder.image_manifest("a" * 64, profile, requirements)
        expanded = marker["expanded_profile"]
        self.assertEqual(expanded["profile_sha256"], hashlib.sha256(builder.EXPANDED_PROFILE.read_bytes()).hexdigest())
        self.assertEqual(expanded["requirements_sha256"], hashlib.sha256(requirements.read_bytes()).hexdigest())
        self.assertEqual(expanded["builder_sha256"], hashlib.sha256(BUILDER.read_bytes()).hexdigest())
        self.assertIn("/usr/local/bin", expanded["command_path"].split(":"))
        self.assertTrue(all(len(release["sha256"]) == 64 for release in expanded["public_releases"]))
        self.assertEqual(expanded["side_by_side_python"], "3.10.20")
        self.assertEqual({item["binary"] for item in expanded["extracted_ubuntu_binaries"]}, {"bootctl", "resolvectl"})
        self.assertNotIn("API_KEY", json.dumps(marker))

    def test_profile_adds_build_time_install_only_when_selected(self):
        for selected in ("minimal", "opulent-full-tools"):
            with self.subTest(selected=selected):
                FakeTemplate.steps = []
                output = io.StringIO()
                with patch.object(sys, "argv", [str(BUILDER), "--profile", selected, "--alias", "test-alias"]), contextlib.redirect_stdout(output):
                    builder.main()
                steps = FakeTemplate.steps
                self.assertEqual(steps[-1][0], "build")
                self.assertEqual([x for x in steps if x[0] == "set_user"][-1][1], ("user",))
                commands = "\n".join(x[1][0] for x in steps if x[0] == "run_cmd")
                self.assertEqual("/opt/opulent-tools/requirements.txt" in commands, selected != "minimal")
                self.assertFalse(any(x[0] == "set_envs" for x in steps))
                if selected != "minimal":
                    self.assertIn("--system-site-packages", commands)
                    self.assertIn("import apt, gi, dbus", commands)
                    self.assertIn("opulent-tools.pth", commands)
                    self.assertIn("ln -s", commands)
                    self.assertIn("sha256sum -c", commands)
                    self.assertIn("corepack@0.31.0", commands)
                    self.assertIn("uv python install 3.10.20", commands)
                    self.assertIn("apt-get download", commands)
                    self.assertTrue(any(x[0] == "apt_install" and x[2].get("no_install_recommends") for x in steps))
                self.assertEqual(json.loads(output.getvalue())["alias"], "test-alias")

    def test_skill_archive_requires_six_regular_skills_and_hashes_contents(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = pathlib.Path(tmp) / "skills"
            source.mkdir()
            for index in range(6):
                directory = source / f"skill-{index}"
                directory.mkdir()
                (directory / "SKILL.md").write_text(f"# Skill {index}\n")
            archive = pathlib.Path(tmp) / "skills.tar.gz"
            manifest = builder.skill_archive(source, archive)
            self.assertEqual(len(manifest["names"]), 6)
            self.assertEqual(len(manifest["files"]), 6)
            self.assertEqual(manifest["files"][0]["path"], "skill-0/SKILL.md")
            with tarfile.open(archive) as stream:
                self.assertEqual([member.mode for member in stream.getmembers()], [0o444] * 6)
            original = manifest["bundle_sha256"]
            (source / "skill-0" / "SKILL.md").write_text("# Updated\n")
            self.assertNotEqual(builder.skill_archive(source, archive)["bundle_sha256"], original)
            declared = {"destinationRoot": "/opt/opulent/skills", "skills": [
                {"name": name, "artifactSha256": hashlib.sha256((source / name / "SKILL.md").read_bytes()).hexdigest()}
                for name in manifest["names"]]}
            (source / "manifest-v1.json").write_text(json.dumps(declared))
            self.assertEqual(len(builder.skill_archive(source, archive)["files"]), 7)
            (source / "README.md").write_text("# Skills\n")
            self.assertEqual(len(builder.skill_archive(source, archive)["files"]), 8)
            declared["skills"][0]["artifactSha256"] = "a" * 64
            (source / "manifest-v1.json").write_text(json.dumps(declared))
            with self.assertRaisesRegex(ValueError, "source manifest differs"):
                builder.skill_archive(source, archive)
            (source / "manifest-v1.json").unlink()
            (source / "skill-0" / "unsafe").symlink_to("/etc/passwd")
            with self.assertRaisesRegex(ValueError, "regular files"):
                builder.skill_archive(source, archive)

    def test_expanded_skills_install_is_read_only_and_minimal_remains_unmodified(self):
        manifest = {"install_path": "/opt/opulent/skills", "names": [f"skill-{i}" for i in range(6)],
                    "files": [{"path": f"skill-{i}/SKILL.md", "sha256": "a" * 64} for i in range(6)],
                    "bundle_sha256": "b" * 64}
        profile, requirements = builder.expanded_inputs()
        self.assertEqual(builder.image_manifest("a" * 64, profile, requirements, manifest)["expanded_profile"]["skills"], manifest)
        FakeTemplate.steps = []
        output = io.StringIO()
        path = builder.HERE.parent / "builtin-skills" / "fixture"
        with patch.object(builder, "skill_archive", return_value=manifest), patch.object(sys, "argv", [str(BUILDER), "--profile", "opulent-full-tools", "--skills-dir", str(path)]), contextlib.redirect_stdout(output):
            builder.main()
        steps = FakeTemplate.steps
        commands = "\n".join(x[1][0] for x in steps if x[0] == "run_cmd")
        self.assertIn("chown -R root:root /opt/opulent/skills", commands)
        self.assertIn("-type f -exec chmod 0444", commands)
        self.assertIn("-type d -exec chmod 0555", commands)
        self.assertEqual([x for x in steps if x[0] == "set_user"][-1][1], ("user",))
        self.assertEqual(json.loads(output.getvalue())["alias"], "lux-legal-desktop-amd64")


if __name__ == "__main__":
    unittest.main()
