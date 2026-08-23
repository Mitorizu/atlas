# atlas

Understand unfamiliar code fast, by mapping *who touches what state* — and what a change just did to that map.

Code now arrives faster than it can be read. What a machine-written change breaks is rarely visible in the diff, because it lives in the relationship between the changed code and everything else that touches the same state. atlas makes that relationship visible, and flags the class of defect that reads fine in review: two systems that write the same state with nothing ordering them.

Current dialect: **Bevy 0.19** (Rust). The architecture is framework-agnostic behind one seam; more dialects are planned.

---

## Install

Requires Node 22+. No Rust toolchain is needed to *use* atlas — only to run its validation harness.

```bash
npm install
npm run build:web     # builds the viewer bundle once
npm link              # puts `atlas` on your PATH
```

## Use it

```bash
atlas diff                       # working tree vs HEAD — the primary command
atlas diff --view                # ...and open the review view
atlas diff main..HEAD            # any two revisions
atlas diff -C /path/to/repo      # run against a repo elsewhere (like git -C)

atlas map <path>                 # whole-codebase orientation view
atlas extract <path> -o g.json   # artifact only, no server
atlas serve g.json               # view an artifact you already have
```

Try it without a Bevy project of your own:

```bash
npm run demo        # builds a throwaway repo from Bevy's examples and reviews a change
```

## What a review looks like

An eight-line addition that reads as obviously fine:

```rust
+        .add_systems(Update, (sprite_movement, snap_to_grid))
+
+fn snap_to_grid(mut sprites: Query<&mut Transform, With<Sprite>>) { … }
```

```
$ atlas diff
b29215c1 -> working tree   1 Rust file(s) changed  (base cached)
  systems  +1 -0 ~0
  1 AMBIGUITY INTRODUCED:
    move_sprite::snap_to_grid vs move_sprite::sprite_movement on Transform [Update]
  652 pre-existing (unchanged)
```

Both write `Transform` in `Update` with nothing ordering them, so Bevy runs them in either
order. The `--view` flag renders the neighbourhood of the change — four nodes out of 1,384 —
with an inspector giving reads, writes, blast radius, and a jump to the source line.

## How it works

```
Rust source ──▶ dialect (tree-sitter) ──▶ IR ──▶ graph ──▶ ELK ──▶ viewer
                knows Bevy               ▲ knows neither
```

The pivot is one invariant: **a state node is state whose access is declared at a
boundary**. ECS declares its access in the type signature — `Query<&mut Transform>` says
what it touches without the body being read — which is why a syntax-only parser suffices
and why atlas needs no compiler, no macro expansion, and no code that builds.

Everything left of the IR knows about Rust and Bevy; everything right of it knows only
executors, state, and accesses.

**Ambiguity analysis** is not a heuristic. Bevy computes the same thing at runtime as
schedule ambiguity detection, and atlas reproduces it statically under five conditions:
same app scope and schedule, no transitive ordering (system- *or* set-level), overlapping
access with at least one write, filters not provably disjoint, and no `ambiguous_with`
suppression. A harness in `harness/` compiles fixtures with Bevy's own detector enabled and
diffs its findings against atlas's — they agree on all eight.

## Development

```bash
npm test              # 163 tests
npm run typecheck
npm run grammar:report   # verify the tree-sitter contract; regenerate reference/
npm run oracle:build && npm run oracle   # Bevy's own ambiguity detector
npm run corpus:stats -- <path>           # extraction statistics
```

`DESIGN.md` carries the reasoning: what was measured, what was rejected, and why.

## Limits, stated plainly

- **Only declared access is visible.** A system that mutates global state inside its body
  is invisible to atlas. That is the cost of needing no compiler.
- **Bevy 0.19 only.** Earlier versions renamed core concepts (`EventReader` became
  `MessageReader` in 0.17); pointing atlas at them reports the mismatch rather than
  silently producing an empty graph.
- **`#[cfg(...)]` in expression position does not parse** — a tree-sitter-rust limitation
  affecting 11 of 411 files in the reference corpus. Recovery is local, so items and
  registrations around it still extract.
- **Unresolvable scope is excluded, not guessed.** A system whose owning app cannot be
  determined is left out of ambiguity analysis and counted in the coverage line.
