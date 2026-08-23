#!/usr/bin/env bash
# Demo for `atlas diff` (DESIGN.md §4.1).
#
# Builds a throwaway git repo from Bevy 0.19's examples, applies a change of the kind an
# assistant plausibly writes -- a new system that looks fine in review -- and shows what
# `git diff` tells you versus what atlas tells you.
#
#   ./scripts/demo-diff.sh
set -euo pipefail

ATLAS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORPUS="$(echo "$HOME"/.cargo/registry/src/*/bevy-0.19.0/examples | cut -d' ' -f1)"
DEMO="${TMPDIR:-/tmp}/atlas-demo-repo"

if [ ! -d "$CORPUS" ]; then
  echo "Bevy 0.19 sources not found in the cargo registry cache." >&2
  echo "Fetch them with:  cargo add bevy@0.19  (in any scratch crate)" >&2
  exit 1
fi

echo "==> building a demo repo from $(basename "$(dirname "$CORPUS")")/examples"
rm -rf "$DEMO"
mkdir -p "$DEMO"
cp -r "$CORPUS"/. "$DEMO"/
git -C "$DEMO" init -q
git -C "$DEMO" config user.email demo@example.com
git -C "$DEMO" config user.name demo
git -C "$DEMO" add -A
git -C "$DEMO" commit -qm "bevy examples at 0.19"
echo "    $(git -C "$DEMO" ls-files '*.rs' | wc -l | tr -d ' ') Rust files committed"

echo
echo "==> applying the change under review"
python3 - "$DEMO" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]) / '2d/move_sprite.rs'
s = p.read_text()
s = s.replace(".add_systems(Update, sprite_movement)",
              ".add_systems(Update, (sprite_movement, snap_to_grid))")
s += '''
/// Keeps sprites aligned to a pixel grid.
fn snap_to_grid(mut sprites: Query<&mut Transform, With<Sprite>>) {
    for mut transform in &mut sprites {
        transform.translation.x = transform.translation.x.round();
    }
}
'''
p.write_text(s)
PY

echo
echo "==> what a reviewer sees (git diff)"
git -C "$DEMO" --no-pager diff -- 2d/move_sprite.rs | sed 's/^/    /'

echo
echo "==> what atlas sees"
(cd "$ATLAS" && ATLAS_DIR="$DEMO" npx tsx src/cli/diff.ts --view | sed 's/^/    /')

echo
echo "The added system and sprite_movement both write Transform in Update with nothing"
echo "ordering them. Bevy will run them in either order, and the diff gives no hint."
echo
echo "A focus artefact was written. To open the review view:"
echo
echo "    npm run dev      then visit http://localhost:5173/"
echo
echo "Re-run to exercise the cached base (roughly 2x faster). Demo repo: $DEMO"
