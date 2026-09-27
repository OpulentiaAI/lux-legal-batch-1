# Desktop template build verified 2026-09-27

- E2B alias: `lux-legal-desktop-amd64-20260927` (mutable)
- E2B template ID: `c2xsaop5g2ny362s3b8v` (reused by E2B on alias rebuild; **not a standalone content guarantee**)
- Successful build ID: `9201696f-9559-4f4e-bfa2-f1faf4334977`
- Root-owned `/opt/computer-use/image.json` SHA-256: `f60ce1097ee693a9bfd6281649cabbcf216572f935cfe1f9109c36a56e6dd29b`
- Vendored source SHA-256 (ordered paths and bytes, per `build-template.py`): `2140dd6318f5f1d1deb994f4acf1414323ef44d9fa3711e8d9577c576b1219dc`
- Runtime bridge SHA-256: `0bf519b4c21d780c6a422f3076da7ae8dd7dafd588040f86e63c8884c6613713`
- Base: `ubuntu:24.04` amd64; the build script refers to a floating base tag, apt repository, Chrome-current URL, and Python transitive dependencies. Rebuilding can change bytes even under this alias/ID. For this build, require the image-manifest digest above at bootstrap and retain the build ID with evaluation provenance.

Versions observed in the live E2B VM: Google Chrome `154.0.8037.57-1`, Python `3.12.3` (`python3`/`python3-venv` `3.12.3-0ubuntu2.1`), `modal-computer-use==2.0.2`, Xvfb `2:21.1.12-1ubuntu1.8`, Openbox `3.6.1-12build5`, XFCE `4.18`, xdotool `1:3.20160805.1-5build1`, x11vnc `0.9.16-10`, FFmpeg `7:6.1.1-3ubuntu5`, and util-linux `2.39.3-9ubuntu6.6`.

Python environment (`pip freeze` in `/opt/computer-use/venv`):

```text
Hypercorn==0.18.0
PyYAML==6.0.3
annotated-doc==0.0.5
annotated-types==0.8.0
anyio==4.15.1
certifi==2026.7.22
click==8.5.0
fastapi==0.141.1
h11==0.16.0
h2==4.4.1
hpack==4.2.0
httpcore==1.0.9
httptools==0.8.0
httpx==0.28.1
hyperframe==6.1.0
idna==3.20
modal-computer-use==2.0.2
mss==10.2.0
pillow==12.3.0
priority==2.0.0
pydantic==2.13.5
pydantic_core==2.46.5
python-dotenv==1.2.3
starlette==1.7.0
typing-inspection==0.4.4
typing_extensions==4.16.0
uvicorn==0.54.0
uvloop==0.22.1
watchfiles==1.3.0
websockets==17.1
wsproto==1.3.2
xxhash==4.0.1
```

Live verification used `secure: true`, `allowPublicTraffic: false`, `denyOut: ['0.0.0.0/0']`, and the broad adapter's `user`/`setpriv --no-new-privs` command wrapper. The daemon reported actions/recordings; Chrome opened a local HTTP page; a computer click changed its DOM text; a 1024×768 PNG showed the updated page. The VM token was owned by `user` at mode `600`; outbound `example.com` timed out (`curl` exit 28). This is availability verification only, not a model or graded legal evaluation.
