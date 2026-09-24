#!/usr/bin/env bash
# lx_pipeline — full corpus build: PDF -> typed notes -> chunks -> embeddings
# -> turbopuffer -> polygres.
#
# Prereqs:
#   PDFs named doc-NN-*.pdf in corpus/raw/  (see corpus/documents.yaml)
#   @firecrawl/anydoc installed (~/arsumbris/au-ingest/converters, or LX_ANYDOC_PATH)
#   env: JINA_API_KEY TURBOPUFFER_API_KEY TURBOPUFFER_REGION POLYGRES2_DIRECT_URL
#
# Usage: scripts/lx_pipeline.sh [--doc=doc-06] [--skip-extract]
set -euo pipefail
cd "$(dirname "$0")/.."

DOC_FLAG=""
SKIP_EXTRACT=0
for a in "$@"; do
  case "$a" in
    --doc=*) DOC_FLAG="$a" ;;
    --skip-extract) SKIP_EXTRACT=1 ;;
  esac
done

if [ "$SKIP_EXTRACT" = "0" ]; then
  node scripts/lx_extract.mjs --refresh
fi
python3 scripts/lx_structure.py ${DOC_FLAG:+$DOC_FLAG}
python3 scripts/lx_index.py ${DOC_FLAG:+$DOC_FLAG}
echo "pipeline complete — start the workspace daemon and lx_search is live"
