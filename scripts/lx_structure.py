#!/usr/bin/env python3
"""lx_structure — cut extracted corpus notes into the typed knowledge graph.

Reads   corpus/notes/doc-NN.md  (markdown from lx_extract.mjs)
        corpus/documents.yaml   (bibliographic metadata)
Writes  entities/documents/doc-NN-*.md        (lx.document instances)
        corpus/structure/doc-NN/*.md          (lx.structure + lx.article notes)
        corpus/chunks/doc-NN/*.md             (lx.chunk notes — body is the exact
                                               text embedded into turbopuffer)
        corpus/index/chunks.jsonl             (id -> path + context manifest)
        corpus/index/documents.json           (document rows for the plugin)

French legal structure detection: LIVRE/TITRE/CHAPITRE/SECTION headings,
markdown #..#### headings, and Article N / Art. N boundaries. Statutes get
article locators (art0100); treatises get section locators (s0042).
"""
from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
NOTES = ROOT / "corpus" / "notes"
DOCS_YAML = ROOT / "corpus" / "documents.yaml"
ENT_DOC = ROOT / "entities" / "documents"
STRUCT_DIR = ROOT / "corpus" / "structure"
CHUNK_DIR = ROOT / "corpus" / "chunks"
INDEX_DIR = ROOT / "corpus" / "index"

# ~4 chars/token for French legal prose; 4600 chars ≈ 1100-1200 tokens.
MAX_CHARS = 4600
OVERLAP = 200
TP_NS = "lx-corpus"

ROMAN = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6, "VII": 7, "VIII": 8,
         "IX": 9, "X": 10, "PREMIER": 1, "PREMIERE": 1, "IER": 1, "IERE": 1}

LEVEL_ORDER = ["livre", "partie", "titre", "chapitre", "section", "sous-section"]

PAT = [
    ("livre", re.compile(r"^\s*(?:#+\s*)?LIVRE\s+([IVXLC]+|PREMIER|PREMIERE)\b[.:\-\s]*(.*)", re.I)),
    ("titre", re.compile(r"^\s*(?:#+\s*)?TITRE\s+([IVXLC]+|PREMIER|PREMIERE)\b[.:\-\s]*(.*)", re.I)),
    ("chapitre", re.compile(r"^\s*(?:#+\s*)?CHAPITRE\s+([IVXLC]+|PREMIER|PREMIERE)\b[.:\-\s]*(.*)", re.I)),
    ("partie", re.compile(r"^\s*(?:#+\s*)?PARTIE\s+([IVXLC]+|PREMIER|PREMIERE)\b[.:\-\s]*(.*)", re.I)),
    ("section", re.compile(r"^\s*(?:#+\s*)?SECTION\s+(\d+|[IVXLC]+)\b[.:\-\s]*(.*)", re.I)),
    ("sous-section", re.compile(r"^\s*(?:#+\s*)?SOUS-SECTION\s+(\d+)\b[.:\-\s]*(.*)", re.I)),
]
PAT_ARTICLE = re.compile(
    r"^\s*(?:#+\s*)?(?:ARTICLE|Article|ART\.?|Art\.?|art\.?)\s+"
    r"(?:n°\s*|num(?:ero|éro)?\.?\s*)?"
    r"(\d+(?:[-.]\d+)*|PREMIER|Premier|premier|1er)\b\s*[.:\-–]?\s*(.*)",
)
PAT_HEADING = re.compile(r"^\s*(#{1,4})\s+(.+?)\s*$")


def slug(text: str, maxlen: int = 48) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text[:maxlen].strip("-") or "x"


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


class _Q(str):
    """str that must always be emitted single-quoted (values like '10821230727e1683'
    that pyyaml leaves bare but stricter YAML parsers resolve as float)."""


def _repr_q(dumper: yaml.Dumper, s: str) -> yaml.ScalarNode:
    return dumper.represent_scalar("tag:yaml.org,2002:str", s, style="'")


yaml.SafeDumper.add_representer(_Q, _repr_q)


def frontmatter(fields: dict) -> str:
    clean = {k: v for k, v in fields.items() if v is not None}
    return "---\n" + yaml.safe_dump(clean, allow_unicode=True, sort_keys=False) + "---"


def detect_boundary(line: str):
    """Return ('article', number, heading) | (level, label, heading) | None."""
    m = PAT_ARTICLE.match(line)
    if m:
        return ("article", m.group(1), m.group(2).strip())
    for level, pat in PAT:
        m = pat.match(line)
        if m:
            return (level, m.group(1).upper(), m.group(2).strip())
    m = PAT_HEADING.match(line)
    if m:
        depth = len(m.group(1))
        level = ["titre", "chapitre", "section", "sous-section"][min(depth - 1, 3)]
        return (level, None, m.group(2).strip())
    return None


def split_paragraphs(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]


