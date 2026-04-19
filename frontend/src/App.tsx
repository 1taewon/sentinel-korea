import { useCallback, useEffect, useState } from 'react';
import FlowDiagram from './components/FlowDiagram';
import GeminiChatbot from './components/GeminiChatbot';
import KdcaUploadPanel from './components/KdcaUploadPanel';
import KoreaMap from './components/KoreaMap';
import LoginPage from './components/LoginPage';
import MiniGlobe from './components/MiniGlobe';
import NewsPanel from './components/NewsPanel';
import RegionPanel from './components/RegionPanel';
import RegionDetailInline from './components/RegionDetailInline';
import ReportView from './components/ReportView';
import StatisticsView from './components/StatisticsView';
import Timeline from './components/Timeline';
import TopNav, { type NavTab } from './components/TopNav';
import TrendsChart from './components/TrendsChart';
import { useAuth } from './contexts/AuthContext';
import type { CombinedData, GlobalSignal, IngestionStatus, KoreaAlert, ScoringConfig } from './types';
import './index.css';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';
// Auth is only enforced when Supabase keys are configured
const AUTH_ENABLED = !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);

type Layer = 'respiratory' | 'wastewater_covid' | 'wastewater_flu' | 'news_trends_risk' | 'total_risk';
type AggregationMode = 'max' | 'weighted';

export default function App() {
  const { user, loading: authLoading, signOut } = useAuth();

  // Auth gate — show login if auth is enabled and user is not signed in
  if (AUTH_ENABLED && authLoading) {
    return (
      <div style={{ minHeight: '100vh', background: '#0B1120', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: '#38BDF8', fontSize: '14px' }}>로딩 중...</div>
      </div>
    );
  }
  if (AUTH_ENABLED && !user) {
    return <LoginPage />;
  }

  return <AppInner user={user} signOut={signOut} />;
}

