#!/bin/bash
set -e

# ── Volume seed logic ──────────────────────────────────────
# Railway Volume at /app/data shadows git-tracked files.
# On first deploy (or empty volume), copy seed data into the volume.
# Subsequent deploys preserve volume data; only NEW git files are added.

SEED_DIR="/app/data_seed"
DATA_DIR="/app/data"

if [ -d "$SEED_DIR" ]; then
    # Count files in volume
    FILE_COUNT=$(find "$DATA_DIR" -type f 2>/dev/null | wc -l)

    if [ "$FILE_COUNT" -lt 5 ]; then
        echo "[start.sh] Volume appears empty ($FILE_COUNT files). Seeding from git data..."
        cp -rn "$SEED_DIR"/* "$DATA_DIR"/ 2>/dev/null || true
        echo "[start.sh] Seed complete. Files now: $(find "$DATA_DIR" -type f | wc -l)"
    else
        echo "[start.sh] Volume has $FILE_COUNT files. Merging any new git-only files..."
        # Copy only files that don't exist in volume yet (preserve existing data)
        cd "$SEED_DIR" && find . -type f | while read f; do
            if [ ! -f "$DATA_DIR/$f" ]; then
                mkdir -p "$(dirname "$DATA_DIR/$f")"
                cp "$SEED_DIR/$f" "$DATA_DIR/$f"
                echo "[start.sh]   + copied new: $f"
            fi
        done
        cd /app
    fi

    # Ensure required subdirectories exist
    mkdir -p "$DATA_DIR/processed/snapshots"
    mkdir -p "$DATA_DIR/processed/global_outbreak_archive"
    mkdir -p "$DATA_DIR/uploads"
    mkdir -p "$DATA_DIR/raw"
    mkdir -p "$DATA_DIR/reports"
else
    echo "[start.sh] No seed directory found (no volume mount?). Using git data as-is."
fi

# ── Start server ───────────────────────────────────────────
echo "[start.sh] Starting uvicorn on port ${PORT:-8000}..."
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
