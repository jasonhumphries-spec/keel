'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { doc, setDoc, getDoc, Timestamp, onSnapshot } from 'firebase/firestore'
import { db } from '@/lib/firebase'

const STEPS = ['welcome', 'how-it-works', 'email-type', 'categories', 'scan'] as const
type Step = typeof STEPS[number]

type EmailType = 'personal' | 'work' | 'both'

const PERSONAL_CATEGORIES = [
  { id: 'cat_finance',  name: 'Finance & Bills',    selected: true,  description: '' },
  { id: 'cat_school',   name: 'School & Education', selected: true,  description: '' },
  { id: 'cat_home',     name: 'Home & Property',    selected: true,  description: '' },
  { id: 'cat_hired',    name: 'Hired Help',          selected: true,  description: '' },
  { id: 'cat_health',   name: 'Health',              selected: true,  description: '' },
  { id: 'cat_travel',   name: 'Holidays & Travel',  selected: true,  description: '' },
  { id: 'cat_drama',    name: 'Social & Events',     selected: false, description: '' },
  { id: 'cat_it',       name: 'IT & Tech',           selected: false, description: '' },
  { id: 'cat_job',      name: 'Job Search',          selected: false, description: '' },
  { id: 'cat_other',    name: 'Other',               selected: true,  description: '' },
]

const WORK_CATEGORIES = [
  { id: 'cat_clients',    name: 'Clients',              selected: true,  description: '' },
  { id: 'cat_suppliers',  name: 'Suppliers & Vendors',  selected: true,  description: '' },
  { id: 'cat_finance',    name: 'Finance & Invoices',   selected: true,  description: '' },
  { id: 'cat_hr',         name: 'HR & People',          selected: true,  description: '' },
  { id: 'cat_legal',      name: 'Legal & Compliance',   selected: true,  description: '' },
  { id: 'cat_projects',   name: 'Projects',             selected: true,  description: '' },
  { id: 'cat_travel',     name: 'Travel & Expenses',    selected: false, description: '' },
  { id: 'cat_marketing',  name: 'Marketing & PR',       selected: false, description: '' },
  { id: 'cat_it',         name: 'IT & Systems',         selected: false, description: '' },
  { id: 'cat_other',      name: 'Other',                selected: true,  description: '' },
]

const BOTH_CATEGORIES = [
  { id: 'cat_finance',    name: 'Finance & Bills',      selected: true,  description: '' },
  { id: 'cat_clients',    name: 'Clients',              selected: true,  description: '' },
  { id: 'cat_suppliers',  name: 'Suppliers & Vendors',  selected: true,  description: '' },
  { id: 'cat_home',       name: 'Home & Property',      selected: true,  description: '' },
  { id: 'cat_health',     name: 'Health',               selected: true,  description: '' },
  { id: 'cat_travel',     name: 'Travel',               selected: true,  description: '' },
  { id: 'cat_school',     name: 'School & Education',   selected: false, description: '' },
  { id: 'cat_hired',      name: 'Hired Help',           selected: false, description: '' },
  { id: 'cat_legal',      name: 'Legal & Compliance',   selected: false, description: '' },
  { id: 'cat_projects',   name: 'Projects',             selected: false, description: '' },
  { id: 'cat_drama',      name: 'Social & Events',      selected: false, description: '' },
  { id: 'cat_other',      name: 'Other',                selected: true,  description: '' },
]

function categoriesForType(type: EmailType) {
  if (type === 'work')  return WORK_CATEGORIES
  if (type === 'both')  return BOTH_CATEGORIES
  return PERSONAL_CATEGORIES
}

const DEFAULT_CATEGORIES = PERSONAL_CATEGORIES

