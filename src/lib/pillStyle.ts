export type PillStyle = 'v1' | 'v2'

const KEY = 'keel_pill_style'

export function getPillStyle(): PillStyle {
  if (typeof window === 'undefined') return 'v1'
  return (localStorage.getItem(KEY) as PillStyle) ?? 'v1'
}

export function setPillStyle(style: PillStyle): void {
  localStorage.setItem(KEY, style)
  applyPillStyle(style)
}

/** Call once on app load (e.g. in ThemeContext useEffect) */
export function applyPillStyle(style?: PillStyle): void {
  const s = style ?? getPillStyle()
  document.documentElement.setAttribute('data-pills', s)
}
