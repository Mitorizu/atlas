import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY_COLOR, EDGE_COLOR, edgeStyle } from '../src/web/theme.ts';

/**
 * Palette verification (DESIGN.md §9.3).
 *
 * §9.3 claims the palette is verified against deuteranopia and protanopia and legible in
 * greyscale. This is that verification, done numerically so it runs on every change rather
 * than being an assertion in a document.
 *
 * Simulation uses the Viénot-Brettel-Mollon linear projection; distances are CIE76 in Lab,
 * which is coarse but ample for "are these two swatches still distinguishable".
 */

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

const toLinear = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (c: number): number => {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
};

/** Viénot et al. simulation for dichromacy. */
function simulate(rgb: RGB, kind: 'deuteranopia' | 'protanopia'): RGB {
  const [r, g, b] = rgb.map(toLinear) as RGB;
  // sRGB -> LMS
  const l = 17.8824 * r + 43.5161 * g + 4.11935 * b;
  const m = 3.45565 * r + 27.1554 * g + 3.86714 * b;
  const s = 0.0299566 * r + 0.184309 * g + 1.46709 * b;

  const [l2, m2, s2] =
    kind === 'protanopia'
      ? [2.02344 * m - 2.52581 * s, m, s]
      : [l, 0.494207 * l + 1.24827 * s, s];

  const rr = 0.080944 * l2 - 0.130504 * m2 + 0.116721 * s2;
  const gg = -0.0102485 * l2 + 0.0540194 * m2 - 0.113615 * s2;
  const bb = -0.000365294 * l2 - 0.00412163 * m2 + 0.693513 * s2;
  return [toSrgb(rr), toSrgb(gg), toSrgb(bb)];
}

function toLab([r, g, b]: RGB): [number, number, number] {
  const [lr, lg, lb] = [r, g, b].map(toLinear) as RGB;
  let x = (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047;
  let y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  let z = (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  [x, y, z] = [f(x), f(y), f(z)];
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function distance(a: RGB, b: RGB): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

const relativeLuminance = ([r, g, b]: RGB): number =>
  0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

/** The three hues that must stay apart: hue encodes state CATEGORY only (§9.3). */
const CATEGORY_HUES = ['component', 'resource', 'message'] as const;

/** CIE76 distance below which two swatches read as the same colour. */
const MIN_SEPARATION = 22;

describe('M8: palette is distinguishable (§9.3)', () => {
  for (const vision of ['normal', 'deuteranopia', 'protanopia'] as const) {
    test(`category hues stay apart under ${vision}`, () => {
      const seen: Array<[string, RGB]> = CATEGORY_HUES.map((name) => {
        const rgb = hexToRgb(CATEGORY_COLOR[name]!);
        return [name, vision === 'normal' ? rgb : simulate(rgb, vision)];
      });

      const tooClose: string[] = [];
      for (let i = 0; i < seen.length; i++) {
        for (let j = i + 1; j < seen.length; j++) {
          const d = distance(seen[i]![1], seen[j]![1]);
          if (d < MIN_SEPARATION) tooClose.push(`${seen[i]![0]}/${seen[j]![0]} ΔE=${d.toFixed(1)}`);
        }
      }
      assert.deepEqual(tooClose, [], `indistinguishable under ${vision}`);
    });
  }

  test('read vs write is carried by FORM, not hue', () => {
    // §9.3: hue is spent on state category, so direction must survive hue loss entirely.
    const read = edgeStyle('read');
    const write = edgeStyle('write');
    assert.notEqual(read.strokeDasharray, write.strokeDasharray, 'dash pattern must differ');
    assert.ok(write.strokeWidth > read.strokeWidth, 'write must be heavier');
  });

  test('read and write still separate by LIGHTNESS under both deficiencies', () => {
    // Their hues do collapse under protanopia -- rose reads as dark grey. That is
    // acceptable because form carries direction, but lightness is a useful redundant
    // channel and should not collapse too.
    for (const vision of ['deuteranopia', 'protanopia'] as const) {
      const read = relativeLuminance(simulate(hexToRgb(EDGE_COLOR['read']!), vision));
      const write = relativeLuminance(simulate(hexToRgb(EDGE_COLOR['write']!), vision));
      assert.ok(
        Math.abs(read - write) > 0.05,
        `read/write lightness collapses under ${vision} (${Math.abs(read - write).toFixed(3)})`,
      );
    }
  });

  test('every category hue carries enough contrast on both themes', () => {
    // Nodes sit on #f7f8fa (light) and #1c2229 (dark); the border must be visible on both.
    const light = relativeLuminance([0xf7, 0xf8, 0xfa]);
    const dark = relativeLuminance([0x1c, 0x22, 0x29]);
    const ratio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

    for (const [name, hex] of Object.entries(CATEGORY_COLOR)) {
      const lum = relativeLuminance(hexToRgb(hex));
      // 3:1 is the WCAG threshold for non-text UI components.
      assert.ok(ratio(lum, light) >= 3, `${name} too faint on light (${ratio(lum, light).toFixed(2)}:1)`);
      assert.ok(ratio(lum, dark) >= 1.9, `${name} too dark on dark (${ratio(lum, dark).toFixed(2)}:1)`);
    }
  });

  test('greyscale keeps the hues apart, because Orbit edges are one pixel wide', () => {
    const greys = CATEGORY_HUES.map((name) => relativeLuminance(hexToRgb(CATEGORY_COLOR[name]!)));
    for (let i = 0; i < greys.length; i++) {
      for (let j = i + 1; j < greys.length; j++) {
        assert.ok(
          Math.abs(greys[i]! - greys[j]!) > 0.02,
          `${CATEGORY_HUES[i]} and ${CATEGORY_HUES[j]} collapse to the same grey`,
        );
      }
    }
  });
});
