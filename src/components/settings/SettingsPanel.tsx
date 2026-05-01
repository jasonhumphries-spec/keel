'use client'

import { useState, useEffect } from 'react'
import { useTheme, Theme, DarkMode } from '@/contexts/ThemeContext'
import { useAuth } from '@/contexts/AuthContext'

interface SettingsPanelProps {
  open:    boolean
  onClose: () => void
}

const THEMES: { id: Theme; name: string; desc: string; swatches: string[] }[] = [
  { id: 'harbour',        name: 'Harbour',        desc: 'Blue-grey · Brass',              swatches: ['#edf2f6', '#9e8040', '#882a2a'] },
  { id: 'chalk',          name: 'Chalk',          desc: 'Warm white · Calke Green',       swatches: ['#fafaf8', '#4a7c5a', '#8a3028'] },
  { id: 'sand',           name: 'Sand',           desc: 'Warm beige · Pitch Blue',        swatches: ['#faf9f7', '#3a4e8c', '#8a3028'] },
  { id: 'slate',          name: 'Slate',          desc: 'Cool grey · Red Earth',          swatches: ['#f0f2f6', '#b04a36', '#8a3028'] },
  { id: 'dusk',           name: 'Dusk',           desc: 'Purple-grey · Sudbury Yellow',   swatches: ['#f2f0f8', '#b08c1a', '#882a38'] },
  { id: 'sage',           name: 'Sage',           desc: 'Green-grey · Incarnadine',       swatches: ['#eef3ef', '#9e3a2e', '#882a2a'] },
  { id: 'neon',           name: 'Neon Dark',      desc: 'Deep black · Electric cyan',     swatches: ['#111118', '#00f5ff', '#ff0066'] },
  { id: 'neopastel',      name: 'Neo-Pastel',     desc: 'Soft white · Violet · Cyan',     swatches: ['#f9fafb', '#8b5cf6', '#22d3ee'] },
  { id: 'electric-blue',  name: 'Electric Blue',  desc: 'Monochrome · Electric blue',     swatches: ['#f5f5f5', '#3b82f6', '#0a0a0a'] },
  { id: 'electric-lime',  name: 'Electric Lime',  desc: 'Monochrome · Lime green',        swatches: ['#f5f5f5', '#84cc16', '#0a0a0a'] },
]

const DARK_MODES: { id: DarkMode; label: string; desc: string }[] = [
  { id: 'system', label: 'System',       desc: 'Follows your device setting' },
  { id: 'light',  label: 'Always light', desc: 'Always show light theme' },
  { id: 'dark',   label: 'Always dark',  desc: 'Always show dark theme' },
]

const SCAN_DAYS_KEY = 'keel_scan_days_back'

export function getScanDaysBack(): number {
  if (typeof window === 'undefined') return 7
  return parseInt(localStorage.getItem(SCAN_DAYS_KEY) ?? '7', 10)
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      style={{ width: 36, height: 20, borderRadius: 10, background: on ? 'var(--color-accent)' : 'var(--color-surface-recessed)', border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-border-strong)'}`, flexShrink: 0, cursor: 'pointer', position: 'relative', transition: 'background 0.15s, border-color 0.15s' }}
    >
      <div style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 14, height: 14, borderRadius: '50%', background: 'var(--color-surface)', boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'left 0.15s' }} />
    </button>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: '9px', color: 'var(--color-text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '10px' }}>
      {children}
    </div>
  )
}

function ToggleRow({ label, desc, on, onToggle }: { label: string; desc: string; on: boolean; onToggle: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--color-border)' }}>
      <div>
        <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--color-text-primary)', marginBottom: 2 }}>{label}</div>
        <div style={{ fontSize: '10px', color: 'var(--color-text-muted)', lineHeight: 1.4 }}>{desc}</div>
      </div>
      <Toggle on={on} onToggle={onToggle} />
    </div>
  )
}

