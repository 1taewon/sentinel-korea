export type NavTab = 'map' | 'statistics' | 'data_sources' | 'pathway' | 'report';

interface TopNavProps {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  userEmail?: string | null;
  onSignOut?: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  snapshotDate?: string;
}

const TABS: { key: NavTab; label: string; labelEn: string }[] = [
  { key: 'map', label: '지도', labelEn: 'MAP' },
  { key: 'statistics', label: '통계', labelEn: 'STATISTICS' },
  { key: 'data_sources', label: '데이터 소스', labelEn: 'DATA SOURCES' },
  { key: 'pathway', label: '파이프라인', labelEn: 'PATHWAY' },
  { key: 'report', label: '리포트', labelEn: 'REPORT' },
];

export default function TopNav({ activeTab, onTabChange, userEmail, onSignOut, theme, onToggleTheme, snapshotDate }: TopNavProps) {
  return (
    <header className="top-nav">
      {/* Logo */}
      <div className="top-nav-logo">
        <span className="top-nav-logo-mark">◉</span>
        <span className="top-nav-logo-text">SENTINEL</span>
        <span className="top-nav-logo-sub">KOREA</span>
      </div>

      {/* Tabs */}
      <nav className="top-nav-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className={`top-nav-tab ${activeTab === tab.key ? 'top-nav-tab--active' : ''}`}
            onClick={() => onTabChange(tab.key)}
          >
            <span className="top-nav-tab-label">{tab.labelEn}</span>
            <span className="top-nav-tab-sub">{tab.label}</span>
          </button>
        ))}
      </nav>

      {/* Right controls */}
      <div className="top-nav-right">
        {snapshotDate && (
          <div className="top-nav-date">
            <span className="top-nav-date-dot" />
            {snapshotDate}
          </div>
        )}
        <button
          className="top-nav-icon-btn"
          onClick={onToggleTheme}
          title={theme === 'light' ? 'Dark mode' : 'Light mode'}
        >
          {theme === 'light' ? '◐' : '◑'}
        </button>
        {userEmail && (
          <div className="top-nav-user">
            <span className="top-nav-user-email">{userEmail}</span>
            <button className="top-nav-signout" onClick={onSignOut} title="로그아웃">
              ⏻
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
