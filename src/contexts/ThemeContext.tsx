'use client'

import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from 'react'

export type Theme    = 'chalk' | 'sand' | 'slate' | 'dusk' | 'sage' | 'harbour' | 'neon' | 'neopastel' | 'electric-blue' | 'electric-lime'
export type DarkMode = 'system' | 'light' | 'dark'
export type FontSize = 'sm' | 'md' | 'lg' | 'xl'

const FONT_SCALE: Record<FontSize, number> = {
  sm: 0.875,
  md: 1,
  lg: 1.125,
  xl: 1.25,
}

interface ThemeContextType {
  theme:       Theme
  darkMode:    DarkMode
  fontSize:    FontSize
  setTheme:    (t: Theme) => void
  setDarkMode: (d: DarkMode) => void
  setFontSize: (f: FontSize) => void
}

const ThemeContext = createContext<ThemeContextType | null>(null)

function applyDarkMode(darkMode: DarkMode) {
  const root = document.documentElement
  if (darkMode === 'dark') {
    root.setAttribute('data-dark', 'true')
  } else if (darkMode === 'light') {
    root.setAttribute('data-dark', 'false')
  } else {
    // System — read OS preference and apply immediately
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    root.setAttribute('data-dark', prefersDark ? 'true' : 'false')
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme,    setThemeState]    = useState<Theme>('harbour')
  const [darkMode, setDarkModeState] = useState<DarkMode>('system')
  const [fontSize, setFontSizeState] = useState<FontSize>('md')

  // Load from localStorage on mount
  useEffect(() => {
    const storedTheme    = localStorage.getItem('keel-theme')    as Theme | null
    const storedDarkMode = localStorage.getItem('keel-darkmode') as DarkMode | null
    const storedFontSize = localStorage.getItem('keel-fontsize') as FontSize | null
    if (storedTheme)    setThemeState(storedTheme)
    if (storedDarkMode) setDarkModeState(storedDarkMode)
    if (storedFontSize) setFontSizeState(storedFontSize)
  }, [])

  // Apply font size to <html>
  useEffect(() => {
    const scale = FONT_SCALE[fontSize]
    document.documentElement.style.setProperty('--font-scale', String(scale))
    document.documentElement.setAttribute('data-fontsize', fontSize)
    localStorage.setItem('keel-fontsize', fontSize)
  }, [fontSize])

  // Apply theme to <html>
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('keel-theme', theme)
  }, [theme])

  // Apply dark mode — including system preference listener
  useEffect(() => {
    applyDarkMode(darkMode)
    localStorage.setItem('keel-darkmode', darkMode)

    if (darkMode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = (e: MediaQueryListEvent) => {
        document.documentElement.setAttribute('data-dark', e.matches ? 'true' : 'false')
      }
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
  }, [darkMode])

  const setTheme    = (t: Theme)    => setThemeState(t)
  const setDarkMode = (d: DarkMode) => setDarkModeState(d)
  const setFontSize = (f: FontSize) => setFontSizeState(f)

  return (
    <ThemeContext.Provider value={{ theme, darkMode, fontSize, setTheme, setDarkMode, setFontSize }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