function AppInner({ user, signOut }: { user: import('@supabase/supabase-js').User | null; signOut: () => Promise<void> }) {
  const [koreaAlerts, setKoreaAlerts] = useState<KoreaAlert[]>([]);
  const [globalSignals, setGlobalSignals] = useState<GlobalSignal[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedKorea, setSelectedKorea] = useState<KoreaAlert | null>(null);
  const [selectedGlobal, setSelectedGlobal] = useState<GlobalSignal | null>(null);
  const [isGlobeExpanded, setIsGlobeExpanded] = useState(false);
  const [showFlowDiagram, setShowFlowDiagram] = useState(false);
  const [activeLayers, setActiveLayers] = useState<Layer[]>(['respiratory']);
  const [aggregationMode, setAggregationMode] = useState<AggregationMode>('max');
  const [showLayerPanel, setShowLayerPanel] = useState(false);

  const toggleLayer = (layer: Layer) => {
    setActiveLayers(prev => {
      if (prev.includes(layer)) {
        if (prev.length === 1) return prev;
        return prev.filter(l => l !== layer);
      }
      return [...prev, layer];
    });
  };
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [currentDate, setCurrentDate] = useState('2026-03-15');
  const [, setIngestionStatus] = useState<IngestionStatus | null>(null);
  const [meta, setMeta] = useState<CombinedData['meta']>();

  // Top navigation tab
  const [navTab, setNavTab] = useState<NavTab>('map');

  // Theme state
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('sentinel-theme');
    return (saved === 'dark') ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('sentinel-theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(prev => prev === 'light' ? 'dark' : 'light');

  // AI Risk Analysis state — OSINT (News+Trends → map)
  const [analyzingOsint, setAnalyzingOsint] = useState(false);
  const [osintResult, setOsintResult] = useState<{ summary?: string; key_signals?: string[]; snapshot_date?: string } | null>(null);

  // AI Risk Analysis state — Sentinel (OSINT+KDCA → final)
  const [analyzingFull, setAnalyzingFull] = useState(false);
  const [fullResult, setFullResult] = useState<{ summary?: string; key_signals?: string[]; snapshot_date?: string } | null>(null);

  const [generatingKdcaReport, setGeneratingKdcaReport] = useState(false);
  const [kdcaReportResult, setKdcaReportResult] = useState<{ summary?: string; filename?: string } | null>(null);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch(`${API_BASE}/ingestion/status`);
        const data: IngestionStatus = await res.json();
        setIngestionStatus(data);
        setAvailableDates(data.available_snapshots);
        setCurrentDate((prev) => (data.available_snapshots.includes(prev) ? prev : data.latest_snapshot));
      } catch {
        setAvailableDates(['2026-03-15']);
      }
    };
    fetchStatus();
  }, []);

  const fetchAlerts = useCallback(async (date?: string) => {
    const d = date || currentDate;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/alerts/combined?date=${d}`);
      const data: CombinedData = await res.json();
      setKoreaAlerts(data.korea || []);
      setGlobalSignals(data.global || []);
      setMeta(data.meta);
    } catch {
      setKoreaAlerts([]);
      setGlobalSignals([]);
      setMeta(undefined);
    }
    setLoading(false);
  }, [currentDate]);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  const handleKoreaClick = useCallback((alert: KoreaAlert) => {
    setSelectedGlobal(null);
    setSelectedKorea(alert);
  }, []);

  const handleClosePanel = useCallback(() => {
    setSelectedKorea(null);
    setSelectedGlobal(null);
  }, []);

  const handleScoringApply = useCallback(async (config: ScoringConfig) => {
    try {
      const res = await fetch(`${API_BASE}/alerts/korea/rescore?date=${currentDate}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const rescored: KoreaAlert[] = await res.json();
      setKoreaAlerts(rescored);
      if (selectedKorea) {
        const updated = rescored.find((alert) => alert.region_code === selectedKorea.region_code) || null;
        setSelectedKorea(updated);
      }
    } catch {
      // Keep the current snapshot if the backend is unavailable.
    }
  }, [currentDate, selectedKorea]);

  const refreshIngestionStatus = async (snapshotDate?: string) => {
    try {
      const statusRes = await fetch(`${API_BASE}/ingestion/status`);
      const statusData: IngestionStatus = await statusRes.json();
      setIngestionStatus(statusData);
      setAvailableDates(statusData.available_snapshots);
      if (snapshotDate) setCurrentDate(snapshotDate);
    } catch { /* ignore */ }
  };

  // OSINT analysis (News+Trends → map update + save OSINT daily report)
  const handleRunOsintAnalysis = async () => {
    setAnalyzingOsint(true);
    setOsintResult(null);
    try {
      const res = await fetch(`${API_BASE}/risk-analysis/analyze-news-trends`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      setOsintResult(data);
      if (data.snapshot_date) {
        await fetchAlerts(data.snapshot_date);
        await refreshIngestionStatus(data.snapshot_date);
      }
      // Save OSINT daily report
      try {
        const rep = await fetch(`${API_BASE}/reports/generate-osint`, { method: 'POST' });
        if (rep.ok) {
          const repData = await rep.json();
          data.summary = (data.summary || '') + `\n\n✅ OSINT 일간 리포트 저장됨: ${repData.report_filename}`;
          setOsintResult({ ...data });
        }
      } catch { /* ignore — analysis still succeeded */ }
    } catch {
      setOsintResult({ summary: 'OSINT analysis failed. Check server connection.' });
    } finally {
      setAnalyzingOsint(false);
    }
  };

  // Sentinel Analysis — Full integration (OSINT+KDCA → final report)
  const handleRunFullAnalysis = async () => {
    setAnalyzingFull(true);
    setFullResult(null);
    try {
      const res = await fetch(`${API_BASE}/risk-analysis/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ include_kdca: true }),
      });
      const data = await res.json();
      setFullResult(data);
      if (data.snapshot_date) {
        await fetchAlerts(data.snapshot_date);
        await refreshIngestionStatus(data.snapshot_date);

        // Save FINAL weekly integrated report
        try {
          const rep = await fetch(`${API_BASE}/reports/generate-final?snapshot_date=${data.snapshot_date}`, { method: 'POST' });
          if (rep.ok) {
            const repData = await rep.json();
            data.summary = (data.summary || '') + `\n\n✅ FINAL 통합 리포트 저장됨: ${repData.report_filename}`;
            setFullResult({ ...data });
          }
        } catch {
          data.summary = (data.summary || '') + '\n\n⚠️ 통합 리포트 저장 실패.';
          setFullResult({ ...data });
        }
      }
    } catch {
      setFullResult({ summary: 'Analysis failed. Check server connection.' });
    } finally {
      setAnalyzingFull(false);
    }
  };

  // KDCA weekly AI report generation (uses /reports/generate-kdca)
  const handleGenerateKdcaReport = async () => {
    setGeneratingKdcaReport(true);
    setKdcaReportResult(null);
    try {
      const res = await fetch(`${API_BASE}/reports/generate-kdca?snapshot_date=${currentDate}`, { method: 'POST' });
      const data = await res.json();
      setKdcaReportResult({
        summary: `KDCA 주간 리포트 저장됨 (${data.report_filename || data.epiweek || '완료'}).`,
        filename: data.report_filename,
      });
    } catch {
      setKdcaReportResult({ summary: 'Weekly report generation failed. Check server connection.' });
    } finally {
      setGeneratingKdcaReport(false);
    }
  };

  // Trigger NewsPanel's internal Keywords Settings modal from the console aside
  const openKeywordsModal = () => {
    const btn = document.getElementById('news-panel-keywords-btn');
    if (btn) (btn as HTMLButtonElement).click();
  };

  const elevatedCount = koreaAlerts.filter((alert) => alert.score >= 0.55).length;
  const criticalCount = koreaAlerts.filter((alert) => alert.score >= 0.75).length;

  if (loading) {
    return (
      <div className="loading-overlay">
        <div className="loading-spinner" />
      </div>
    );
  }

  return (
    <div className="kas-app">
      <TopNav
        activeTab={navTab}
        onTabChange={setNavTab}
        userEmail={user?.email}
        onSignOut={signOut}
        theme={theme}
        onToggleTheme={toggleTheme}
        snapshotDate={meta?.snapshot_date || currentDate}
        availableDates={availableDates}
        onDateChange={setCurrentDate}
      />

      {/* === MAP TAB (default) === */}
      {navTab === 'map' && (
        <main className="kas-map-view">
          <div className="kas-map-container">
            <KoreaMap
              koreaAlerts={koreaAlerts}
              onRegionClick={handleKoreaClick}
              activeLayers={activeLayers}
              aggregationMode={aggregationMode}
            />
          </div>

          {/* Floating left region panel (Kaspersky-style) */}
          {selectedKorea && (
            <aside className="kas-region-panel">
              <div className="kas-region-panel-header">
                <div className="kas-region-panel-title">
                  <span className="kas-region-panel-indicator" />
                  {selectedKorea.region_name_kr.toUpperCase()}
                </div>
                <button className="kas-region-panel-close" onClick={handleClosePanel}>×</button>
              </div>
              <div className="kas-region-panel-subtitle">
                {(() => {
                  const rank = [...koreaAlerts].sort((a, b) => b.score - a.score).findIndex(a => a.region_code === selectedKorea.region_code) + 1;
                  return `# ${rank} 위험도 순위 지역`;
                })()}
              </div>
              <div className="kas-region-panel-stats">
                {Object.entries(selectedKorea.signals || {}).map(([key, value]) => {
                  const label = key === 'notifiable_disease' ? '법정감염'
                    : key === 'influenza_like' ? 'ILI/SARI'
                    : key === 'wastewater_pathogen' ? '폐수'
                    : key === 'clinical_cxr_aware' ? 'CXR'
                    : key === 'news_trends_ai' ? 'OSINT'
                    : key;
                  const colorClass = key === 'notifiable_disease' ? 'kas-stat-oas'
                    : key === 'influenza_like' ? 'kas-stat-ods'
                    : key === 'wastewater_pathogen' ? 'kas-stat-wav'
                    : key === 'clinical_cxr_aware' ? 'kas-stat-mav'
                    : key === 'news_trends_ai' ? 'kas-stat-ids'
                    : 'kas-stat-default';
                  return (
                    <div key={key} className="kas-region-panel-stat">
                      <span className={`kas-stat-label ${colorClass}`}>{label}</span>
                      <span className="kas-stat-value">{value == null ? '—' : (Number(value) * 1000).toFixed(0)}</span>
                    </div>
                  );
                })}
              </div>
              <div className="kas-region-panel-score">
                <div className="kas-region-score-label">종합 위험 점수</div>
                <div className={`kas-region-score-value kas-level-${selectedKorea.level}`}>
                  {selectedKorea.score.toFixed(2)}
                </div>
                <div className="kas-region-score-level">{selectedKorea.level.toUpperCase()}</div>
              </div>
              <div className="kas-region-panel-meta">
                {selectedKorea.epiweek} · 시그널 {selectedKorea.active_sources}/{Object.keys(selectedKorea.signals || {}).length}
              </div>
              <div className="kas-region-panel-timeline">
                <RegionDetailInline
                  alert={selectedKorea}
                  allAlerts={koreaAlerts}
                  variant="floating"
                />
              </div>
            </aside>
          )}

          {/* Right-side vertical stack: toolbar + legend */}
          <div className="kas-right-stack">
            <div className="kas-right-toolbar">
              <button
                className={`kas-toolbar-btn ${isGlobeExpanded ? 'kas-toolbar-btn--active' : ''}`}
                onClick={() => setIsGlobeExpanded(v => !v)}
                title="글로벌 지구본"
                type="button"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3 12h18" />
                  <path d="M12 3a14.5 14.5 0 0 1 0 18a14.5 14.5 0 0 1 0-18z" />
                </svg>
              </button>
              <button
                className={`kas-toolbar-btn ${showLayerPanel ? 'kas-toolbar-btn--active' : ''}`}
                onClick={() => setShowLayerPanel(v => !v)}
                title="레이어"
                type="button"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3l9 5-9 5-9-5 9-5z" />
                  <path d="M3 13l9 5 9-5" />
                  <path d="M3 18l9 5 9-5" />
                </svg>
              </button>
              <button
                className="kas-toolbar-btn"
                onClick={() => {
                  const btn = document.getElementById('chatbot-toggle-btn');
                  if (btn) btn.click();
                }}
                title="AI Chat"
                type="button"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                </svg>
              </button>
              <button
                className="kas-toolbar-btn"
                onClick={() => handleRunFullAnalysis()}
                title="Sentinel 분석"
                disabled={analyzingFull}
                type="button"
              >
                {analyzingFull ? (
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="kas-toolbar-spin">
                    <path d="M21 12a9 9 0 1 1-6.2-8.55" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 2L4.09 12.97a.7.7 0 0 0 .56 1.13H11l-1 8 8.91-10.97A.7.7 0 0 0 18.35 10H13l1-8z" />
                  </svg>
                )}
              </button>
            </div>

            {/* Right-side legend (vertical) */}
            <div className="kas-side-legend">
              <div className="kas-side-legend-title">
                <Timeline dates={availableDates.length ? availableDates : [currentDate]} currentDate={currentDate} onChange={setCurrentDate} />
              </div>
              <div className="kas-side-legend-items">
                <div className="kas-legend-item"><span className="kas-legend-dot kas-level-critical" />G3 위험 <span className="kas-legend-count">{criticalCount}</span></div>
                <div className="kas-legend-item"><span className="kas-legend-dot kas-level-high" />G2 경계 <span className="kas-legend-count">{elevatedCount - criticalCount}</span></div>
                <div className="kas-legend-item"><span className="kas-legend-dot kas-level-moderate" />G1 주의 <span className="kas-legend-count">{koreaAlerts.filter(a => a.level === 'G1').length}</span></div>
                <div className="kas-legend-item"><span className="kas-legend-dot kas-level-low" />G0 안정 <span className="kas-legend-count">{koreaAlerts.filter(a => a.level === 'G0').length}</span></div>
              </div>
            </div>
          </div>

          {/* Layer selector panel (toggle-able) */}
          {showLayerPanel && (
            <div className="kas-layer-panel">
              <div className="kas-layer-panel-title">레이어 선택</div>
              <label className={`kas-layer-item ${activeLayers.includes('respiratory') ? 'active' : ''}`}>
                <input type="checkbox" checked={activeLayers.includes('respiratory')} onChange={() => toggleLayer('respiratory')} />
                <span>종합 호흡기</span>
              </label>
              <label className={`kas-layer-item ${activeLayers.includes('wastewater_covid') ? 'active' : ''}`}>
                <input type="checkbox" checked={activeLayers.includes('wastewater_covid')} onChange={() => toggleLayer('wastewater_covid')} />
                <span>폐수 (COVID)</span>
              </label>
              <label className={`kas-layer-item ${activeLayers.includes('wastewater_flu') ? 'active' : ''}`}>
                <input type="checkbox" checked={activeLayers.includes('wastewater_flu')} onChange={() => toggleLayer('wastewater_flu')} />
                <span>폐수 (독감)</span>
              </label>
              <label className={`kas-layer-item ${activeLayers.includes('news_trends_risk') ? 'active' : ''}`}>
                <input type="checkbox" checked={activeLayers.includes('news_trends_risk')} onChange={() => toggleLayer('news_trends_risk')} />
                <span>OSINT 위험도</span>
              </label>
              <label className={`kas-layer-item ${activeLayers.includes('total_risk') ? 'active' : ''}`}>
                <input type="checkbox" checked={activeLayers.includes('total_risk')} onChange={() => toggleLayer('total_risk')} />
                <span>총 위험도</span>
              </label>
              {activeLayers.length > 1 && (
                <div className="kas-aggregation">
                  <span className="kas-aggregation-label">집계:</span>
                  <button className={`kas-agg-btn ${aggregationMode === 'max' ? 'kas-agg-btn--active' : ''}`} onClick={() => setAggregationMode('max')}>MAX</button>
                  <button className={`kas-agg-btn ${aggregationMode === 'weighted' ? 'kas-agg-btn--active' : ''}`} onClick={() => setAggregationMode('weighted')}>Weighted</button>
                </div>
              )}
            </div>
          )}

          {/* Expanded globe overlay */}
          {isGlobeExpanded && (
            <div className="expanded-globe-overlay">
              <div className="expanded-globe-header">
                <div>
                  <h3>글로벌 컨텍스트 레이어</h3>
                  <p>외부 유입 위험 감시 · 지역 벤치마킹 · 국제 신호 보완</p>
                </div>
                <button className="panel-close" onClick={() => setIsGlobeExpanded(false)}>×</button>
              </div>
              <div className="expanded-globe-container">
                <MiniGlobe isExpanded={true} signals={globalSignals} koreaAlerts={koreaAlerts} activeLayers={activeLayers} aggregationMode={aggregationMode} />
              </div>
            </div>
          )}

          <RegionPanel selectedKorea={null} selectedGlobal={selectedGlobal} onClose={handleClosePanel} />
          <GeminiChatbot snapshotDate={currentDate} inSidebar={false} />
        </main>
      )}

      {/* === STATISTICS TAB === */}
      {navTab === 'statistics' && (
        <main className="kas-tab-view">
          <StatisticsView
            koreaAlerts={koreaAlerts}
            onScoringApply={handleScoringApply}
          />
        </main>
      )}

      {/* === DATA SOURCES TAB === */}
      {navTab === 'data_sources' && (
        <main className="kas-tab-view">
          <div className="kas-sources-layout">
            {/* LEFT — analysis result displays */}
            <div className="kas-sources-main">
              <section className="kas-sources-card">
                <h3>뉴스 파이프라인</h3>
                <NewsPanel hideKeywordsButton />
              </section>
              <section className="kas-sources-card">
                <h3>트렌드 파이프라인</h3>
                <TrendsChart />
              </section>
              <section className="kas-sources-card">
                <h3>KDCA AI Analysis</h3>
                <KdcaUploadPanel view="summary" />
              </section>
            </div>

            {/* RIGHT — console: grouped SETTINGS + AI ANALYZE */}
            <aside className="kas-sources-aside">
              {/* ── SETTINGS (data source configuration) ── */}
              <section className="kas-sources-card kas-console-group">
                <h3 className="kas-console-group-title">SETTINGS</h3>
                <p className="console-card-desc">Configure data sources and ingest new KDCA datasets.</p>

                <div className="kas-console-subcard">
                  <div className="kas-console-subcard-title">Keywords Editor</div>
                  <p className="console-card-desc">Edit collection keywords for Naver / NewsAPI / Google Trends / Naver Trends.</p>
                  <button className="console-action-btn console-neutral-btn" onClick={openKeywordsModal}>
                    <span className="console-btn-title">Open Keywords Editor</span>
                    <span className="console-btn-sub">Per-source query lists</span>
                  </button>
                </div>

                <div className="kas-console-subcard">
                  <div className="kas-console-subcard-title">KDCA Data Upload</div>
                  <p className="console-card-desc">Upload raw KDCA data · Manage report recipients.</p>
                  <KdcaUploadPanel view="console" />
                </div>
              </section>

              {/* ── AI ANALYZE (trigger pipelines) ── */}
              <section className="kas-sources-card kas-console-group">
                <h3 className="kas-console-group-title">AI ANALYZE</h3>
                <p className="console-card-desc">Run risk analysis pipelines — results populate the map & panels on the left.</p>

                <button className="osint-analysis-btn console-action-btn" onClick={handleRunOsintAnalysis} disabled={analyzingOsint}>
                  <span className="console-btn-title">{analyzingOsint ? 'Running OSINT...' : 'OSINT ANALYZE'}</span>
                  <span className="console-btn-sub">Open Source Intelligence · News + Trends</span>
                </button>
                <button className="kdca-report-btn console-action-btn" onClick={handleGenerateKdcaReport} disabled={generatingKdcaReport}>
                  <span className="console-btn-title">{generatingKdcaReport ? 'Analyzing KDCA...' : 'KDCA DATA ANALYZE'}</span>
                  <span className="console-btn-sub">KDCA surveillance · Weekly AI report</span>
                </button>
                <button className="sentinel-analysis-btn console-action-btn" onClick={handleRunFullAnalysis} disabled={analyzingFull}>
                  <span className="console-btn-title">{analyzingFull ? 'Running Final...' : 'FINAL ANALYZE'}</span>
                  <span className="console-btn-sub">Integrated · OSINT + KDCA (Sentinel)</span>
                </button>

                {osintResult?.summary && (
                  <div className="osint-analysis-result">
                    <div className="osint-result-header">OSINT REPORT</div>
                    <p className="osint-result-text">{osintResult.summary}</p>
                  </div>
                )}
                {kdcaReportResult?.summary && (
                  <div className="osint-analysis-result">
                    <div className="osint-result-header">KDCA WEEKLY REPORT</div>
                    <p className="osint-result-text">{kdcaReportResult.summary}</p>
                  </div>
                )}
                {fullResult?.summary && (
                  <div className="sentinel-analysis-result">
                    <div className="sentinel-result-header">FINAL REPORT</div>
                    <p className="sentinel-result-text">{fullResult.summary}</p>
                  </div>
                )}
              </section>
            </aside>
          </div>
        </main>
      )}

      {/* === PATHWAY TAB === */}
      {navTab === 'pathway' && (
        <main className="kas-tab-view kas-tab-view--pathway">
          <FlowDiagram
            onClose={() => setNavTab('map')}
            onDataRefreshed={() => fetchAlerts()}
            embedded
          />
        </main>
      )}

      {/* === REPORT TAB === */}
      {navTab === 'report' && (
        <main className="kas-tab-view">
          <ReportView />
        </main>
      )}

      {/* Legacy overlay (kept for backward compat) */}
      {showFlowDiagram && (
        <FlowDiagram
          onClose={() => setShowFlowDiagram(false)}
          onDataRefreshed={() => fetchAlerts()}
        />
      )}
    </div>
  );
}
