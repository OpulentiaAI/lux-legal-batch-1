"""Checks the rendered PDF and records headings that need a page break.

Usage: python3 verify.py [pdf]   (needs PyMuPDF)

Reports, per page: headings stranded at the page foot, text left of the column (lost padding),
em dashes, and pages that hold only a few lines. Stranded headings are added to pagination.json,
which build.mjs reads; rerun the build and this check until it reports no issues.
"""
import json
import sys
from pathlib import Path

import pymupdf

HERE = Path(__file__).parent
PDF = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "opulent-research-update-francois-bernard.pdf"
PX = 96 / 72                    # PDF points to CSS px
TOP, BOTTOM = 92, 1122.5 - 80   # content box, as in build.mjs
LEFT = 48 + 44 - 2              # rail plus the inner padding


def lines(page):
    out = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            spans = [s for s in line["spans"] if s["text"].strip()]
            if not spans:
                continue
            x0, y0, _, y1 = (v * PX for v in line["bbox"])
            if y0 < TOP or y1 > BOTTOM:
                continue
            size = round(spans[0]["size"] * PX, 1)
            text = "".join(s["text"] for s in spans)
            out.append({"x0": x0, "y0": y0, "y1": y1, "size": size, "font": spans[0]["font"], "text": text})
    return sorted(out, key=lambda l: (l["y0"], l["x0"]))


def main():
    doc = pymupdf.open(PDF)
    path = HERE / "pagination.json"
    overrides = json.loads(path.read_text()) if path.exists() else {}
    breaks = list(overrides.get("breakBefore", []))
    issues, added = [], []
    for n, page in enumerate(doc, start=1):
        ls = lines(page)
        for i, l in enumerate(ls):
            is_heading = (l["size"] == 24.0 and "Lig" in l["font"]) or (l["size"] == 14.0 and "Medium" in l["font"])
            if is_heading and n > 1:
                below = [m for m in ls[i + 1:] if m["y0"] > l["y1"] - 1]
                if len(below) < 2:
                    issues.append(f"p{n}: heading stranded at the page foot: {l['text']!r}")
                    if l["text"] not in breaks:
                        breaks.append(l["text"])
                        added.append(l["text"])
            if l["x0"] < LEFT and not l["text"].startswith(("TABLE", "SOURCE")) and l["size"] > 9:
                issues.append(f"p{n}: text left of the column at x={l['x0']:.0f}: {l['text'][:50]!r}")
            if "—" in l["text"]:
                issues.append(f"p{n}: em dash: {l['text'][:60]!r}")
        if ls and ls[-1]["y1"] - TOP < 0.2 * (BOTTOM - TOP) and n not in (1, doc.page_count):
            issues.append(f"p{n}: page holds only {len(ls)} lines")
        if n == doc.page_count and len(ls) < 8:
            issues.append(f"p{n}: last page holds only {len(ls)} lines")
    if added:
        path.write_text(json.dumps({"breakBefore": breaks}, ensure_ascii=False, indent=2) + "\n")
    print(f"{doc.page_count} pages")
    for issue in issues:
        print(" ", issue)
    if added:
        print(f"added {len(added)} break(s) to pagination.json; rebuild")
    sys.exit(1 if issues else 0)


if __name__ == "__main__":
    main()
