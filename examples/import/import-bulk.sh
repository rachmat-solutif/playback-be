#!/bin/bash
# Bulk import conversations from a JSON file.
# Usage: IMPORT_API_KEY=... ./import-bulk.sh [BASE_URL]
#
# The script splits bulk-import.json into chunks of 10,000 conversations,
# submits them sequentially, and polls each asynchronous job to completion.

set -euo pipefail

BASE_URL="${1:-https://playback.rachmat.pro}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INPUT_FILE="${SCRIPT_DIR}/bulk-import.json"
CHUNK_SIZE=10000
IMPORT_API_KEY="${IMPORT_API_KEY:-}"

if [ -z "$IMPORT_API_KEY" ]; then
  echo "Error: IMPORT_API_KEY is not set"
  echo "Usage: IMPORT_API_KEY=your-key $0 [BASE_URL]"
  exit 1
fi

if [ ! -f "$INPUT_FILE" ]; then
  echo "Error: input file not found: $INPUT_FILE"
  exit 1
fi

prettyjson() {
  node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.stringify(JSON.parse(d),null,2))}catch{console.log(d)}})"
}

getfield() {
  node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d)['$1']||'')}catch{console.log('')}})"
}

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# Split the input without changing item order.
node - "$INPUT_FILE" "$TMP_DIR" "$CHUNK_SIZE" <<'NODE'
const fs = require('fs');
const [inputPath, outputDir, chunkSizeText] = process.argv.slice(2);
const chunkSize = Number(chunkSizeText);
const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
if (!Array.isArray(data.conversations) || data.conversations.length === 0) {
  throw new Error('Input must contain a non-empty conversations array');
}
for (let start = 0, chunk = 1; start < data.conversations.length; start += chunkSize, chunk++) {
  const items = data.conversations.slice(start, start + chunkSize);
  const filename = `chunk-${String(chunk).padStart(5, '0')}.json`;
  fs.writeFileSync(
    `${outputDir}/${filename}`,
    JSON.stringify({ conversations: items }) + '\n',
  );
}
console.log(`Prepared ${Math.ceil(data.conversations.length / chunkSize)} chunk(s) from ${data.conversations.length} conversations`);
NODE

TOTAL_CHUNKS=$(find "$TMP_DIR" -name 'chunk-*.json' | wc -l)
CURRENT_CHUNK=0

for CHUNK_FILE in "$TMP_DIR"/chunk-*.json; do
  CURRENT_CHUNK=$((CURRENT_CHUNK + 1))
  echo ""
  echo "Submitting chunk ${CURRENT_CHUNK}/${TOTAL_CHUNKS} (${CHUNK_SIZE} max records) ..."

  HTTP_RESPONSE=$(curl -sS -X POST "${BASE_URL}/api/import/bulk" \
    -H "Authorization: Bearer ${IMPORT_API_KEY}" \
    -H "Content-Type: application/json" \
    --data-binary "@${CHUNK_FILE}" \
    -w $'\n%{http_code}')
  HTTP_CODE="${HTTP_RESPONSE##*$'\n'}"
  RESPONSE_BODY="${HTTP_RESPONSE%$'\n'*}"

  if [ "$HTTP_CODE" != "202" ]; then
    echo "$RESPONSE_BODY" | prettyjson
    echo "Error: bulk request returned HTTP ${HTTP_CODE}"
    exit 1
  fi

  echo "$RESPONSE_BODY" | prettyjson
  JOB_ID=$(printf '%s' "$RESPONSE_BODY" | getfield jobId)
  if [ -z "$JOB_ID" ]; then
    echo "Error: no jobId in response"
    exit 1
  fi

  echo "Job started: $JOB_ID"
  echo "Polling status..."

  while true; do
    STATUS_RESPONSE=$(curl -sS \
      -H "Authorization: Bearer ${IMPORT_API_KEY}" \
      "${BASE_URL}/api/import/jobs/${JOB_ID}")
    echo "$STATUS_RESPONSE" | prettyjson

    JOB_STATUS=$(printf '%s' "$STATUS_RESPONSE" | getfield status)
    if [ "$JOB_STATUS" = "complete" ]; then
      break
    fi
    if [ "$JOB_STATUS" = "failed" ]; then
      echo "Error: job ${JOB_ID} failed"
      exit 1
    fi
    sleep 2
  done
done

echo ""
echo "Done. All ${TOTAL_CHUNKS} bulk import jobs completed."
