import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'FoodOrder',
    short_name: 'FoodOrder',
    description: 'Browse local restaurants and keep your cart ready wherever you are.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#fafaf9',
    theme_color: '#ea580c',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
