import os
import pathlib
import sys


def command(name, args, root=pathlib.Path("/opt/opulent/document-tools")):
    if name == "opulent-document":
        return [str(root / "node/bin/node"), str(root / "document.mjs"), *args]
    options = args[:args.index("--")] if "--" in args else args
    if name == "anydoc":
        blocked = {"--ocr", "--api-key", "--api-url"}
        if any(arg.split("=", 1)[0] in blocked for arg in options):
            raise ValueError("Prepared anydoc is local-only; hosted OCR and API options are unavailable")
        return [str(root / "node/bin/node"), str(root / "node_modules/@firecrawl/anydoc/cli.js"), *args]
    if name not in {"lit", "liteparse"}:
        raise ValueError("Unknown prepared document command")
    if args and (not options or options[0] not in {"parse", "batch-parse", "screenshot", "is-complex", "help"}
                 and not all(arg in {"--help", "-h", "--version", "-V"} for arg in args)):
        raise ValueError("Unsupported prepared LiteParse command layout")
    blocked = {"--config", "--ocr-server-url", "--ocr-server-header"}
    if any(arg.split("=", 1)[0] in blocked for arg in options):
        raise ValueError("Prepared LiteParse uses only its root-owned offline OCR configuration")
    for index, arg in enumerate(options):
        if arg == "--ocr-language":
            language = options[index + 1] if index + 1 < len(options) else ""
        elif arg.startswith("--ocr-language="):
            language = arg.split("=", 1)[1]
        else:
            continue
        if language not in {"eng", "en"}:
            raise ValueError("Only prepared offline English OCR is available")
    if options and options[0] == "batch-parse" and not any(arg in {"--help", "-h"} for arg in options) and "--no-ocr" not in options:
        raise ValueError("Prepared LiteParse batch-parse requires --no-ocr; use opulent-document for bounded offline OCR")
    if options and options[0] == "parse" and not any(arg in {"--help", "-h"} for arg in options):
        separator = args.index("--") if "--" in args else len(args)
        args = [*args[:separator], "--config", str(root / "liteparse-offline.json"), *args[separator:]]
    return [str(root / "node/bin/node"), str(root / "node_modules/@llamaindex/liteparse/dist/cli.js"), *args]


if __name__ == "__main__":
    try:
        argv = command(sys.argv[1], sys.argv[2:])
        os.environ["PATH"] = "/opt/opulent/document-tools/node/bin:/usr/bin:/bin"
        os.environ["TESSDATA_PREFIX"] = "/usr/share/tesseract-ocr/5/tessdata"
        for name in ("FIRECRAWL_API_KEY", "FIRECRAWL_API_URL", "NODE_OPTIONS", "NODE_PATH"):
            os.environ.pop(name, None)
        os.execv(argv[0], argv)
    except (ValueError, IndexError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
