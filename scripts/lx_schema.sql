-- Polygres "Default Project" (p200ca3d1b2c180b7c928652) — corpus provenance store.
-- Run: psql "$POLYGRES2_DIRECT_URL" -f scripts/lx_schema.sql
-- (lx_index.py applies the same DDL idempotently; this file documents it.)

CREATE TABLE IF NOT EXISTS lx_documents (
  doc_id       text PRIMARY KEY,
  title        text NOT NULL,
  kind         text NOT NULL,
  language     text NOT NULL DEFAULT 'fr',
  year         int,
  authors      text[],
  topics       text[],
  raw_file     text,
  pages        int,
  chunk_count  int,
  indexed_at   timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lx_chunks (
  chunk_id   text PRIMARY KEY,
  doc_id     text NOT NULL REFERENCES lx_documents(doc_id),
  locator    text NOT NULL,          -- art0100 | s0042
  ordinal    int  NOT NULL,
  article    text,
  structure  text[],                 -- ordered heading path
  path       text NOT NULL,          -- repo path of the chunk note
  ns         text NOT NULL,          -- turbopuffer namespace
  hash       text NOT NULL,          -- sha256(model:text) for resumable indexing
  tokens     int,
  indexed_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lx_chunks_doc ON lx_chunks(doc_id);
CREATE INDEX IF NOT EXISTS lx_chunks_article ON lx_chunks(doc_id, article);
