'use client';

import { useEffect, useState } from 'react';

/**
 * True only on phone-width viewports (<640px — Tailwind's `sm` edge).
 *
 * Deliberately FALSE during SSR and the first client paint so mobile-only
 * furniture (sticky checkout/submit bars) never enters the desktop DOM at
 * all. The e2e suite's desktop specs use strict text locators
 * (`getByText('Subtotal')`, price-text counts) that a hidden-but-present
 * duplicate bar would break; CSS `sm:hidden` is not enough because
 * getByText matches hidden nodes. Only `matchMedia` can decide to render.
 */
export function useIsCompactViewport(): boolean {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639.98px)');
    const sync = () => setCompact(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  return compact;
}
