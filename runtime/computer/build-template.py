#!/usr/bin/env python3
"""Build the credential-free x86_64 E2B image for prepared desktop bootstrap."""

import argparse
import hashlib
import io
import json
import pathlib
import tarfile
import tempfile

from e2b import Template, default_build_logger


HERE = pathlib.Path(__file__).resolve().parent
APT = (
    "xvfb xfce4 openbox x11vnc novnc websockify xdotool libx11-6 "
    "libxcb1 libxcb-shm0 libxdamage1 libxtst6 wmctrl maim scrot ffmpeg "
    "xclip x11-utils x11-xserver-utils dbus-x11 curl util-linux "
    "python3 python3-venv ca-certificates"
)


def source_archive(destination):
    files = sorted(path for path in (HERE / "vendor" / "src").rglob("*")
                   if path.is_file() and "__pycache__" not in path.parts) + [HERE / "vendor" / "LICENSE"]
    digest = hashlib.sha256()
    with tarfile.open(destination, "w:gz") as archive:
        for path in files:
            relative = path.relative_to(HERE / "vendor")
            data = path.read_bytes()
            digest.update(str(relative).encode() + b"\0" + data)
            info = tarfile.TarInfo(str(relative))
            info.size = len(data)
            info.mode = 0o644
            info.mtime = 0
            archive.addfile(info, io.BytesIO(data))
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--alias", default="lux-legal-desktop-amd64")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix=".desktop-build-", dir=HERE) as tmp:
        bundle = pathlib.Path(tmp) / "source.tar.gz"
        source_hash = source_archive(bundle)
        marker = pathlib.Path(tmp) / "image.json"
        marker.write_text(json.dumps({
            "schema": 1,
            "base": "ubuntu:24.04",
            "architecture": "amd64",
            "python_package": "modal-computer-use==2.0.2",
            "vendor_sha256": source_hash,
            "bridge_sha256": hashlib.sha256((HERE / "bridge.py").read_bytes()).hexdigest(),
            "apt_packages": APT.split(),
            "browser": "google-chrome-stable (build-time apt repository version)",
        }, indent=2) + "\n")
        template = (
            Template().from_image("ubuntu:24.04")
            .set_user("root")
            .apt_install(APT.split())
            .run_cmd("curl -fsSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/chrome.deb && rm /tmp/chrome.deb && ln -s /usr/bin/google-chrome /usr/local/bin/chromium")
            .run_cmd("python3 -m venv /opt/computer-use/venv && /opt/computer-use/venv/bin/pip install --disable-pip-version-check 'modal-computer-use==2.0.2'")
            .make_dir("/opt/modal-computer-use")
            .copy(str(bundle.relative_to(HERE)), "/opt/modal-computer-use/source.tar.gz")
            .run_cmd("tar -C /opt/modal-computer-use -xzf /opt/modal-computer-use/source.tar.gz && rm /opt/modal-computer-use/source.tar.gz")
            .copy(str(marker.relative_to(HERE)), "/opt/computer-use/image.json")
            .run_cmd("id user >/dev/null 2>&1 || useradd -m -s /bin/bash user")
            .set_user("user")
        )
        info = Template.build(template, alias=args.alias, cpu_count=2, memory_mb=4096, on_build_logs=default_build_logger())
        print(json.dumps({"template_id": info.template_id, "build_id": info.build_id,
                          "alias": args.alias, "image_sha256": hashlib.sha256(marker.read_bytes()).hexdigest(),
                          "vendor_sha256": source_hash}))


if __name__ == "__main__":
    main()