// Keel logo — matches sidebar
function KeelLogo({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
      <circle cx="128" cy="128" r="110" fill="none" stroke="#B8964E" strokeWidth="8"/>
      <path d="M 108 83 L 128 93 L 148 83"   fill="none" stroke="#B8964E" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M 110 101 L 128 111 L 146 101" fill="none" stroke="#B8964E" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M 112 119 L 128 129 L 144 119" fill="none" stroke="#B8964E" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M 114 137 L 128 147 L 142 137" fill="none" stroke="#B8964E" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M 116 155 L 128 165 L 140 155" fill="none" stroke="#B8964E" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M 118 173 L 128 183 L 138 173" fill="none" stroke="#B8964E" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function ProgressDots({ current }: { current: number }) {
  return (
    <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginBottom: 28 }}>
      {STEPS.map((_, i) => (
        <div key={i} style={{ width: i === current ? 20 : 6, height: 6, borderRadius: 3, background: i === current ? 'var(--color-accent)' : i < current ? 'var(--color-accent)' : 'var(--color-border)', opacity: i < current ? 0.4 : 1, transition: 'all 0.3s' }} />
      ))}
    </div>
  )
}

function WelcomeStep({ onNext, name }: { onNext: () => void; name: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
        <KeelLogo size={56} />
      </div>
      <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8, letterSpacing: '-0.02em' }}>
        Welcome to Keel, {name}
      </h1>
      <p style={{ fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.7, marginBottom: 24, maxWidth: 320, margin: '0 auto 24px' }}>
        Keel reads your emails and surfaces what actually needs your attention — bills, appointments, RSVPs, and more. Works for personal and work email alike.
      </p>
      <div style={{ background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: '16px 20px', marginBottom: 28, textAlign: 'left' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 12, fontFamily: 'var(--font-dm-mono)', letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>What happens next</div>
        {[
          {
            icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
            text: "We'll scan your recent emails to find what's active",
          },
          {
            icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>,
            text: 'Items are organised into categories automatically',
          },
          {
            icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
            text: 'Email content is never stored — only key details',
          },
        ].map((item, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: i < 2 ? 10 : 0 }}>
            <span style={{ flexShrink: 0, marginTop: 1 }}>{item.icon}</span>
            <span style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>{item.text}</span>
          </div>
        ))}
      </div>
      <button onClick={onNext} style={primaryBtn}>Get started →</button>
    </div>
  )
}

function EmailTypeStep({ onNext, onBack }: { onNext: (type: EmailType) => void; onBack: () => void }) {
  const [selected, setSelected] = useState<EmailType | null>(null)

  const options: { id: EmailType; label: string; sub: string; preview: string[] }[] = [
    {
      id: 'personal',
      label: 'Personal',
      sub: 'Gmail, home, family, health, bills',
      preview: ['Finance & Bills', 'Home & Property', 'Health', 'Holidays & Travel', 'School & Education'],
    },
    {
      id: 'work',
      label: 'Work',
      sub: 'Business email, clients, suppliers, projects',
      preview: ['Clients', 'Suppliers & Vendors', 'Finance & Invoices', 'HR & People', 'Legal & Compliance'],
    },
    {
      id: 'both',
      label: 'Both',
      sub: 'Mixed personal and work in one inbox',
      preview: ['Finance & Bills', 'Clients', 'Home & Property', 'Travel', 'Health'],
    },
  ]

  return (
    <div>
      <h2 style={stepTitle}>What's this email account for?</h2>
      <p style={stepSubtitle}>
        Keel will suggest a starter set of categories based on your answer — you can customise them in the next step.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
        {options.map(opt => {
          const isSelected = selected === opt.id
          return (
            <button
              key={opt.id}
              onClick={() => setSelected(opt.id)}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 14, padding: '14px 16px',
                borderRadius: 'var(--radius-md)', textAlign: 'left' as const, cursor: 'pointer',
                border: `2px solid ${isSelected ? 'var(--color-accent)' : 'var(--color-border)'}`,
                background: isSelected ? 'var(--color-accent-sub)' : 'var(--color-surface)',
                transition: 'all 0.15s',
              }}
            >
              {/* Radio circle */}
              <div style={{ width: 18, height: 18, borderRadius: '50%', border: `2px solid ${isSelected ? 'var(--color-accent)' : 'var(--color-border)'}`, background: isSelected ? 'var(--color-accent)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2 }}>
                {isSelected && <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'white' }} />}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: isSelected ? 'var(--color-accent)' : 'var(--color-text-primary)', marginBottom: 2 }}>
                  {opt.label}
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>{opt.sub}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 5 }}>
                  {opt.preview.map(p => (
                    <span key={p} style={{ fontSize: 10, fontFamily: 'var(--font-dm-mono)', padding: '2px 7px', borderRadius: 4, background: isSelected ? 'var(--color-accent)' : 'var(--color-surface-recessed)', color: isSelected ? 'white' : 'var(--color-text-muted)', border: `1px solid ${isSelected ? 'transparent' : 'var(--color-border)'}` }}>
                      {p}
                    </span>
                  ))}
                  <span style={{ fontSize: 10, color: 'var(--color-text-muted)', fontFamily: 'var(--font-dm-mono)', padding: '2px 4px' }}>+more</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={onBack} style={ghostBtn}>← Back</button>
        <button
          onClick={() => selected && onNext(selected)}
          disabled={!selected}
          style={{ ...primaryBtn, flex: 1, opacity: !selected ? 0.5 : 1 }}
        >
          Continue →
        </button>
      </div>
    </div>
  )
}

function HowItWorksStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  return (
    <div>
      <h2 style={stepTitle}>How Keel works</h2>
      <p style={stepSubtitle}>A control tower, not a second inbox. Everything stays in Gmail.</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 28 }}>
        {[
          {
            title: 'Scans your recent emails',
            body: 'Keel looks for emails with activity in the last 7 days — so your dashboard shows what\'s live, not everything you\'ve ever received. For any thread it finds, it reads the full conversation history (however old) to understand the context properly. You can adjust the 7-day window later in Settings.',
            colour: 'var(--color-status-new)',
          },
          {
            title: 'Extracts what matters',
            body: 'Bills due, RSVPs needed, questions awaiting replies, upcoming dates — surfaced as clear, actionable items.',
            colour: 'var(--color-status-warning)',
          },
          {
            title: 'Organises into categories',
            body: 'Each item is automatically placed into a category like Finance, School, or Home. You choose the categories and can adjust them any time.',
            colour: 'var(--color-accent)',
          },
          {
            title: 'You act in Gmail, not here',
            body: 'Keel is read-only. When you need to reply or pay something, it takes you straight to the email in Gmail.',
            colour: 'var(--color-status-positive)',
          },
        ].map((item, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderLeft: `3px solid ${item.colour}`, borderRadius: 'var(--radius-md)', padding: '12px 14px' }}>
            <div style={{ width: 20, height: 20, borderRadius: '50%', background: item.colour, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 11, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>{i + 1}</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 3 }}>{item.title}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>{item.body}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={onBack} style={ghostBtn}>← Back</button>
        <button onClick={onNext} style={{ ...primaryBtn, flex: 1 }}>Continue →</button>
      </div>
    </div>
  )
}

