import { useCallback, useEffect, useMemo, useState } from 'react';
import FlowDiagram from './components/FlowDiagram';
import GeminiChatbot from './components/GeminiChatbot';
import KdcaNotifiablePanel from './components/KdcaNotifiablePanel';
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
import { relevanceLabel, scoreInternationalRelevance } from './lib/internationalRelevance';
import type { CombinedData, GlobalSignal, IngestionStatus, KoreaAlert, ScoringConfig } from './types';
import './index.css';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';
// Auth is only enforced when Supabase keys are configured
const AUTH_ENABLED = !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);

type Layer = 'respiratory' | 'wastewater_covid' | 'wastewater_flu' | 'news_trends_risk' | 'total_risk';
type AggregationMode = 'max' | 'weighted';
type OperationKey =
  | 'korea_news'
  | 'trends'
  | 'global'
  | 'kdca_upload'
  | 'kdca_api'
  | 'kdca_digest'
  | 'osint'
  | 'sentinel'
  | 'kdca_report';

type UploadHistoryItem = {
  filename: string;
  file_type: string;
  label?: string;
  uploaded_at?: string;
  updated_dates?: string[];
  snapshot_count?: number;
  records_parsed?: number;
  outputs?: string[];
};

type ReportListItem = {
  filename: string;
  type?: 'osint' | 'kdca' | 'final';
  epiweek?: string;
  snapshot_date?: string;
  generated_at?: string;
  size_bytes?: number;
};

type KdcaDigestStatus = {
  status?: string;
  generated_at?: string;
  sources_used?: string[];
  kdca_summary?: string;
  message?: string;
};

type OperationRow = {
  key: OperationKey;
  lane: string;
  title: string;
  detail: string;
  status: 'ready' | 'needs-run' | 'running' | 'error';
  updatedAt?: string;
  epiweek?: string;
  primaryAction: string;
};

const relevanceFactorLabels: Record<string, string> = {
  severity: '질병 심각도',
  diseaseRisk: '호흡기/신종 위험',
  trafficProxy: '한국 이동량 proxy',
  proximity: '거리/인접성',
  unexpectedness: '예상 밖 이벤트',
  sourceReliability: '소스 신뢰도',
};

