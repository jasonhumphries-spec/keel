import type { Metadata, Viewport } from 'next'
import { Lora, DM_Mono } from 'next/font/google'
import { AuthProvider }  from '@/contexts/AuthContext'
import { ThemeProvider } from '@/contexts/ThemeContext'
import '@/styles/themes.css'
import './globals.css'

const lora = Lora({
  subsets:  ['latin'],
  variable: '--font-dm-sans',   // keep same var name — every existing reference picks up Lora
  weight:   ['400', '500', '600', '700'],
  style:    ['normal', 'italic'],
})

const dmMono = DM_Mono({
  subsets:  ['latin'],
  variable: '--font-dm-mono',
  weight:   ['400', '500'],
})

export const viewport: Viewport = {
  themeColor:           '#1C2A2E',
  width:                'device-width',
  initialScale:         1,
  viewportFit:          'cover',  // safe-area insets on iPhone notch/home bar
  minimumScale:         1,
  maximumScale:         1,
  userScalable:         false,
}

export const metadata: Metadata = {
  title:              'Keel',
  description:        'Your personal admin hub. Stay on top of everything that matters.',
  applicationName:    'Keel',
  appleWebApp: {
    capable:         true,
    statusBarStyle:  'black-translucent',
    title:           'Keel',
    startupImage:    '/icons/apple-touch-icon.png',
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon:      [
      { url: '/icons/icon-32.png',  sizes: '32x32',   type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple:     '/icons/apple-touch-icon.png',
    shortcut:  '/icons/icon-32.png',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="harbour" suppressHydrationWarning>
      <head>
        {/* PWA service worker registration */}
        <script dangerouslySetInnerHTML={{ __html: `
          if ('serviceWorker' in navigator) {
            window.addEventListener('load', function() {
              navigator.serviceWorker.register('/sw.js')
                .then(function(reg) { console.log('[SW] Registered:', reg.scope) })
                .catch(function(err) { console.warn('[SW] Registration failed:', err) })
            })
          }
        `}} />
      </head>
      <body className={`${lora.variable} ${dmMono.variable}`}>
        <ThemeProvider>
          <AuthProvider>
            {children}
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
