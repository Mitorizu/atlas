import { useEffect, useRef, useState } from 'react';
import { useOnViewportChange, type Viewport } from '@xyflow/react';

/** Semantic zoom tiers (DESIGN.md §9.2). */
export type Tier = 'orbit' | 'street' | 'detail';

/**
 * A representative node width, in layout units. The tier is chosen from how large a node
 * APPEARS on screen, not from the raw zoom factor: fitting 2,000 nodes puts React Flow's
 * zoom around 0.05, so a rule like "orbit below zoom 0.5" would never leave orbit
 * regardless of how readable the view actually is.
 */
const NOMINAL_NODE_WIDTH = 170;

/** Apparent width in CSS pixels at which each tier begins. */
export const ORBIT_MAX_PX = 26;
export const DETAIL_MIN_PX = 78;

/**
 * Fraction by which a threshold must be overshot before the tier flips back.
 *
 * Without a deadband, resting exactly on a boundary and jittering a trackpad strobes
 * between tiers. 18% is wide enough that ordinary scroll noise cannot cross it twice.
 */
const HYSTERESIS = 0.18;

export function tierFor(apparentPx: number, previous: Tier): Tier {
  const grow = 1 + HYSTERESIS;
  const shrink = 1 - HYSTERESIS;

  switch (previous) {
    case 'orbit':
      // Must exceed the boundary by the deadband before leaving orbit.
      return apparentPx > ORBIT_MAX_PX * grow ? 'street' : 'orbit';
    case 'detail':
      return apparentPx < DETAIL_MIN_PX * shrink ? 'street' : 'detail';
    case 'street':
      if (apparentPx < ORBIT_MAX_PX * shrink) return 'orbit';
      if (apparentPx > DETAIL_MIN_PX * grow) return 'detail';
      return 'street';
  }
}

export function apparentWidth(zoom: number): number {
  return NOMINAL_NODE_WIDTH * zoom;
}

/** Tracks the viewport and reports the current tier, with hysteresis applied. */
export function useLodTier(enabled: boolean): Tier {
  const [tier, setTier] = useState<Tier>('street');
  const current = useRef<Tier>('street');

  useEffect(() => {
    current.current = tier;
  }, [tier]);

  useOnViewportChange({
    onChange: (viewport: Viewport) => {
      if (!enabled) return;
      const next = tierFor(apparentWidth(viewport.zoom), current.current);
      if (next !== current.current) {
        current.current = next;
        setTier(next);
      }
    },
  });

  return enabled ? tier : 'street';
}
