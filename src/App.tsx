import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { AppShell } from './components/AppShell';
import { LoginScreen } from './components/LoginScreen';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { CampaignsPage } from './pages/CampaignsPage';
import { ImportPage } from './pages/ImportPage';
import { LeadsPage, type LeadsViewMode } from './pages/LeadsPage';
import { OutboxPage } from './pages/OutboxPage';
import { OverviewPage } from './pages/OverviewPage';
import { ResearchPage } from './pages/ResearchPage';
import { SettingsPage } from './pages/SettingsPage';
import type { PageId } from './types/outreach';

function DeskRouter() {
  const { isAuthenticated, isLoading } = useAuth();
  const [activePage, setActivePage] = useState<PageId>('overview');
  const [leadsViewMode, setLeadsViewMode] = useState<LeadsViewMode>('list');
  const [overviewRefreshSignal, setOverviewRefreshSignal] = useState(0);
  const [leadsRefreshSignal, setLeadsRefreshSignal] = useState(0);
  const [campaignsRefreshSignal, setCampaignsRefreshSignal] = useState(0);
  const [outboxRefreshSignal, setOutboxRefreshSignal] = useState(0);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center px-4">
        <div className="flex items-center gap-3 text-sm font-medium text-slate-600 dark:text-slate-400">
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span>Verifying session...</span>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  function handleNavigate(nextPage: PageId) {
    if (nextPage === 'pipeline') {
      setLeadsViewMode('board');
    } else if (nextPage === 'leads' && activePage !== 'leads') {
      setLeadsViewMode('list');
    }
    setActivePage(nextPage);
  }

  const isLeadsOrPipeline = activePage === 'leads' || activePage === 'pipeline';

  const headerAction =
    activePage === 'overview' ||
    isLeadsOrPipeline ||
    activePage === 'campaigns' ||
    activePage === 'outbox' ? (
      <button
        type="button"
        onClick={() => {
          if (activePage === 'overview') {
            setOverviewRefreshSignal((prev) => prev + 1);
          } else if (activePage === 'campaigns') {
            setCampaignsRefreshSignal((prev) => prev + 1);
          } else if (activePage === 'outbox') {
            setOutboxRefreshSignal((prev) => prev + 1);
          } else {
            setLeadsRefreshSignal((prev) => prev + 1);
          }
        }}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors min-h-[36px] whitespace-nowrap shrink-0"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        <span>Refresh</span>
      </button>
    ) : undefined;

  return (
    <AppShell
      activePage={activePage}
      onNavigate={handleNavigate}
      headerAction={headerAction}
    >
      {activePage === 'overview' && (
        <OverviewPage
          onNavigate={handleNavigate}
          refreshSignal={overviewRefreshSignal}
        />
      )}
      {isLeadsOrPipeline && (
        <LeadsPage
          refreshSignal={leadsRefreshSignal}
          viewMode={leadsViewMode}
          onChangeViewMode={(mode) => {
            setLeadsViewMode(mode);
            setActivePage(mode === 'board' ? 'pipeline' : 'leads');
          }}
          onNavigateToImport={() => setActivePage('import')}
          onNavigateToResearch={() => setActivePage('research')}
          onNavigateToSettings={() => setActivePage('settings')}
          onLeadMutated={() => setOverviewRefreshSignal((prev) => prev + 1)}
        />
      )}
      {activePage === 'research' && (
        <ResearchPage
          onNavigateToLeads={() => {
            setLeadsRefreshSignal((prev) => prev + 1);
            setLeadsViewMode('list');
            setActivePage('leads');
          }}
          onNavigateToCampaigns={() => {
            setCampaignsRefreshSignal((prev) => prev + 1);
            setActivePage('campaigns');
          }}
          onNavigateToSettings={() => setActivePage('settings')}
          onImported={() => {
            setLeadsRefreshSignal((prev) => prev + 1);
            setCampaignsRefreshSignal((prev) => prev + 1);
            setOverviewRefreshSignal((prev) => prev + 1);
          }}
        />
      )}
      {activePage === 'campaigns' && (
        <CampaignsPage
          refreshSignal={campaignsRefreshSignal}
          onNavigateToImport={() => setActivePage('import')}
          onNavigateToSettings={() => setActivePage('settings')}
          onCampaignMutated={() => setOverviewRefreshSignal((prev) => prev + 1)}
        />
      )}
      {activePage === 'import' && (
        <ImportPage
          onImportCompleted={() => {
            setLeadsRefreshSignal((prev) => prev + 1);
            setOverviewRefreshSignal((prev) => prev + 1);
            setLeadsViewMode('list');
            setActivePage('leads');
          }}
          onNavigateToLeads={() => {
            setLeadsViewMode('list');
            setActivePage('leads');
          }}
          onCampaignCreated={() => {
            setCampaignsRefreshSignal((prev) => prev + 1);
            setOverviewRefreshSignal((prev) => prev + 1);
            setActivePage('campaigns');
          }}
        />
      )}
      {activePage === 'outbox' && (
        <OutboxPage
          refreshSignal={outboxRefreshSignal}
          onEmailSent={() => setOverviewRefreshSignal((prev) => prev + 1)}
          onNavigateToSettings={() => setActivePage('settings')}
        />
      )}
      {activePage === 'settings' && (
        <SettingsPage
          onMailboxChanged={() => setOverviewRefreshSignal((prev) => prev + 1)}
        />
      )}
    </AppShell>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <DeskRouter />
      </AuthProvider>
    </ThemeProvider>
  );
}
