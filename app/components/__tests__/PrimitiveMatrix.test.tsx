/**
 * Uses `react-dom/server` rather than `@testing-library/react` (not a
 * dependency of this app) to check the static markup of the initial render —
 * sufficient here since we're only asserting on the column headers, not on
 * the post-mount animation driven by useEffect.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrimitiveMatrix } from '../PrimitiveMatrix';

describe('PrimitiveMatrix (learn slide deck)', () => {
  it('renders six primitive columns, with Revocation appended after Discovery', () => {
    const markup = renderToStaticMarkup(<PrimitiveMatrix />);

    const primitives = ['Attestation', 'Communication', 'Attribution', 'Settlement', 'Discovery', 'Revocation'];
    for (const primitive of primitives) {
      expect(markup).toContain(primitive);
    }

    // Revocation is appended at the end so existing lesson content's
    // 0-indexed [row, col] pairs for the first five columns are unaffected.
    expect(markup.indexOf('Discovery')).toBeLessThan(markup.indexOf('Revocation'));
  });
});
