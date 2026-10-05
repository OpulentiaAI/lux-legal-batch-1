import base64
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, env={
        "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": "/root", "LANG": "C.UTF-8", "DEBIAN_FRONTEND": "noninteractive",
        "TESSDATA_PREFIX": "/usr/share/tesseract-ocr/5/tessdata",
        "PYTHONDONTWRITEBYTECODE": "1",
    }, **kwargs)


def download(item, destination):
    with urllib.request.urlopen(item["url"], timeout=120) as response, destination.open("wb") as output:
        shutil.copyfileobj(response, output)
    if digest(destination) != item["sha256"]:
        raise RuntimeError("Artifact hash mismatch: " + destination.name)


def install(payload):
    recipe = payload["recipe"]
    root = pathlib.Path(recipe["destinationRoot"])
    if os.geteuid() != 0 or os.uname().machine != "x86_64":
        raise RuntimeError("Document tools require root at build time on Linux x86_64")
    if 'VERSION_ID="24.04"' not in pathlib.Path("/etc/os-release").read_text():
        raise RuntimeError("Only Ubuntu 24.04 is supported")
    if root.exists() or root.is_symlink():
        raise RuntimeError("Refusing to replace an installed document layer")
    root.mkdir(mode=0o755, parents=True)
    for path in (pathlib.Path("/opt"), root.parent, pathlib.Path("/usr/bin")):
        if path.is_symlink() or not path.is_dir() or path.stat().st_uid != 0:
            raise RuntimeError("Untrusted document-tool ancestor: " + str(path))
        path.chmod(0o755)
    for item in payload["files"]:
        relative = pathlib.PurePosixPath(item["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise RuntimeError("Invalid payload path")
        data = base64.b64decode(item["body"], validate=True)
        if hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise RuntimeError("Payload hash mismatch: " + item["path"])
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    apt = json.loads((root / "apt-lock.json").read_text())
    with tempfile.TemporaryDirectory(prefix="opulent-documents-build-", dir="/opt") as work:
        work = pathlib.Path(work)
        work.chmod(0o755)
        sources = work / "ubuntu.sources"
        sources.write_text("Types: deb\nURIs: " + apt["url"] + "\nSuites: " +
                           " ".join(item["suite"] for item in apt["inRelease"]) +
                           "\nComponents: " + " ".join(apt["components"]) +
                           "\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n")
        (work / "lists/partial").mkdir(parents=True)
        (work / "archives/partial").mkdir(parents=True)
        opts = ["-o", "Dir::Etc::sourcelist=" + str(sources), "-o", "Dir::Etc::sourceparts=-",
                "-o", "Dir::State::lists=" + str(work / "lists"),
                "-o", "Dir::Cache::archives=" + str(work / "archives"),
                "-o", "Acquire::Check-Valid-Until=false"]
        run(["apt-get", *opts, "update"])
        for item in apt["inRelease"]:
            files = list((work / "lists").glob("*_dists_" + item["suite"] + "_InRelease"))
            if len(files) != 1 or digest(files[0]) != item["sha256"]:
                raise RuntimeError("Immutable snapshot InRelease hash mismatch: " + item["suite"])
        for item in apt["packages"]:
            data = run(["apt-cache", *opts, "show", item["name"] + "=" + item["version"]],
                       stdout=subprocess.PIPE, text=True).stdout
            candidates = [part for part in data.split("\n\n") if "\nSHA256: " in "\n" + part]
            if not candidates or any("\nSHA256: " + item["sha256"] not in "\n" + part or
                                     "\nFilename: " + item["filename"] not in "\n" + part for part in candidates):
                raise RuntimeError("Package metadata differs from lock: " + item["name"])
        run(["apt-get", *opts, "install", "-y", "--no-install-recommends", "--no-remove",
             *[item["name"] + "=" + item["version"] for item in apt["packages"]]])
        for name in ("node", "rga"):
            archive = work / (name + ".tar")
            download(recipe[name], archive)
            with tarfile.open(archive) as bundle:
                prefix = recipe[name]["archiveRoot"] + "/"
                if any(not member.name.startswith(prefix) and member.name != prefix.rstrip("/")
                       for member in bundle.getmembers()):
                    raise RuntimeError("Unexpected archive root")
                bundle.extractall(work / name, filter="data")
            shutil.move(str(work / name / recipe[name]["archiveRoot"]), root / name)
        for item in recipe["sourceLicenses"]:
            path = root / "licenses" / (item["name"] + ".LICENSE")
            path.parent.mkdir(exist_ok=True)
            download(item, path)
        node = root / "node/bin/node"
        npm = root / "node/lib/node_modules/npm/bin/npm-cli.js"
        run([str(node), str(npm), "ci", "--ignore-scripts", "--include=optional", "--no-audit", "--no-fund",
             "--cache", str(work / "npm-cache")], cwd=root)
        pdfium = work / "pdfium.tgz"
        download(recipe["pdfium"], pdfium)
        with tarfile.open(pdfium) as bundle:
            bundle.extractall(work / "pdfium", filter="data")
        for path in [work / "pdfium/lib/libpdfium.so", root / "node_modules/@llamaindex/liteparse/libpdfium.so",
                     root / "node_modules/@llamaindex/liteparse-linux-x64-gnu/libpdfium.so"]:
            if digest(path) != recipe["pdfium"]["binarySha256"]:
                raise RuntimeError("LiteParse's bundled PDFium differs from the licensed pinned release")
        (root / "pdfium-licenses").mkdir()
        shutil.copy2(work / "pdfium/LICENSE", root / "pdfium-licenses/LICENSE")
        shutil.copytree(work / "pdfium/licenses", root / "pdfium-licenses/licenses")
        run(["/usr/bin/python3.12", "-m", "venv", str(root / "venv")])
        wheels = work / "wheels"
        wheels.mkdir()
        python = json.loads((root / "python-wheels.json").read_text())
        for item in python["packages"]:
            download(item, wheels / item["filename"])
        run([str(root / "venv/bin/python"), "-m", "pip", "install", "--disable-pip-version-check",
             "--no-index", "--find-links", str(wheels), "--no-deps", "--require-hashes", "--only-binary=:all:",
             "--no-compile", "-r", str(root / "requirements.lock")])
        run([str(root / "venv/bin/python"), "-m", "pip", "check"])
    for filename, expected in recipe["tessdata"]["files"].items():
        if digest(pathlib.Path(recipe["tessdata"]["path"]) / filename) != expected:
            raise RuntimeError("Offline traineddata differs from lock")
    for name in ("opulent-document", "anydoc", "lit", "liteparse"):
        path = pathlib.Path("/usr/bin") / name
        if path.exists() or path.is_symlink():
            raise RuntimeError("Refusing to replace an existing CLI: " + name)
        path.write_text('#!/bin/sh\nexec /usr/bin/python3.12 /opt/opulent/document-tools/local-cli.py ' + name + ' "$@"\n')
        path.chmod(0o555)
    for name in ("rga", "rga-preproc"):
        path = pathlib.Path("/usr/bin") / name
        if path.exists() or path.is_symlink():
            raise RuntimeError("Refusing to replace an existing CLI: " + name)
        shutil.copyfile(root / "rga" / name, path)
        path.chmod(0o555)
    available = json.loads(run([str(root / "node/bin/node"), str(root / "probe-installed.mjs"),
                               "--root", str(root)], stdout=subprocess.PIPE, text=True).stdout)
    native = json.loads(run([str(root / "node/bin/node"), str(root / "probe-installed.mjs"),
                            "--root", str(root), "--fixtures"], stdout=subprocess.PIPE, text=True).stdout)
    installed = {
        "schema": 1, "name": recipe["name"], "recipeSha256": payload["recipeSha256"],
        "files": [{"path": item["path"], "sha256": item["sha256"]} for item in payload["files"]],
        "aptSnapshot": apt["snapshot"], "availability": available, "nativeFixtures": native,
        "installedDebianPackages": run(["dpkg-query", "-W", "-f=${binary:Package}\t${Version}\n"],
                                      stdout=subprocess.PIPE, text=True).stdout.splitlines(),
        "networkPolicy": recipe["networkPolicy"], "licenses": recipe["licenses"],
    }
    marker = root / "installed.json"
    marker.write_text(json.dumps(installed, sort_keys=True, indent=2) + "\n")
    for directory, dirs, files in os.walk(root):
        for name in dirs + files:
            path = pathlib.Path(directory) / name
            os.chown(path, 0, 0, follow_symlinks=False)
            if path.is_file() and not path.is_symlink():
                path.chmod(0o555 if path.stat().st_mode & 0o111 else 0o444)
        os.chown(directory, 0, 0)
        pathlib.Path(directory).chmod(0o555)
    return {"installedManifestPath": str(marker), "installedManifestSha256": digest(marker),
            "recipeSha256": payload["recipeSha256"], "name": recipe["name"],
            "sourceFiles": installed["files"], "availability": available, "nativeFixtures": native}


if __name__ == "__main__":
    payload = json.loads(base64.b64decode(pathlib.Path(sys.argv[1]).read_bytes(), validate=True))
    result = install(payload)
    pathlib.Path(sys.argv[2]).write_text(json.dumps(result, sort_keys=True) + "\n")
