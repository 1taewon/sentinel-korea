import { useEffect, useRef, useState } from 'react';

export type NavTab = 'map' | 'statistics' | 'data_sources' | 'pathway' | 'report';

interface TopNavProps {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  userEmail?: string | null;
  onSignOut?: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  snapshotDate?: string;
  availableDates?: string[];
  onDateChange?: (date: string) => void;
}

const TABS: { key: NavTab; label: string; labelEn: string }[] = [
  { key: 'map', label: '지도', labelEn: 'MAP' },
  { key: 'statistics', label: '통계', labelEn: 'STATISTICS' },
  { key: 'data_sources', label: '데이터 소스', labelEn: 'DATA SOURCES' },
  { key: 'pathway', label: 'Control', labelEn: 'PIPELINE' },
  { key: 'report', label: '리포트', labelEn: 'REPORT' },
];

export default function TopNav({
  activeTab, onTabChange, userEmail, onSignOut, theme, onToggleTheme,
  snapshotDate, availableDates, onDateChange,
}: TopNavProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const dateRef = useRef<HTMLDivElement>(null);

  // close picker when clicking outside
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (dateRef.current && !dateRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen]);

  const handlePick = (d: string) => {
    if (onDateChange) onDateChange(d);
    setPickerOpen(false);
  };

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
          <div className="top-nav-date-wrap" ref={dateRef}>
            <button
              className={`top-nav-date top-nav-date--button ${pickerOpen ? 'top-nav-date--open' : ''}`}
              onClick={() => setPickerOpen((v) => !v)}
              title="스냅샷 날짜 변경"
              type="button"
            >
              <span className="top-nav-date-dot" />
              {snapshotDate}
              <span className="top-nav-date-caret">▾</span>
            </button>
            {pickerOpen && (
              <div className="top-nav-date-picker">
                <input
                  type="date"
                  className="top-nav-date-input"
                  value={snapshotDate}
                  onChange={(e) => e.target.value && handlePick(e.target.value)}
                />
                {availableDates && availableDates.length > 0 && (
                  <div className="top-nav-date-list">
                    <div className="top-nav-date-list-title">보유 스냅샷</div>
                    {availableDates.slice(-20).reverse().map((d) => (
                      <button
                        key={d}
                        className={`top-nav-date-list-item ${d === snapshotDate ? 'top-nav-date-list-item--active' : ''}`}
                        onClick={() => handlePick(d)}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        <button
          className="top-nav-icon-btn"
          onClick={onToggleTheme}
          title={theme === 'light' ? 'Dark mode' : 'Light mode'}
          type="button"
        >
          {theme === 'light' ? '◐' : '◑'}
        </button>
        {userEmail && (
          <div className="top-nav-user">
            <span className="top-nav-user-email">{userEmail}</span>
            <button className="top-nav-signout" onClick={onSignOut} title="로그아웃" type="button">
              ⏻
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
