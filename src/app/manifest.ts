import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name:             'Keel',
    short_name:       'Keel',
    description:      'Your personal admin hub. Stay on top of everything that matters.',
    start_url:        '/',
    display:          'standalone',
    background_color: '#1C2A2E',
    theme_color:      '#1C2A2E',
    orientation:      'portrait-primary',
    icons: [
      {
        src:     '/icons/icon-192.png',
        sizes:   '192x192',
        type:    'image/png',
        purpose: 'any',
      },
      {
        src:     '/icons/icon-512.png',
        sizes:   '512x512',
        type:    'image/png',
        purpose: 'any',
      },
      {
        src:     '/icons/icon-512.png',
        sizes:   '512x512',
        type:    'image/png',
        purpose: 'maskable',
      },
    ],
  }
}
