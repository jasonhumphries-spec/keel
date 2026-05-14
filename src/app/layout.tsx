import type { Metadata } from 'next'
import { Lora, DM_Mono } from 'next/font/google'
import { AuthProvider }  from '@/contexts/AuthContext'
import { ThemeProvider } from '@/contexts/ThemeContext'
import '@/styles/themes.css'
import './globals.css'

const lora = Lora({
  subsets:  ['latin'],
  variable: '--font-dm-sans',   // keep same var name — every existing reference picks up Lora
  weight:   ['400', '500', '600', '700'],
  style:    ['normal', 'italic'],  // italic used for step subtitles and panel captions
})

const dmMono = DM_Mono({
  subsets:  ['latin'],
  variable: '--font-dm-mono',
  weight:   ['400', '500'],
})

export const metadata: Metadata = {
  title:       'Keel — Personal Life OS',
  description: 'Your personal admin hub. Stay on top of everything that matters.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="harbour" suppressHydrationWarning>
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
