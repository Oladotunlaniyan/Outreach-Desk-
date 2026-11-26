import { useEffect, useState, type ReactNode } from 'react';
import {
  Compass,
  Kanban,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  Moon,
  Send,
  Settings,
  Sun,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { apiFetch } from '../lib/api';
import type { CampaignItem, CampaignsListResponse, PageId } from '../types/outreach';

interface NavItem {
  id: PageId;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'leads', label: 'Leads', icon: Users },
  { id: 'research', label: 'AI Research', icon: Compass },
  { id: 'import', label: 'Import', icon: Upload },
  { id: 'campaigns', label: 'Campaigns', icon: Send },
  { id: 'pipeline', label: 'Pipeline', icon: Kanban },
  { id: 'outbox', label: 'Outbox', icon: Mail },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const MOBILE_PRIMARY_IDS: PageId[] = ['overview', 'leads', 'campaigns', 'pipeline'];

interface AppShellProps {
  activePage: PageId;
  onNavigate: (page: PageId) => void;
  headerAction?: ReactNode;
  children: ReactNode;
}

export function AppShell({
  activePage,
  onNavigate,
  headerAction,
  children,
}: AppShellProps) {
  const { theme, toggleTheme } = useTheme();
  const { logout, isAuthenticated } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [activeSendingCampaign, setActiveSendingCampaign] = useState<CampaignItem | null>(null);

  useEffect(() => {
    if (!isAuthenticated) {
      setActiveSendingCampaign(null);
      return;
    }

    let cancelled = false;
    const pollActive = async () => {
      try {
        const res = await apiFetch<CampaignsListResponse>('/api/campaigns?status=Sending');
        if (!cancelled) {
          setActiveSendingCampaign(res.campaigns[0] ?? null);
        }
      } catch {
        // Ignore transient poll errors
      }
    };

    void pollActive();
    const intervalId = window.setInterval(() => {
      void pollActive();
    }, 10000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isAuthenticated, activePage]);

  const activeNav = NAV_ITEMS.find((item) => item.id === activePage) || NAV_ITEMS[0];
  const mobilePrimaryItems = NAV_ITEMS.filter((item) => MOBILE_PRIMARY_IDS.includes(item.id));
  const mobileSecondaryItems = NAV_ITEMS.filter((item) => !MOBILE_PRIMARY_IDS.includes(item.id));

  const handleMobileNavigate = (page: PageId) => {
    onNavigate(page);
    setMobileMenuOpen(false);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex md:w-60 lg:w-64 md:flex-col md:fixed md:inset-y-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="flex h-14 items-center px-5 border-b border-slate-200 dark:border-slate-800">
          <span className="font-display text-base font-semibold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap">
            Outreach Desk
          </span>
        </div>

        <nav aria-label="Primary navigation" className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = item.id === activePage;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors min-h-[40px] whitespace-nowrap ${
                  isActive
                    ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                <Icon
                  className={`h-4 w-4 shrink-0 ${
                    isActive
                      ? 'text-blue-600 dark:text-blue-400'
                      : 'text-slate-400 dark:text-slate-500'
                  }`}
                />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {activeSendingCampaign && (
          <div className="px-3 pb-3">
            <button
              type="button"
              onClick={() => onNavigate('campaigns')}
              className="w-full text-left rounded-lg border border-blue-200 dark:border-blue-900/60 bg-blue-50/80 dark:bg-blue-950/30 px-3 py-2.5 space-y-1 hover:bg-blue-50 dark:hover:bg-blue-950/50 transition-colors"
            >
              <div className="flex items-center justify-between gap-2 text-xs font-medium text-blue-800 dark:text-blue-200">
                <span className="truncate">Sending campaign</span>
                <span className="font-mono tabular-nums shrink-0">
                  {activeSendingCampaign.sentCount}/{activeSendingCampaign.totalRecipients}
                </span>
              </div>
              <div className="text-[11px] text-blue-700 dark:text-blue-300 truncate">
                {activeSendingCampaign.name}
              </div>
            </button>
          </div>
        )}

        <div className="p-3 border-t border-slate-200 dark:border-slate-800 space-y-1">
          <button
            type="button"
            onClick={toggleTheme}
            className="w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-100 transition-colors min-h-[40px] whitespace-nowrap"
          >
            {theme === 'dark' ? (
              <Sun className="h-4 w-4 shrink-0 text-slate-400" />
            ) : (
              <Moon className="h-4 w-4 shrink-0 text-slate-400" />
            )}
            <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
          </button>
          <button
            type="button"
            onClick={() => void logout()}
            className="w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-red-600 dark:hover:text-red-400 transition-colors min-h-[40px] whitespace-nowrap"
          >
            <LogOut className="h-4 w-4 shrink-0 text-slate-400" />
            <span>Lock desk</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 md:pl-60 lg:pl-64 pb-20 md:pb-0">
        <header className="sticky top-0 z-20 h-14 flex items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3 min-w-0">
            <span className="md:hidden font-display text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap">
              Outreach Desk
            </span>
            <span className="md:hidden text-slate-300 dark:text-slate-700" aria-hidden="true">
              /
            </span>
            <h1 className="font-display text-base sm:text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100 truncate">
              {activeNav.label}
            </h1>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {headerAction}
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="md:hidden inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-800 p-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 min-h-[40px] min-w-[40px]"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 max-w-7xl w-full mx-auto">
          {children}
        </main>
      </div>

      {/* Mobile More Sheet */}
      {mobileMenuOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex flex-col justify-end bg-slate-950/40 backdrop-blur-[1px]">
          <div
            className="flex-1"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <div className="rounded-t-2xl border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 pt-4 pb-6 space-y-2">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-slate-800">
              <span className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                More sections
              </span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close navigation menu"
                className="inline-flex items-center justify-center rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 min-h-[44px] min-w-[44px]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {mobileSecondaryItems.map((item) => {
              const Icon = item.icon;
              const isActive = item.id === activePage;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleMobileNavigate(item.id)}
                  className={`w-full flex items-center gap-3 rounded-lg px-3.5 py-3 text-sm font-medium min-h-[44px] ${
                    isActive
                      ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <Icon
                    className={`h-4 w-4 ${
                      isActive ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400'
                    }`}
                  />
                  <span>{item.label}</span>
                </button>
              );
            })}

            <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  void logout();
                }}
                className="w-full flex items-center gap-3 rounded-lg px-3.5 py-3 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 min-h-[44px]"
              >
                <LogOut className="h-4 w-4" />
                <span>Lock desk</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Bottom Navigation */}
      <nav
        aria-label="Mobile navigation"
        className="md:hidden fixed bottom-0 inset-x-0 z-30 h-16 border-t border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm grid grid-cols-5"
      >
        {mobilePrimaryItems.map((item) => {
          const Icon = item.icon;
          const isActive = item.id === activePage;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => handleMobileNavigate(item.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`flex flex-col items-center justify-center gap-1 min-h-[44px] px-1 text-[11px] font-medium transition-colors ${
                isActive
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate max-w-full">{item.label}</span>
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => setMobileMenuOpen((prev) => !prev)}
          aria-expanded={mobileMenuOpen}
          className={`flex flex-col items-center justify-center gap-1 min-h-[44px] px-1 text-[11px] font-medium transition-colors ${
            mobileMenuOpen || mobileSecondaryItems.some((item) => item.id === activePage)
              ? 'text-blue-600 dark:text-blue-400'
              : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
          }`}
        >
          <Menu className="h-4 w-4 shrink-0" />
          <span>More</span>
        </button>
      </nav>
    </div>
  );
}