function CategoriesStep({ onNext, onBack }: { onNext: (cats: typeof DEFAULT_CATEGORIES) => void; onBack: () => void }) {
  const [cats, setCats]         = useState(DEFAULT_CATEGORIES)
  const [newCat, setNewCat]     = useState('')
  const [phase, setPhase]       = useState<'pick' | 'describe'>('pick')
  const [descIndex, setDescIndex] = useState(0)
  const [descriptions, setDescriptions] = useState<Record<string, string>>({})

  const toggle = (id: string) => setCats(prev => prev.map(c => c.id === id ? { ...c, selected: !c.selected } : c))

  const addCustom = () => {
    if (!newCat.trim()) return
    setCats(prev => [...prev, { id: `cat_${Date.now()}`, name: newCat.trim(), selected: true, description: '' }])
    setNewCat('')
  }

  // IDs of the built-in defaults — these have descriptions baked into the AI prompt
  const DEFAULT_IDS = new Set([
    'cat_finance', 'cat_school', 'cat_home', 'cat_hired',
    'cat_health', 'cat_travel', 'cat_work', 'cat_it',
    'cat_drama', 'cat_job', 'cat_other',
  ])

  const selected     = cats.filter(c => c.selected)
  const customCats   = selected.filter(c => !DEFAULT_IDS.has(c.id)) // only user-added ones
  const needsDesc    = customCats.length > 0

  const goToDescribe = () => {
    if (!needsDesc) {
      onNext(cats as typeof DEFAULT_CATEGORIES)
      return
    }
    setDescIndex(0)
    setPhase('describe')
  }

  const nextDesc = () => {
    if (descIndex < customCats.length - 1) {
      setDescIndex(i => i + 1)
    } else {
      // All custom cats described — merge descriptions in and proceed
      const catsWithDesc = cats.map(c => ({
        ...c,
        description: descriptions[c.id] ?? '',
      }))
      onNext(catsWithDesc as typeof DEFAULT_CATEGORIES)
    }
  }

  const skipAllDesc = () => {
    onNext(cats as typeof DEFAULT_CATEGORIES)
  }

  // ---- Describe phase — custom categories only ----
  if (phase === 'describe') {
    // Safety: if no custom cats somehow, skip to scan
    if (customCats.length === 0) {
      onNext(cats as typeof DEFAULT_CATEGORIES)
      return null
    }

    const cat     = customCats[descIndex]
    const isFirst = descIndex === 0
    const isLast  = descIndex === customCats.length - 1
    const desc    = descriptions[cat.id] ?? ''

    const exampleMap: Record<string, string> = {
      cat_finance:  'Bills, invoices, and bank statements. Senders include energy suppliers, HMRC, our accountant (DPC), and credit card providers.',
      cat_school:   'Emails from St Mary\'s school, the PTA, and after-school clubs. Includes term dates, fees, and event notices.',
      cat_home:     'Emails about our house in Bath — from letting agents, the council, and tradespeople like plumbers and electricians.',
      cat_hired:    'Our cleaner Maria, the gardener, and childcare providers. Includes invoices and scheduling.',
      cat_health:   'GP, dentist, and physio appointments. Includes NHS letters and private health insurance.',
      cat_travel:   'Flight and hotel confirmations, travel insurance, and holiday bookings.',
      cat_work:     'Work emails — clients, suppliers, and colleagues related to Digby Fine English.',
      cat_it:       'Domain renewals, hosting invoices, and software subscriptions like Zoho and Shopify.',
    }
    const example = exampleMap[cat.id] ?? `Emails that belong in ${cat.name} — who sends them, what they\'re about, and any key names or topics.`

    return (
      <div>
        {/* Progress */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h2 style={stepTitle}>Describe your categories</h2>
            <p style={{ ...stepSubtitle, marginBottom: 0 }}>
              {cat.name} — {descIndex + 1} of {customCats.length} new {customCats.length === 1 ? 'category' : 'categories'}
            </p>
          </div>
          <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 10, color: 'var(--color-text-muted)' }}>
            {customCats.map((s, i) => (
              <span key={s.id} style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: i === descIndex ? 'var(--color-accent)' : i < descIndex ? 'var(--color-accent)' : 'var(--color-border)', opacity: i < descIndex ? 0.4 : 1, marginRight: 4 }} />
            ))}
          </div>
        </div>

        {/* Teaching moment — only on first category */}
        {isFirst && (
          <div style={{ background: 'var(--color-accent-sub)', border: '1px solid var(--color-accent)', borderRadius: 'var(--radius-md)', padding: '12px 14px', marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-accent)', marginBottom: 6 }}>
              ✨ One quick step for your new {customCats.length === 1 ? 'category' : 'categories'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
              Keel uses your description to automatically place future emails here — without asking you each time. Tell it who sends these emails, what they're about, and any key names or companies. The more specific, the smarter it gets.
            </div>
          </div>
        )}

        {/* Description input */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', display: 'block', marginBottom: 6 }}>
            What emails belong in <span style={{ color: 'var(--color-accent)' }}>{cat.name}</span>?
          </label>
          <textarea
            autoFocus
            value={desc}
            onChange={e => setDescriptions(prev => ({ ...prev, [cat.id]: e.target.value }))}
            placeholder={`e.g. "${example}"`}
            rows={4}
            style={{ width: '100%', background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '10px 12px', fontSize: 13, color: 'var(--color-text-primary)', fontFamily: 'var(--font-dm-sans)', outline: 'none', resize: 'none', lineHeight: 1.6, boxSizing: 'border-box' as const }}
          />
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4, lineHeight: 1.5 }}>
            You can edit this any time from the Categories page.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          {descIndex === 0 ? (
            <button onClick={() => setPhase('pick')} style={ghostBtn}>← Back</button>
          ) : (
            <button onClick={() => setDescIndex(i => i - 1)} style={ghostBtn}>← Prev</button>
          )}
          <button onClick={nextDesc} style={{ ...primaryBtn, flex: 1 }}>
            {isLast ? 'Start scanning →' : `Next: ${customCats[descIndex + 1]?.name} →`}
          </button>
        </div>

        <div style={{ textAlign: 'center', marginTop: 10 }}>
          <button onClick={skipAllDesc} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--color-text-muted)', fontFamily: 'var(--font-dm-sans)' }}>
            Skip descriptions — go straight to scanning
          </button>
        </div>
      </div>
    )
  }

  // ---- Pick phase ----
  return (
    <div>
      <h2 style={stepTitle}>Your categories</h2>
      <p style={stepSubtitle}>Select the areas that apply to you. You can add, rename, or remove these at any time.</p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
        {cats.map(cat => (
          <button
            key={cat.id}
            onClick={() => toggle(cat.id)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 'var(--radius-md)', border: `1.5px solid ${cat.selected ? 'var(--color-accent)' : 'var(--color-border)'}`, background: cat.selected ? 'var(--color-accent-sub)' : 'var(--color-surface)', cursor: 'pointer', textAlign: 'left' as const, transition: 'all 0.15s' }}
          >
            <span style={{ fontSize: 12, fontWeight: cat.selected ? 600 : 400, color: cat.selected ? 'var(--color-accent)' : 'var(--color-text-secondary)' }}>
              {cat.name}
            </span>
            {cat.selected && <span style={{ marginLeft: 'auto', color: 'var(--color-accent)', fontSize: 12, flexShrink: 0 }}>✓</span>}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <input
          value={newCat}
          onChange={e => setNewCat(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addCustom()}
          placeholder="Add a custom category..."
          style={{ flex: 1, background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '8px 12px', fontSize: 13, color: 'var(--color-text-primary)', fontFamily: 'var(--font-dm-sans)', outline: 'none' }}
        />
        <button onClick={addCustom} disabled={!newCat.trim()} style={{ background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '8px 12px', cursor: newCat.trim() ? 'pointer' : 'not-allowed', color: 'var(--color-text-secondary)', fontSize: 13, fontFamily: 'var(--font-dm-sans)' }}>
          + Add
        </button>
      </div>

      <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 16, textAlign: 'center' as const }}>
        {selected.length} categor{selected.length === 1 ? 'y' : 'ies'} selected
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={onBack} style={ghostBtn}>← Back</button>
        <button onClick={goToDescribe} disabled={selected.length === 0} style={{ ...primaryBtn, flex: 1, opacity: selected.length === 0 ? 0.5 : 1 }}>
          {needsDesc ? 'Continue →' : 'Start scanning →'}
        </button>
      </div>
    </div>
  )
}

