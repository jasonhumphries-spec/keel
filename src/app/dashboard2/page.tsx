'use client'

import { useEffect, Suspense } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { DashboardShell2 } from '@/components/dashboard/DashboardShell2'

function Dashboard2Content() {
  const { user, loading } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (!loading && !user) router.push('/')
  }, [user, loading, router])

  if (loading || !user) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-bg)' }}>
        <div style={{ width: 24, height: 24, border: '2px solid var(--color-border)', borderTopColor: 'var(--color-accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  return <DashboardShell2 />
}

export default function Dashboard2Page() {
  return (
    <Suspense>
      <Dashboard2Content />
    </Suspense>
  )
}