export function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const { theme, darkMode, fontSize, setTheme, setDarkMode, setFontSize } = useTheme()
  const { user } = useAuth()
  const [scanDays, setScanDays]         = useState(14)
  const [watchingSince, setWatchingSince] = useState<string | null>(null)

  useEffect(() => {
    setScanDays(getScanDaysBack())
    // Load watching since date from Firestore
    if (user) {
      import('firebase/firestore').then(({ doc, getDoc }) => {
        import('@/lib/firebase').then(({ db }) => {
          getDoc(doc(db, `users/${user.uid}/meta/onboarding`)).then(snap => {
            if (snap.exists() && snap.data()?.watchingSince) {
              const d = snap.data()!.watchingSince.toDate()
              setWatchingSince(d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))
            }
          })
        })
      })
    }
  }, [user])

  const handleScanDaysChange = (val: number) => {
    setScanDays(val)
    localStorage.setItem(SCAN_DAYS_KEY, String(val))
  }

  return (
    <>
      <div onClick={onClose} style={{ display: open ? 'block' : 'none', position: 'fixed', inset: 0, background: 'var(--color-overlay)', zIndex: 200 }} />

      <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 320, background: 'var(--color-surface)', borderLeft: '1px solid var(--color-border)', zIndex: 201, display: 'flex', flexDirection: 'column', transform: open ? 'translateX(0)' : 'translateX(100%)', transition: 'transform 0.25s ease', boxShadow: '-8px 0 32px rgba(0,0,0,0.12)' }}>

        <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--color-text-primary)' }}>Settings</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 4 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '18px', display: 'flex', flexDirection: 'column', gap: '24px' }}>

          {/* Theme */}
          <div>
            <SectionTitle>Appearance — Theme</SectionTitle>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              {THEMES.map((t) => (
                <button key={t.id} onClick={() => setTheme(t.id)} style={{ border: `1.5px solid ${theme === t.id ? 'var(--color-accent)' : 'var(--color-border)'}`, borderRadius: 'var(--radius-md)', padding: '9px 8px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6, background: theme === t.id ? 'var(--color-accent-sub)' : 'var(--color-surface-raised)', transition: 'border-color 0.15s, background 0.15s', textAlign: 'left', fontFamily: 'var(--font-dm-sans)' }}>
                  <div style={{ display: 'flex', gap: 3 }}>
                    {t.swatches.map((s, i) => (
                      <div key={i} style={{ width: 14, height: 14, borderRadius: '50%', background: s, border: '1px solid rgba(0,0,0,0.08)' }} />
                    ))}
                  </div>
                  <div style={{ fontSize: '11px', fontWeight: 600, color: theme === t.id ? 'var(--color-accent)' : 'var(--color-text-primary)' }}>{t.name}</div>
                  <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: '8px', color: 'var(--color-text-muted)', lineHeight: 1.4 }}>{t.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Dark mode */}
          <div>
            <SectionTitle>Dark mode</SectionTitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {DARK_MODES.map((d) => (
                <button key={d.id} onClick={() => setDarkMode(d.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: `1.5px solid ${darkMode === d.id ? 'var(--color-accent)' : 'var(--color-border)'}`, borderRadius: 'var(--radius-md)', background: darkMode === d.id ? 'var(--color-accent-sub)' : 'var(--color-surface-raised)', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-dm-sans)', transition: 'border-color 0.15s' }}>
                  <div style={{ width: 14, height: 14, borderRadius: '50%', border: `2px solid ${darkMode === d.id ? 'var(--color-accent)' : 'var(--color-border-strong)'}`, background: darkMode === d.id ? 'var(--color-accent)' : 'transparent', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {darkMode === d.id && <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'white' }} />}
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', fontWeight: 600, color: darkMode === d.id ? 'var(--color-accent)' : 'var(--color-text-primary)' }}>{d.label}</div>
                    <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: '9px', color: 'var(--color-text-muted)' }}>{d.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Font size */}
          <div>
            <SectionTitle>Text size</SectionTitle>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
              {([
                { id: 'sm', label: 'Small',   sample: 'Aa' },
                { id: 'md', label: 'Default', sample: 'Aa' },
                { id: 'lg', label: 'Large',   sample: 'Aa' },
                { id: 'xl', label: 'X-Large', sample: 'Aa' },
              ] as const).map(opt => (
                <button
                  key={opt.id}
                  onClick={() => setFontSize(opt.id)}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                    padding: '10px 6px', borderRadius: 'var(--radius-md)',
                    border: `1.5px solid ${fontSize === opt.id ? 'var(--color-accent)' : 'var(--color-border)'}`,
                    background: fontSize === opt.id ? 'var(--color-accent-sub)' : 'var(--color-surface)',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{
                    fontSize: opt.id === 'sm' ? 12 : opt.id === 'md' ? 15 : opt.id === 'lg' ? 18 : 22,
                    fontWeight: 600,
                    color: fontSize === opt.id ? 'var(--color-accent)' : 'var(--color-text-primary)',
                    lineHeight: 1,
                  }}>
                    {opt.sample}
                  </span>
                  <span style={{ fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-dm-mono)', color: fontSize === opt.id ? 'var(--color-accent)' : 'var(--color-text-muted)', letterSpacing: '0.04em' }}>
                    {opt.label}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Scanning */}
          <div>
            <SectionTitle>Scanning</SectionTitle>

            {/* Thread activity window */}
            <div style={{ padding: '10px 0', borderBottom: '1px solid var(--color-border)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--color-text-primary)' }}>Thread activity window</div>
                  <div style={{ fontSize: '10px', color: 'var(--color-text-muted)', marginTop: 2, lineHeight: 1.4 }}>
                    How long a thread can be silent before Keel stops watching it for new activity. Items already on your dashboard are unaffected — they stay until resolved.
                  </div>
                </div>
                <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: '14px', fontWeight: 700, color: 'var(--color-accent)', minWidth: 48, textAlign: 'right' }}>
                  {scanDays}d
                </div>
              </div>
              <input
                type="range"
                min={7}
                max={90}
                step={7}
                value={scanDays}
                onChange={e => handleScanDaysChange(Number(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--color-accent)', cursor: 'pointer', height: 4 }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-dm-mono)', fontSize: '9px', color: 'var(--color-text-muted)', marginTop: 4 }}>
                <span>7d</span>
                <span>14d</span>
                <span>30d</span>
                <span>60d</span>
                <span>90d</span>
              </div>
            </div>

            {/* Watching since */}
            <div style={{ padding: '10px 0', borderBottom: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--color-text-primary)', marginBottom: 3 }}>Keel has been watching since</div>
              <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: '12px', color: 'var(--color-accent)' }}>
                {watchingSince ?? '—'}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--color-text-muted)', marginTop: 3, lineHeight: 1.4 }}>
                This is the earliest date fully examined during your initial scan.
              </div>
            </div>

            {/* Historical scan — premium placeholder */}
            <div style={{ padding: '10px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--color-text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    Scan earlier emails
                    <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: '9px', background: 'var(--color-accent-sub)', color: 'var(--color-accent)', border: '1px solid var(--color-accent)', borderRadius: 3, padding: '1px 5px', letterSpacing: '0.06em' }}>
                      PREMIUM
                    </span>
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--color-text-muted)', marginTop: 2, lineHeight: 1.4 }}>
                    Go back further in your inbox to surface older active threads. A one-off ingestion run — existing items are unaffected.
                  </div>
                </div>
              </div>
              <button
                disabled
                style={{ width: '100%', padding: '8px 12px', background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', fontSize: '12px', color: 'var(--color-text-muted)', fontFamily: 'var(--font-dm-sans)', cursor: 'not-allowed', textAlign: 'left', opacity: 0.6 }}
              >
                Scan earlier emails → (available on Pro)
              </button>
            </div>
          </div>

          {/* Calendar */}
          <div>
            <SectionTitle>Calendar</SectionTitle>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <ToggleRow label="Link to email account's calendar" desc="School emails → School calendar, personal → Personal" on={true} onToggle={() => {}} />
              <div style={{ padding: '10px 0', borderBottom: '1px solid var(--color-border)' }}>
                <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--color-text-primary)', marginBottom: 6 }}>Window</div>
                <select style={{ background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '5px 8px', fontSize: '11px', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-dm-sans)', cursor: 'pointer' }}>
                  <option>10 days</option>
                  <option>7 days</option>
                  <option>14 days</option>
                  <option>30 days</option>
                </select>
              </div>
            </div>
          </div>

          {/* Notifications */}
          <div>
            <SectionTitle>Notifications</SectionTitle>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <ToggleRow label="Weekly quiet log digest" desc="Summary of quietly logged emails every week" on={true} onToggle={() => {}} />
              <div style={{ padding: '10px 0', borderBottom: '1px solid var(--color-border)' }}>
                <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--color-text-primary)', marginBottom: 4 }}>Response received grace period</div>
                <div style={{ fontSize: '10px', color: 'var(--color-text-muted)', marginBottom: 6, lineHeight: 1.4 }}>How long to show resolved awaiting-reply items</div>
                <select style={{ background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '5px 8px', fontSize: '11px', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-dm-sans)', cursor: 'pointer' }}>
                  <option>48 hours</option>
                  <option>24 hours</option>
                  <option>7 days</option>
                  <option>Off</option>
                </select>
              </div>
            </div>
          </div>

          {/* Connected accounts */}
          <div>
            <SectionTitle>Connected accounts</SectionTitle>
            {user && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', borderBottom: '1px solid var(--color-border)' }}>
                {user.photoURL && <img src={user.photoURL} alt="" width={22} height={22} style={{ borderRadius: '50%' }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</div>
                  <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: '9px', color: 'var(--color-text-muted)' }}>Personal Gmail · Primary</div>
                </div>
                <Toggle on={true} onToggle={() => {}} />
              </div>
            )}
            <button style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', marginTop: 8, padding: '8px', border: '1px dashed var(--color-border)', borderRadius: 'var(--radius-md)', background: 'transparent', fontSize: '11px', color: 'var(--color-text-muted)', cursor: 'pointer', fontFamily: 'var(--font-dm-sans)' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Add another account
            </button>
          </div>

        </div>

        {/* Footer */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--color-border)', flexShrink: 0 }}>
          <a
            href="/privacy"
            style={{ display: 'block', textAlign: 'center', fontFamily: 'var(--font-dm-mono)', fontSize: 'var(--fs-sm)', color: 'var(--color-text-muted)', textDecoration: 'none', letterSpacing: '0.04em' }}
          >
            Privacy Policy &amp; GDPR →
          </a>
        </div>

      </div>
    </>
  )
}


