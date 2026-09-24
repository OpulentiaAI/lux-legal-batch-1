#!/usr/bin/env python3
"""lx_ocr — OCR fallback extractor for corpus PDFs anydoc refuses.

Uses liteparse (run-llama/liteparse) with ocr_enabled=True so mixed
text/scanned PDFs still yield a complete markdown note. Called by
lx_extract.mjs when anydoc reports 'needs OCR'.

Usage: python3 scripts/lx_ocr.py <pdf> <out.md>
"""
import sys
from pathlib import Path

import liteparse


def main() -> int:
    pdf, out = sys.argv[1], Path(sys.argv[2])
    parser = liteparse.LiteParse(
        ocr_enabled=True,
        ocr_language="fra",
        output_format="markdown",
        keep_headers_footers=False,
        continue_on_page_error=True,
        num_workers=4,
        quiet=True,
    )
    result = parser.parse(pdf)
    text = result.text or ""
    if not text.strip():
        print(f"ocr produced no text for {pdf}", file=sys.stderr)
        return 1
    failed = [e for e in (result.page_errors or [])]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    print(f"{out.name}: {len(text)} chars, {result.total_pages} pages"
          + (f" ({len(failed)} page errors)" if failed else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
