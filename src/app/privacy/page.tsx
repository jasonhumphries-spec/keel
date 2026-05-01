'use client'

import Link from 'next/link'

const LAST_UPDATED = '30 April 2026'
// TODO: Replace with real contact email once domain is live, and update LAST_UPDATED date
const CONTACT_EMAIL = 'privacy@keel.app'

export default function PrivacyPage() {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-bg)', padding: '40px 20px 80px' }}>
      <div style={{ maxWidth: 680, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ marginBottom: 40 }}>
          <Link href="/" style={{ fontFamily: 'var(--font-dm-mono)', fontSize: 12, color: 'var(--color-text-muted)', textDecoration: 'none', letterSpacing: '0.06em' }}>
            ← Back to Keel
          </Link>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--color-text-primary)', marginTop: 20, marginBottom: 6, letterSpacing: '-0.02em' }}>
            Privacy Policy
          </h1>
          <p style={{ fontSize: 13, color: 'var(--color-text-muted)', fontFamily: 'var(--font-dm-mono)' }}>
            Last updated: {LAST_UPDATED}
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>

          <Section title="Who we are">
            <P>Keel is a personal life administration tool that reads your Gmail to surface what needs your attention. We are committed to handling your data responsibly and transparently.</P>
            <P>For privacy-related questions, contact us at <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: 'var(--color-accent)' }}>{CONTACT_EMAIL}</a>.</P>
          </Section>

          <Section title="What data we process">
            <P>Keel reads your emails to extract structured signals. We operate on a strict <strong>read and discard</strong> principle:</P>
            <div style={{ background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden', marginTop: 12 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)' }}>
                    <th style={{ padding: '10px 14px', textAlign: 'left', color: 'var(--color-text-primary)', fontWeight: 600 }}>What we store</th>
                    <th style={{ padding: '10px 14px', textAlign: 'left', color: 'var(--color-text-primary)', fontWeight: 600 }}>What we never store</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ['Sender name and email address', 'The body content of your emails'],
                    ['Email subject line', 'Attachments of any kind'],
                    ['AI-generated summary (e.g. "Bill due 2 May")', 'Full thread content'],
                    ['Detected dates, amounts, and deadlines', 'Any data from emails we classify as noise'],
                    ['Item status (action needed, done, etc.)', ''],
                    ['Payment records you create (amount, payee, date)', ''],
                    ['Your category structure and preferences', ''],
                  ].map(([stored, notStored], i) => (
                    <tr key={i} style={{ borderBottom: i < 6 ? '1px solid var(--color-border)' : 'none' }}>
                      <td style={{ padding: '9px 14px', color: 'var(--color-text-secondary)', verticalAlign: 'top' }}>
                        {stored && <span style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}><span style={{ color: 'var(--color-status-positive)', flexShrink: 0 }}>✓</span>{stored}</span>}
                      </td>
                      <td style={{ padding: '9px 14px', color: 'var(--color-text-secondary)', verticalAlign: 'top' }}>
                        {notStored && <span style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}><span style={{ color: 'var(--color-status-urgent)', flexShrink: 0 }}>✗</span>{notStored}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <P style={{ marginTop: 12 }}>The stored metadata does constitute personally identifiable information. We treat it with the same seriousness as the raw email content it replaces.</P>
          </Section>

          <Section title="How we use your data">
            <P>We use the data we store exclusively to:</P>
            <ul style={{ paddingLeft: 20, color: 'var(--color-text-secondary)', fontSize: 14, lineHeight: 2 }}>
              <li>Display your dashboard and organised life categories</li>
              <li>Surface items requiring your attention</li>
              <li>Track payment history you have created</li>
              <li>Learn your category preferences so future emails are classified correctly</li>
            </ul>
            <P>We do not use your data for advertising, analytics sold to third parties, or AI model training without your explicit consent.</P>
          </Section>

          <Section title="Encryption and security">
            <P>All data stored in our database is encrypted at rest using AES-256, provided by Google Cloud's infrastructure. All data in transit is protected by TLS.</P>
            <P>Your email content is processed ephemerally — it passes through our AI pipeline to extract signals, and the raw content is immediately discarded. It is never written to disk or stored in our database.</P>
            <P>We are committed to implementing application-layer field-level encryption of sensitive metadata fields (sender names, email addresses, AI summaries) before public launch. This will ensure that even in the event of a database compromise, your personal data remains unreadable.</P>
          </Section>

          <Section title="Third parties">
            <P>Keel uses the following third-party services to operate:</P>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {[
                { name: 'Google (Gmail API, Google Calendar API)', purpose: 'Reading your emails and calendar to extract signals', policy: 'https://policies.google.com/privacy' },
                { name: 'Anthropic (Claude API)', purpose: 'AI classification of email threads. Email content is sent to Anthropic\'s API for processing and is not retained by Anthropic beyond the API call.', policy: 'https://www.anthropic.com/privacy' },
                { name: 'Google Firebase / Firestore', purpose: 'Storing your account data, categories, and extracted signals', policy: 'https://firebase.google.com/support/privacy' },
                { name: 'Vercel', purpose: 'Hosting the application', policy: 'https://vercel.com/legal/privacy-policy' },
              ].map((tp, i) => (
                <div key={i} style={{ background: 'var(--color-surface-recessed)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '12px 14px' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>{tp.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5, marginBottom: 6 }}>{tp.purpose}</div>
                  <a href={tp.policy} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: 'var(--color-accent)', fontFamily: 'var(--font-dm-mono)' }}>Privacy policy →</a>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Your rights (GDPR)">
            <P>If you are in the UK or European Economic Area, you have the following rights regarding your personal data:</P>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {[
                { right: 'Right of access', detail: 'Request a copy of all personal data we hold about you.' },
                { right: 'Right to rectification', detail: 'Ask us to correct inaccurate data.' },
                { right: 'Right to erasure', detail: 'Request deletion of all your data. We will purge your account within 30 days of a verified request.' },
                { right: 'Right to data portability', detail: 'Request your data in a machine-readable format (JSON or CSV).' },
                { right: 'Right to object', detail: 'Object to our processing of your personal data.' },
                { right: 'Right to restrict processing', detail: 'Ask us to pause processing while a dispute is resolved.' },
              ].map((item, i) => (
                <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-accent)', flexShrink: 0, marginTop: 5 }} />
                  <div>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{item.right} — </span>
                    <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>{item.detail}</span>
                  </div>
                </div>
              ))}
            </div>
            <P style={{ marginTop: 12 }}>To exercise any of these rights, email us at <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: 'var(--color-accent)' }}>{CONTACT_EMAIL}</a>. We will respond within 30 days.</P>
          </Section>

          <Section title="Data retention">
            <P>We retain your data for as long as your account is active. Specifically:</P>
            <ul style={{ paddingLeft: 20, color: 'var(--color-text-secondary)', fontSize: 14, lineHeight: 2 }}>
              <li>Active items and signals — retained until you delete them or close your account</li>
              <li>Quietly logged items — automatically purged after 90 days</li>
              <li>Payment history — retained until you delete it or close your account</li>
              <li>On account deletion — all data purged within 30 days</li>
            </ul>
          </Section>

          <Section title="Cookies">
            <P>Keel uses only strictly necessary cookies required to keep you signed in (Firebase Authentication session cookies). These are exempt from consent requirements under UK PECR and the EU ePrivacy Directive.</P>
            <P>We do not use analytics cookies, advertising cookies, or any third-party tracking cookies. We collect no telemetry or behavioural data about how you use the application.</P>
            <P>Because we use only strictly necessary cookies, no cookie consent banner is shown. If this ever changes — for example if we introduce optional analytics — we will update this policy and add appropriate consent controls before doing so.</P>
          </Section>

          <Section title="Changes to this policy">
            <P>We may update this policy as the product evolves. We will notify you of material changes by email or via a notice on the dashboard. The date at the top of this page reflects the most recent update.</P>
          </Section>

          <Section title="Contact">
            <P>For any privacy-related questions or to exercise your rights, contact us at <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: 'var(--color-accent)' }}>{CONTACT_EMAIL}</a>.</P>
          </Section>

        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 style={{ fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 12, letterSpacing: '-0.01em', paddingBottom: 8, borderBottom: '1px solid var(--color-border)' }}>
        {title}
      </h2>
      {children}
    </div>
  )
}

function P({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <p style={{ fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.7, marginBottom: 10, ...style }}>
      {children}
    </p>
  )
}