const formatPercent = (value: number) => `${Math.round(value * 100)}%`;
const formatDistance = (value: number) => `${Math.round(value).toLocaleString()} km`;

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
  const [refreshingKdcaApi, setRefreshingKdcaApi] = useState(false);
  const [kdcaApiResult, setKdcaApiResult] = useState<{ summary?: string } | null>(null);
  const [showRunPanel, setShowRunPanel] = useState(false);
  const [runningPipeline, setRunningPipeline] = useState<OperationKey | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [uploadHistory, setUploadHistory] = useState<UploadHistoryItem[]>([]);
  const [reportList, setReportList] = useState<ReportListItem[]>([]);
  const [kdcaDigestStatus, setKdcaDigestStatus] = useState<KdcaDigestStatus | null>(null);
  const [lastPipelineRun, setLastPipelineRun] = useState<Record<OperationKey, string | undefined>>({
    korea_news: undefined,
    trends: undefined,
    global: undefined,
    kdca_upload: undefined,
    kdca_api: undefined,
    kdca_digest: undefined,
    osint: undefined,
    sentinel: undefined,
    kdca_report: undefined,
  });

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

  const refreshOperationStatus = useCallback(async () => {
    try {
      const [historyRes, reportsRes, kdcaDigestRes] = await Promise.all([
        fetch(`${API_BASE}/ingestion/upload-history`),
        fetch(`${API_BASE}/reports/list`),
        fetch(`${API_BASE}/risk-analysis/kdca-digest`),
      ]);
      if (historyRes.ok) setUploadHistory(await historyRes.json());
      if (reportsRes.ok) setReportList(await reportsRes.json());
      if (kdcaDigestRes.ok) setKdcaDigestStatus(await kdcaDigestRes.json());
    } catch {
      // The dashboard itself should remain usable even when one status lane is unavailable.
    }
  }, []);

  useEffect(() => {
    refreshOperationStatus();
  }, [refreshOperationStatus]);

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
      if (!res.ok) throw new Error(data?.detail || 'OSINT analysis failed');
      setOsintResult(data);
      if (data.snapshot_date) {
        await fetchAlerts(data.snapshot_date);
        await refreshIngestionStatus(data.snapshot_date);
      }
      // Save OSINT daily report
      try {
        const rep = await fetch(`${API_BASE}/reports/generate-osint`, { method: 'POST' });
        const repData = await rep.json();
        if (!rep.ok) throw new Error(repData?.detail || 'OSINT report generation failed');
        data.summary = (data.summary || '') + `\n\nOSINT daily report saved: ${repData.report_filename}`;
        setOsintResult({ ...data });
        await refreshOperationStatus();
      } catch (reportError) {
        data.summary = (data.summary || '') + `\n\nOSINT analysis completed, but report save failed: ${reportError instanceof Error ? reportError.message : 'unknown error'}`;
        setOsintResult({ ...data });
      }
    } catch (error) {
      setOsintResult({ summary: error instanceof Error ? error.message : 'OSINT analysis failed. Check server connection.' });
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
      if (!res.ok) throw new Error(data?.detail || 'Sentinel integrated analysis failed');
      setFullResult(data);
      const reportSnapshot = data.snapshot_date || currentDate;
      if (data.snapshot_date) {
        await fetchAlerts(data.snapshot_date);
        await refreshIngestionStatus(data.snapshot_date);
      }

      // Save FINAL weekly integrated report even if the AI response omitted snapshot_date.
      try {
        const rep = await fetch(`${API_BASE}/reports/generate-final?snapshot_date=${reportSnapshot}`, { method: 'POST' });
        const repData = await rep.json();
        if (!rep.ok) throw new Error(repData?.detail || 'Final report generation failed');
        data.summary = (data.summary || '') + `\n\nSentinel final report saved: ${repData.report_filename}`;
        setFullResult({ ...data, snapshot_date: data.snapshot_date || reportSnapshot });
        await refreshOperationStatus();
      } catch (reportError) {
        data.summary = (data.summary || '') + `\n\nSentinel analysis completed, but final report save failed: ${reportError instanceof Error ? reportError.message : 'unknown error'}`;
        setFullResult({ ...data });
      }
    } catch (error) {
      setFullResult({ summary: error instanceof Error ? error.message : 'Analysis failed. Check server connection.' });
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
      if (!res.ok) throw new Error(data?.detail || 'KDCA report generation failed');
      setKdcaReportResult({
        summary: `KDCA 주간 리포트 저장됨 (${data.report_filename || data.epiweek || '완료'}).`,
        filename: data.report_filename,
      });
      await refreshOperationStatus();
    } catch (error) {
      setKdcaReportResult({ summary: error instanceof Error ? error.message : 'Weekly report generation failed. Check server connection.' });
    } finally {
      setGeneratingKdcaReport(false);
    }
  };

  const markPipelineRun = (key: OperationKey) => {
    setLastPipelineRun((prev) => ({ ...prev, [key]: new Date().toISOString() }));
  };

  const runOperation = async (key: OperationKey) => {
    setRunningPipeline(key);
    setOperationError(null);
    try {
      if (key === 'korea_news') {
        const res = await fetch(`${API_BASE}/ingestion/refresh-korea`, { method: 'POST' });
        if (!res.ok) throw new Error('Korea news refresh failed');
      } else if (key === 'trends') {
        const res = await fetch(`${API_BASE}/ingestion/refresh-trends`, { method: 'POST' });
        const data = await res.json();
        const googleError = data?.results?.google?.error || data?.results?.google_korea?.error || data?.results?.google_global?.error;
        if (!res.ok || googleError || data?.status === 'error') {
          throw new Error(googleError || data?.detail || 'Google Trends refresh failed');
        }
      } else if (key === 'global') {
        const res = await fetch(`${API_BASE}/ingestion/refresh-global`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok || data?.status === 'error' || data?.status === 'empty') {
          throw new Error(data?.details || data?.detail || 'WHO DON / overseas news refresh failed');
        }
        await fetchAlerts();
      } else if (key === 'kdca_api') {
        await handleRefreshKdcaNotifiable();
      } else if (key === 'kdca_digest') {
        const res = await fetch(`${API_BASE}/risk-analysis/kdca-digest`, { method: 'POST' });
        if (!res.ok) throw new Error('KDCA digest failed');
        setKdcaDigestStatus(await res.json());
      } else if (key === 'osint') {
        await handleRunOsintAnalysis();
      } else if (key === 'sentinel') {
        await handleRunFullAnalysis();
      } else if (key === 'kdca_report') {
        await handleGenerateKdcaReport();
      } else if (key === 'kdca_upload') {
        setNavTab('data_sources');
      }
      markPipelineRun(key);
      await refreshIngestionStatus();
      await refreshOperationStatus();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Run failed');
    } finally {
      setRunningPipeline(null);
    }
  };

  const handleRefreshKdcaNotifiable = async () => {
    setRefreshingKdcaApi(true);
    setKdcaApiResult(null);
    try {
      const res = await fetch(`${API_BASE}/ingestion/refresh-kdca-notifiable`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || 'KDCA API refresh failed');
      const mismatchCount = data.validation?.mismatch_count ?? 0;
      setKdcaApiResult({
        summary: `KDCA PeriodRegion ${data.year} 갱신 완료: 전체 ${data.all_notifiable_record_count || 0} rows, 호흡기 관련 ${data.record_count} rows, 호흡기/공기전파 바이러스 ${data.respiratory_virus_record_count || 0} rows, latest ${data.latest_epiweek || data.latest_period || 'n/a'}, PeriodBasic 검산 mismatch ${mismatchCount}.`,
      });
    } catch {
      setKdcaApiResult({ summary: 'KDCA 법정감염병 API 갱신 실패. API key, 네트워크, 공공데이터포털 endpoint 상태를 확인하세요.' });
    } finally {
      setRefreshingKdcaApi(false);
    }
  };

  // Trigger NewsPanel's internal Keywords Settings modal from the console aside
  const openKeywordsModal = () => {
    const btn = document.getElementById('news-panel-keywords-btn');
    if (btn) (btn as HTMLButtonElement).click();
  };

  const elevatedCount = koreaAlerts.filter((alert) => alert.score >= 0.55).length;
  const criticalCount = koreaAlerts.filter((alert) => alert.score >= 0.75).length;
  const internationalSummary = useMemo(() => {
    const sourceLabels: Record<string, string> = {
      healthmap: 'HealthMap',
      promed: 'ProMED',
      google_trends: 'Google Trends',
      who_don: 'WHO DON',
      news_global: 'Global News',
      google_news: 'Google News',
    };
    const bySource = globalSignals.reduce<Record<string, number>>((acc, signal) => {
      const key = sourceLabels[signal.source] || signal.source;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const bySeverity = globalSignals.reduce<Record<string, number>>((acc, signal) => {
      acc[signal.severity] = (acc[signal.severity] || 0) + 1;
      return acc;
    }, {});
    const byRelevance = globalSignals.reduce<Record<string, number>>((acc, signal) => {
      const relevance = scoreInternationalRelevance(signal);
      acc[relevance.level] = (acc[relevance.level] || 0) + 1;
      return acc;
    }, {});
    const countries = globalSignals.reduce<Record<string, number>>((acc, signal) => {
      const key = signal.country || 'Unspecified';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const topCountries = Object.entries(countries)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const recentSignals = [...globalSignals]
      .sort((a, b) => {
        const scoreDelta = scoreInternationalRelevance(b).score - scoreInternationalRelevance(a).score;
        if (Math.abs(scoreDelta) > 0.01) return scoreDelta;
        return (b.date || '').localeCompare(a.date || '');
      })
      .slice(0, 6);
    const averageRelevance = globalSignals.length
      ? globalSignals.reduce((sum, signal) => sum + scoreInternationalRelevance(signal).score, 0) / globalSignals.length
      : 0;
    return { bySource, bySeverity, byRelevance, topCountries, recentSignals, averageRelevance };
  }, [globalSignals]);
  const latestUpload = useMemo(() => {
    return [...uploadHistory]
      .sort((a, b) => (b.uploaded_at || '').localeCompare(a.uploaded_at || ''))[0];
  }, [uploadHistory]);
  const latestReport = useMemo(() => {
    return [...reportList]
      .sort((a, b) => (b.generated_at || '').localeCompare(a.generated_at || ''))[0];
  }, [reportList]);
  const latestReportsByType = useMemo(() => {
    return reportList.reduce<Record<string, ReportListItem | undefined>>((acc, report) => {
      const type = report.type || 'kdca';
      if (!acc[type] || (report.generated_at || '').localeCompare(acc[type]?.generated_at || '') > 0) {
        acc[type] = report;
      }
      return acc;
    }, {});
  }, [reportList]);
  const formatRunTime = (value?: string) => {
    if (!value) return 'not run';
    const dateValue = new Date(value);
    if (Number.isNaN(dateValue.getTime())) return value;
    return dateValue.toLocaleString('ko-KR', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };
  const operationRows: OperationRow[] = [
    {
      key: 'korea_news',
      lane: 'SOURCE',
      title: '국내 뉴스 수집',
      detail: '네이버 뉴스와 국내 NewsAPI 결과를 새로 모아 OSINT 분석의 국내 사건/증상 탐색 근거로 씁니다.',
      status: runningPipeline === 'korea_news' ? 'running' : lastPipelineRun.korea_news ? 'ready' : 'needs-run',
      updatedAt: lastPipelineRun.korea_news,
      primaryAction: '수집',
    },
    {
      key: 'trends',
      lane: 'SOURCE',
      title: '검색 트렌드 수집',
      detail: 'Google Trends와 Naver DataLab 검색량을 갱신해 뉴스가 실제 관심도 변화와 맞물리는지 봅니다.',
      status: runningPipeline === 'trends' ? 'running' : lastPipelineRun.trends ? 'ready' : 'needs-run',
      updatedAt: lastPipelineRun.trends,
      primaryAction: '수집',
    },
    {
      key: 'global',
      lane: 'SOURCE',
      title: 'WHO/해외 뉴스 수집',
      detail: `WHO DON, NewsAPI, Google News RSS에서 해외 outbreak 보조 신호를 가져옵니다. 현재 ${globalSignals.length}건 로드됨.`,
      status: runningPipeline === 'global' ? 'running' : globalSignals.length ? 'ready' : 'needs-run',
      updatedAt: lastPipelineRun.global,
      primaryAction: '수집',
    },
    {
      key: 'kdca_upload',
      lane: 'KDCA',
      title: 'KDCA 파일 업로드/파싱',
      detail: latestUpload
        ? `${latestUpload.file_type} / ${latestUpload.records_parsed || 0} records / ${latestUpload.snapshot_count || 0} snapshots`
        : '질병청 주간 xlsx/pdf 원자료를 업로드하면 지역별 감시 신호로 정규화합니다.',
      status: runningPipeline === 'kdca_upload' ? 'running' : latestUpload ? 'ready' : 'needs-run',
      updatedAt: latestUpload?.uploaded_at,
      primaryAction: '업로드',
    },
    {
      key: 'kdca_api',
      lane: 'KDCA',
      title: 'KDCA 법정감염병 API',
      detail: kdcaApiResult?.summary || '공공데이터 PeriodRegion/PeriodBasic API를 갱신해 법정감염병 보조 신호를 확인합니다.',
      status: runningPipeline === 'kdca_api' || refreshingKdcaApi ? 'running' : lastPipelineRun.kdca_api ? 'ready' : 'needs-run',
      updatedAt: lastPipelineRun.kdca_api,
      primaryAction: 'API 실행',
    },
    {
      key: 'kdca_digest',
      lane: 'AI',
      title: 'KDCA 감시자료 요약',
      detail: kdcaDigestStatus?.status === 'ok'
        ? `${kdcaDigestStatus.sources_used?.length || 0} source files summarized.`
        : '업로드된 질병청 원자료를 AI가 요약해 Sentinel 통합 분석의 공식 감시 맥락으로 넘깁니다.',
      status: runningPipeline === 'kdca_digest' ? 'running' : kdcaDigestStatus?.status === 'ok' ? 'ready' : 'needs-run',
      updatedAt: kdcaDigestStatus?.generated_at,
      primaryAction: '요약',
    },
    {
      key: 'osint',
      lane: 'AI',
      title: 'OSINT 지도 분석',
      detail: osintResult?.snapshot_date
        ? `snapshot ${osintResult.snapshot_date}`
        : latestReportsByType.osint?.filename || `국내 뉴스/검색 트렌드 기반 OSINT 위험이 있는 지역 ${koreaAlerts.filter((alert) => alert.news_trends_risk).length}개.`,
      status: runningPipeline === 'osint' || analyzingOsint ? 'running' : latestReportsByType.osint || koreaAlerts.some((alert) => alert.news_trends_risk) || osintResult ? 'ready' : 'needs-run',
      updatedAt: latestReportsByType.osint?.generated_at || lastPipelineRun.osint,
      epiweek: osintResult?.snapshot_date || currentDate,
      primaryAction: '분석',
    },
    {
      key: 'sentinel',
      lane: 'AI',
      title: 'Sentinel 통합 분석',
      detail: fullResult?.snapshot_date
        ? `final snapshot ${fullResult.snapshot_date}`
        : latestReportsByType.final?.filename || `KDCA, OSINT, 해외 보조 신호를 결합한 통합 위험 지역 ${koreaAlerts.filter((alert) => alert.total_risk).length}개.`,
      status: runningPipeline === 'sentinel' || analyzingFull ? 'running' : latestReportsByType.final || koreaAlerts.some((alert) => alert.total_risk) || fullResult ? 'ready' : 'needs-run',
      updatedAt: latestReportsByType.final?.generated_at || lastPipelineRun.sentinel,
      epiweek: fullResult?.snapshot_date || currentDate,
      primaryAction: '분석',
    },
    {
      key: 'kdca_report',
      lane: 'REPORT',
      title: 'KDCA 주간 리포트',
      detail: latestReportsByType.kdca?.filename || kdcaReportResult?.filename || '아직 생성된 KDCA 주간 리포트가 없습니다.',
      status: runningPipeline === 'kdca_report' || generatingKdcaReport ? 'running' : latestReportsByType.kdca || kdcaReportResult ? 'ready' : 'needs-run',
      updatedAt: latestReportsByType.kdca?.generated_at || lastPipelineRun.kdca_report,
      epiweek: latestReportsByType.kdca?.epiweek || currentDate,
      primaryAction: '생성',
    },
  ];
  const pipelineEdges: Array<[OperationKey, OperationKey]> = [
    ['korea_news', 'osint'],
    ['trends', 'osint'],
    ['global', 'osint'],
    ['kdca_upload', 'kdca_digest'],
    ['kdca_api', 'kdca_digest'],
    ['kdca_digest', 'sentinel'],
    ['osint', 'sentinel'],
    ['sentinel', 'kdca_report'],
  ];
  const operationIndex = new Map(operationRows.map((row, index) => [row.key, index]));
  const pipelineNodePositions = operationRows.map((row, index) => {
    const x = 28 + (index % 3) * 32;
    const y = 24 + Math.floor(index / 3) * 28;
    return { key: row.key, x, y, row };
  });
  const pipelineNodeMap = new Map(pipelineNodePositions.map((node) => [node.key, node]));
  const operationReadyCount = operationRows.filter((row) => row.status === 'ready').length;
  const mapToolGuides = [
    {
      title: 'WHO/국제 뉴스 보조레이어',
      text: '해외 outbreak, WHO DON, Google News/NewsAPI 신호를 globe에서 확인합니다.',
      action: () => setIsGlobeExpanded(true),
      active: isGlobeExpanded,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="square">
          <circle cx="12" cy="12" r="9" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <ellipse cx="12" cy="12" rx="4.5" ry="9" />
        </svg>
      ),
    },
    {
      title: '레이어 선택',
      text: 'KDCA, OSINT, 폐하수, 통합 위험도를 켜고 끄며 지도 색의 근거를 비교합니다.',
      action: () => setShowLayerPanel(true),
      active: showLayerPanel,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="square" strokeLinejoin="miter">
          <rect x="4" y="4" width="12" height="12" />
          <rect x="8" y="8" width="12" height="12" />
        </svg>
      ),
    },
    {
      title: 'Query console',
      text: '현재 snapshot과 원천자료를 기준으로 질문하고, 지역/신호 해석을 빠르게 확인합니다.',
      action: () => {
        const btn = document.getElementById('chatbot-toggle-btn');
        if (btn) (btn as HTMLButtonElement).click();
      },
      active: false,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="square" strokeLinejoin="miter">
          <rect x="3" y="5" width="18" height="14" />
          <polyline points="7,10 10,12 7,14" />
          <line x1="12" y1="15" x2="17" y2="15" />
        </svg>
      ),
    },
    {
      title: 'Run analyze center',
      text: '데이터 수집, AI 분석, 리포트 생성을 한 곳에서 실행하고 연결 상태를 봅니다.',
      action: () => setShowRunPanel(true),
      active: showRunPanel,
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="square" strokeLinejoin="miter">
          <polyline points="2,12 5,12 7,6 10,18 13,9 15,15 17,12 22,12" />
        </svg>
      ),
    },
  ];
  const sourceOverviewCards = [
    {
      label: 'OFFICIAL',
      title: 'KDCA 표본감시 + 법정감염병 API',
      description: 'ILI/ARI/SARI xlsx/csv는 핵심 지역 감시 신호로, EIDAPI PeriodRegion은 주차별 법정감염병 국내/해외유입 보조 신호로 사용합니다.',
      cadence: '주간 / epiweek',
      output: 'normalized_signal + period_region',
      metric: `${koreaAlerts.length || 17} 시도`,
      tone: 'green',
    },
    {
      label: 'DOCUMENT',
      title: 'KDCA 폐하수감시 공보',
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
      output: 'evidence_analysis',
      metric: 'AI analyze',
      tone: 'blue',
    },
    {
      label: 'GLOBAL',
      title: 'WHO/국제 뉴스 보조 신호',
      description: '국내 뉴스/트렌드와 분리된 보조 레이어입니다. 국제 발생 상황, WHO 알림, 외부 corroboration을 globe에서 설명합니다.',
      cadence: '별도 보조 레이어',
      output: 'globe context panel',
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
          <section className="map-system-brief" aria-label="Sentinel Korea structure">
            <div>
              <span>Sentinel Korea structure</span>
              <strong>공식 감시자료, OSINT, 검색 트렌드, 해외 보조 신호를 한 지도에서 합성합니다.</strong>
              <p>
                KDCA 주간 감시와 법정감염병 API가 기준선을 만들고, 국내 뉴스/검색 트렌드가 이상 징후를 보조합니다.
                WHO DON과 해외 뉴스는 국내 경보를 대체하지 않고, 한국 관련성이 있는 외부 outbreak 맥락을 globe에서 따로 보여줍니다.
              </p>
            </div>
            <div className="map-system-brief-flow">
              <span>KDCA</span>
              <i />
              <span>OSINT</span>
              <i />
              <span>GLOBAL</span>
              <i />
              <span>RISK MAP</span>
            </div>
          </section>
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
                title="WHO/국제 뉴스 보조 레이어"
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
                className={`kas-toolbar-btn ${showRunPanel ? 'kas-toolbar-btn--active' : ''}`}
                onClick={() => setShowRunPanel((v) => !v)}
                title="Run analyze center"
                type="button"
              >
                {runningPipeline ? (
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

            {showRunPanel && (
              <section className="run-control-panel" aria-label="Run analyze status center">
                <div className="run-control-header">
                  <div>
                    <span className="run-control-kicker">RUN ANALYZE</span>
                    <h3>Pipeline command center</h3>
                    <p>Source lane, KDCA, AI analysis, report status are tracked here.</p>
                  </div>
                  <div className="run-control-score">
                    <strong>{operationReadyCount}/{operationRows.length}</strong>
                    <span>ready</span>
                  </div>
                </div>

                <div className="run-control-summary">
                  <div>
                    <span>Current snapshot</span>
                    <strong>{meta?.snapshot_date || currentDate}</strong>
                  </div>
                  <div>
                    <span>KDCA latest</span>
                    <strong>{latestUpload?.updated_dates?.slice(-1)[0] || latestUpload?.file_type || 'none'}</strong>
                  </div>
                  <div>
                    <span>Report</span>
                    <strong>{latestReport?.epiweek || 'none'}</strong>
                  </div>
                </div>

                {operationError && (
                  <div className="run-control-error">{operationError}</div>
                )}

                <div className="run-control-flow" aria-label="Pipeline dependency map">
                  <svg viewBox="0 0 100 84" role="img">
                    <defs>
                      <marker id="run-flow-arrow" markerWidth="5" markerHeight="5" refX="4.2" refY="2.5" orient="auto">
                        <path d="M0,0 L5,2.5 L0,5 Z" />
                      </marker>
                    </defs>
                    {pipelineEdges.map(([fromKey, toKey]) => {
                      const from = pipelineNodeMap.get(fromKey);
                      const to = pipelineNodeMap.get(toKey);
                      if (!from || !to) return null;
                      const dx = Math.abs(to.x - from.x);
                      const midY = from.y + (to.y - from.y) * 0.55;
                      const d = dx < 4
                        ? `M${from.x},${from.y + 4} C${from.x - 8},${midY} ${to.x - 8},${midY} ${to.x},${to.y - 4}`
                        : `M${from.x + 5},${from.y} C${from.x + 13},${midY} ${to.x - 13},${midY} ${to.x - 5},${to.y}`;
                      return <path className="run-flow-edge" d={d} key={`${fromKey}-${toKey}`} markerEnd="url(#run-flow-arrow)" />;
                    })}
                    {pipelineNodePositions.map(({ key, x, y, row }) => (
                      <g className={`run-flow-node status-${row.status}`} transform={`translate(${x} ${y})`} key={key}>
                        <circle r="5.5" />
                        <text y="15">{row.lane}</text>
                      </g>
                    ))}
                  </svg>
                  <div>
                    <span>연결 흐름</span>
                    <strong>원천자료가 OSINT와 KDCA 요약으로 들어가고, Sentinel 통합 분석이 최종 리포트로 이어집니다.</strong>
                  </div>
                </div>

                <div className="run-control-list">
                  {operationRows.map((row) => {
                    const upstream = pipelineEdges.filter(([, to]) => to === row.key).map(([from]) => operationRows[operationIndex.get(from) || 0]?.title).filter(Boolean);
                    const downstream = pipelineEdges.filter(([from]) => from === row.key).map(([, to]) => operationRows[operationIndex.get(to) || 0]?.title).filter(Boolean);
                    return (
                    <article className={`run-control-row status-${row.status}`} key={row.key}>
                      <div className="run-control-row-main">
                        <div className="run-control-row-top">
                          <span className="run-control-lane">{row.lane}</span>
                          <span className="run-control-state">{row.status === 'needs-run' ? '실행 필요' : row.status === 'ready' ? '준비됨' : row.status === 'running' ? '실행 중' : '오류'}</span>
                        </div>
                        <strong>{row.title}</strong>
                        <p>{row.detail}</p>
                        <div className="run-control-meta">
                          <span>updated: {formatRunTime(row.updatedAt)}</span>
                          {row.epiweek && <span>target: {row.epiweek}</span>}
                        </div>
                        {(upstream.length > 0 || downstream.length > 0) && (
                          <div className="run-control-links">
                            {upstream.length > 0 && <span>입력: {upstream.join(' + ')}</span>}
                            {downstream.length > 0 && <span>다음: {downstream.join(' + ')}</span>}
                          </div>
                        )}
                      </div>
                      <button
                        className="run-control-action"
                        disabled={!!runningPipeline}
                        onClick={() => runOperation(row.key)}
                        type="button"
                      >
                        {runningPipeline === row.key ? 'Running...' : row.primaryAction}
                      </button>
                    </article>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Right-side legend (vertical) */}
            <div className="kas-side-legend">
              <div className="kas-side-legend-title">
                <Timeline dates={availableDates.length ? availableDates : [currentDate]} currentDate={currentDate} onChange={setCurrentDate} />
              </div>
              <div className="kas-map-explain">
                <span className="kas-map-explain-kicker">MAP 해석 가이드</span>
                <strong>17개 시·도 호흡기 경보 현황</strong>
                <p>
                  지도 색상은 선택한 날짜의 snapshot에서 계산된 지역별 composite alert level입니다.
                  클릭하면 어떤 신호가 점수를 올렸는지, 신뢰도와 근거 흐름을 확인합니다.
                </p>
                <p>
                  <b>날짜 패널</b>은 실제 오늘 날짜가 아니라 백엔드가 보관한 snapshot_date/epiweek를 선택하는 컨트롤입니다.
                  과거 주차를 선택하면 당시 기준의 경보와 설명을 다시 재생합니다.
                </p>
              </div>
              <div className="map-tool-guide-list">
                {mapToolGuides.map((tool) => (
                  <button
                    className={`map-tool-guide ${tool.active ? 'is-active' : ''}`}
                    key={tool.title}
                    onClick={tool.action}
                    type="button"
                  >
                    <span className="map-tool-guide-icon">{tool.icon}</span>
                    <span>
                      <strong>{tool.title}</strong>
                      <small>{tool.text}</small>
                    </span>
                  </button>
                ))}
              </div>
              <div className="kas-side-legend-items">
                <div className="kas-legend-item">
                  <span className="kas-legend-dot kas-level-critical" />
                  <div><strong>G3 위험</strong><small>즉시 원인 확인과 대응 검토</small></div>
                  <span className="kas-legend-count">{criticalCount}</span>
                </div>
                <div className="kas-legend-item">
                  <span className="kas-legend-dot kas-level-high" />
                  <div><strong>G2 경계</strong><small>복수 신호 상승, 집중 모니터링</small></div>
                  <span className="kas-legend-count">{elevatedCount - criticalCount}</span>
                </div>
                <div className="kas-legend-item">
                  <span className="kas-legend-dot kas-level-moderate" />
                  <div><strong>G1 주의</strong><small>초기 변화 가능성, 추세 확인</small></div>
                  <span className="kas-legend-count">{koreaAlerts.filter(a => a.level === 'G1').length}</span>
                </div>
                <div className="kas-legend-item">
                  <span className="kas-legend-dot kas-level-low" />
                  <div><strong>G0 안정</strong><small>기준선 범위, 정기 감시 유지</small></div>
                  <span className="kas-legend-count">{koreaAlerts.filter(a => a.level === 'G0').length}</span>
                </div>
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
                  <h3>WHO/국제 뉴스 보조 레이어</h3>
                  <p>국내 뉴스/국내 트렌드와 분리해서 보는 국제 발생 상황, WHO 알림, 외부 corroboration 패널입니다.</p>
                </div>
                <button className="panel-close" onClick={() => setIsGlobeExpanded(false)}>×</button>
              </div>
              <div className="expanded-globe-body">
                <div className="expanded-globe-container">
                  <MiniGlobe
                    isExpanded={true}
                    signals={globalSignals}
                    koreaAlerts={koreaAlerts}
                    activeLayers={activeLayers}
                    aggregationMode={aggregationMode}
                    onGlobalSignalClick={setSelectedGlobal}
                    selectedGlobalId={selectedGlobal?.id}
                  />
                </div>
                <aside className="globe-context-panel">
                  <span className="globe-context-kicker">한국 관련성 기반 국제 감시</span>
                  <h4>어떤 국제 신호가 한국에 가까운가?</h4>
                  <p>
                    국제 신호는 질병 심각도, 한국 이동량 proxy, 거리, 예상 밖 이벤트, 소스 신뢰도를
                    함께 보아 Korea relevance를 계산합니다. 점수가 높을수록 globe에서 한국으로 향하는
                    arc가 더 자주, 더 진하게 나타납니다.
                  </p>

                  <div className="globe-context-metrics">
                    <div>
                      <span>Total</span>
                      <strong>{globalSignals.length}</strong>
                    </div>
                    <div>
                      <span>Critical</span>
                      <strong>{internationalSummary.byRelevance.critical || 0}</strong>
                    </div>
                    <div>
                      <span>High+</span>
                      <strong>{(internationalSummary.byRelevance.critical || 0) + (internationalSummary.byRelevance.high || 0)}</strong>
                    </div>
                    <div>
                      <span>Avg relevance</span>
                      <strong>{formatPercent(internationalSummary.averageRelevance)}</strong>
                    </div>
                  </div>

                  <div className="globe-context-section">
                    <h5>소스 구성</h5>
                    {Object.entries(internationalSummary.bySource).length ? (
                      Object.entries(internationalSummary.bySource).map(([source, count]) => (
                        <div className="globe-context-row" key={source}>
                          <span>{source}</span>
                          <strong>{count}</strong>
                        </div>
                      ))
                    ) : (
                      <p className="globe-context-empty">국제 신호가 아직 없습니다.</p>
                    )}
                  </div>

                  <div className="globe-context-section">
                    <h5>관련 국가</h5>
                    {internationalSummary.topCountries.length ? (
                      internationalSummary.topCountries.map(([country, count]) => (
                        <div className="globe-context-row" key={country}>
                          <span>{country}</span>
                          <strong>{count}</strong>
                        </div>
                      ))
                    ) : (
                      <p className="globe-context-empty">국가 정보가 없습니다.</p>
                    )}
                  </div>

                  <div className="globe-context-section">
                    <h5>한국 관련성 상위 국제 신호</h5>
                    {internationalSummary.recentSignals.length ? (
                      internationalSummary.recentSignals.map((signal) => {
                        const relevance = scoreInternationalRelevance(signal);
                        return (
                          <button
                            className={`globe-signal-item is-${relevance.level} ${selectedGlobal?.id === signal.id ? 'is-selected' : ''}`}
                            style={{ borderLeftColor: relevance.color }}
                            key={`${signal.id}-${signal.date}`}
                            onClick={() => setSelectedGlobal(signal)}
                            type="button"
                          >
                            <span>{signal.date} / {signal.source.replace('_', ' ')}</span>
                            <strong>{signal.title || signal.keyword || signal.disease || 'International signal'}</strong>
                            <div className="globe-signal-meta">
                              <em>{signal.country || signal.severity}</em>
                              <b className={`relevance-pill level-${relevance.level}`}>
                                {formatPercent(relevance.score)}
                              </b>
                            </div>
                            <small>
                              {relevanceLabel(relevance.score)} · 거리 {formatDistance(relevance.distanceKm)}
                            </small>
                          </button>
                        );
                      })
                    ) : (
                      <p className="globe-context-empty">표시할 국제 신호가 없습니다.</p>
                    )}
                  </div>

                  <div className="globe-context-section">
                    <h5>선택 신호 RAW DATA</h5>
                    {selectedGlobal ? (() => {
                      const relevance = scoreInternationalRelevance(selectedGlobal);
                      return (
                        <div className="globe-raw-card">
                          <div className="globe-raw-card-top">
                            <span className={`relevance-pill level-${relevance.level}`}>{relevanceLabel(relevance.score)}</span>
                            <strong>{formatPercent(relevance.score)}</strong>
                          </div>
                          <h6>{selectedGlobal.title || selectedGlobal.keyword || selectedGlobal.disease || 'International signal'}</h6>
                          <div className="globe-raw-grid">
                            <div><span>source</span><strong>{selectedGlobal.source.replace('_', ' ')}</strong></div>
                            <div><span>country</span><strong>{selectedGlobal.country || 'n/a'}</strong></div>
                            <div><span>severity</span><strong>{selectedGlobal.severity}</strong></div>
                            <div><span>distance</span><strong>{formatDistance(relevance.distanceKm)}</strong></div>
                          </div>
                          <div className="globe-factor-list">
                            {Object.entries(relevance.factors).map(([key, value]) => (
                              <div className="globe-factor-row" key={key}>
                                <span>{relevanceFactorLabels[key] || key}</span>
                                <div className="globe-factor-bar">
                                  <i className="globe-factor-fill" style={{ width: formatPercent(value), background: relevance.color }} />
                                </div>
                                <strong>{formatPercent(value)}</strong>
                              </div>
                            ))}
                          </div>
                          {selectedGlobal.url && (
                            <a className="globe-raw-link" href={selectedGlobal.url} target="_blank" rel="noreferrer">
                              원문 링크 열기
                            </a>
                          )}
                          <pre className="globe-raw-json">{JSON.stringify(selectedGlobal, null, 2)}</pre>
                        </div>
                      );
                    })() : (
                      <p className="globe-click-hint">
                        Globe의 arc/node 또는 위 목록을 클릭하면 AI relevance factor와 원천 RAW DATA를 여기서 확인할 수 있습니다.
                      </p>
                    )}
                  </div>
                </aside>
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
              <h2>Respiratory surveillance intelligence data inputs</h2>
              <p>
                Data를 해석할때 중요한 것은 데이터가 어디서 왔고, 어떤 역할이며, 최종 경보의 어느 부분에
                쓰이는가입니다. 아래 보드는 각 source lane의 목적, 갱신 주기, 산출물을 먼저 보여줍니다.
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
                <h3>뉴스트렌드 파이프라인</h3>
                <p className="source-section-helper">
                  국내외 뉴스를 분석하여 질환 관련 trends, 이상 징후, 초기 경고신호를 추출합니다.
                </p>
                <NewsPanel hideKeywordsButton />
              </section>
              <section className="kas-sources-card">
                <h3>검색 트렌드 파이프라인</h3>
                <p className="source-section-helper">
                  국내 검색 행동 변화를 시간축으로 분석하여 증상 탐색 증가, 관심도 변화, 공식 감시자료와의 방향성을 비교합니다.
                </p>
                <TrendsChart />
              </section>
              <section className="kas-sources-card">
                <h3>KDCA 감시자료 분석</h3>
                <p className="source-section-helper">
                  질병관리청에서 제공하는 주간보고서를 기반으로 AI가 통합분석하여 요약 및 위험도 분석을 제공합니다.
                </p>
                <KdcaUploadPanel view="summary" />
              </section>
              <section className="kas-sources-card">
                <h3>KDCA 법정감염병 real data</h3>
                <p className="source-section-helper">
                  EIDAPI PeriodRegion 원자료를 주차별로 보여주고, Sentinel이 호흡기 관련 질환과 호흡기/공기전파 바이러스 subset을 어떻게 파싱했는지 확인합니다.
                </p>
                <KdcaNotifiablePanel />
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

                <div className="kas-console-subcard">
                  <div className="kas-console-subcard-title">KDCA 법정감염병 API</div>
                  <p className="console-card-desc">
                    PeriodRegion을 기본으로 주차별 법정감염병 국내/해외유입 값을 수집하고, PeriodBasic으로 총합을 검산합니다.
                    17개 시도 지역 신호는 업로드 xlsx/csv 감시자료가 담당합니다.
                  </p>
                  <button className="console-action-btn console-neutral-btn" onClick={handleRefreshKdcaNotifiable} disabled={refreshingKdcaApi}>
                    <span className="console-btn-title">{refreshingKdcaApi ? 'KDCA API 갱신 중...' : '법정감염병 API 갱신'}</span>
                    <span className="console-btn-sub">PeriodRegion primary · PeriodBasic validation</span>
                  </button>
                  {kdcaApiResult?.summary && (
                    <div className="osint-analysis-result">
                      <div className="osint-result-header">KDCA EIDAPI</div>
                      <p className="osint-result-text">{kdcaApiResult.summary}</p>
                    </div>
                  )}
                </div>
              </section>

              {/* ── AI ANALYZE (trigger pipelines) ── */}
              <section className="kas-sources-card kas-console-group">
                <h3 className="kas-console-group-title">분석 실행 / AI ANALYZE</h3>
                <p className="console-card-desc">각 분석 버튼은 map, report, pipeline control의 산출물을 갱신합니다.</p>

                <button className="osint-analysis-btn console-action-btn" onClick={handleRunOsintAnalysis} disabled={analyzingOsint}>
                  <span className="console-btn-title">{analyzingOsint ? 'OSINT 실행 중...' : 'OSINT 분석'}</span>
                  <span className="console-btn-sub">국내 뉴스 + 검색 트렌드 보조 신호 분석</span>
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