function ScanStep({ categories }: { categories: typeof DEFAULT_CATEGORIES }) {
  const { user, scanProgress, triggerScan } = useAuth()
  const router = useRouter()
  const [setupDone, setSetupDone]   = useState(false)
  const [elapsed,   setElapsed]     = useState(0)
  const [tipIndex,  setTipIndex]    = useState(0)
  const [feedItems,    setFeedItems]   = useState<string[]>([])
  const [threadCount,  setThreadCount] = useState<number | null>(null)

  const tips = [
    'This can take a minute or two for a busy inbox — hang tight.',
    'Keel reads the full thread history so it understands conversations in context.',
    'Email content is never stored — only the key details are kept.',
    'Once done, you can adjust categories and descriptions any time.',
    'Items already resolved in Gmail will be quietly filed away automatically.',
    'You can run another scan any time from the dashboard.',
  ]

  useEffect(() => {
    if (!user || setupDone) return
    setupCategories()
  }, [user])

  // Listen to live feed from Firestore
  useEffect(() => {
    if (!user) return
    const feedRef = doc(db, `users/${user.uid}/meta/scanFeed`)
    const unsub = onSnapshot(feedRef,
      (snap) => {
        if (snap.exists()) setFeedItems(snap.data()?.items ?? [])
      },
      () => {}
    )
    return () => unsub()
  }, [user])

  // Elapsed timer and tip rotation
  useEffect(() => {
    if (scanProgress.status !== 'scanning') return
    const timer    = setInterval(() => setElapsed(e => e + 1), 1000)
    const tipTimer = setInterval(() => setTipIndex(i => (i + 1) % tips.length), 6000)
    return () => { clearInterval(timer); clearInterval(tipTimer) }
  }, [scanProgress.status])

  useEffect(() => {
    if (scanProgress.status === 'done') {
      setTimeout(() => router.push('/dashboard'), 2000)
    }
  }, [scanProgress.status])

  const setupCategories = async () => {
    if (!user) return
    setSetupDone(true)
    const selected = categories.filter(c => c.selected)
    const now = Timestamp.now()
    const watchingSince = Timestamp.fromDate(new Date(Date.now() - 7 * 86400000))
    await Promise.all(selected.map((cat, i) =>
      setDoc(doc(db, `users/${user.uid}/categories`, cat.id), {
        categoryId: cat.id, name: cat.name, icon: 'tag',
        order: i + 1, archived: false, archivedAt: null,
        description: cat.description ?? '', itemCount: 0, parentId: null,
        createdAt: now, updatedAt: now,
      })
    ))
    await setDoc(doc(db, `users/${user.uid}/meta/onboarding`), {
      completed: true, completedAt: now, watchingSince,
    }, { merge: true })
    localStorage.setItem('keel_scan_days_back', '7')
    await triggerScan('onboarding')
  }

  const isScanning = scanProgress.status === 'scanning'
  const isDone     = scanProgress.status === 'done'
  const pct        = scanProgress.processed ?? 5

  const formatElapsed = (s: number) => s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`

  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ marginBottom: 20 }}>
        {isDone ? (
          <>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--color-status-positive)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>All done!</h2>
            <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
              {scanProgress.message} · Taking you to your dashboard now...
            </p>
          </>
        ) : (
          <>
            <div style={{ width: 48, height: 48, border: '3px solid var(--color-accent)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px' }} />
            <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 4 }}>
              Setting up your dashboard
            </h2>
            <p style={{ fontSize: 13, color: 'var(--color-accent)', fontWeight: 500, marginBottom: 2 }}>
              {scanProgress.message || 'Starting…'}
            </p>
            {elapsed > 0 && (
              <p style={{ fontSize: 11, color: 'var(--color-text-muted)', fontFamily: 'var(--font-dm-mono)' }}>
                {formatElapsed(elapsed)} elapsed
              </p>
            )}
          </>
        )}
      </div>

      {/* Progress bar */}
      {!isDone && (
        <div style={{ background: 'var(--color-border)', borderRadius: 4, height: 4, overflow: 'hidden', marginBottom: 14 }}>
          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--color-accent)', borderRadius: 4, transition: 'width 0.8s ease' }} />
        </div>
      )}

      {/* Stage checklist */}
      {!isDone && (
        <div style={{ textAlign: 'left', background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '10px 14px', marginBottom: 12 }}>
          {[
            { label: 'Connected to Gmail',                    done: pct >= 12 },
            { label: 'Found email threads',                   done: pct >= 30, sub: pct >= 25 && threadCount !== null ? `${threadCount} threads` : pct >= 25 ? 'counting…' : undefined },
            { label: 'Read full thread history for context',  done: pct >= 45 },
            { label: 'Classified emails with AI',             done: pct >= 76 },
            { label: 'Extracted signals, dates and payments', done: isDone },
          ].map((item, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: i < 4 ? 7 : 0, opacity: (i === 4 ? isDone : pct >= [12,25,45,76,90][i]) ? 1 : 0.35, transition: 'opacity 0.5s' }}>
              <div style={{ width: 14, height: 14, borderRadius: '50%', background: (i === 4 ? isDone : pct >= [12,25,45,76,90][i]) ? 'var(--color-status-positive)' : 'var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 0.3s' }}>
                {pct >= [12,25,45,76,90][i] && <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
              </div>
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                {item.label}
                {item.sub && <span style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 10, color: 'var(--color-accent)', marginLeft: 6 }}>{item.sub}</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Live thread feed — shown while scanning, below checklist */}
      {isScanning && feedItems.length > 0 && (
        <div style={{ background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '10px 12px', marginBottom: 12, textAlign: 'left', position: 'relative', overflow: 'hidden' }}>
          <div style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 10, color: 'var(--color-text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' as const, marginBottom: 6 }}>
            Reading emails
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {feedItems.slice(0, 8).map((item, i) => (
              <div key={i} style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 11, color: i === 0 ? 'var(--color-accent)' : i < 3 ? 'var(--color-text-secondary)' : 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, transition: 'color 0.4s' }}>
                <span style={{ color: i === 0 ? 'var(--color-status-positive)' : 'var(--color-border)', marginRight: 6 }}>›</span>
                {item}
              </div>
            ))}
          </div>
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 28, background: 'linear-gradient(transparent, var(--color-surface-recessed))', pointerEvents: 'none' }} />
        </div>
      )}

      {/* Rotating tip */}
      {isScanning && (
        <div style={{ background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '10px 14px', fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.6, textAlign: 'left', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          {tips[tipIndex]}
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

const primaryBtn: React.CSSProperties = {
  display: 'block', width: '100%', padding: '12px 16px',
  background: 'var(--color-accent)', color: 'white',
  border: 'none', borderRadius: 'var(--radius-md)',
  fontSize: 14, fontWeight: 600, cursor: 'pointer',
  fontFamily: 'var(--font-dm-sans)', letterSpacing: '-0.01em',
}
const ghostBtn: React.CSSProperties = {
  padding: '12px 16px', background: 'transparent',
  border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)',
  fontSize: 14, color: 'var(--color-text-secondary)', cursor: 'pointer',
  fontFamily: 'var(--font-dm-sans)',
}
const stepTitle: React.CSSProperties = {
  fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)',
  marginBottom: 6, letterSpacing: '-0.01em',
}
const stepSubtitle: React.CSSProperties = {
  fontSize: 13, color: 'var(--color-text-secondary)',
  lineHeight: 1.6, marginBottom: 20,
}

export default function OnboardingPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [stepIndex,   setStepIndex]   = useState(0)
  const [emailType,   setEmailType]   = useState<EmailType>('personal')
  const [categories, setCategories]   = useState(DEFAULT_CATEGORIES)

  useEffect(() => {
    if (loading) return
    if (!user) { router.push('/'); return }
    getDoc(doc(db, `users/${user.uid}/meta/onboarding`)).then(snap => {
      if (snap.exists() && snap.data()?.completed) router.push('/dashboard')
    })
  }, [user, loading])

  if (loading || !user) return null

  const currentStep = STEPS[stepIndex]
  const next = () => setStepIndex(i => Math.min(i + 1, STEPS.length - 1))
  const back = () => setStepIndex(i => Math.max(i - 1, 0))

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', background: 'var(--color-bg)', padding: '40px 20px 60px' }}>
      <div style={{ width: '100%', maxWidth: 480 }}>

        {/* Logo — just the mark, no wordmark, no tagline */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 28 }}>
          <KeelLogo size={44} />
        </div>

        {/* Card */}
        <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-xl)', padding: '28px 28px 32px', boxShadow: 'var(--shadow-md)' }}>
          <ProgressDots current={stepIndex} />

          {currentStep === 'welcome'      && <WelcomeStep onNext={next} name={user.displayName?.split(' ')[0] ?? 'there'} />}
          {currentStep === 'how-it-works' && <HowItWorksStep onNext={next} onBack={back} />}
          {currentStep === 'email-type'   && (
            <EmailTypeStep
              onNext={type => {
                setEmailType(type)
                setCategories(categoriesForType(type))
                next()
              }}
              onBack={back}
            />
          )}
          {currentStep === 'categories'   && <CategoriesStep onNext={cats => { setCategories(cats); next() }} onBack={back} />}
          {currentStep === 'scan'         && <ScanStep categories={categories} />}
        </div>

        {currentStep !== 'scan' && (
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button onClick={() => router.push('/dashboard')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--color-text-muted)', fontFamily: 'var(--font-dm-sans)' }}>
              Skip setup → go to dashboard
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
