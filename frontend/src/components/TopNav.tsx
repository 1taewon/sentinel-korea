import { useEffect, useMemo, useRef, useState } from 'react';

export type NavTab = 'map' | 'statistics' | 'data_sources' | 'pathway' | 'report' | 'ontology';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

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
  isAdmin?: boolean;
  isAuthEnabled?: boolean;
  onAdminLogin?: () => void;
}

const TABS: { key: NavTab; label: string; labelEn: string; adminOnly?: boolean }[] = [
  { key: 'map', label: '지도', labelEn: 'MAP' },
  { key: 'statistics', label: '통계', labelEn: 'STATISTICS' },
  { key: 'data_sources', label: '데이터 소스', labelEn: 'DATA SOURCES' },
  { key: 'pathway', label: 'Control', labelEn: 'PIPELINE' },
  { key: 'report', label: '리포트', labelEn: 'REPORT' },
  { key: 'ontology', label: '예측분석', labelEn: 'FORECASTING' },
];

/* ── Pipeline Status Bar ────────────────────────────────────── */
function PipelineStatusBar() {
  const [info, setInfo] = useState<{
    latestSnapshot?: string;
    lastUploadAt?: string;
    lastUploadLabel?: string;
    lastReportAt?: string;
  }>({});

  useEffect(() => {
    // Latest snapshot
    fetch(`${API_BASE}/ingestion/status`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setInfo(s => ({ ...s, latestSnapshot: d.latest_snapshot })))
      .catch(() => {});

    // Last KDCA upload
    fetch(`${API_BASE}/ingestion/upload-history`)
      .then(r => r.ok ? r.json() : [])
      .then((data: any[]) => {
        if (data.length > 0) {
          const sorted = [...data].sort((a, b) =>
            (b.uploaded_at || '').localeCompare(a.uploaded_at || ''));
          const latest = sorted[0];
          const at = latest.uploaded_at || '';
          setInfo(s => ({
            ...s,
            lastUploadAt: at ? at.replace('T', ' ').slice(5, 16) : undefined,
            lastUploadLabel: latest.label || latest.filename,
          }));
        }
      })
      .catch(() => {});

    // Last report
    fetch(`${API_BASE}/reports/list`)
      .then(r => r.ok ? r.json() : [])
      .then((data: any[]) => {
        if (data.length > 0) {
          setInfo(s => ({ ...s, lastReportAt: data[0].generated_at?.slice(0, 10) }));
        }
      })
      .catch(() => {});
  }, []);

  // Next cron: Sunday 22:00 UTC = Monday 07:00 KST
  const nextCron = useMemo(() => {
    const now = new Date();
    const day = now.getUTCDay();
    const daysUntilSun = (7 - day) % 7 || 7;
    const candidate = new Date(now);
    candidate.setUTCDate(now.getUTCDate() + daysUntilSun);
    candidate.setUTCHours(22, 0, 0, 0);
    if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 7);
    const kst = new Date(candidate.getTime() + 9 * 3600000);
    const m = kst.getMonth() + 1;
    const d = kst.getDate();
    return `${m}/${d} (월) 07:00`;
  }, []);

  return (
    <div className="pipeline-status-bar">
      <div className="pipeline-status-item" title="Vercel Cron: 매주 월요일 07:00 KST 자동 실행 (뉴스·트렌드·해외 outbreak·KDCA API→AI 분석→FINAL 리포트)">
        <span className="pipeline-dot pipeline-dot--cron" />
        <span className="pipeline-label">자동분석</span>
        <span className="pipeline-value">{nextCron}</span>
      </div>
      <span className="pipeline-sep" />
      <div className="pipeline-status-item" title={`최근 스냅샷: ${info.latestSnapshot || '—'}\n리포트: ${info.lastReportAt || '—'}`}>
        <span className="pipeline-dot pipeline-dot--snapshot" />
        <span className="pipeline-label">최근 분석</span>
        <span className="pipeline-value">{info.latestSnapshot || '—'}</span>
      </div>
      <span className="pipeline-sep" />
      <div className="pipeline-status-item" title={info.lastUploadLabel || 'KDCA Excel/PDF 업로드 이력'}>
        <span className="pipeline-dot pipeline-dot--upload" />
        <span className="pipeline-label">KDCA 업로드</span>
        <span className="pipeline-value">{info.lastUploadAt || '—'}</span>
      </div>
    </div>
  );
}

export default function TopNav({
  activeTab, onTabChange, userEmail, onSignOut, theme, onToggleTheme,
  snapshotDate, availableDates, onDateChange, isAdmin = false, isAuthEnabled = false, onAdminLogin,
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

      {/* Tabs — adminOnly tabs (ONTOLOGY) hidden from read-only users */}
      <nav className="top-nav-tabs">
        {TABS.filter((tab) => !tab.adminOnly || isAdmin).map((tab) => (
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

      {/* Pipeline status */}
      <PipelineStatusBar />

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
        <span className={`top-nav-role ${isAdmin ? 'top-nav-role--admin' : ''}`}>
          {isAdmin ? 'ADMIN' : 'READ ONLY'}
        </span>
        {userEmail && (
          <div className="top-nav-user">
            <span className="top-nav-user-email">{userEmail}</span>
            <button className="top-nav-signout" onClick={onSignOut} title="로그아웃" type="button">
              ⏻
            </button>
          </div>
        )}
        {!userEmail && isAuthEnabled && (
          <button className="top-nav-admin-hint" type="button" onClick={onAdminLogin} title="Operator sign-in is configured through Firebase Auth">
            OPERATOR LOGIN
          </button>
        )}
      </div>
    </header>
  );
}
