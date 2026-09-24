#!/usr/bin/env python3
"""lx_index — embed corpus chunks (text-embedding-3-large via Vercel AI Gateway)
and upsert into turbopuffer.

Reads   corpus/index/chunks.jsonl     + the chunk note bodies it points at
Writes  turbopuffer namespaces lx-corpus (one row per chunk) and lx-documents
        (one row per document); Polygres tables lx_documents / lx_chunks
        (provenance + analytics); entities/namespaces/*.md instances;
        corpus/index/state.json (hashes already indexed — resumable).

Env: AI_GATEWAY_API_KEY, TURBOPUFFER_API_KEY, TURBOPUFFER_REGION,
     POLYGRES2_DIRECT_URL (DDL + bulk load).
Flags: --doc=doc-06 (restrict), --batch=N (upsert batch, default 256),
       --no-pg (skip polygres), --docs-only / --chunks-only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "corpus" / "index"
CHUNKS_JSONL = INDEX / "chunks.jsonl"
DOCS_JSON = INDEX / "documents.json"
STATE = INDEX / "state.json"
EMBED_MODEL = "openai/text-embedding-3-large"
DIMS = 3072
CHUNK_NS = os.environ.get("LX_TP_NAMESPACE", "lx-corpus")
DOC_NS = os.environ.get("LX_TP_DOC_NAMESPACE", "lx-documents")
REGION = os.environ["TURBOPUFFER_REGION"]
TP_BASE = f"https://{REGION}.turbopuffer.com"
TP_KEY = os.environ["TURBOPUFFER_API_KEY"]
GATEWAY_KEY = os.environ["AI_GATEWAY_API_KEY"]
GATEWAY_API = "https://ai-gateway.vercel.sh/v1"

FTS_FR = {"language": "french", "stemming": True, "remove_stopwords": True,
          "case_sensitive": False, "ascii_folding": True}

CHUNK_SCHEMA = {
    "text": {"type": "string", "full_text_search": FTS_FR, "regex": True},
    "doc": {"type": "string", "full_text_search": False},
    "doc_title": {"type": "string", "full_text_search": FTS_FR},
    "kind": {"type": "string"},
    "article": {"type": "string"},
    "path": {"type": "string", "full_text_search": FTS_FR, "regex": True},
    "lang": {"type": "string"},
    "pages": {"type": "string"},
}
DOC_SCHEMA = {
    "text": {"type": "string", "full_text_search": FTS_FR},
    "doc": {"type": "string"},
    "doc_title": {"type": "string", "full_text_search": FTS_FR},
    "kind": {"type": "string"},
    "year": {"type": "int"},
    "authors": {"type": "[]string"},
}


def http(method: str, url: str, key: str, body: dict | None = None, retries: int = 4) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                raw = res.read().decode()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:300]
            if e.code in (429, 500, 502, 503) and attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise SystemExit(f"{method} {url} -> {e.code}: {detail}")
    raise SystemExit("unreachable")


def embed(texts: list[str]) -> list[list[float]]:
    out = http("POST", f"{GATEWAY_API}/embeddings", GATEWAY_KEY, {
        "model": EMBED_MODEL, "dimensions": DIMS, "input": texts})
    data = sorted(out["data"], key=lambda d: d["index"])
    return [d["embedding"] for d in data]


# AI Gateway caps one request at 300k tokens — pack sub-batches by char budget
def embed_batch(texts: list[str], char_budget: int = 400_000) -> list[list[float]]:
    vecs: list[list[float]] = []
    group: list[str] = []
    size = 0
    for t in texts:
        if group and size + len(t) > char_budget:
            vecs.extend(embed(group))
            group, size = [], 0
        group.append(t)
        size += len(t)
    if group:
        vecs.extend(embed(group))
    return vecs


def body_of(path: Path) -> str:
    raw = path.read_text(encoding="utf-8")
    end = raw.find("\n---", 4)
    return raw[end + 4:].strip() if end != -1 else raw


def upsert(ns: str, rows: list[dict], schema: dict) -> None:
    http("POST", f"{TP_BASE}/v2/namespaces/{ns}", TP_KEY, {
        "upsert_rows": rows,
        "distance_metric": "cosine_distance",
        "schema": schema,
    })


def pg_setup() -> None:
    import psycopg
    ddl = """
    CREATE TABLE IF NOT EXISTS lx_documents (
      doc_id text primary key, title text, kind text, language text,
      year int, authors text[], topics text[], raw_file text,
      pages int, chunk_count int, indexed_at timestamptz default now());
    CREATE TABLE IF NOT EXISTS lx_chunks (
      chunk_id text primary key, doc_id text references lx_documents(doc_id),
      locator text, ordinal int, article text, structure text[],
      path text, ns text, hash text, tokens int,
      indexed_at timestamptz default now());
    CREATE INDEX IF NOT EXISTS lx_chunks_doc ON lx_chunks(doc_id);
    """
    with psycopg.connect(os.environ["POLYGRES2_DIRECT_URL"], autocommit=True) as c:
        c.execute(ddl)


def pg_load(docs: list[dict], rows: list[dict]) -> None:
    import psycopg
    with psycopg.connect(os.environ["POLYGRES2_DIRECT_URL"], autocommit=True) as c:
        for d in docs:
            c.execute(
                "INSERT INTO lx_documents(doc_id,title,kind,language,year,authors,topics,"
                "raw_file,pages,chunk_count) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                "ON CONFLICT (doc_id) DO UPDATE SET title=excluded.title,"
                "chunk_count=excluded.chunk_count,indexed_at=now()",
                (d["doc_id"], d["title"], d["kind"], d["language"], d.get("year"),
                 d.get("authors") or [], d.get("topics") or [], d["raw_file"],
                 d.get("pages"), d["chunk_count"]))
        for r in rows:
            c.execute(
                "INSERT INTO lx_chunks(chunk_id,doc_id,locator,ordinal,article,"
                "structure,path,ns,hash,tokens) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                "ON CONFLICT (chunk_id) DO UPDATE SET hash=excluded.hash,indexed_at=now()",
                (r["chunk_id"], r["doc_id"], r["locator"], r["ordinal"],
                 r.get("article"), r.get("structure") or [], r["path"], r["ns"],
                 r["hash"], r.get("tokens")))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc")
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--no-pg", action="store_true")
    ap.add_argument("--docs-only", action="store_true")
    ap.add_argument("--chunks-only", action="store_true")
    ap.add_argument("--force", action="store_true",
                    help="delete namespaces + reset resume state before indexing")
    args = ap.parse_args()

    if args.force:
        for ns in (CHUNK_NS, DOC_NS):
            http("DELETE", f"{TP_BASE}/v1/namespaces/{ns}", TP_KEY)
            print(f"{ns}: deleted")
        if STATE.exists():
            STATE.unlink()

    rows = [json.loads(l) for l in CHUNKS_JSONL.read_text().splitlines() if l.strip()]
    docs = json.loads(DOCS_JSON.read_text())
    if args.doc:
        rows = [r for r in rows if r["doc_id"] == args.doc]
        docs = [d for d in docs if d["doc_id"] == args.doc]
    state = json.loads(STATE.read_text()) if STATE.exists() else {}

    # per-row hash for resume: hash of (text,model) so a model swap re-indexes
    pending = []
    for r in rows:
        text = body_of(ROOT / r["path"])
        h = hashlib.sha256(f"{EMBED_MODEL}:{text}".encode()).hexdigest()[:16]
        r["hash"] = h
        r["text"] = text
        if args.force or state.get(r["chunk_id"]) != h:
            pending.append(r)

    if not args.chunks_only:
        doc_rows = []
        for d in docs:
            text = f"{d['title']} — {d['kind']} ({d.get('language','fr')}). " \
                   f"Topics: {', '.join(d.get('topics', []))}. {d.get('note','')}"
            vec = embed([text])[0]
            doc_rows.append({"id": d["doc_id"], "vector": vec, "text": text,
                             "doc": d["doc_id"], "doc_title": d["title"],
                             "kind": d["kind"], "year": d.get("year") or 0,
                             "authors": d.get("authors") or []})
        upsert(DOC_NS, doc_rows, DOC_SCHEMA)
        print(f"{DOC_NS}: {len(doc_rows)} document rows upserted")

    if not args.docs_only:
        done = 0
        for i in range(0, len(pending), args.batch):
            part = pending[i:i + args.batch]
            vecs = embed_batch([p["text"][:8000] for p in part])
            upsert(CHUNK_NS, [
                {"id": p["chunk_id"], "vector": v, "text": p["text"][:4000],
                 "doc": p["doc_id"], "doc_title": p["doc_title"], "kind": p["kind"],
                 "article": p.get("article") or "", "path": " > ".join(p.get("structure") or []),
                 "lang": "fr", "pages": p.get("pages") or ""}
                for p, v in zip(part, vecs)], CHUNK_SCHEMA)
            for p in part:
                state[p["chunk_id"]] = p["hash"]
            STATE.write_text(json.dumps(state))
            done += len(part)
            print(f"{CHUNK_NS}: {done}/{len(pending)} upserted", flush=True)

    if not args.no_pg:
        pg_setup()
        pg_load(docs, [{k: v for k, v in r.items() if k != "text"} for r in rows])
        print("polygres: lx_documents + lx_chunks loaded")

    # lx.namespace instances
    ns_dir = ROOT / "entities" / "namespaces"
    ns_dir.mkdir(parents=True, exist_ok=True)
    for name, holds, count in ((CHUNK_NS, "chunks", len(rows)), (DOC_NS, "documents", len(docs))):
        (ns_dir / f"{name}.md").write_text(
            f"---\ntype: lx.namespace\ntldr: turbopuffer {name} ({holds})\n"
            f"ns_name: {name}\nregion: {REGION}\nmodel: {EMBED_MODEL}\n"
            f"dimensions: {DIMS}\nholds: {holds}\nrow_count: {count}\n---\n")
    print("done")


if __name__ == "__main__":
    main()
