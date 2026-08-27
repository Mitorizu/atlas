# atlas

Map who touches what state — and what a change just did to that map.

Code arrives faster than it can be read. What a change breaks is rarely visible in the diff, because it lives in the relationship between the changed code and everything else touching the same state.

**Rust / Bevy 0.19.** Node 22+. No Rust toolchain needed to use it.

## Install

```bash
npm install
npm run build:web
npm link
```

## Commands

```bash
atlas diff                     # working tree vs HEAD
atlas diff --view              #   ...and open the review view
atlas diff main..HEAD          # any two revisions
atlas map <path>               # whole-codebase map
atlas extract <path> -o g.json # artifact only, no server
atlas serve g.json             # view an existing artifact
```

| flag | |
|---|---|
| `-C <dir>` | run against a repo elsewhere, like `git -C` |
| `--view` | serve the result and print a URL |
| `--group crate\|cluster` | how the map carves regions (default `crate`) |
| `--hops N` | focus expansion distance (default 2) |
| `--watch` | re-extract on file change |
| `--json` | delta as JSON |

Try it on a throwaway repo built from Bevy's examples:

```bash
npm run demo
```

## Reviewing a change

An eight-line addition that reads as fine:

```rust
+  .add_systems(Update, (sprite_movement, snap_to_grid))
+fn snap_to_grid(mut sprites: Query<&mut Transform, With<Sprite>>) { … }
```

```
$ atlas diff
b29215c1 -> working tree   1 Rust file(s) changed  (base cached)
  1 AMBIGUITY INTRODUCED:
    move_sprite::snap_to_grid vs move_sprite::sprite_movement on Transform [Update]
  652 pre-existing (unchanged)
```

Both write `Transform` in `Update` with nothing ordering them, so Bevy runs them in either order. `--view` renders the neighbourhood of the change — four nodes out of 1,731 — with an inspector giving reads, writes, blast radius, and a jump to the source line.

## Reading a codebase

`atlas map <path>` opens at whole-map altitude: one labelled box per crate, with the type vocabulary of each. Zoom in and a region reveals its functions, most-connected first; the others stay boxed because they leave the viewport. Zoom is the only control.

## How it works

```
Rust ──▶ dialect (tree-sitter) ──▶ IR ──▶ graph ──▶ ELK ──▶ viewer
         knows Bevy               ▲ knows neither
```

One invariant: **a state node is state whose access is declared at a boundary.**

`fn plan_route(net: &RoadNetwork, from: LaneId) -> Vec<Waypoint>` declares what it consumes and produces, exactly as `Query<&mut Transform>` does. Parameters read, return types write, methods read their `impl` type — so a syntax-only parser suffices, and atlas needs no compiler, no macro expansion, and no code that builds.

**Ambiguity analysis is not a heuristic.** Bevy computes the same thing at runtime as schedule ambiguity detection; atlas reproduces it statically under five conditions — same app scope and schedule, no transitive ordering (system *or* set level), overlapping access with at least one write, filters not provably disjoint, no `ambiguous_with` suppression. `harness/` runs Bevy's own detector over eight fixtures and diffs it against atlas's findings. They agree on all eight.

## Development

```bash
npm test                    # 183 tests
npm run typecheck
npm run grammar:report      # verify the tree-sitter contract, regenerate reference/
npm run oracle:build && npm run oracle
npm run corpus:stats -- <path>
```

`DESIGN.md` holds the reasoning: what was measured, what was rejected, why.

## Limits

- **Only declared access is visible.** State mutated inside a function body, behind a call, is invisible. That is the price of needing no compiler.
- **Bevy 0.19 only.** Earlier versions renamed core concepts (`EventReader` became `MessageReader` in 0.17). Pointing atlas at them reports the mismatch rather than emitting an empty graph.
- **`#[cfg(...)]` in expression position does not parse** — a tree-sitter-rust limitation, 13 of 411 files in the reference corpus. Recovery is local, so surrounding items still extract.
- **Unresolvable scope is excluded, not guessed**, and counted in the coverage line.
- **No click-to-fly.** Navigation is zoom and pan; see `DESIGN.md` §11.