def chunk_block(text: str) -> list[str]:
    """Split a block into <=MAX_CHARS chunks on paragraph boundaries, with overlap."""
    paras = split_paragraphs(text)
    chunks: list[str] = []
    cur = ""
    for p in paras:
        if len(p) > MAX_CHARS:  # hard-split a huge paragraph at sentence edges
            for sent in re.split(r"(?<=[.!?])\s+", p):
                if len(cur) + len(sent) + 1 > MAX_CHARS and cur:
                    chunks.append(cur.strip())
                    cur = cur[-OVERLAP:] + "\n" if OVERLAP else ""
                cur += sent + " "
            continue
        if len(cur) + len(p) + 2 > MAX_CHARS and cur:
            chunks.append(cur.strip())
            cur = cur[-OVERLAP:] + "\n\n" if OVERLAP else ""
        cur += p + "\n\n"
    if cur.strip():
        chunks.append(cur.strip())
    return chunks or [text.strip()]


def rel(p: Path) -> str:
    return str(p.relative_to(ROOT))


def write_note(path: Path, fields: dict, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(frontmatter(fields) + "\n" + body.strip() + "\n")


def process_doc(doc: dict, chunk_rows: list[dict], manifest_docs: list[dict]) -> None:
    doc_id = doc["doc_id"]
    note_path = NOTES / f"{doc_id}.md"
    if not note_path.exists():
        print(f"{doc_id}: corpus/notes/{doc_id}.md missing — run lx_extract first", file=sys.stderr)
        return
    text = note_path.read_text(encoding="utf-8")
    lines = text.split("\n")

    # lx.document instance
    authors = [f"[[{a}]]" for a in doc.get("authors", [])]
    topics = [f"[[{t}]]" for t in doc.get("topics", [])]
    doc_stem = f"{doc_id}-{slug(doc['title'], 40)}"
    doc_rel = f"entities/documents/{doc_stem}.md"
    write_note(ROOT / doc_rel, {
        "type": "lx.document",
        "tldr": f"{doc['title']} ({doc.get('year') or 'n.d.'})",
        "doc_id": doc_id,
        "kind": doc["kind"],
        "title": doc["title"],
        "authors": authors or None,
        "year": doc.get("year"),
        "language": doc["language"],
        "topics": topics or None,
        "raw_file": f"corpus/raw/{doc['raw_file']}",
        "captured": "2026-09-22",
        "consolidated": doc.get("consolidated"),
        "rights": doc.get("rights"),
    }, f"# {doc['title']}\n\nExtracted text: [[{doc_id}]] "
       f"(raw: `corpus/raw/{doc['raw_file']}`). Structure and chunks under "
       f"`corpus/structure/{doc_id}/` and `corpus/chunks/{doc_id}/`.\n")
    manifest_docs.append({**{k: doc.get(k) for k in
        ("doc_id", "title", "kind", "language", "raw_file")},
        "authors": doc.get("authors", []), "year": doc.get("year"),
        "topics": doc.get("topics", []), "note": doc_rel, "chunk_count": 0})

    # Walk boundaries
    stack: list[dict] = []           # [{level, label, heading, slug}]
    cur_article: dict | None = None  # {number, heading, slug, locator}
    order = {"structure": 0, "article": 0, "block": 0}
    used_slugs: set[str] = set()     # article stems + structure slugs already taken
    block_lines: list[str] = []

    def unique_slug(base: str) -> str:
        """base, base-2, base-3 ... first free stem in this doc."""
        slug_candidate, k = base, 1
        while slug_candidate in used_slugs:
            k += 1
            slug_candidate = f"{base}-{k}"
        used_slugs.add(slug_candidate)
        return slug_candidate

    def parent_path() -> list[str]:
        return [s["heading"] or f"{s['level']} {s['label']}" for s in stack]

    def flush_block():
        nonlocal block_lines, cur_article
        body = "\n".join(block_lines).strip()
        block_lines = []
        if not body:
            return
        scope_slug = cur_article["slug"] if cur_article else (stack[-1]["slug"] if stack else "front")
        scope_dir = CHUNK_DIR / doc_id / scope_slug
        # Non-article blocks get a per-doc sequential locator so repeated
        # flushes under one scope can never collide.
        if cur_article is None:
            order["block"] += 1
        for i, piece in enumerate(chunk_block(body)):
            locator = cur_article["locator"] if cur_article else f"s{order['block']:04d}"
            cid = f"{doc_id}:{locator}:c{i}"
            fields = {
                "type": "lx.chunk",
                "tldr": (piece[:80].replace("\n", " ")),
                "chunk_id": cid,
                "document": f"[[{doc_stem}]]",
                "parent": f"[[{stack[-1]['slug']}]]" if stack else None,
                "article": f"[[{cur_article['slug']}]]" if cur_article else None,
                "ordinal": i,
                "tokens": len(piece) // 4,
                "tp_namespace": TP_NS,
                "hash": _Q(sha(piece)),
            }
            path = scope_dir / f"{locator}-c{i}.md"
            write_note(path, fields, piece)
            chunk_rows.append({
                "chunk_id": cid, "path": rel(path), "doc_id": doc_id,
                "doc_title": doc["title"], "kind": doc["kind"],
                "structure": parent_path(), "article": cur_article["number"] if cur_article else None,
                "locator": locator, "ordinal": i, "ns": TP_NS,
            })
            manifest_docs[-1]["chunk_count"] += 1

    def open_structure(level, label, heading):
        nonlocal cur_article
        flush_block()
        cur_article = None
        while stack and LEVEL_ORDER.index(stack[-1]["level"]) >= LEVEL_ORDER.index(level):
            stack.pop()
        order["structure"] += 1
        node_slug = unique_slug(f"{doc_id}-{level}-{slug(label or heading, 36)}-{order['structure']:03d}")
        stack.append({"level": level, "label": label, "heading": heading, "slug": node_slug})
        parent_slug = stack[-2]["slug"] if len(stack) > 1 else None
        write_note(STRUCT_DIR / doc_id / f"{node_slug}.md", {
            "type": "lx.structure",
            "tldr": f"{level} {label or ''} {heading}".strip(),
            "document": f"[[{doc_stem}]]",
            "parent": f"[[{parent_slug}]]" if parent_slug else None,
            "level": level,
            "heading": heading or f"{level} {label}",
            "order": order["structure"],
        }, f"# {level.capitalize()} {label or ''} — {heading}\n")

    def open_article(number, rest):
        nonlocal cur_article, block_lines
        flush_block()
        order["article"] += 1
        num = re.sub(r"[^0-9A-Za-z]+", "", number) or f"x{order['article']:03d}"
        slug_art = unique_slug(f"{doc_id}-art{num}")
        # The 'rest' of the matched line is the article's first text (statutes carry
        # 'Art. N. <full text>' on one line); a short rest doubles as the rubric.
        heading = rest if rest and len(rest) <= 80 else ""
        # Locator mirrors the stem suffix: art2, art2-2, ... keeps chunk_ids unique
        # when a doc repeats article numbers across parts.
        locator = slug_art.removeprefix(f"{doc_id}-")
        cur_article = {"number": number, "num": num, "heading": heading, "slug": slug_art, "locator": locator}
        parent_slug = stack[-1]["slug"] if stack else None
        write_note(STRUCT_DIR / doc_id / f"{slug_art}.md", {
            "type": "lx.article",
            "tldr": f"Article {number} {heading}".strip(),
            "document": f"[[{doc_stem}]]",
            "parent": f"[[{parent_slug}]]" if parent_slug else None,
            "number": number,
            "heading": heading or None,
            "order": order["article"],
        }, f"# Article {number} — {heading}\n")
        if rest:
            block_lines = [rest]

    for line in lines:
        b = detect_boundary(line)
        if b is None:
            block_lines.append(line)
            continue
        if b[0] == "article":
            open_article(b[1], b[2].lstrip("—.:-– "))
        else:
            open_structure(b[0], b[1], b[2].lstrip("—.:-– "))
    flush_block()


def main() -> None:
    docs = yaml.safe_load(DOCS_YAML.read_text())
    only = {a.removeprefix("--doc=") for a in sys.argv[1:] if a.startswith("--doc=")}
    chunk_rows: list[dict] = []
    manifest_docs: list[dict] = []
    for doc in docs:
        if only and doc["doc_id"] not in only:
            continue
        process_doc(doc, chunk_rows, manifest_docs)
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    (INDEX_DIR / "chunks.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in chunk_rows) + "\n")
    (INDEX_DIR / "documents.json").write_text(json.dumps(manifest_docs, ensure_ascii=False, indent=2))
    write_csv_indexes(chunk_rows, manifest_docs)
    print(f"chunk notes: {len(chunk_rows)} across {len(manifest_docs)} documents")


def write_csv_indexes(chunk_rows: list[dict], manifest_docs: list[dict]) -> None:
    """Flat CSV companions to the JSON index — browsable via the workspace data-grid."""
    with (INDEX_DIR / "chunks.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["chunk_id", "doc_id", "doc_title", "kind", "article", "locator", "structure", "chars"])
        for r in chunk_rows:
            try:
                chars = len(Path(r["path"]).read_text())
            except OSError:
                chars = 0
            w.writerow([r["chunk_id"], r["doc_id"], r["doc_title"], r["kind"],
                        r.get("article") or "", r["locator"], " › ".join(r.get("structure") or []), chars])
    with (INDEX_DIR / "documents.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["doc_id", "title", "kind", "language", "authors", "year", "topics", "chunk_count", "raw_file"])
        for d in manifest_docs:
            w.writerow([d["doc_id"], d["title"], d["kind"], d.get("language", ""),
                        "; ".join(d.get("authors") or []), d.get("year") or "",
                        "; ".join(d.get("topics") or []), d.get("chunk_count") or "", d.get("raw_file", "")])


if __name__ == "__main__":
    main()
