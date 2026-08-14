#!/usr/bin/env bash
# Open the Pocketsize app. Pass a folder to queue it on launch.
set -euo pipefail
cd "$(dirname "$0")"
PY=${PYTHON:-python3}
if ! "$PY" -c "import PIL, numpy, ssimulacra2, imagequant, zopfli" 2>/dev/null; then
  echo "First run - installing dependencies..."
  "$PY" -m pip install --quiet --upgrade -r requirements.txt
fi
exec "$PY" -m pocketsize.gui "$@"
