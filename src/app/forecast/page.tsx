'use client'
// Forecast — one sidebar entry, three tabs: Submit, Log (staff only), Accuracy.
// Each tab is the former standalone page rendered in embedded mode. Visited tabs stay mounted
// (hidden) so a half-typed forecast survives switching tabs. The active tab is kept in the URL hash.
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import Sidebar from '@/components/layout/Sidebar'
import SubmitTab from '@/components/forecast/SubmitTab'
import LogTab from '@/components/forecast/LogTab'
import AccuracyTab from '@/components/forecast/AccuracyTab'
import { isStaff, isBrandOwner } from '@/lib/roles'

type TabId = 'submit' | 'log' | 'accuracy'
const TABS: { id: TabId; label: string; staffOnly?: boolean }[] = [
  { id: 'submit', label: 'Submit' },
  { id: 'log', label: 'Log', staffOnly: true },
  { id: 'accuracy', label: 'Accuracy' },
]

export default function ForecastPage() {
  const supabase = createClient()
  const router = useRouter()
  const [profile, setProfile] = useState<any>(null)
  const [brands, setBrands] = useState<string[]>([])
  const [tab, setTab] = useState<TabId | null>(null)
  const [visited, setVisited] = useState<TabId[]>([])

  useEffect(() => { init() }, [])

  async function init() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }
    const { data: prof } = await supabase.from('profiles').select('*').eq('id', user.id).single()
    setProfile(prof)
    const { data: access } = await supabase.from('user_brand_access').select('brand').eq('user_id', user.id)
    setBrands((access ?? []).map((a: any) => a.brand))
    const staff = isStaff(prof?.role)
    const allowed = TABS.filter(t => staff || !t.staffOnly).map(t => t.id)
    const fromHash = window.location.hash.replace('#', '') as TabId
    select(allowed.includes(fromHash) ? fromHash : (isBrandOwner(prof?.role) ? 'submit' : 'accuracy'), false)
  }

  function select(id: TabId, writeHash = true) {
    setTab(id)
    setVisited(v => (v.includes(id) ? v : [...v, id]))
    if (writeHash) window.history.replaceState(null, '', `#${id}`)
  }

  const staff = isStaff(profile?.role)
  const tabs = TABS.filter(t => staff || !t.staffOnly)

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#F4F2EE', fontFamily: 'Calibri, "Segoe UI", sans-serif', fontSize: 13 }}>
      <Sidebar userEmail={profile?.email} userName={profile?.full_name} userRole={profile?.role} brands={brands} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <div style={{ background: '#fff', borderBottom: '1px solid #E4DDD3', padding: '10px 24px 0' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#1F2937', fontFamily: 'Cambria, Georgia, serif' }}>Forecast</div>
          <div style={{ fontSize: 11.5, color: '#4B5563', margin: '2px 0 8px' }}>Submit the sales forecast, review submissions, and track how accurate it was</div>
          <div role="tablist" style={{ display: 'flex', gap: 4 }}>
            {tabs.map(t => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => select(t.id)}
                style={{
                  fontFamily: 'inherit', fontSize: 12.5, padding: '7px 14px', cursor: 'pointer', background: 'transparent',
                  border: 'none', borderBottom: `2px solid ${tab === t.id ? '#0F6E56' : 'transparent'}`,
                  color: tab === t.id ? '#1F2937' : '#4B5563', fontWeight: tab === t.id ? 600 : 400,
                }}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {tab === null && <div style={{ padding: 20, color: '#8B948F' }}>Loading…</div>}
          {visited.includes('submit') && <div hidden={tab !== 'submit'}><SubmitTab embedded /></div>}
          {visited.includes('log') && staff && <div hidden={tab !== 'log'}><LogTab embedded onNewSubmission={() => select('submit')} /></div>}
          {visited.includes('accuracy') && <div hidden={tab !== 'accuracy'}><AccuracyTab embedded /></div>}
        </div>
      </div>
    </div>
  )
}
