# Prepared E2B desktop image

`build-template.py` creates a separate, credential-free amd64 Ubuntu 24.04 template. It installs the desktop packages, Chrome, Python 3.12's venv, `modal-computer-use==2.0.2`, and the exact vendored source from this directory at build time. It does **not** start the daemon, write an auth token, or include a browser profile. Build-time network and root access are required; evaluation-time bootstrap needs neither.

```sh
/home/user/.capy/work/harvey-eval/repo/.venv/bin/python runtime/computer/build-template.py --alias lux-legal-desktop-amd64-20260927
```

The builder emits a template ID, build ID, image-manifest SHA-256, and vendored-source SHA-256. E2B reused the template ID when rebuilding the same alias, so **neither the alias nor the ID alone proves immutable content**. Record the ID and specific build ID, manifest digest/content, source revision, and Chrome/Python/package versions observed in a sandbox for provenance; do not rebuild that alias for a fixed run. The script uses the host's `E2B_API_KEY` solely to call the build API, never copies it into the image, and leaves the Harvey template untouched.

To use the prepared path, provision a sandbox from that recorded template ID and call `createComputer(sandbox, { computerPreparedImage: true, computerImageSha256: '<build output image_sha256>' }).bootstrap()` once per new sandbox. The adapter validates the root-owned image manifest against the expected digest, checks its package/bridge compatibility, writes `/tmp/computer-use/bridge.py`, generates a new mode-0600 token in the VM, and starts the loopback daemon as the unprivileged sandbox user. Subsequent attaches call `ready()`; never snapshot a running daemon as a reusable base image, since a snapshot can preserve the per-VM token/profile. Keep the existing sandbox's `secure`/network policy and the broad evaluation's nonroot `setpriv --no-new-privs` command wrapper. `computerPreparedImage` alone does not select an image; the provisioner must select the ID explicitly. A missing or unexpected image fails bootstrap instead of falling back to privileged installation.

The original non-prepared bootstrap remains available for other callers; the broad adapter must opt into the prepared path itself. The daemon's localhost bearer authentication, per-VM token, and existing repository approval policy are unchanged. The prepared image is infrastructure availability, not a graded evaluation or a claim about corpus/provider connectivity.

On the prepared image the daemon starts the lean Openbox manager and Chrome with software rendering and first-run prompts disabled. Without software rendering the daemon reported a launched PID but Chrome did not render a window in the E2B VM. The local browser-console bridge checks the focused window's `WM_CLASS` with `xprop` before allowing CDP evaluation.
