#!/usr/bin/env python3
"""Build the credential-free x86_64 E2B image for prepared desktop bootstrap."""

import argparse
import hashlib
import io
import json
import pathlib
import re
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
EXPANDED_PROFILE = HERE / "opulent-full-tools.json"
TOOL_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin"


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


def expanded_inputs():
    profile = json.loads(EXPANDED_PROFILE.read_text())
    requirements = HERE / profile["requirements"]
    if profile["schema"] != 1 or profile["base"] != "ubuntu:24.04":
        raise ValueError("Unsupported expanded image profile")
    if requirements.parent != HERE or not requirements.is_file():
        raise ValueError("Expanded profile requires a local requirements file")
    packages = profile["apt_packages"]
    if not packages or len(packages) != len(set(packages)) or any(not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*", p) for p in packages):
        raise ValueError("Invalid expanded apt package list")
    if any(not re.fullmatch(r"[A-Za-z0-9_-]+==[0-9][A-Za-z0-9.+-]*", p) for p in profile["additional_python_cli"]):
        raise ValueError("Invalid additional Python CLI requirement")
    if not re.fullmatch(r"[a-z0-9-]+@[0-9][a-z0-9.]*", profile["additional_npm_cli"]):
        raise ValueError("Invalid additional npm CLI requirement")
    for release in profile["public_releases"]:
        if (not re.fullmatch(r"[a-z-]+", release["name"]) or
                release["format"] not in {"gzip", "sbt-tar", "zip", "binary", "ngrok-tar", "frp-tar"} or
                not re.fullmatch(r"https://(?:github.com|static.rust-lang.org|bin.equinox.io)/[A-Za-z0-9_./-]+", release["url"]) or
                not re.fullmatch(r"[a-f0-9]{64}", release["sha256"])):
            raise ValueError("Invalid pinned public release")
    if not re.fullmatch(r"3\.10\.[0-9]+", profile["side_by_side_python"]):
        raise ValueError("Invalid side-by-side Python version")
    for entry in profile["extracted_ubuntu_binaries"]:
        if (not re.fullmatch(r"[a-z0-9-]+", entry["package"]) or
                not re.fullmatch(r"[0-9a-z.+-]+", entry["version"]) or
                not re.fullmatch(r"[a-z0-9-]+", entry["binary"]) or
                not re.fullmatch(r"[a-f0-9]{64}", entry["deb_sha256"])):
            raise ValueError("Invalid pinned Ubuntu binary")
    return profile, requirements


def image_manifest(source_hash, profile=None, requirements=None):
    marker = {
        "schema": 1,
        "base": "ubuntu:24.04",
        "architecture": "amd64",
        "python_package": "modal-computer-use==2.0.2",
        "vendor_sha256": source_hash,
        "bridge_sha256": hashlib.sha256((HERE / "bridge.py").read_bytes()).hexdigest(),
        "apt_packages": APT.split(),
        "browser": "google-chrome-stable (build-time apt repository version)",
    }
    if profile is not None:
        marker["expanded_profile"] = {
            "name": profile["name"],
            "profile_sha256": hashlib.sha256(EXPANDED_PROFILE.read_bytes()).hexdigest(),
            "requirements_sha256": hashlib.sha256(requirements.read_bytes()).hexdigest(),
            "builder_sha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
            "requested_inventories_sha256": profile["requested_inventories_sha256"],
            "apt_packages": profile["apt_packages"],
            "python": profile["python"],
            "command_path": TOOL_PATH,
            "additional_python_cli": profile["additional_python_cli"],
            "additional_npm_cli": profile["additional_npm_cli"],
            "public_releases": profile["public_releases"],
            "side_by_side_python": profile["side_by_side_python"],
            "extracted_ubuntu_binaries": profile["extracted_ubuntu_binaries"],
        }
    return marker


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--alias", default="lux-legal-desktop-amd64")
    parser.add_argument("--profile", choices=["minimal", "opulent-full-tools"], default="minimal")
    args = parser.parse_args()
    profile, requirements = expanded_inputs() if args.profile == "opulent-full-tools" else (None, None)
    with tempfile.TemporaryDirectory(prefix=".desktop-build-", dir=HERE) as tmp:
        bundle = pathlib.Path(tmp) / "source.tar.gz"
        source_hash = source_archive(bundle)
        marker = pathlib.Path(tmp) / "image.json"
        marker.write_text(json.dumps(image_manifest(source_hash, profile, requirements), indent=2) + "\n")
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
        )
        if profile is not None:
            template = (
                template.apt_install(profile["apt_packages"], no_install_recommends=True)
                .make_dir("/opt/opulent-tools")
                .copy(str(requirements.relative_to(HERE)), "/opt/opulent-tools/requirements.txt")
                .run_cmd("python3 -m venv --system-site-packages /opt/opulent-tools/venv && "
                         "/opt/opulent-tools/venv/bin/python -m pip install --disable-pip-version-check "
                         "--prefer-binary -r /opt/opulent-tools/requirements.txt && "
                         "/opt/opulent-tools/venv/bin/python -m pip check && "
                         "/opt/opulent-tools/venv/bin/python -c 'import apt, gi, dbus' && "
                         "/opt/computer-use/venv/bin/python -c 'import modal_computer_use'")
                .run_cmd("echo /opt/opulent-tools/venv/lib/python3.12/site-packages > "
                         "/usr/local/lib/python3.12/dist-packages/opulent-tools.pth && "
                         "for executable in /opt/opulent-tools/venv/bin/*; do "
                         "test -f \"$executable\" || continue; "
                         "case \"$(basename \"$executable\")\" in python*|activate*|Activate.ps1) continue;; esac; "
                         "test \"$(head -c 2 \"$executable\")\" = '#!' || continue; "
                         "test -e \"/usr/local/bin/$(basename \"$executable\")\" || "
                         "ln -s \"$executable\" \"/usr/local/bin/$(basename \"$executable\")\"; "
                         "done && "
                         "python3 -c 'import apt, gi, dbus, numpy, pandas, pyarrow, scipy, streamlit' && "
                         "command -v aws && command -v flake8 && command -v jupyter")
                .run_cmd("python3 -m venv /opt/opulent-tools/cli-venv && "
                         "/opt/opulent-tools/cli-venv/bin/pip install --disable-pip-version-check "
                         "--prefer-binary " + " ".join(profile["additional_python_cli"]) + " && "
                         "/opt/opulent-tools/cli-venv/bin/pip check && "
                         "ln -s /opt/opulent-tools/cli-venv/bin/uv /usr/local/bin/uv && "
                         "ln -s /opt/opulent-tools/cli-venv/bin/uvx /usr/local/bin/uvx && "
                         "ln -s /opt/opulent-tools/cli-venv/bin/poetry /usr/local/bin/poetry")
                .run_cmd("npm install --global --no-audit --no-fund " + profile["additional_npm_cli"])
            )
            for release in profile["public_releases"]:
                artifact = "/tmp/opulent-" + release["name"]
                command = ("curl -fsSL --retry 3 -o " + artifact + " " + release["url"] +
                           " && echo '" + release["sha256"] + "  " + artifact + "' | sha256sum -c - && ")
                if release["format"] == "gzip":
                    command += "gzip -dc " + artifact + " > /usr/local/bin/" + release["name"] + " && chmod 755 /usr/local/bin/" + release["name"]
                elif release["format"] == "sbt-tar":
                    command += ("tar -xzf " + artifact + " -C /opt/opulent-tools && "
                                "ln -s /opt/opulent-tools/sbt/bin/sbt /usr/local/bin/sbt && "
                                "install -m 755 /opt/opulent-tools/sbt/bin/sbtn-x86_64-pc-linux /usr/local/bin/sbtn")
                elif release["format"] == "zip":
                    command += "unzip -p " + artifact + " scalafmt > /usr/local/bin/scalafmt && chmod 755 /usr/local/bin/scalafmt"
                elif release["format"] == "ngrok-tar":
                    command += "tar -xOzf " + artifact + " ngrok > /usr/local/bin/ngrok && chmod 755 /usr/local/bin/ngrok"
                elif release["format"] == "frp-tar":
                    command += ("tar -xOzf " + artifact +
                                " frp_0.71.0_linux_amd64/frpc > /usr/local/bin/frpc && chmod 755 /usr/local/bin/frpc")
                else:
                    command += "install -m 755 " + artifact + " /usr/local/bin/" + release["name"]
                command += " && rm " + artifact
                template = template.run_cmd(command)
            template = template.run_cmd("ln -s /usr/local/bin/cs /usr/local/bin/coursier && "
                                        "command -v scala-cli && command -v coursier && "
                                        "command -v sbt && command -v sbtn && "
                                        "command -v scalafmt && command -v amm")
            version = profile["side_by_side_python"]
            python_bin = "/opt/opulent-tools/pythons/cpython-" + version + "-linux-x86_64-gnu/bin"
            template = template.run_cmd(
                "/opt/opulent-tools/cli-venv/bin/uv python install " + version +
                " --install-dir /opt/opulent-tools/pythons --no-bin && "
                "for name in python3.10 pip3.10 pydoc3.10; do "
                "ln -s " + python_bin + "/$name /usr/local/bin/$name; done && "
                "python3.10 -c 'import sys; assert sys.version_info[:3] == (3, 10, " + version.split(".")[2] + ")'")
            for entry in profile["extracted_ubuntu_binaries"]:
                deb = entry["package"] + "_" + entry["version"] + "_amd64.deb"
                template = template.run_cmd(
                    "mkdir -p /tmp/opulent-deb && cd /tmp/opulent-deb && "
                    "test \"$(dpkg-query -W -f='${Version}' systemd)\" = '" + entry["version"] + "' && "
                    "apt-get download '" + entry["package"] + "=" + entry["version"] + "' && "
                    "echo '" + entry["deb_sha256"] + "  " + deb + "' | sha256sum -c - && "
                    "dpkg-deb -x " + deb + " extracted && "
                    "install -m 755 extracted/usr/bin/" + entry["binary"] + " /usr/local/bin/" + entry["binary"] + " && "
                    "ldd /usr/local/bin/" + entry["binary"] + " | grep -q libsystemd-shared && "
                    "rm -rf /tmp/opulent-deb")
        template = template.set_user("user")
        info = Template.build(template, alias=args.alias, cpu_count=2, memory_mb=4096, on_build_logs=default_build_logger())
        print(json.dumps({"template_id": info.template_id, "build_id": info.build_id,
                          "alias": args.alias, "image_sha256": hashlib.sha256(marker.read_bytes()).hexdigest(),
                          "vendor_sha256": source_hash}))


if __name__ == "__main__":
    main()
