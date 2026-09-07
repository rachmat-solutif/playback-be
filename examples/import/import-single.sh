#!/bin/bash
# Import a single conversation with an audio file attachment.
# Usage: ./import-single.sh [BASE_URL]
#
# The JSON body is in single-import.json (audio.url is omitted because
# we attach the file directly via multipart).

#BASE_URL="${1:-http://localhost:3000}"
BASE_URL="${1:-https://playback.rachmat.pro}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

AUDIO_FILE="${SCRIPT_DIR}/sample-call.wav"

if [ ! -f "$AUDIO_FILE" ]; then
  echo "Error: audio file not found at $AUDIO_FILE"
  exit 1
fi

echo "Importing single conversation to ${BASE_URL}/api/import ..."

curl -s -X POST "${BASE_URL}/api/import" \
  -F "data=@${SCRIPT_DIR}/single-import.json;type=application/json" \
  -F "audio=@${AUDIO_FILE};type=audio/wav" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))"

echo ""
echo "Done."
