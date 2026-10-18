'use client'
import { useRouter, usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import clsx from 'clsx'
import { isStaff, canEdit, roleLabel } from '@/lib/roles'
import {
  LayoutDashboard, BarChart3, Bell, LogOut,
  RefreshCw, TrendingUp, GitMerge, Send, SlidersHorizontal
} from 'lucide-react'

// Brands shown under "My Projects". Temporarily limited to iLady; add names back to re-enable.
const VISIBLE_BRANDS = ['ilady']

interface SidebarProps {
  userEmail?: string
  userName?: string
  userRole?: string
  brands?: string[]
  activeBrand?: string
}

export default function Sidebar({ userEmail, userName, userRole, brands = [], activeBrand }: SidebarProps) {
  const router = useRouter()
  const pathname = usePathname()
  const supabase = createClient()

  const initials = userName
    ? userName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    : userEmail?.slice(0, 2).toUpperCase() || '??'

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const staff = isStaff(userRole)
  const editor = canEdit(userRole)
  const visibleBrands = brands.filter(b => VISIBLE_BRANDS.includes(b.toLowerCase()))

  return (
    <div className="w-52 min-w-52 flex flex-col h-full" style={{ background: '#1F2937' }}>
      {/* Header */}
      <div className="px-4 py-5" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="text-white font-semibold text-sm tracking-wide" style={{ fontFamily: 'Cambria, Georgia, serif' }}>CTG Supply Chain</div>
        <div className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.4)', fontFamily: 'Calibri, Segoe UI, sans-serif' }}>S&D Portal</div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-2">
        <div className="px-4 py-2 text-white/30 text-xs uppercase tracking-widest font-medium">{staff ? 'Overview' : 'My Brand'}</div>
        <NavItem
          icon={<LayoutDashboard size={15} />}
          label="Inventory Health"
          href="/dashboard"
          active={pathname === '/dashboard'}
          onClick={() => router.push('/dashboard')}
        />
        <NavItem
          icon={<SlidersHorizontal size={15} />}
          label="Inventory Parameters"
          href="/inventory-params"
          active={pathname === '/inventory-params'}
          onClick={() => router.push('/inventory-params')}
        />

        {staff && (
          <NavItem
            icon={<Send size={15} />}
            label="PO Release"
            href="/po-release"
            active={pathname === '/po-release'}
            onClick={() => router.push('/po-release')}
          />
        )}

        <div className="px-4 py-2 text-white/30 text-xs uppercase tracking-widest font-medium mt-1">Tools</div>
        {editor && (
          <NavItem
            icon={<TrendingUp size={15} />}
            label="Sales History"
            href="/sales-history-upload"
            active={pathname === '/sales-history-upload'}
            onClick={() => router.push('/sales-history-upload')}
          />
        )}
        <NavItem
          icon={<Send size={15} />}
          label="Submit Forecast"
          href="/forecast-submit"
          active={pathname === '/forecast-submit'}
          onClick={() => router.push('/forecast-submit')}
        />
        {staff && (
          <NavItem
            icon={<RefreshCw size={15} />}
            label="Forecast Log"
            href="/forecast-log"
            active={pathname === '/forecast-log'}
            onClick={() => router.push('/forecast-log')}
          />
        )}
        {editor && (
          <NavItem
            icon={<GitMerge size={15} />}
            label="PLM"
            href="/plm"
            active={pathname.startsWith('/plm')}
            onClick={() => router.push('/plm')}
          />
        )}

        {visibleBrands.length > 0 && (
          <>
            <div className="px-4 py-2 text-white/30 text-xs uppercase tracking-widest font-medium mt-1">My Projects</div>
            {[...visibleBrands].sort((a, b) => a.localeCompare(b)).map(brand => (
              <NavItem
                key={brand}
                icon={<BarChart3 size={15} />}
                label={brand}
                href={`/project/${encodeURIComponent(brand)}`}
                active={activeBrand === brand}
                onClick={() => router.push(`/project/${encodeURIComponent(brand)}`)}
              />
            ))}
          </>
        )}
      </nav>

      {/* User footer */}
      <div className="px-4 py-4 border-t border-white/10">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0" style={{ background: 'rgba(14,92,86,0.35)', color: '#DCEAE8' }}>
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-white text-xs font-medium truncate">{userName || userEmail}</div>
            <div className="text-white/40 text-xs truncate capitalize">{roleLabel(userRole)}</div>
          </div>
          <button onClick={handleLogout} className="text-white/30 hover:text-white/70 transition-colors">
            <LogOut size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}

function NavItem({ icon, label, href, active, onClick }: {
  icon: React.ReactNode
  label: string
  href: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      style={active ? { borderLeft: '2px solid #0E5C56', background: 'rgba(14,92,86,0.15)', color: '#FFFFFF' } : { borderLeft: '2px solid transparent', color: 'rgba(255,255,255,0.5)' }}
         className="w-full flex items-center gap-2.5 px-4 py-2 text-sm transition-all border-l-2"
    >
      <span>{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}
