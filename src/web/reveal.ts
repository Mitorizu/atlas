import type { Scene, SceneMember, SceneRegion } from '../layout/scene.ts';

/**
 * Progressive reveal (DESIGN.md §9.2).
 *
 * Pure and headless so it can be tested without a browser: given a scene and a viewport,
 * decide which regions are open, which of their members are mounted, and how much detail
 * each shows. Nothing here touches React.
 */

/** How much a single node renders, as a function of its own apparent size. */
export type Detail = 'dot' | 'label' | 'full';

export interface RevealOptions {
  /** Most members mounted at once, across all regions. */
  budget?: number;
  /** Visible area in flow units, for culling. Omit to skip culling. */
  viewport?: { x: number; y: number; width: number; height: number };
}

export interface RevealState {
  open: Set<string>;
  /** Regions that wanted to open but lost the budget; shown with a marker. */
  capped: Set<string>;
  /** Member id -> how much of it to draw. Absent means not mounted. */
  members: Map<string, Detail>;
  mounted: number;
}

/**
 * A region opens when its MEMBERS would be big enough to draw, not when the region is.
 *
 * Gating on the region's own size is wrong in a way that only shows up on real data: a
 * 6,000-unit region like `server` is still 600px across at whole-map zoom, so it opened
 * immediately and the orientation view had no orientation left. Earth has the same
 * property — Russia is enormous at globe altitude and still shows no cities. What decides
 * is whether the contents are legible.
 *
 * The per-region behaviour ("zoom into Europe, Asia stays shut") then comes from viewport
 * culling rather than from differing thresholds, which is also how Earth does it.
 */
export const MEMBER_OPEN_PX = 44;
/** Apparent member width at which every member of a region is revealed. */
export const MEMBER_ALL_PX = 150;

/**
 * Apparent width at which a member gains a label, and then its full detail.
 *
 * Calibrated against a real fit: whole-map view of a 10-crate workspace puts a member at
 * about 23px, which is unreadable — so nothing may open there. Opening starts at roughly
 * twice that, which is the first zoom where a name can actually be read.
 */
export const MEMBER_LABEL_PX = 44;
export const MEMBER_FULL_PX = 200;

/**
 * Deadband applied to the region-open boundary.
 *
 * Same reason as the old global tiers: resting exactly on a threshold and jittering a
 * trackpad would otherwise mount and unmount a region's contents repeatedly. Now that
 * every region has its own boundary, the risk is per region rather than global.
 */
const HYSTERESIS = 0.12;

export const DEFAULT_BUDGET = 500;

function intersects(
  region: { x: number; y: number; width: number; height: number },
  viewport: NonNullable<RevealOptions['viewport']>,
): boolean {
  return !(
    region.x > viewport.x + viewport.width ||
    region.x + region.width < viewport.x ||
    region.y > viewport.y + viewport.height ||
    region.y + region.height < viewport.y
  );
}

/** Typical member width in a region, used as its reveal yardstick. */
function memberScale(region: SceneRegion): number {
  if (region.members.length === 0) return 160;
  const widths = region.members.map((m) => m.width).sort((a, b) => a - b);
  return widths[Math.floor(widths.length / 2)] ?? 160;
}

function detailFor(member: SceneMember, zoom: number): Detail {
  const apparent = member.width * zoom;
  if (apparent >= MEMBER_FULL_PX) return 'full';
  if (apparent >= MEMBER_LABEL_PX) return 'label';
  return 'dot';
}

/**
 * Fraction of a region's members to reveal, ramping between the open and full thresholds.
 * This is the "capitals before towns" ramp: at the open threshold a couple of the most
 * connected members appear, and the rest arrive as the region grows.
 */
function revealFraction(region: SceneRegion, zoom: number): number {
  const apparent = memberScale(region) * zoom;
  if (apparent <= MEMBER_OPEN_PX) return 0;
  if (apparent >= MEMBER_ALL_PX) return 1;
  return (apparent - MEMBER_OPEN_PX) / (MEMBER_ALL_PX - MEMBER_OPEN_PX);
}

export function computeReveal(
  scene: Scene,
  zoom: number,
  options: RevealOptions = {},
  previous?: RevealState,
): RevealState {
  const budget = options.budget ?? DEFAULT_BUDGET;
  const open = new Set<string>();
  const capped = new Set<string>();
  const members = new Map<string, Detail>();

  const onScreen = (region: SceneRegion): boolean =>
    options.viewport === undefined || intersects(region, options.viewport);

  interface Wanting {
    region: SceneRegion;
    want: number;
  }
  const wanting: Wanting[] = [];

  for (const region of scene.regions) {
    const apparent = memberScale(region) * zoom;
    // Hysteresis: an already-open region needs to shrink well below the boundary to close.
    const wasOpen = previous?.open.has(region.id) ?? false;
    const threshold = MEMBER_OPEN_PX * (wasOpen ? 1 - HYSTERESIS : 1 + HYSTERESIS);
    if (apparent < threshold || !onScreen(region)) continue;

    const fraction = revealFraction(region, zoom);
    const want = Math.max(1, Math.ceil(fraction * region.members.length));
    wanting.push({ region, want });
  }

  // Budget goes to the regions that are largest on screen — what you are looking at wins.
  wanting.sort((a, b) => b.region.width * b.region.height - a.region.width * a.region.height ||
    (a.region.id < b.region.id ? -1 : 1));

  let spent = 0;
  for (const { region, want } of wanting) {
    if (spent >= budget) {
      capped.add(region.id);
      continue;
    }
    const allowed = Math.min(want, budget - spent);
    if (allowed < 1) {
      capped.add(region.id);
      continue;
    }
    open.add(region.id);
    // Members are pre-sorted by importance, so a prefix is the most connected ones.
    for (const member of region.members.slice(0, allowed)) {
      members.set(member.id, detailFor(member, zoom));
    }
    spent += allowed;
    if (allowed < region.members.length) capped.add(region.id);
  }

  for (const member of scene.shared) {
    members.set(member.id, detailFor(member, zoom));
  }

  return { open, capped, members, mounted: members.size };
}

export interface RetargetedEdge {
  id: string;
  source: string;
  target: string;
  mode: string;
  doubleHeaded: boolean;
  /** How many real relations this one line stands for. */
  weight: number;
}

/**
 * Re-targets every edge to the deepest endpoint currently visible (§9.2).
 *
 * A relation from an open region's function to a closed region's state terminates on the
 * closed region's box; when that region opens, the same edge snaps to the real node. One
 * line per real relation at every zoom, never doubled — parallel lines between the same
 * pair merge and carry a weight.
 */
export function retargetEdges(scene: Scene, reveal: RevealState): RetargetedEdge[] {
  const endpoint = (id: string): string | null => {
    if (reveal.members.has(id)) return id;
    const owner = scene.ownerOf[id];
    // No owner and not mounted means a shared node that was culled: drop the edge.
    return owner ?? null;
  };

  const merged = new Map<string, RetargetedEdge>();
  for (const edge of scene.edges) {
    const source = endpoint(edge.source);
    const target = endpoint(edge.target);
    if (source === null || target === null || source === target) continue;

    const key = `${source}->${target}:${edge.mode}`;
    const existing = merged.get(key);
    if (existing) {
      existing.weight++;
      existing.doubleHeaded = existing.doubleHeaded || edge.doubleHeaded;
      continue;
    }
    merged.set(key, {
      id: key,
      source,
      target,
      mode: edge.mode,
      doubleHeaded: edge.doubleHeaded,
      weight: 1,
    });
  }
  return [...merged.values()];
}
