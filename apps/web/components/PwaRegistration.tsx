'use client';

import { useEffect } from 'react';

/** Register the one worker shared by PWA caching and browser push. */
export default function PwaRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // Offline support is progressive enhancement; a blocked worker must not
      // prevent the storefront from rendering or push from explaining itself.
    });
  }, []);

  return null;
}
