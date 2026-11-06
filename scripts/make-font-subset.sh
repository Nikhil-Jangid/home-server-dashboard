#!/usr/bin/env bash
# Rebuilds www/fonts/jbm-nerd-subset.woff2: the terminal's glyph-only subset of "JetBrainsMono Nerd Font Mono"
# (OFL-1.1): the ellipsis, box drawing, the powerline separators and the few Nerd icons the prompt uses.
# No ASCII or Latin-1: text stays in each theme's own --mono.
# UNICODES is the single source of truth, so keep it on one line: term/test_dashboard_bashrc.py checks the prompt's
# glyphs against it, and tests/themes.test.js checks that the built font maps every code point in it and that the
# @font-face unicode-range in www/styles.css lists exactly these ranges.
#
# Usage: bash scripts/make-font-subset.sh
#   JBM_ZIP=/path/to/JetBrainsMono.zip reuses an already-downloaded release zip (still checked against the hash).
#
# Needs python3 (with venv), curl, unzip and network access to github.com and PyPI. fonttools and brotli go into
# a throwaway venv in a temp directory; nothing is installed globally.
set -euo pipefail
cd "$(dirname "$0")/.."

UNICODES="U+2026,U+2500-257F,U+276F,U+E0A0-E0A2,U+E0B0-E0B7,U+F00C,U+F00D,U+F015,U+F017,U+F07B,U+F126,U+F17C,U+F31B"

# Official ryanoasis/nerd-fonts release asset (published 2024-04-12 by the release workflow, 117875043 bytes).
FONT_URL="https://github.com/ryanoasis/nerd-fonts/releases/download/v3.2.1/JetBrainsMono.zip"
EXPECTED_SHA256="6596922aabaf8876bb657c36a47009ac68c388662db45d4ac05c2536c2f07ade"
FONT_TTF="JetBrainsMonoNerdFontMono-Regular.ttf"
# Fallback licence if the zip ever lacks OFL.txt: JetBrains Mono's own, at the version Nerd Fonts v3.2.1 patched.
OFL_FALLBACK_URL="https://raw.githubusercontent.com/JetBrains/JetBrainsMono/v2.304/OFL.txt"

OUT_DIR="www/fonts"
OUT_FONT="$OUT_DIR/jbm-nerd-subset.woff2"
OUT_OFL="$OUT_DIR/OFL.txt"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

zip="$tmp/JetBrainsMono.zip"
if [ -n "${JBM_ZIP:-}" ]; then
  cp "$JBM_ZIP" "$zip"
else
  echo "== downloading $FONT_URL"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$zip" "$FONT_URL"
fi

actual="$(shasum -a 256 "$zip" | cut -d' ' -f1)"
echo "== sha256 $actual"
if [ "$actual" != "$EXPECTED_SHA256" ]; then
  echo "FAIL: JetBrainsMono.zip sha256 mismatch (expected $EXPECTED_SHA256); refusing to build from it" >&2
  exit 1
fi

mkdir "$tmp/font"
unzip -q -o "$zip" "$FONT_TTF" 'OFL.txt' -d "$tmp/font" 2>/dev/null || unzip -q -o "$zip" "$FONT_TTF" -d "$tmp/font"
[ -f "$tmp/font/$FONT_TTF" ] || { echo "FAIL: $FONT_TTF not in the zip" >&2; exit 1; }

echo "== fonttools in a temporary venv"
python3 -m venv "$tmp/venv"
"$tmp/venv/bin/pip" install --quiet --disable-pip-version-check fonttools brotli

mkdir -p "$OUT_DIR"
"$tmp/venv/bin/pyftsubset" "$tmp/font/$FONT_TTF" \
  --unicodes="$UNICODES" --flavor=woff2 --layout-features='' --no-hinting \
  --output-file="$OUT_FONT"

if [ -f "$tmp/font/OFL.txt" ]; then
  cp "$tmp/font/OFL.txt" "$OUT_OFL"
else
  echo "== OFL.txt not in the zip; fetching JetBrains Mono's"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$OUT_OFL" "$OFL_FALLBACK_URL"
fi

echo "== wrote $OUT_FONT ($(wc -c < "$OUT_FONT" | tr -d ' ') bytes) and $OUT_OFL"
