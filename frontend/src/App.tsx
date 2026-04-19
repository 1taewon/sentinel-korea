import { useCallback, useEffect, useRef, useState } from 'react';
import FlowDiagram from './components/FlowDiagram';
import GeminiChatbot from './components/GeminiChatbot';
import KdcaUploadPanel from './components/KdcaUploadPanel';
import KoreaMap from './components/KoreaMap';
import MiniGlobe from './components/MiniGlobe';
import NewsPanel from './components/NewsPanel';
import RegionPanel from './components/RegionPanel';
import ScoringPanel from './components/ScoringPanel';
import Timeline from './components/Timeline';
import TrendsChart from './components/TrendsChart';
import type { CombinedData, GlobalSignal, IngestionStatus, KoreaAlert, ScoringConfig } from './types';
import './index.css';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

type SidebarTab = 'settings' | 'news_trends' | 'data_upload';
type Layer = 'respiratory' | 'wastewater_covid' | 'wastewater_flu' | 'news_trends_risk' | 'total_risk';
type AggregationMode = 'max' | 'weighted';

export default function App() {
  const [koreaAlerts, setKoreaAlerts] = useState<KoreaAlert[]>([]);
  const [globalSignals, setGlobalSignals] = useState<GlobalSignal[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => window.innerWidth > 900);
  const [selectedKorea, setSelectedKorea] = useState<KoreaAlert | null>(null);
  const [selectedGlobal, setSelectedGlobal] = useState<GlobalSignal | null>(null);
  const [isGlobeExpanded, setIsGlobeExpanded] = useState(false);
  const [showFlowDiagram, setShowFlowDiagram] = useState(false);
  const [activeLayers, setActiveLayers] = useState<Layer[]>(['respiratory']);
  const [aggregationMode, setAggregationMode] = useState<AggregationMode>('max');

  // Resizable sidebar
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('sentinel-sidebar-width');
    return saved ? parseInt(saved, 10) : 370;
  });
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(370);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = e.clientX - dragStartX.current;
      const newWidth = Math.max(320, Math.min(700, dragStartWidth.current + delta));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem('sentinel-sidebar-width', String(sidebarWidth));
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
  }, [sidebarWidth]);

  const handleDragStart = (e: React.MouseEvent) => {
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = sidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

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
  const [ingestionStatus, setIngestionStatus] = useState<IngestionStatus | null>(null);
  const [meta, setMeta] = useState<CombinedData['meta']>();

  // Sidebar tab state (3 tabs)
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('settings');

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

  // OSINT analysis (News+Trends → map update)
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
        
        // Auto-generate weekly report
        try {
          await fetch(`${API_BASE}/reports/generate?snapshot_date=${data.snapshot_date}`, { method: 'POST' });
          data.summary = data.summary + '\n\n✅ 주간 보고서가 성공적으로 자동 생성되었습니다. (Settings 탭 또는 서버 내 확인 가능)';
        } catch (e) {
          data.summary = data.summary + '\n\n⚠️ 위험도 분석은 완료되었으나, 주간 보고서 생성에 실패했습니다.';
        }
      }
    } catch {
      setFullResult({ summary: 'Analysis failed. Check server connection.' });
    } finally {
      setAnalyzingFull(false);
    }
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
    <div className="app-layout">
      <aside className={`sidebar-left ${isSidebarOpen ? '' : 'closed'}`} style={isSidebarOpen ? { width: sidebarWidth } : undefined}>
        <header className="app-header panelized-header">
          <div className="header-left">
            <div className="header-title">Sentinel</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <button
              className="flow-pipeline-btn"
              onClick={() => setShowFlowDiagram(true)}
              title="Open Pipeline Control"
            >
              &#9881;
            </button>
            <button
              className="theme-toggle-btn"
              onClick={toggleTheme}
              title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              id="theme-toggle-btn"
            >
              {theme === 'light' ? '◐' : '◑'}
            </button>
            <div className="header-status-block">
              <span>{meta?.snapshot_date || currentDate}</span>
            </div>
          </div>
        </header>

        {/* 3-Tab Navigation */}
        <div className="sidebar-tabs">
          <button
            className={`sidebar-tab${sidebarTab === 'settings' ? ' sidebar-tab--active' : ''}`}
            onClick={() => setSidebarTab('settings')}
            id="sidebar-tab-settings"
          >
            Settings
          </button>
          <button
            className={`sidebar-tab${sidebarTab === 'news_trends' ? ' sidebar-tab--active' : ''}`}
            onClick={() => setSidebarTab('news_trends')}
            id="sidebar-tab-news-trends"
            title="Open-Source Intelligence using News and Keyword Trends"
          >
            OSINT
          </button>
          <button
            className={`sidebar-tab${sidebarTab === 'data_upload' ? ' sidebar-tab--active' : ''}`}
            onClick={() => setSidebarTab('data_upload')}
            id="sidebar-tab-data-upload"
          >
            Data Upload
          </button>
        </div>

        {/* Tab Content */}
        <div className="sidebar-tab-content">
          {sidebarTab === 'settings' && (
            <ScoringPanel onApply={handleScoringApply} />
          )}

          {sidebarTab === 'news_trends' && (
            <div>
              <NewsPanel />
              <div className="sidebar-trends-wrapper">
                <TrendsChart />
              </div>
              {/* OSINT Analysis — News+Trends → Map */}
              <div className="risk-analysis-section" id="osint-analysis-section">
                <button
                  className="osint-analysis-btn"
                  onClick={handleRunOsintAnalysis}
                  disabled={analyzingOsint}
                  id="run-osint-analysis-btn"
                >
                  {analyzingOsint ? (
                    <>
                      <div className="news-spinner" style={{ width: 14, height: 14 }} />
                      Analyzing OSINT...
                    </>
                  ) : (
                    <>OSINT Analysis (NEWS + TRENDS)</>
                  )}
                </button>
                <div className="osint-analysis-desc">
                  Combine news and trends data to generate regional risk scores on the map
                </div>
                {osintResult && osintResult.summary && (
                  <div className="osint-analysis-result">
                    <div className="osint-result-header">OSINT Report</div>
                    <p className="osint-result-text">{osintResult.summary}</p>
                    {osintResult.key_signals && osintResult.key_signals.length > 0 && (
                      <ul className="risk-signals-list">
                        {osintResult.key_signals.map((sig, i) => (
                          <li key={i}>{sig}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {sidebarTab === 'data_upload' && (
            <div className="sidebar-kdca-wrapper">
              <p className="sidebar-tab-description">
                Upload KDCA data to update signal sources (notifiable disease, ILI/SARI, wastewater pathogen).
              </p>
              <KdcaUploadPanel />
            </div>
          )}
        </div>

        <div className="sidebar-footer">
          <div className="layer-controller sidebar-layer-controller">
            <div className="layer-controller-title">Primary views</div>
            <label className={`layer-item ${activeLayers.includes('respiratory') ? 'active' : ''}`}>
              <input type="checkbox" checked={activeLayers.includes('respiratory')} onChange={() => toggleLayer('respiratory')} />
              <span className="layer-label">Composite respiratory</span>
            </label>
            <label className={`layer-item ${activeLayers.includes('wastewater_covid') ? 'active' : ''}`}>
              <input type="checkbox" checked={activeLayers.includes('wastewater_covid')} onChange={() => toggleLayer('wastewater_covid')} />
              <span className="layer-label">Wastewater (COVID)</span>
            </label>
            <label className={`layer-item ${activeLayers.includes('wastewater_flu') ? 'active' : ''}`}>
              <input type="checkbox" checked={activeLayers.includes('wastewater_flu')} onChange={() => toggleLayer('wastewater_flu')} />
              <span className="layer-label">Wastewater (Influenza)</span>
            </label>
            <label className={`layer-item ${activeLayers.includes('news_trends_risk') ? 'active' : ''}`}>
              <input type="checkbox" checked={activeLayers.includes('news_trends_risk')} onChange={() => toggleLayer('news_trends_risk')} />
              <span className="layer-label">OSINT risk</span>
            </label>
            <label className={`layer-item ${activeLayers.includes('total_risk') ? 'active' : ''}`}>
              <input type="checkbox" checked={activeLayers.includes('total_risk')} onChange={() => toggleLayer('total_risk')} />
              <span className="layer-label">Total risk stratification</span>
            </label>
            {activeLayers.length > 1 && (
              <div className="aggregation-toggle">
                <span className="aggregation-label">Aggregation:</span>
                <button
                  className={`aggregation-btn ${aggregationMode === 'max' ? 'aggregation-btn--active' : ''}`}
                  onClick={() => setAggregationMode('max')}
                >MAX</button>
                <button
                  className={`aggregation-btn ${aggregationMode === 'weighted' ? 'aggregation-btn--active' : ''}`}
                  onClick={() => setAggregationMode('weighted')}
                >Weighted</button>
              </div>
            )}
          </div>
          
          {/* Sentinel Analysis — comprehensive final analysis */}
          <div className="sentinel-analysis-section" id="sentinel-analysis-section">
            <button
              className="sentinel-analysis-btn"
              onClick={handleRunFullAnalysis}
              disabled={analyzingFull}
              id="run-sentinel-analysis-btn"
            >
              {analyzingFull ? (
                <>
                  <span className="sentinel-analysis-icon">
                    <div className="news-spinner" style={{ width: 14, height: 14 }} />
                  </span>
                  Analyzing...
                </>
              ) : (
                <>
                  <span className="sentinel-analysis-icon">&#9878;</span>
                  Sentinel Analysis
                </>
              )}
            </button>
            <div className="sentinel-analysis-desc">
              OSINT (NEWS+TRENDS) + KDCA data integrated final risk stratification
            </div>
            {fullResult && fullResult.summary && (
              <div className="sentinel-analysis-result">
                <div className="sentinel-result-header">Final Report</div>
                <p className="sentinel-result-text">{fullResult.summary}</p>
                {fullResult.key_signals && fullResult.key_signals.length > 0 && (
                  <ul className="risk-signals-list">
                    {fullResult.key_signals.map((sig, i) => (
                      <li key={i}>{sig}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <GeminiChatbot snapshotDate={currentDate} inSidebar={true} />
        </div>
      </aside>

      {/* Sidebar resize drag handle */}
      {isSidebarOpen && (
        <div className="sidebar-resize-handle" style={{ left: sidebarWidth - 2 }} onMouseDown={handleDragStart} />
      )}

      <button
        className={`sidebar-toggle-btn ${isSidebarOpen ? '' : 'closed'}`}
        onClick={() => setIsSidebarOpen((prev) => !prev)}
        title={isSidebarOpen ? 'Close panel' : 'Open panel'}
        style={isSidebarOpen ? { left: sidebarWidth + 6 } : undefined}
      >
        {isSidebarOpen ? '<' : '>'}
      </button>

      <main className="main-content" style={isSidebarOpen ? { marginLeft: sidebarWidth } : undefined}>
        <div className="page-banner" style={{ justifyContent: 'flex-end', background: 'transparent', border: 'none', boxShadow: 'none', backdropFilter: 'none' }}>
          <div className="banner-metrics" style={{ background: 'var(--bg-overlay)', padding: '10px 16px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}>
            <div>
              <strong>{koreaAlerts.length}</strong>
              <span>regions</span>
            </div>
            <div>
              <strong>{elevatedCount}</strong>
              <span>elevated</span>
            </div>
            <div>
              <strong>{criticalCount}</strong>
              <span>critical</span>
            </div>
          </div>
        </div>

        <KoreaMap koreaAlerts={koreaAlerts} onRegionClick={handleKoreaClick} activeLayers={activeLayers} aggregationMode={aggregationMode} />

        {!isGlobeExpanded && (
          <div className="mini-globe-wrapper" onClick={() => setIsGlobeExpanded(true)}>
            <div className="mini-globe-hint">Global context</div>
            <MiniGlobe signals={globalSignals} koreaAlerts={koreaAlerts} activeLayers={activeLayers} aggregationMode={aggregationMode} />
          </div>
        )}

        {isGlobeExpanded && (
          <div className="expanded-globe-overlay">
            <div className="expanded-globe-header">
              <div>
                <h3>Global context layer</h3>
                <p>Imported-risk watch, regional benchmarking, and external corroboration.</p>
              </div>
              <button className="panel-close" onClick={() => setIsGlobeExpanded(false)}>×</button>
            </div>
            <div className="expanded-globe-container">
              <MiniGlobe isExpanded={true} signals={globalSignals} koreaAlerts={koreaAlerts} activeLayers={activeLayers} aggregationMode={aggregationMode} />
            </div>
            <div className="expanded-globe-footer">
              <div className="global-legend">
                <span><span className="dot healthmap" />HealthMap</span>
                <span><span className="dot promed" />ProMED</span>
                <span><span className="dot gtrends" />Google Trends</span>
              </div>
            </div>
          </div>
        )}

        <div className="vertical-controls-panel">
          <Timeline dates={availableDates.length ? availableDates : [currentDate]} currentDate={currentDate} onChange={setCurrentDate} />

          <div className="bottom-bar">
            <div className="legend">
              <div className="legend-item"><span className="legend-dot g3" />G3 Critical</div>
              <div className="legend-item"><span className="legend-dot g2" />G2 Elevated</div>
              <div className="legend-item"><span className="legend-dot g1" />G1 Guarded</div>
              <div className="legend-item"><span className="legend-dot g0" />G0 Low</div>
            </div>
            <div className="stats">
              <span>snapshot <span className="stat-value">{meta?.snapshot_date || currentDate}</span></span>
              <span>global <span className="stat-value">{globalSignals.length}</span></span>
              <span>sources <span className="stat-value">{ingestionStatus?.sources.length || 0}</span></span>
            </div>
          </div>
        </div>

        <RegionPanel selectedKorea={selectedKorea} selectedGlobal={selectedGlobal} onClose={handleClosePanel} />
      </main>

      {/* Flow Diagram Overlay */}
      {showFlowDiagram && (
        <FlowDiagram
          onClose={() => setShowFlowDiagram(false)}
          onDataRefreshed={() => fetchAlerts()}
        />
      )}
    </div>
  );
}
