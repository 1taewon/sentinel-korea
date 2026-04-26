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
  const sourceOverviewCards = [
    {
      label: 'OFFICIAL',
      title: '질병청 감시자료',
      description: 'ILI/SARI, 법정감염병, 지역 단위 기준선을 만드는 핵심 소스입니다.',
      cadence: '주간 / epiweek',
      output: 'normalized_signal',
      metric: `${koreaAlerts.length || 17} 시도`,
      tone: 'green',
    },
    {
      label: 'DOCUMENT',
      title: '폐하수 PDF 공보',
      description: '현재는 문서-only 보조 신호입니다. 자동 표 추출과 검수 모드는 다음 단계로 둡니다.',
      cadence: '주간 PDF',
      output: 'corroboration lane',
      metric: 'deferred',
      tone: 'amber',
    },
    {
      label: 'OSINT',
      title: '국내 뉴스 + 검색 트렌드',
      description: '국내 호흡기 이상 징후를 빠르게 포착하되, 공식 감시자료를 대체하지 않습니다.',
      cadence: '수동/일간 refresh',
      output: 'evidence_digest',
      metric: 'AI digest',
      tone: 'blue',
    },
    {
      label: 'CONTEXT',
      title: '해외 유입 맥락',
      description: '인접국/해외 신호는 imported-risk watch와 외부 corroboration 용도로만 사용합니다.',
      cadence: '보조 맥락',
      output: 'context layer',
      metric: `${globalSignals.length} signals`,
      tone: 'slate',
    },
    {
      label: 'FUSION',
      title: 'Sentinel scoring',
      description: '소스 독립성, freshness, coverage를 반영해 지역별 경보와 confidence를 계산합니다.',
      cadence: meta?.snapshot_date || currentDate,
      output: 'alert_snapshot',
      metric: meta?.algorithm_version || 'latest',
      tone: 'red',
    },
  ];

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
              {/* Globe — wireframe meridian/parallel grid */}
              <button
                className={`kas-toolbar-btn ${isGlobeExpanded ? 'kas-toolbar-btn--active' : ''}`}
                onClick={() => setIsGlobeExpanded(v => !v)}
                title="Global view"
                type="button"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeLinecap="square">
                  <circle cx="12" cy="12" r="9" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="12" y1="3" x2="12" y2="21" />
                  <ellipse cx="12" cy="12" rx="4.5" ry="9" />
                  <ellipse cx="12" cy="12" rx="9" ry="4.5" />
                </svg>
              </button>
              {/* Layers — orthographic stacked planes */}
              <button
                className={`kas-toolbar-btn ${showLayerPanel ? 'kas-toolbar-btn--active' : ''}`}
                onClick={() => setShowLayerPanel(v => !v)}
                title="Layers"
                type="button"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeLinecap="square" strokeLinejoin="miter">
                  <rect x="4" y="4" width="12" height="12" />
                  <rect x="8" y="8" width="12" height="12" />
                </svg>
              </button>
              {/* Console / terminal prompt */}
              <button
                className="kas-toolbar-btn"
                onClick={() => {
                  const btn = document.getElementById('chatbot-toggle-btn');
                  if (btn) btn.click();
                }}
                title="Query console"
                type="button"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeLinecap="square" strokeLinejoin="miter">
                  <rect x="3" y="5" width="18" height="14" />
                  <polyline points="7,10 10,12 7,14" />
                  <line x1="12" y1="15" x2="17" y2="15" />
                </svg>
              </button>
              {/* Waveform — signal / analysis */}
              <button
                className="kas-toolbar-btn"
                onClick={() => handleRunFullAnalysis()}
                title="Run analysis"
                disabled={analyzingFull}
                type="button"
              >
                {analyzingFull ? (
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeLinecap="square" className="kas-toolbar-spin">
                    <path d="M21 12a9 9 0 1 1-6.2-8.55" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeLinecap="square" strokeLinejoin="miter">
                    <polyline points="2,12 5,12 7,6 10,18 13,9 15,15 17,12 22,12" />
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
                  <h3>Imported-risk context layer</h3>
                  <p>Overseas and neighbor-country signals are used only for corroboration, benchmarking, and watch context.</p>
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
          <section className="data-source-command-board">
            <div>
              <span className="data-source-kicker">데이터 소스 운영 현황</span>
              <h2>Korea-first respiratory intelligence inputs</h2>
              <p>
                질병청 직원이 볼 때 중요한 것은 데이터가 어디서 왔고, 어떤 역할이며,
                최종 경보의 어느 부분에 쓰이는가입니다. 아래 보드는 각 source lane의
                목적, 갱신 주기, 산출물을 먼저 보여줍니다.
              </p>
            </div>
            <div className="source-visibility-grid">
              {sourceOverviewCards.map((source) => (
                <article className={`source-visibility-card tone-${source.tone}`} key={source.label}>
                  <div className="source-card-topline">
                    <span>{source.label}</span>
                    <strong>{source.metric}</strong>
                  </div>
                  <h3>{source.title}</h3>
                  <p>{source.description}</p>
                  <div className="source-card-meta">
                    <span>{source.cadence}</span>
                    <span>{source.output}</span>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <div className="kas-sources-layout">
            {/* LEFT — analysis result displays */}
            <div className="kas-sources-main">
              <section className="kas-sources-card">
                <h3>뉴스/OSINT 파이프라인</h3>
                <NewsPanel hideKeywordsButton />
              </section>
              <section className="kas-sources-card">
                <h3>검색 트렌드 파이프라인</h3>
                <TrendsChart />
              </section>
              <section className="kas-sources-card">
                <h3>KDCA 감시자료 분석</h3>
                <KdcaUploadPanel view="summary" />
              </section>
            </div>

            {/* RIGHT — console: grouped SETTINGS + AI ANALYZE */}
            <aside className="kas-sources-aside">
              {/* ── SETTINGS (data source configuration) ── */}
              <section className="kas-sources-card kas-console-group">
                <h3 className="kas-console-group-title">설정 / SETTINGS</h3>
                <p className="console-card-desc">데이터 수집 키워드와 KDCA 원천자료 입력 흐름을 관리합니다.</p>

                <div className="kas-console-subcard">
                  <div className="kas-console-subcard-title">키워드 편집기</div>
                  <p className="console-card-desc">Naver / NewsAPI / Google Trends / Naver Trends 수집 키워드를 조정합니다.</p>
                  <button className="console-action-btn console-neutral-btn" onClick={openKeywordsModal}>
                    <span className="console-btn-title">키워드 설정 열기</span>
                    <span className="console-btn-sub">소스별 query list 관리</span>
                  </button>
                </div>

                <div className="kas-console-subcard">
                  <div className="kas-console-subcard-title">KDCA 데이터 입력</div>
                  <p className="console-card-desc">질병청 원천자료 업로드와 보고서 수신자 관리를 담당합니다.</p>
                  <KdcaUploadPanel view="console" />
                </div>
              </section>

              {/* ── AI ANALYZE (trigger pipelines) ── */}
              <section className="kas-sources-card kas-console-group">
                <h3 className="kas-console-group-title">분석 실행 / AI ANALYZE</h3>
                <p className="console-card-desc">각 분석 버튼은 map, report, pipeline control의 산출물을 갱신합니다.</p>

                <button className="osint-analysis-btn console-action-btn" onClick={handleRunOsintAnalysis} disabled={analyzingOsint}>
                  <span className="console-btn-title">{analyzingOsint ? 'OSINT 실행 중...' : 'OSINT 분석'}</span>
                  <span className="console-btn-sub">국내 뉴스 + 검색 트렌드 보조 신호 요약</span>
                </button>
                <button className="kdca-report-btn console-action-btn" onClick={handleGenerateKdcaReport} disabled={generatingKdcaReport}>
                  <span className="console-btn-title">{generatingKdcaReport ? 'KDCA 분석 중...' : 'KDCA 감시자료 분석'}</span>
                  <span className="console-btn-sub">공식 감시자료 기반 주간 AI report</span>
                </button>
                <button className="sentinel-analysis-btn console-action-btn" onClick={handleRunFullAnalysis} disabled={analyzingFull}>
                  <span className="console-btn-title">{analyzingFull ? 'Sentinel 실행 중...' : 'Sentinel 통합 분석'}</span>
                  <span className="console-btn-sub">KDCA + OSINT + trend를 결합해 alert snapshot 계산</span>
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
            snapshotDate={currentDate}
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
          snapshotDate={currentDate}
        />
      )}
    </div>
  );
}
