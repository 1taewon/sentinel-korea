import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { useAuth } from '../contexts/AuthContext';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ObjectTypeMeta {
  id: string; label: string; label_kr: string; color: string;
  instance_count: number;
}

interface OntologySchema {
  object_types: ObjectTypeMeta[];
  link_types: { id: string; from: string; to: string; label: string }[];
}

interface InstanceDetail {
  type_id: string;
  instance: Record<string, any>;
  links: { link_type: string; to_type: string; to_id: string; to_label: string }[];
}

interface ForecastPoint {
  date: string; weeks_ahead: number; score?: number; value?: number;
  level?: string; low: number; high: number;
}

interface HistoryPoint {
  date: string; score?: number; value?: number; level?: string; epiweek?: string;
}

interface MethodInfo {
  name: string; formula: string;
  parameters: Record<string, any>; description_kr: string;
}

interface ForecastResult {
  region_id?: string; disease_id?: string; model_name?: string;
  history: HistoryPoint[]; forecast: ForecastPoint[];
  method?: MethodInfo;
  ema_baseline?: number; momentum?: number; volatility?: number;
  outbreak_exogenous_lift?: number;
  diagnostics?: { aic?: number; bic?: number };
  peak?: { date: string; value: number };
  narrative: string; error?: string;
}

interface DecompositionResult {
  contributions: { signal: string; label: string; value: number; weight: number; weighted_contribution: number; share_of_score: number }[];
  narrative: string; error?: string;
}

interface HotspotEntry {
  region_id: string; name_kr: string; name_en: string;
  current_score: number; current_level: string;
  projected_score: number; projected_level: string;
  delta: number;
  progression?: { week: number; score: number; level: string }[];
}

interface HotspotsResult {
  weeks_ahead: number; snapshot_date: string; total_regions: number;
  hotspots: HotspotEntry[];
}

interface Recommendation {
  priority: 'HIGH' | 'MEDIUM' | 'WATCH'; action: string; reasoning: string; audience?: string;
}
interface RecommendationsResult {
  region_id: string; recommendations: Recommendation[]; error?: string; raw?: string;
}

// What-if types
interface WhatIfComparison {
  weeks_ahead: number; baseline_score: number; baseline_level: string;
  scenario_score: number; scenario_level: string; delta: number; level_changed: boolean;
}
// WhatIfResult removed — replaced by NationalOutbreakResult for national spread model.

// National outbreak spread result
interface NationalRegionResult {
  region_id: string; region_name: string;
  is_primary_zone?: boolean; spread_multiplier: number; lift: number;
  baseline_level: string; baseline_score: number;
  scenario_level: string; scenario_score: number;
  max_delta: number; level_changed: boolean;
  comparison: WhatIfComparison[];
  error?: string;
}
interface NationalOutbreakResult {
  entry_point: { code: string; label: string; primary_zones: string[] };
  scenario: { disease: string; country: string; severity: string; base_lift: number; proximity_multiplier: number; proximity_source?: string; aviation?: { multiplier: number; arr_passengers: number; country_kr: string; month: string } | null; traffic_source?: string; traffic_base?: number; weather_source?: string };
  regions: NationalRegionResult[];
  summary: { total_regions: number; escalated_count: number; escalated_regions: string[]; total_delta: number; traffic_sensitivity?: { base: number; escalated_count: number; is_selected: boolean }[] | null };
  gemini_scenario?: {
    impact_summary?: string; spread_pattern?: string;
    timeline?: { week?: number; description?: string }[];
    response_actions?: { priority?: string; action?: string; timing?: string }[];
    high_risk_regions?: { region?: string; reason?: string }[];
    risk_factors?: string[]; best_case?: string; worst_case?: string;
    error?: string; raw?: string; parse_error?: boolean;
  } | null;
  narrative: string;
  error?: string;
}

// Lead-lag types
interface LeadLagCorrelation {
  lag: number; correlation: number; interpretation: string; pairs: number;
}
interface LeadLagResult {
  signal_a: string; signal_b: string; label_a: string; label_b: string;
  data_points: number;
  date_range: { start: string; end: string };
  correlations: LeadLagCorrelation[];
  best_lag: { lag: number; correlation: number; strength: string; strength_kr: string; lead_signal: string; lag_signal: string };
  series_a: { date: string; value: number }[];
  series_b: { date: string; value: number }[];
  method?: MethodInfo;
  narrative: string;
  error?: string;
}

// Integrated report types
interface ForecastReport {
  report: {
    executive_summary?: string; risk_assessment?: string;
    forecast_consensus?: string; early_warning?: string;
    action_items?: string[]; outlook?: string;
    raw?: string; parse_error?: boolean;
  };
  data_sources: Record<string, any>;
  narrative: string;
  error?: string;
}

// ─── D3 Time-Series Chart ──────────────────────────────────────────────────

function TimeSeriesChart({
  history, forecast, valueKey = 'score', height = 210,
  color = '#38bdf8', label,
}: {
  history: HistoryPoint[]; forecast: ForecastPoint[];
  valueKey?: string; height?: number;
  color?: string; label?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!svgRef.current || !containerRef.current) return;
    const width = containerRef.current.clientWidth || 520;
    const margin = { top: 20, right: 16, bottom: 30, left: 50 };
    const w = width - margin.left - margin.right;
    const h = height - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('width', width).attr('height', height);
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const histData = history.map((p) => ({
      date: new Date(p.date), value: (p as any)[valueKey] ?? p.value ?? p.score ?? 0, type: 'h' as const,
    }));
    const fcData = forecast.map((p) => ({
      date: new Date(p.date), value: (p as any)[valueKey] ?? p.value ?? p.score ?? 0,
      low: p.low, high: p.high, type: 'f' as const,
    }));

    const allDates = [...histData.map((d) => d.date), ...fcData.map((d) => d.date)];
    const allVals = [
      ...histData.map((d) => d.value), ...fcData.map((d) => d.value),
      ...fcData.map((d) => d.high), ...fcData.map((d) => d.low),
    ];

    const x = d3.scaleTime().domain(d3.extent(allDates) as [Date, Date]).range([0, w]);
    const y = d3.scaleLinear()
      .domain([Math.min(0, (d3.min(allVals) ?? 0) * 0.9), (d3.max(allVals) ?? 1) * 1.1])
      .range([h, 0]).nice();

    // Grid
    g.selectAll('.grid-line')
      .data(y.ticks(5)).enter().append('line')
      .attr('x1', 0).attr('x2', w)
      .attr('y1', (d) => y(d)).attr('y2', (d) => y(d))
      .attr('stroke', 'rgba(148,163,184,0.12)').attr('stroke-dasharray', '2,3');

    // Confidence band
    if (fcData.length > 0) {
      const bridge = histData.length > 0
        ? [{ date: histData[histData.length - 1].date, low: histData[histData.length - 1].value, high: histData[histData.length - 1].value }]
        : [];
      const bandData = [...bridge, ...fcData];
      g.append('path')
        .datum(bandData)
        .attr('d', d3.area<any>().x((d) => x(d.date)).y0((d) => y(d.low)).y1((d) => y(d.high)).curve(d3.curveMonotoneX))
        .attr('fill', color).attr('opacity', 0.12);
    }

    // Divider
    if (histData.length > 0 && fcData.length > 0) {
      const dx = x(histData[histData.length - 1].date);
      g.append('line').attr('x1', dx).attr('x2', dx).attr('y1', 0).attr('y2', h)
        .attr('stroke', 'rgba(148,163,184,0.35)').attr('stroke-dasharray', '4,4');
      g.append('text').attr('x', dx + 4).attr('y', 10)
        .attr('font-size', '9px').attr('fill', '#94a3b8').text('forecast →');
    }

    // History line
    if (histData.length > 1) {
      const line = d3.line<any>().x((d) => x(d.date)).y((d) => y(d.value)).curve(d3.curveMonotoneX);
      g.append('path').datum(histData).attr('d', line)
        .attr('fill', 'none').attr('stroke', color).attr('stroke-width', 2);
      g.selectAll('.dh').data(histData).enter().append('circle')
        .attr('cx', (d) => x(d.date)).attr('cy', (d) => y(d.value))
        .attr('r', 2.5).attr('fill', color);
    }

    // Forecast line (dashed)
    if (fcData.length > 0) {
      const bridge2 = histData.length > 0
        ? [{ date: histData[histData.length - 1].date, value: histData[histData.length - 1].value }]
        : [];
      const line = d3.line<any>().x((d) => x(d.date)).y((d) => y(d.value)).curve(d3.curveMonotoneX);
      g.append('path').datum([...bridge2, ...fcData]).attr('d', line)
        .attr('fill', 'none').attr('stroke', '#fb7185').attr('stroke-width', 2).attr('stroke-dasharray', '6,4');
      g.selectAll('.df').data(fcData).enter().append('circle')
        .attr('cx', (d) => x(d.date)).attr('cy', (d) => y(d.value))
        .attr('r', 4).attr('fill', '#fb7185').attr('stroke', '#1c2435').attr('stroke-width', 1.5);
    }

    // Axes
    g.append('g').attr('transform', `translate(0,${h})`)
      .call(d3.axisBottom(x).ticks(6).tickFormat((d) => d3.timeFormat('%m/%d')(d as Date)))
      .selectAll('text').attr('fill', '#94a3b8').attr('font-size', '9px');
    g.append('g')
      .call(d3.axisLeft(y).ticks(5).tickFormat((d) => String(d)))
      .selectAll('text').attr('fill', '#94a3b8').attr('font-size', '9px');

    svg.selectAll('.domain').attr('stroke', 'rgba(148,163,184,0.25)');
    svg.selectAll('.tick line').attr('stroke', 'rgba(148,163,184,0.15)');

    // Label
    if (label) {
      g.append('text').attr('x', 4).attr('y', -6)
        .attr('font-size', '10px').attr('fill', color).attr('font-weight', '700')
        .text(label);
    }
  }, [history, forecast, valueKey, height, color, label]);

  return (
    <div ref={containerRef} className="ontology-chart-container">
      <svg ref={svgRef} />
    </div>
  );
}

// ─── Methodology panel ──────────────────────────────────────────────────────

function MethodologyPanel({ method, diagnostics }: { method?: MethodInfo; diagnostics?: { aic?: number; bic?: number } }) {
  const [open, setOpen] = useState(true);
  if (!method) return null;
  return (
    <div className="ontology-methodology">
      <button className="ontology-methodology-toggle" onClick={() => setOpen(!open)} type="button">
        {open ? '▾' : '▸'} {method.name}
      </button>
      {open && (
        <div className="ontology-methodology-body">
          <div className="ontology-methodology-formula"><code>{method.formula}</code></div>
          <div className="ontology-methodology-desc">{method.description_kr}</div>
          <div className="ontology-methodology-params">
            {Object.entries(method.parameters).map(([k, v]) => (
              <span key={k} className="ontology-methodology-param">
                {k} = <code>{String(v)}</code>
              </span>
            ))}
            {diagnostics?.aic != null && (
              <span className="ontology-methodology-param">AIC = <code>{diagnostics.aic}</code></span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Reusable bits ──────────────────────────────────────────────────────────

function LevelPill({ level }: { level?: string }) {
  return <span className={`ontology-pill ontology-pill-${level || 'G0'}`}>{level || '-'}</span>;
}

function ScoreBar({ value, color = '#38bdf8' }: { value: number; color?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="ontology-bar-track">
      <div className="ontology-bar-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

// ─── Object Type descriptions ───────────────────────────────────────────────

const TYPE_DESCRIPTIONS: Record<string, { desc_kr: string; desc_en: string }> = {
  Region: {
    desc_kr: '17개 시·도별 호흡기 감염병 위험도를 종합 점수(G0~G3)로 모니터링합니다. 각 지역의 6개 신호원을 가중 합산하여 실시간 경보를 제공합니다.',
    desc_en: '17 provinces — composite risk score from 6 surveillance signals',
  },
  Disease: {
    desc_kr: 'KDCA 주간 감시 보고서에서 추적하는 8대 호흡기 질환/병원체입니다. 인플루엔자(ILI), 중증폐렴(SARI), RSV, hMPV, 아데노바이러스, 코로나19 등 개별 시계열 데이터를 EMA와 SARIMAX 이중 모델로 예측합니다.',
    desc_en: '8 respiratory diseases tracked by KDCA weekly surveillance',
  },
  Snapshot: {
    desc_kr: '파이프라인 분석(analyze) 실행 시 생성되는 주차별 전국 위험도 스냅샷입니다. 각 스냅샷은 17개 지역의 G-level 분포를 기록하며, 시계열 예측의 입력 데이터로 활용됩니다.',
    desc_en: 'Weekly composite alert snapshots — input for time-series forecasting',
  },
};

// ─── Decision panels ────────────────────────────────────────────────────────

function DecompositionPanel({ data }: { data: DecompositionResult }) {
  if (data.error) return <div className="ontology-decision-error">{data.error}</div>;
  const max = Math.max(...data.contributions.map((c) => c.weighted_contribution), 0.01);
  return (
    <div className="ontology-decision-block">
      <div className="ontology-decision-narrative">{data.narrative}</div>
      <div className="ontology-driver-list">
        {data.contributions.map((c) => (
          <div key={c.signal} className="ontology-driver-row">
            <span className="ontology-driver-label">{c.label}</span>
            <div className="ontology-driver-bar">
              <ScoreBar value={c.weighted_contribution / max} color="#38bdf8" />
            </div>
            <span className="ontology-driver-value">{c.value.toFixed(2)}</span>
            <span className="ontology-driver-share">{Math.round(c.share_of_score * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ForecastPanel({ data }: { data: ForecastResult }) {
  if (data.error) return <div className="ontology-decision-error">{data.error}</div>;
  const vk = data.disease_id ? 'value' : 'score';
  const modelLabel = data.model_name || data.method?.name || 'Forecast';
  const col = data.model_name === 'SARIMAX' ? '#f59e0b' : (data.disease_id ? '#c084fc' : '#38bdf8');
  return (
    <div className="ontology-decision-block">
      <div className="ontology-decision-narrative">{data.narrative}</div>
      <TimeSeriesChart
        history={data.history} forecast={data.forecast}
        valueKey={vk} height={210} color={col} label={modelLabel}
      />
      <div className="ontology-forecast-meta">
        {data.ema_baseline != null && <>EMA={data.ema_baseline.toFixed(2)} </>}
        {data.momentum != null && <>momentum={data.momentum >= 0 ? '+' : ''}{data.momentum.toFixed(2)} </>}
        {data.outbreak_exogenous_lift != null && <>outbreak_lift=+{data.outbreak_exogenous_lift.toFixed(2)} </>}
        {data.volatility != null && <>vol={data.volatility.toFixed(2)} </>}
        {data.diagnostics?.aic != null && <>AIC={data.diagnostics.aic} </>}
        {data.peak && <>| peak: {data.peak.date} ({data.peak.value.toFixed(0)})</>}
      </div>
      <MethodologyPanel method={data.method} diagnostics={data.diagnostics} />
    </div>
  );
}

function RecommendationsPanel({
  data, loading, isAdmin, onGenerate,
}: {
  data: RecommendationsResult | null; loading: boolean; isAdmin: boolean; onGenerate: () => void;
}) {
  if (!data) {
    return (
      <div className="ontology-decision-block">
        <button type="button" className="ontology-generate-btn"
          onClick={onGenerate} disabled={!isAdmin || loading}>
          {loading ? 'Generating...' : isAdmin ? 'Generate recommendations (Gemini)' : 'Admin only'}
        </button>
      </div>
    );
  }
  if (data.error) {
    return (
      <div className="ontology-decision-block">
        <div className="ontology-decision-error">{data.error}</div>
        <button className="ontology-generate-btn" onClick={onGenerate} disabled={loading}>Retry</button>
      </div>
    );
  }
  return (
    <div className="ontology-decision-block">
      <div className="ontology-rec-list">
        {data.recommendations.map((r, i) => (
          <div key={i} className={`ontology-rec-card ontology-rec-${r.priority}`}>
            <div className="ontology-rec-head">
              <span className={`ontology-pill ontology-rec-priority-${r.priority}`}>{r.priority}</span>
              {r.audience && <span className="ontology-rec-audience">{r.audience}</span>}
            </div>
            <div className="ontology-rec-action">{r.action}</div>
            <div className="ontology-rec-reasoning">{r.reasoning}</div>
          </div>
        ))}
      </div>
      <button className="ontology-generate-btn ontology-generate-btn--regen"
        onClick={onGenerate} disabled={loading}>Regenerate</button>
    </div>
  );
}

function HotspotsPanel({ data, onPickRegion }: { data: HotspotsResult; onPickRegion: (rid: string) => void }) {
  return (
    <div className="ontology-decision-block">
      <div className="ontology-decision-narrative">
        Top {data.hotspots.length} of {data.total_regions} regions | {data.weeks_ahead}wk forecast
      </div>
      <div className="ontology-hotspot-list">
        {data.hotspots.map((h) => (
          <button key={h.region_id} type="button" className="ontology-hotspot-row-multi"
            onClick={() => onPickRegion(h.region_id)}>
            <span className="ontology-hotspot-name">{h.name_kr || h.name_en}</span>
            <div className="ontology-hotspot-progression">
              <span className="ontology-hotspot-week-label">Now</span>
              <LevelPill level={h.current_level} />
              <span className="ontology-hotspot-week-score">{h.current_score.toFixed(2)}</span>
              {h.progression?.map((p) => (
                <span key={p.week} className="ontology-hotspot-week-group">
                  <span className="ontology-hotspot-arrow">→</span>
                  <span className="ontology-hotspot-week-label">+{p.week}w</span>
                  <LevelPill level={p.level} />
                  <span className="ontology-hotspot-week-score">{p.score.toFixed(2)}</span>
                </span>
              ))}
            </div>
            <span className={`ontology-hotspot-delta ${h.delta > 0 ? 'up' : h.delta < 0 ? 'down' : ''}`}>
              {h.delta > 0 ? '+' : ''}{h.delta.toFixed(2)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── What-If Outbreak panel ─────────────────────────────────────────────────

const WHAT_IF_PRESETS = [
  { disease: 'H5N1 Avian Influenza', country: 'China', severity: 'critical' },
  { disease: 'MERS-CoV', country: 'Saudi Arabia', severity: 'high' },
  { disease: 'Novel Coronavirus', country: 'China', severity: 'high' },
  { disease: 'Measles outbreak', country: 'Japan', severity: 'medium' },
  { disease: 'H7N9 Influenza', country: 'Vietnam', severity: 'high' },
];

// WhatIfPanel (single-region) removed — replaced by WhatIfStandalonePanel (national).

// ─── Korea GeoJSON Map for Outbreak Scenario ─────────────────────────────

// GeoJSON SIG_CD prefix (2 digits) → Backend sido code
const GEOJSON_TO_BACKEND: Record<string, string> = {
  '11': '11', '21': '26', '22': '27', '23': '28',
  '24': '29', '25': '30', '26': '31', '29': '36',
  '31': '41', '32': '42', '33': '43', '34': '44',
  '35': '45', '36': '46', '37': '47', '38': '48',
  '39': '50',
};

// Module-level GeoJSON cache (shared across all instances)
let _koreaGeoCache: any[] | null = null;
let _koreaGeoPromise: Promise<any[]> | null = null;

function useKoreaGeoJSON() {
  const [features, setFeatures] = useState<any[]>(_koreaGeoCache || []);
  useEffect(() => {
    if (_koreaGeoCache) { setFeatures(_koreaGeoCache); return; }
    if (!_koreaGeoPromise) {
      _koreaGeoPromise = fetch('/korea-sig.geojson')
        .then(r => r.json())
        .then(data => { _koreaGeoCache = data.features; return data.features; })
        .catch(() => []);
    }
    _koreaGeoPromise.then(f => setFeatures(f));
  }, []);
  return features;
}

const GLEVEL_COLORS: Record<string, string> = {
  G0: '#34d399', G1: '#f6e05e', G2: '#ff9f43', G3: '#ff4d4f',
};

const SIDO_LABELS = [
  { code: '11', abbr: '서울', lat: 37.5665, lng: 126.9780 },
  { code: '26', abbr: '부산', lat: 35.1796, lng: 129.0756 },
  { code: '27', abbr: '대구', lat: 35.8714, lng: 128.6014 },
  { code: '28', abbr: '인천', lat: 37.4563, lng: 126.7052 },
  { code: '29', abbr: '광주', lat: 35.1595, lng: 126.8526 },
  { code: '30', abbr: '대전', lat: 36.3504, lng: 127.3845 },
  { code: '31', abbr: '울산', lat: 35.5384, lng: 129.3114 },
  { code: '36', abbr: '세종', lat: 36.4800, lng: 127.2890 },
  { code: '41', abbr: '경기', lat: 37.2750, lng: 127.0094 },
  { code: '42', abbr: '강원', lat: 37.8228, lng: 128.1555 },
  { code: '43', abbr: '충북', lat: 36.6357, lng: 127.4917 },
  { code: '44', abbr: '충남', lat: 36.5184, lng: 126.8000 },
  { code: '45', abbr: '전북', lat: 35.7175, lng: 127.1530 },
  { code: '46', abbr: '전남', lat: 34.8161, lng: 126.4629 },
  { code: '47', abbr: '경북', lat: 36.4919, lng: 128.8889 },
  { code: '48', abbr: '경남', lat: 35.4606, lng: 128.2132 },
  { code: '50', abbr: '제주', lat: 33.4890, lng: 126.4983 },
];

function ScenarioMiniMap({ regionLevels, targetCode, title }: {
  regionLevels: { code: string; level: string }[];
  targetCode?: string;
  title: string;
}) {
  const features = useKoreaGeoJSON();
  const levelMap = useMemo(() => new Map(regionLevels.map(r => [r.code, r.level])), [regionLevels]);
  const targetSet = useMemo(() => new Set((targetCode || '').split(',').filter(Boolean)), [targetCode]);

  // d3 Mercator projection centered on Korea
  const projection = useMemo(() =>
    d3.geoMercator().center([127.8, 36.0]).scale(4800).translate([200, 240]),
  []);
  const pathGen = useMemo(() => d3.geoPath().projection(projection), [projection]);

  // Pre-compute SVG paths + styling
  const polys = useMemo(() => {
    if (!features.length) return [];
    return features.map((f: any, i: number) => {
      const sigCode = f.properties?.code || '';
      const sidoPrefix = sigCode.substring(0, 2);
      const backendCode = GEOJSON_TO_BACKEND[sidoPrefix] || '';
      const level = levelMap.get(backendCode) || 'G0';
      const color = GLEVEL_COLORS[level] || GLEVEL_COLORS.G0;
      const isTarget = targetSet.has(backendCode);
      return { key: i, d: pathGen(f) || '', color, isTarget, level };
    });
  }, [features, levelMap, targetSet, pathGen]);

  // Sido label positions
  const labels = useMemo(() =>
    SIDO_LABELS.map(s => {
      const pt = projection([s.lng, s.lat]) || [0, 0];
      return { ...s, x: pt[0], y: pt[1], level: levelMap.get(s.code) || 'G0' };
    }),
  [projection, levelMap]);

  return (
    <div className="scenario-minimap">
      <div className="scenario-minimap-title">{title}</div>
      <svg viewBox="0 0 400 480" className="scenario-minimap-svg korea-geo-svg">
        <defs>
          <filter id={`glow-${title.replace(/\s/g, '')}`}>
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {/* SiGunGu polygons colored by parent Sido level */}
        {polys.map(p => (
          <path key={p.key} d={p.d}
            fill={p.color}
            fillOpacity={p.isTarget ? 0.95 : 0.6}
            stroke={p.isTarget ? 'rgba(255,255,255,0.8)' : 'rgba(100,150,200,0.25)'}
            strokeWidth={p.isTarget ? 1 : 0.3}
            filter={p.isTarget ? `url(#glow-${title.replace(/\s/g, '')})` : undefined}
          />
        ))}
        {/* Sido name labels */}
        {labels.map(l => (
          <text key={l.code} x={l.x} y={l.y}
            textAnchor="middle" dominantBaseline="central"
            fontSize={12} fontWeight={700}
            fill={l.level === 'G1' ? '#1c2435' : '#fff'}
            stroke="rgba(0,0,0,0.6)" strokeWidth={2.5} paintOrder="stroke"
            style={{ pointerEvents: 'none' }}>
            {l.abbr}
          </text>
        ))}
      </svg>
    </div>
  );
}

// ─── Animated spread figure: aviation import → connectivity/proximity spread ──
// Plays the backend's weekly projection (comparison[]) across the landing 시도 map:
// the entry point (항공 유입 거점) seeds, spread edges fan out weighted by each
// region's spread_multiplier (교통 연결성 × 인접성), nodes grow with predicted score.
function ScenarioSpreadMap({ regions, primaryZones, entryLabel }: {
  regions: NationalRegionResult[];
  primaryZones: string[];
  entryLabel: string;
}) {
  const features = useKoreaGeoJSON();
  const weeks = useMemo(() => Math.max(1, ...regions.map((r) => r.comparison?.length || 0)), [regions]);
  const [week, setWeek] = useState(0);
  const [playing, setPlaying] = useState(true);

  const projection = useMemo(() => d3.geoMercator().center([127.8, 36.0]).scale(4800).translate([200, 240]), []);
  const pathGen = useMemo(() => d3.geoPath().projection(projection), [projection]);

  const regionByCode = useMemo(() => new Map(regions.map((r) => [r.region_id, r])), [regions]);
  const centroids = useMemo(() => {
    const m = new Map<string, [number, number]>();
    SIDO_LABELS.forEach((s) => { const p = projection([s.lng, s.lat]); if (p) m.set(s.code, [p[0], p[1]]); });
    return m;
  }, [projection]);

  const levelAt = (r: NationalRegionResult, w: number): string => {
    if (w <= 0) return r.baseline_level || 'G0';
    const c = r.comparison?.[Math.min(w, r.comparison.length) - 1];
    return c?.scenario_level || r.scenario_level || 'G0';
  };
  const scoreAt = (r: NationalRegionResult, w: number): number => {
    if (w <= 0) return r.baseline_score || 0;
    const c = r.comparison?.[Math.min(w, r.comparison.length) - 1];
    return c?.scenario_score ?? r.scenario_score ?? 0;
  };

  const polys = useMemo(() => features.map((f: any, i: number) => {
    const sido = String(f.properties?.code || '').substring(0, 2);
    return { key: i, d: pathGen(f) || '', code: GEOJSON_TO_BACKEND[sido] || '' };
  }), [features, pathGen]);

  const originPts = useMemo(
    () => primaryZones.map((c) => centroids.get(c)).filter(Boolean) as [number, number][],
    [primaryZones, centroids]);

  const edges = useMemo(() => {
    if (!originPts.length) return [] as { code: string; from: [number, number]; to: [number, number]; mult: number }[];
    const o = originPts[0];
    return regions
      .filter((r) => !primaryZones.includes(r.region_id) && !r.error)
      .map((r) => { const c = centroids.get(r.region_id); return c ? { code: r.region_id, from: o, to: c, mult: r.spread_multiplier || 0 } : null; })
      .filter(Boolean) as { code: string; from: [number, number]; to: [number, number]; mult: number }[];
  }, [regions, originPts, centroids, primaryZones]);
  const maxMult = useMemo(() => Math.max(1, ...edges.map((e) => e.mult)), [edges]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setWeek((w) => (w >= weeks ? 0 : w + 1)), 1300);
    return () => clearInterval(id);
  }, [playing, weeks]);

  return (
    <div className="scenario-spread">
      <div className="scenario-spread-head">
        <button type="button" className="scenario-spread-play" onClick={() => setPlaying((p) => !p)}>
          {playing ? '일시정지' : '재생'}
        </button>
        <input type="range" min={0} max={weeks} step={1} value={week}
          onChange={(e) => { setPlaying(false); setWeek(Number(e.target.value)); }}
          className="scenario-spread-slider" />
        <span className="scenario-spread-week">{week === 0 ? '현재 (기준)' : `${week}주 후`}</span>
      </div>
      <svg viewBox="0 0 400 480" className="scenario-spread-svg korea-geo-svg">
        <defs>
          <filter id="spread-glow">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {polys.map((p) => {
          const r = p.code ? regionByCode.get(p.code) : undefined;
          const level = r ? levelAt(r, week) : 'G0';
          return (
            <path key={p.key} d={p.d} fill={GLEVEL_COLORS[level] || GLEVEL_COLORS.G0}
              fillOpacity={week === 0 ? 0.32 : 0.6} stroke="rgba(100,150,200,0.25)" strokeWidth={0.3}
              style={{ transition: 'fill 0.7s ease, fill-opacity 0.7s ease' }} />
          );
        })}
        {week >= 1 && edges.map((e) => {
          const r = regionByCode.get(e.code);
          if (!r || scoreAt(r, week) <= (r.baseline_score || 0) + 0.008) return null;
          return (
            <line key={e.code} x1={e.from[0]} y1={e.from[1]} x2={e.to[0]} y2={e.to[1]}
              stroke="rgba(255,120,60,0.55)" strokeWidth={0.5 + 2.5 * (e.mult / maxMult)}
              strokeLinecap="round" strokeDasharray="3 5" className="scenario-spread-edge" />
          );
        })}
        {SIDO_LABELS.map((s) => {
          const r = regionByCode.get(s.code);
          const pt = centroids.get(s.code);
          if (!pt) return null;
          const level = r ? levelAt(r, week) : 'G0';
          const rad = 3 + (r ? scoreAt(r, week) : 0) * 9;
          const isOrigin = primaryZones.includes(s.code);
          return (
            <g key={s.code}>
              {isOrigin && (
                <circle cx={pt[0]} cy={pt[1]} r={rad + 5} fill="none"
                  stroke="rgba(255,90,50,0.7)" strokeWidth={1.5} className="scenario-spread-origin" />
              )}
              <circle cx={pt[0]} cy={pt[1]} r={rad} fill={GLEVEL_COLORS[level] || GLEVEL_COLORS.G0}
                stroke="#fff" strokeWidth={1} filter={isOrigin ? 'url(#spread-glow)' : undefined}
                style={{ transition: 'r 0.7s ease, fill 0.7s ease' }} />
              <text x={pt[0]} y={pt[1] - rad - 3} textAnchor="middle" fontSize={9} fontWeight={700}
                fill="#e5e7eb" stroke="rgba(0,0,0,0.6)" strokeWidth={2} paintOrder="stroke"
                style={{ pointerEvents: 'none' }}>{s.abbr}</text>
            </g>
          );
        })}
      </svg>
      <div className="scenario-spread-legend">
        <span><i className="ssl-origin" /> 해외유입 거점(항공): {entryLabel}</span>
        <span><i className="ssl-edge" /> 확산 경로 (굵기 = 교통 연결성·인접성)</span>
        <span><i className="ssl-node" /> 시도 위험도 (크기 = 예측 점수)</span>
      </div>
    </div>
  );
}

// ─── National Outbreak Analysis Panel (results in analysis area) ──────────

function NationalAnalysisPanel({ result }: { result: NationalOutbreakResult }) {
  const g = result.gemini_scenario;
  const ep = result.entry_point;

  // Build before/after maps from region results (null-safe)
  const regions = result.regions || [];
  const baselineLevels = regions.map((r) => ({ code: r.region_id, level: r.baseline_level }));
  const scenarioLevels = regions.map((r) => ({ code: r.region_id, level: r.scenario_level }));
  // Highlight all primary zone + escalated regions on the "after" map
  const highlightCodes = new Set([
    ...(ep?.primary_zones || []),
    ...regions.filter((r) => r.level_changed).map((r) => r.region_id),
  ]);

  // Sensitivity cells come from the backend sweep, now centered on the chosen base
  // (±0.3) with the chosen value as the selected middle point.
  const sensCells = result.summary?.traffic_sensitivity || null;
  const sensSelectedBase = sensCells?.find((c) => c.is_selected)?.base ?? result.scenario?.traffic_base ?? 0.5;

  return (
    <div className="whatif-analysis-panel">
      {/* Header */}
      <div className="whatif-analysis-header">
        <span className="whatif-analysis-tag">NATIONAL SPREAD SCENARIO</span>
        <span className="whatif-analysis-region">{ep?.label || ep?.code || '—'}</span>
        <span className="whatif-analysis-scenario">
          {result.scenario?.disease} / {result.scenario?.country} / {result.scenario?.severity}
        </span>
        {result.scenario?.proximity_source === 'aviation' && result.scenario?.aviation ? (
          <span className="whatif-mobility-badge whatif-mobility-badge--real" title="발생국→인천 실측 도착 여객량 기반 이동량">
            실측 여객 {result.scenario.aviation.country_kr} {result.scenario.aviation.arr_passengers?.toLocaleString()}명/{result.scenario.aviation.month} · ×{result.scenario.proximity_multiplier}
          </span>
        ) : (
          <span className="whatif-mobility-badge" title="하드코딩 이동량 proxy (항공상황 add 미적용)">
            이동량 proxy · ×{result.scenario?.proximity_multiplier}
          </span>
        )}
        {result.scenario?.traffic_source === 'highway' && (
          <span className="whatif-mobility-badge whatif-mobility-badge--real" title="고속도로 실측 도착 교통량 기반 지역 연결성을 확산 배수에 반영">
            교통 연결성 반영(실측)
          </span>
        )}
        {result.scenario?.weather_source === 'kma' && (
          <span className="whatif-mobility-badge whatif-mobility-badge--real" title="기상청 실측 기온·절대습도 기반 계절 전파력 반영">
            기상 전파력 반영(실측)
          </span>
        )}
      </div>

      {/* Summary bar */}
      <div className="national-summary-bar">
        <div className="national-summary-stat">
          <span className="national-summary-num">{result.summary?.escalated_count ?? 0}</span>
          <span className="national-summary-label">G-level 상향 지역</span>
        </div>
        <div className="national-summary-stat">
          <span className="national-summary-num">+{(result.summary?.total_delta ?? 0).toFixed(3)}</span>
          <span className="national-summary-label">전국 총 Delta</span>
        </div>
        <div className="national-summary-stat">
          <span className="national-summary-num">{ep?.primary_zones?.length ?? 0}</span>
          <span className="national-summary-label">1차 영향 지역</span>
        </div>
      </div>

      {/* Hero figure: animated spread across the landing 시도 map */}
      {regions.length > 0 && (
        <div className="whatif-section">
          <div className="whatif-section-title">확산 시뮬레이션 · 항공 유입 → 교통 연결성·인접성 확산</div>
          <ScenarioSpreadMap regions={regions} primaryZones={ep?.primary_zones || []}
            entryLabel={ep?.label || ep?.code || '유입 거점'} />
        </div>
      )}

      {/* Connectivity-base sensitivity — escalated-region count at base 0.3/0.5/0.7 (+chosen) */}
      {sensCells && (
        <div className="traffic-sensitivity">
          <span className="traffic-sensitivity-label">연결성 base 민감도 · 상향 지역 수</span>
          <div className="traffic-sensitivity-cells">
            {sensCells.map((s) => (
              <div key={s.base} className={`traffic-sensitivity-cell ${s.is_selected ? 'is-selected' : ''}`}>
                <span className="tsc-base">{s.base.toFixed(2)} {s.is_selected ? '선택' : s.base < sensSelectedBase ? '허브집중' : '광역'}</span>
                <span className="tsc-count">{s.escalated_count}개</span>
              </div>
            ))}
          </div>
          <span className="traffic-sensitivity-hint">선택값({(result.scenario?.traffic_base ?? 0.5).toFixed(2)}) 중심 ±0.3 이웃값의 상향 지역 수입니다. 값이 비슷할수록 base에 견고. 지도·표·애니메이션은 선택값 기준으로 계산됩니다.</span>
        </div>
      )}

      {/* Before/After Mini Maps — all regions shown */}
      <div className="whatif-minimap-pair">
        <ScenarioMiniMap regionLevels={baselineLevels} title="현재 (Baseline)" />
        <ScenarioMiniMap regionLevels={scenarioLevels}
          targetCode={Array.from(highlightCodes).join(',')}
          title="시나리오 적용 후" />
      </div>

      {/* Narrative */}
      <div className="ontology-decision-narrative">{result.narrative}</div>

      {/* Region ranking table (all 17) */}
      <div className="whatif-section">
        <div className="whatif-section-title">지역별 위험도 변화 (Delta 순)</div>
        <div className="national-region-table">
          <div className="national-region-header">
            <span>지역</span><span>현재</span><span>시나리오</span><span>Delta</span><span>Spread</span>
          </div>
          {regions.map((r) => (
            <div key={r.region_id} className={`national-region-row ${r.level_changed ? 'escalated' : ''} ${r.is_primary_zone ? 'primary' : ''}`}>
              <span className="national-region-name">
                {r.is_primary_zone && <span className="national-primary-badge">1차</span>}
                {r.region_name}
              </span>
              <span><LevelPill level={r.baseline_level} /> {r.baseline_score.toFixed(3)}</span>
              <span><LevelPill level={r.scenario_level} /> {r.scenario_score.toFixed(3)}</span>
              <span className={`whatif-comp-delta ${r.max_delta > 0 ? 'up' : ''}`}>
                +{r.max_delta.toFixed(3)}{r.level_changed && ' ⚠'}
              </span>
              <span className="national-spread-mult">×{r.spread_multiplier.toFixed(2)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Gemini national narrative */}
      {g && !g.error && !g.parse_error && (
        <div className="whatif-gemini">
          {g.impact_summary && (
            <div className="whatif-section">
              <div className="whatif-section-title">Impact Summary</div>
              <p>{g.impact_summary}</p>
            </div>
          )}
          {g.spread_pattern && (
            <div className="whatif-section">
              <div className="whatif-section-title">Spread Pattern</div>
              <p>{g.spread_pattern}</p>
            </div>
          )}
          {g.timeline && g.timeline.length > 0 && (
            <div className="whatif-section">
              <div className="whatif-section-title">Timeline Scenario</div>
              {g.timeline.map((t, i) => (
                <div key={i} className="whatif-timeline-item">
                  {t.week != null && <span className="whatif-timeline-week">+{t.week}w</span>}
                  <span>{t.description}</span>
                </div>
              ))}
            </div>
          )}
          {g.high_risk_regions && g.high_risk_regions.length > 0 && (
            <div className="whatif-section">
              <div className="whatif-section-title">High Risk Regions</div>
              {g.high_risk_regions.map((hr, i) => (
                <div key={i} className="whatif-action-item">
                  <span className="ontology-pill ontology-rec-priority-HIGH">{hr.region}</span>
                  <span className="whatif-action-text">{hr.reason}</span>
                </div>
              ))}
            </div>
          )}
          {g.response_actions && (
            <div className="whatif-section">
              <div className="whatif-section-title">Response Actions</div>
              {g.response_actions.map((a, i) => (
                <div key={i} className="whatif-action-item">
                  {a.priority && <span className={`ontology-pill ontology-rec-priority-${a.priority?.toUpperCase()}`}>{a.priority}</span>}
                  <span className="whatif-action-text">{a.action}</span>
                  {a.timing && <span className="whatif-action-timing">{a.timing}</span>}
                </div>
              ))}
            </div>
          )}
          {(g.best_case || g.worst_case) && (
            <div className="whatif-section whatif-cases">
              {g.best_case && <div className="whatif-case best">Best case: {g.best_case}</div>}
              {g.worst_case && <div className="whatif-case worst">Worst case: {g.worst_case}</div>}
            </div>
          )}
          {g.risk_factors && (
            <div className="whatif-section">
              <div className="whatif-section-title">Risk Factors</div>
              <ul className="whatif-risk-list">
                {g.risk_factors.map((rf, i) => <li key={i}>{rf}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
      {g?.error && <div className="ontology-decision-error">{g.error}</div>}
    </div>
  );
}

// ─── Signal Lead-Lag panel (all 5 at once) ────────────────────────────────

const SIGNAL_PAIRS = [
  { a: 'wastewater_pathogen', b: 'influenza_like', label: 'Wastewater → ILI' },
  { a: 'wastewater_pathogen', b: 'sari_pneumonia', label: 'Wastewater → SARI Pneumonia' },
  { a: 'wastewater_pathogen', b: 'notifiable_disease', label: 'Wastewater → Notifiable' },
  { a: 'influenza_like', b: 'sari_influenza', label: 'ILI → SARI Influenza' },
  { a: 'notifiable_disease', b: 'sari_pneumonia', label: 'Notifiable → SARI Pneumonia' },
];

function LeadLagCorrelationChart({ correlations, labelA, labelB }: {
  correlations: LeadLagCorrelation[]; labelA: string; labelB: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || correlations.length === 0) return;
    const width = containerRef.current.clientWidth || 400;
    const height = 120;
    const margin = { top: 10, right: 12, bottom: 28, left: 32 };
    const w = width - margin.left - margin.right;
    const h = height - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('width', width).attr('height', height);
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const x = d3.scaleBand()
      .domain(correlations.map((c) => String(c.lag)))
      .range([0, w]).padding(0.2);
    const y = d3.scaleLinear()
      .domain([-1, 1]).range([h, 0]);

    // Zero line
    g.append('line').attr('x1', 0).attr('x2', w)
      .attr('y1', y(0)).attr('y2', y(0))
      .attr('stroke', 'rgba(148,163,184,0.4)').attr('stroke-dasharray', '3,3');

    // Bars
    g.selectAll('.bar').data(correlations).enter().append('rect')
      .attr('x', (d) => x(String(d.lag)) || 0)
      .attr('y', (d) => d.correlation >= 0 ? y(d.correlation) : y(0))
      .attr('width', x.bandwidth())
      .attr('height', (d) => Math.abs(y(d.correlation) - y(0)))
      .attr('fill', (d) => d.correlation >= 0 ? 'rgba(56,189,248,0.7)' : 'rgba(251,113,133,0.7)')
      .attr('rx', 2);

    // Best lag highlight
    const best = correlations.reduce((a, b) => Math.abs(a.correlation) > Math.abs(b.correlation) ? a : b);
    g.append('rect')
      .attr('x', (x(String(best.lag)) || 0) - 2)
      .attr('y', best.correlation >= 0 ? y(best.correlation) - 2 : y(0) - 2)
      .attr('width', x.bandwidth() + 4)
      .attr('height', Math.abs(y(best.correlation) - y(0)) + 4)
      .attr('fill', 'none').attr('stroke', '#f59e0b').attr('stroke-width', 2).attr('rx', 3);

    // X axis
    g.append('g').attr('transform', `translate(0,${h})`)
      .call(d3.axisBottom(x).tickFormat((d) => `${+d > 0 ? '+' : ''}${d}`))
      .selectAll('text').attr('fill', '#94a3b8').attr('font-size', '8px');
    g.append('text').attr('x', w / 2).attr('y', h + 24)
      .attr('text-anchor', 'middle').attr('font-size', '8px').attr('fill', '#64748b')
      .text(`← ${labelB} leads | lag (weeks) | ${labelA} leads →`);

    // Y axis
    g.append('g').call(d3.axisLeft(y).ticks(3).tickFormat((d) => String(d)))
      .selectAll('text').attr('fill', '#94a3b8').attr('font-size', '8px');

    svg.selectAll('.domain').attr('stroke', 'rgba(148,163,184,0.25)');
    svg.selectAll('.tick line').attr('stroke', 'rgba(148,163,184,0.15)');
  }, [correlations, labelA, labelB]);

  return (
    <div ref={containerRef} className="ontology-chart-container" style={{ minHeight: 120 }}>
      <svg ref={svgRef} />
    </div>
  );
}

function LeadLagAllPairs() {
  const [results, setResults] = useState<(LeadLagResult | null)[]>(Array(SIGNAL_PAIRS.length).fill(null));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all(
      SIGNAL_PAIRS.map(async (pair) => {
        try {
          const r = await fetch(`${API_BASE}/ontology/functions/signalLeadLag`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inputs: { signal_a: pair.a, signal_b: pair.b } }),
          });
          const d = await r.json();
          return (d.result || d) as LeadLagResult;
        } catch {
          return null;
        }
      })
    ).then((all) => {
      if (!cancelled) { setResults(all); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="ontology-pane-loading">Computing all 5 cross-correlations...</div>;

  return (
    <div className="leadlag-all-grid">
      {results.map((res, i) => (
        <div key={i} className="leadlag-card">
          <div className="leadlag-card-title">{SIGNAL_PAIRS[i].label}</div>
          {res && !res.error ? (
            <>
              <LeadLagCorrelationChart
                correlations={res.correlations}
                labelA={res.label_a} labelB={res.label_b}
              />
              <div className="leadlag-summary">
                <span>Best: <strong>{res.best_lag.lag > 0 ? '+' : ''}{res.best_lag.lag}w</strong></span>
                <span>r = <strong>{res.best_lag.correlation.toFixed(3)}</strong></span>
                <span className={`ontology-pill ontology-pill-strength-${res.best_lag.strength}`}>
                  {res.best_lag.strength_kr}
                </span>
                <span>{res.data_points}pts</span>
              </div>
            </>
          ) : (
            <div className="ontology-decision-error">{res?.error || 'Failed'}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Integrated Forecast Report panel ───────────────────────────────────────

function ForecastReportPanel({ regionId, isAdmin, adminHeaders }: {
  regionId: string; isAdmin: boolean; adminHeaders: () => Promise<Record<string, string>>;
}) {
  const [report, setReport] = useState<ForecastReport | null>(null);
  const [loading, setLoading] = useState(false);

  const generate = async () => {
    setLoading(true); setReport(null);
    try {
      const r = await fetch(`${API_BASE}/ontology/functions/generateForecastReport`, {
        method: 'POST', headers: await adminHeaders(),
        body: JSON.stringify({ inputs: { region_id: regionId } }),
      });
      const d = await r.json();
      setReport(d.result || d);
    } catch (e: any) {
      setReport({ report: {}, data_sources: {}, narrative: '', error: String(e?.message || e) });
    } finally { setLoading(false); }
  };

  if (!report) {
    return (
      <div className="ontology-decision-block">
        <div className="forecast-report-desc">
          Decomposition + EMA + SARIMAX + Hotspots + Lead-Lag 분석 결과를 종합하여
          Gemini 기반 통합 예측 보고서를 생성합니다.
        </div>
        <button type="button" className="ontology-generate-btn ontology-generate-btn--report"
          onClick={generate} disabled={!isAdmin || loading}>
          {loading ? 'Generating report...' : isAdmin ? 'Generate Integrated Report (Gemini)' : 'Admin only'}
        </button>
      </div>
    );
  }

  if (report.error) {
    return (
      <div className="ontology-decision-block">
        <div className="ontology-decision-error">{report.error}</div>
        <button className="ontology-generate-btn" onClick={generate} disabled={loading}>Retry</button>
      </div>
    );
  }

  const rpt = report.report;
  return (
    <div className="ontology-decision-block forecast-report">
      {rpt.executive_summary && (
        <div className="forecast-report-section">
          <div className="forecast-report-label">EXECUTIVE SUMMARY</div>
          <p>{rpt.executive_summary}</p>
        </div>
      )}
      {rpt.risk_assessment && (
        <div className="forecast-report-section">
          <div className="forecast-report-label">RISK ASSESSMENT</div>
          <p>{rpt.risk_assessment}</p>
        </div>
      )}
      {rpt.forecast_consensus && (
        <div className="forecast-report-section">
          <div className="forecast-report-label">FORECAST CONSENSUS (EMA vs SARIMAX)</div>
          <p>{rpt.forecast_consensus}</p>
        </div>
      )}
      {rpt.early_warning && (
        <div className="forecast-report-section">
          <div className="forecast-report-label">EARLY WARNING SIGNAL</div>
          <p>{rpt.early_warning}</p>
        </div>
      )}
      {rpt.action_items && rpt.action_items.length > 0 && (
        <div className="forecast-report-section">
          <div className="forecast-report-label">ACTION ITEMS</div>
          <ul className="forecast-report-actions">
            {rpt.action_items.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        </div>
      )}
      {rpt.outlook && (
        <div className="forecast-report-section forecast-report-outlook">
          <div className="forecast-report-label">4-WEEK OUTLOOK</div>
          <p>{rpt.outlook}</p>
        </div>
      )}
      <button className="ontology-generate-btn ontology-generate-btn--regen"
        onClick={generate} disabled={loading}>Regenerate</button>
    </div>
  );
}

// ─── Lead-Lag Explanation ──────────────────────────────────────────────────

function LeadLagExplainer() {
  return (
    <div className="ontology-decision-block leadlag-explainer">
      <div className="leadlag-explainer-title">Lead-Lag 분석이란?</div>
      <div className="leadlag-explainer-body">
        두 감시 신호 간의 <strong>시간적 선후 관계</strong>를 정규화 교차상관(normalized cross-correlation)으로 측정합니다.
        Lag = -N이면 Signal A가 Signal B보다 N주 <strong>앞서</strong> 움직이고 (선행 지표),
        Lag = +N이면 A가 B보다 N주 <strong>뒤에</strong> 따라갑니다.
      </div>
      <div className="leadlag-explainer-how">
        <strong>해석 방법:</strong> 상관계수가 높고(|r| &gt; 0.5) 음의 lag에서 피크가 나타나면,
        해당 선행 신호의 변화가 후행 신호의 향후 움직임을 <em>예고</em>하는 조기경보로 활용할 수 있습니다.
        예: 하수 병원체 → ILI의 lag = -2 (r = 0.7)이면, 하수 데이터 상승 2주 후 ILI 환자가 증가할 가능성이 높습니다.
      </div>
    </div>
  );
}

// ─── Disease Integrated Forecast Report ────────────────────────────────────

function DiseaseForecastReportPanel({ diseaseId, isAdmin, adminHeaders }: {
  diseaseId: string; isAdmin: boolean; adminHeaders: () => Promise<Record<string, string>>;
}) {
  const [report, setReport] = useState<ForecastReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [cachedAt, setCachedAt] = useState<string | null>(null);

  // Auto-load cached report on mount / disease change
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/ontology/disease-forecast-reports/${diseaseId}`);
        if (r.ok && !cancelled) {
          const d = await r.json();
          setReport(d);
          setCachedAt(d.generated_at || null);
        }
      } catch { /* no cached report — that's fine */ }
    })();
    return () => { cancelled = true; };
  }, [diseaseId]);

  const generate = async () => {
    setLoading(true); setReport(null); setCachedAt(null);
    try {
      const r = await fetch(`${API_BASE}/ontology/functions/generateDiseaseForecastReport`, {
        method: 'POST', headers: await adminHeaders(),
        body: JSON.stringify({ inputs: { disease_id: diseaseId } }),
      });
      const d = await r.json();
      setReport(d.result || d);
    } catch (e: any) {
      setReport({ report: {}, data_sources: {}, narrative: '', error: String(e?.message || e) });
    } finally { setLoading(false); }
  };

  if (!report) {
    return (
      <div className="ontology-decision-block">
        <div className="forecast-report-desc">
          EMA + SARIMAX 이중 모델 예측 결과 + Lead-Lag 조기경보 분석을 종합하여
          해당 질병의 Gemini 기반 통합 예측 보고서를 생성합니다.
        </div>
        <button type="button" className="ontology-generate-btn ontology-generate-btn--report"
          onClick={generate} disabled={!isAdmin || loading}>
          {loading ? 'Generating report...' : isAdmin ? 'Generate Integrated Report (Gemini)' : 'Admin only'}
        </button>
      </div>
    );
  }

  if (report.error) {
    return (
      <div className="ontology-decision-block">
        <div className="ontology-decision-error">{report.error}</div>
        <button className="ontology-generate-btn" onClick={generate} disabled={loading}>Retry</button>
      </div>
    );
  }

  const rpt = report.report;
  return (
    <div className="ontology-decision-block forecast-report">
      {cachedAt && (
        <div className="forecast-report-cached-badge">
          Auto-generated: {new Date(cachedAt).toLocaleString('ko-KR')}
        </div>
      )}
      {rpt.executive_summary && (
        <div className="forecast-report-section">
          <div className="forecast-report-label">EXECUTIVE SUMMARY</div>
          <p>{rpt.executive_summary}</p>
        </div>
      )}
      {rpt.risk_assessment && (
        <div className="forecast-report-section">
          <div className="forecast-report-label">RISK ASSESSMENT</div>
          <p>{rpt.risk_assessment}</p>
        </div>
      )}
      {rpt.forecast_consensus && (
        <div className="forecast-report-section">
          <div className="forecast-report-label">FORECAST CONSENSUS (EMA vs SARIMAX)</div>
          <p>{rpt.forecast_consensus}</p>
        </div>
      )}
      {rpt.early_warning && (
        <div className="forecast-report-section">
          <div className="forecast-report-label">EARLY WARNING SIGNAL</div>
          <p>{rpt.early_warning}</p>
        </div>
      )}
      {rpt.action_items && rpt.action_items.length > 0 && (
        <div className="forecast-report-section">
          <div className="forecast-report-label">ACTION ITEMS</div>
          <ul className="forecast-report-actions">
            {rpt.action_items.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        </div>
      )}
      {rpt.outlook && (
        <div className="forecast-report-section forecast-report-outlook">
          <div className="forecast-report-label">4-WEEK OUTLOOK</div>
          <p>{rpt.outlook}</p>
        </div>
      )}
      {isAdmin && (
        <button className="ontology-generate-btn ontology-generate-btn--regen"
          onClick={generate} disabled={loading}>
          {loading ? 'Regenerating...' : 'Regenerate'}
        </button>
      )}
    </div>
  );
}

// ─── Main view ──────────────────────────────────────────────────────────────

export default function OntologyView() {
  const { isAdmin, getIdToken } = useAuth();
  const [schema, setSchema] = useState<OntologySchema | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [instances, setInstances] = useState<Record<string, any>[]>([]);
  const [loadingInstances, setLoadingInstances] = useState(false);
  const [selectedInstance, setSelectedInstance] = useState<InstanceDetail | null>(null);
  const [loadingInstance, setLoadingInstance] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [whatIfMode, setWhatIfMode] = useState(false);

  // What-If result state (national outbreak)
  const [whatIfResult, setWhatIfResult] = useState<NationalOutbreakResult | null>(null);

  // Decision state
  const [decomposition, setDecomposition] = useState<DecompositionResult | null>(null);
  const [forecastEMA, setForecastEMA] = useState<ForecastResult | null>(null);
  const [forecastSARIMAX, setForecastSARIMAX] = useState<ForecastResult | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendationsResult | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [hotspots, setHotspots] = useState<HotspotsResult | null>(null);
  const [diseaseForecastEMA, setDiseaseForecastEMA] = useState<ForecastResult | null>(null);
  const [diseaseForecastSARIMAX, setDiseaseForecastSARIMAX] = useState<ForecastResult | null>(null);

  const adminHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = await getIdToken();
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [getIdToken]);

  useEffect(() => {
    fetch(`${API_BASE}/ontology/schema`)
      .then((r) => r.json()).then(setSchema).catch(() => {});
  }, []);

  function resetDecision() {
    setDecomposition(null); setForecastEMA(null); setForecastSARIMAX(null);
    setRecommendations(null); setHotspots(null);
    setDiseaseForecastEMA(null); setDiseaseForecastSARIMAX(null);
  }

  useEffect(() => {
    if (!selectedType) {
      setInstances([]); setSelectedInstance(null); resetDecision(); return;
    }
    if (selectedType === 'WhatIf') {
      setWhatIfMode(true); setInstances([]); setSelectedInstance(null); resetDecision();
      setWhatIfResult(null);
      return;
    }
    setWhatIfMode(false);
    setLoadingInstances(true); setSelectedInstance(null); resetDecision();
    fetch(`${API_BASE}/ontology/objects/${selectedType}`)
      .then((r) => r.json())
      .then((d) => setInstances(d.instances || []))
      .catch(() => setInstances([]))
      .finally(() => setLoadingInstances(false));
  }, [selectedType]);

  // Load instance — takes explicit typeOverride to fix hotspot→Region navigation
  const loadInstance = useCallback((id: string, typeOverride?: string) => {
    const typeId = typeOverride || selectedType;
    if (!typeId || !id) return;
    setLoadingInstance(true); resetDecision();
    fetch(`${API_BASE}/ontology/objects/${typeId}/${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((data) => {
        setSelectedInstance(data);
        if (data.type_id === 'Region') {
          const rid = String(data.instance.code ?? data.instance.id ?? '');
          // Decomposition
          fetch(`${API_BASE}/ontology/functions/decomposeRegionScore`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inputs: { region_id: rid } }),
          }).then((r) => r.json()).then((d) => setDecomposition(d.result || d));
          // EMA forecast
          fetch(`${API_BASE}/ontology/functions/forecastRegionScore`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inputs: { region_id: rid, weeks: 4 } }),
          }).then((r) => r.json()).then((d) => setForecastEMA(d.result || d));
          // SARIMAX forecast
          fetch(`${API_BASE}/ontology/functions/forecastRegionSARIMAX`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inputs: { region_id: rid, weeks: 4 } }),
          }).then((r) => r.json()).then((d) => setForecastSARIMAX(d.result || d));
        } else if (data.type_id === 'Snapshot') {
          fetch(`${API_BASE}/ontology/functions/topRiskHotspots`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inputs: { weeks: 4, top_n: 5 } }),
          }).then((r) => r.json()).then((d) => setHotspots(d.result || d));
        } else if (data.type_id === 'Disease') {
          const did = String(data.instance.id ?? '');
          // Fire BOTH models in parallel
          fetch(`${API_BASE}/ontology/functions/forecastDiseaseTrend`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inputs: { disease_id: did, weeks: 4 } }),
          }).then((r) => r.json()).then((d) => setDiseaseForecastEMA(d.result || d));
          fetch(`${API_BASE}/ontology/functions/forecastDiseaseSARIMAX`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inputs: { disease_id: did, weeks: 4 } }),
          }).then((r) => r.json()).then((d) => setDiseaseForecastSARIMAX(d.result || d));
        }
      })
      .catch(() => setSelectedInstance(null))
      .finally(() => setLoadingInstance(false));
  }, [selectedType]);

  const generateRecommendations = useCallback(async () => {
    if (!selectedInstance || selectedInstance.type_id !== 'Region') return;
    const rid = String(selectedInstance.instance.code ?? selectedInstance.instance.id ?? '');
    setRecLoading(true);
    try {
      const r = await fetch(`${API_BASE}/ontology/functions/regionRecommendations`, {
        method: 'POST', headers: await adminHeaders(),
        body: JSON.stringify({ inputs: { region_id: rid } }),
      });
      const d = await r.json();
      setRecommendations(d.result || d);
    } catch (e: any) {
      setRecommendations({ region_id: rid, recommendations: [], error: String(e?.message || e) });
    } finally { setRecLoading(false); }
  }, [selectedInstance, adminHeaders]);

  // Navigate from Hotspot → Region (fixed: explicit type override)
  const navigateToRegion = useCallback((regionId: string) => {
    setSelectedType('Region');
    setWhatIfMode(false);
    // Fetch instances list first, then load the specific region
    fetch(`${API_BASE}/ontology/objects/Region`)
      .then((r) => r.json())
      .then((d) => {
        setInstances(d.instances || []);
        loadInstance(regionId, 'Region');
      });
  }, [loadInstance]);

  const filteredInstances = useMemo(() => {
    if (!filterText.trim()) return instances;
    const q = filterText.toLowerCase();
    return instances.filter((i) =>
      Object.values(i).some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [instances, filterText]);

  const currentTypeMeta = useMemo(
    () => schema?.object_types.find((t) => t.id === selectedType) || null,
    [schema, selectedType],
  );

  if (!schema) {
    return <div className="ontology-view"><div className="ontology-loading">Loading...</div></div>;
  }

  const titleOf = (inst: Record<string, any>) =>
    inst.name_kr || inst.title || inst.label || inst.name || inst.filename || inst.id;

  const regionId = selectedInstance?.type_id === 'Region'
    ? String(selectedInstance.instance.code ?? selectedInstance.instance.id ?? '')
    : '';

  return (
    <div className="ontology-view">
      {/* ── LEFT SIDEBAR: header + types + instances ── */}
      <div className="ontology-sidebar">
        {/* Header */}
        <div className="ontology-sidebar-header">
          <span className="ontology-kicker">SENTINEL FORECASTING</span>
          <h2>Decision Intelligence</h2>
          <p>
            Region/Disease/Snapshot 기반 예측 분석 시스템. 질병별 <strong>EMA + SARIMAX 이중 모델</strong> 비교,
            지역별 4주 예측 + Gemini AI 추천, Outbreak Scenario, Lead-Lag 조기경보.
          </p>
          <div className="ontology-header-features">
            <span>EMA+Momentum</span>
            <span>SARIMAX(1,1,1)</span>
            <span>Outbreak Scenario</span>
            <span>Lead-Lag</span>
            <span>Gemini AI</span>
          </div>
        </div>

        {/* Object Types */}
        <div className="ontology-sidebar-section">
          <div className="ontology-pane-title">OBJECT TYPES</div>
          <div className="ontology-type-list">
            {/* Order: Disease & Outbreak Scenario first (most useful, emphasized), then Region, Snapshot */}
            {(['Disease', 'WhatIf', 'Region', 'Snapshot'] as const).map((tabId) => {
              const featured = tabId === 'Disease' || tabId === 'WhatIf';
              if (tabId === 'WhatIf') {
                return (
                  <button key="WhatIf"
                    className={`ontology-type-card ontology-type-card--featured ${selectedType === 'WhatIf' ? 'is-active' : ''}`}
                    onClick={() => setSelectedType('WhatIf')}
                    style={{ borderLeftColor: '#fb7185' }} type="button">
                    <div className="ontology-type-card-row">
                      <span className="ontology-type-card-name">Outbreak Scenario</span>
                    </div>
                    <div className="ontology-type-card-kr">가상 유입 시나리오 분석</div>
                    <div className="ontology-type-card-desc">
                      해외 신종 감염병이 국내로 유입되는 상황을 가정해, 공항 유입 거점에서 전국 17개 시도로 퍼지는 확산을 시뮬레이션합니다. 인천공항 실측 여객량(해외유입 위험)과 고속도로 교통 연결성(국내 확산)을 반영하며, 주별 확산 애니메이션과 base 민감도 분석까지 제공합니다.
                    </div>
                  </button>
                );
              }
              const t = schema.object_types.find((o) => o.id === tabId);
              if (!t) return null;
              const desc = TYPE_DESCRIPTIONS[t.id];
              return (
                <button key={t.id}
                  className={`ontology-type-card ${featured ? 'ontology-type-card--featured' : ''} ${selectedType === t.id ? 'is-active' : ''}`}
                  onClick={() => setSelectedType(t.id)} style={{ borderLeftColor: t.color }} type="button">
                  <div className="ontology-type-card-row">
                    <span className="ontology-type-card-name">{t.label}</span>
                    <span className="ontology-type-card-count" style={{ color: t.color }}>{t.instance_count}</span>
                  </div>
                  <div className="ontology-type-card-kr">{t.label_kr}</div>
                  {desc && <div className="ontology-type-card-desc">{desc.desc_kr}</div>}
                </button>
              );
            })}
          </div>
        </div>

      </div>

      {/* ── RIGHT MAIN: Instances (top) + Forecasting & Analysis (below) ── */}
      <div className="ontology-main">
        {/* Instances column (narrow left panel) */}
        <div className={`ontology-instances-col ${whatIfMode ? 'is-scenario' : ''}`}>
          <div className="ontology-instances-col-header">
            <div className="ontology-pane-title">
              {whatIfMode
                ? <>OUTBREAK SCENARIO</>
                : <>INSTANCES{currentTypeMeta && <span className="ontology-pane-subtitle"> · {currentTypeMeta.label}</span>}</>
              }
            </div>
          </div>
          {whatIfMode ? (
            <WhatIfStandalonePanel isAdmin={isAdmin} adminHeaders={adminHeaders}
              onResult={(result) => { setWhatIfResult(result); }} />
          ) : selectedType ? (
            <>
              <input className="ontology-filter-input" placeholder="Filter..."
                value={filterText} onChange={(e) => setFilterText(e.target.value)} />
              {loadingInstances ? <div className="ontology-pane-loading">Loading...</div>
              : filteredInstances.length === 0 ? <div className="ontology-pane-empty">No instances.</div>
              : (
                <div className="ontology-instance-list">
                  {filteredInstances.map((inst) => {
                    const id = String(inst.id ?? inst.code ?? '?');
                    const isActive = selectedInstance?.instance?.id === inst.id
                      || String(selectedInstance?.instance?.code) === id;
                    return (
                      <button key={id}
                        className={`ontology-instance-row ${isActive ? 'is-active' : ''}`}
                        onClick={() => loadInstance(id)} type="button">
                        <div className="ontology-instance-row-title">{titleOf(inst)}</div>
                        <div className="ontology-instance-row-meta">
                          {selectedType === 'Region' && (
                            <><LevelPill level={inst.current_level} /><span>{(inst.current_score ?? 0).toFixed(2)}</span></>
                          )}
                          {selectedType === 'Disease' && (
                            <>
                              <span className={`ontology-pill ontology-pill-trend-${inst.trend}`}>
                                {inst.trend === 'rising' ? '↑' : inst.trend === 'falling' ? '↓' : '→'}
                              </span>
                              <span>{inst.latest_value != null ? inst.latest_value.toFixed(0) : '-'}</span>
                              <span className="ontology-instance-dim">{inst.data_points}pts</span>
                            </>
                          )}
                          {selectedType === 'Snapshot' && (
                            <><span>{inst.epiweek}</span><span>G3:{inst.g3_count} G2:{inst.g2_count} G1:{inst.g1_count}</span></>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="ontology-pane-footer">{filteredInstances.length} / {instances.length}</div>
            </>
          ) : (
            <div className="ontology-pane-empty">Select an object type.</div>
          )}
        </div>

        {/* Analysis area below */}
        <div className="ontology-analysis-area">
          <div className="ontology-main-title">FORECASTING & ANALYSIS</div>
          {whatIfMode ? (
            whatIfResult && !whatIfResult.error ? (
              <NationalAnalysisPanel result={whatIfResult} />
            ) : whatIfResult?.error ? (
              <div className="ontology-pane-empty">
                <div className="ontology-decision-error">{whatIfResult.error}</div>
              </div>
            ) : (
              <div className="ontology-pane-empty">시나리오를 실행하면 결과가 여기에 표시됩니다.</div>
            )
          ) : loadingInstance ? <div className="ontology-pane-loading">Loading...</div>
          : !selectedInstance ? (
            <div className="ontology-pane-empty">Select an instance to see forecasting + analysis.</div>
          ) : (
            <div className="ontology-detail">
              <div className="ontology-detail-meta">
                <span className="ontology-detail-type">{selectedInstance.type_id}</span>
                <h3>{titleOf(selectedInstance.instance)}</h3>
              </div>

              {/* ── Region ── */}
              {selectedInstance.type_id === 'Region' && (
                <>
                  {/* Row 1: Decomposition + Recommendations */}
                  <div className="detail-grid-2col">
                    <div className="detail-grid-cell">
                      <div className="ontology-detail-section-title">DRIVER DECOMPOSITION</div>
                      {decomposition ? <DecompositionPanel data={decomposition} /> : <div className="ontology-pane-loading">Computing...</div>}
                    </div>
                    <div className="detail-grid-cell">
                      <div className="ontology-detail-section-title">RECOMMENDATIONS (Gemini)</div>
                      <RecommendationsPanel data={recommendations} loading={recLoading} isAdmin={isAdmin} onGenerate={generateRecommendations} />
                    </div>
                  </div>

                  {/* Row 2: EMA + SARIMAX */}
                  <div className="detail-grid-2col">
                    <div className="detail-grid-cell">
                      <div className="ontology-detail-section-title">4-WEEK FORECAST — EMA + OUTBREAK</div>
                      {forecastEMA ? <ForecastPanel data={forecastEMA} /> : <div className="ontology-pane-loading">Computing EMA...</div>}
                    </div>
                    <div className="detail-grid-cell">
                      <div className="ontology-detail-section-title">4-WEEK FORECAST — SARIMAX(1,1,1)</div>
                      {forecastSARIMAX ? <ForecastPanel data={forecastSARIMAX} /> : <div className="ontology-pane-loading">Computing SARIMAX...</div>}
                    </div>
                  </div>

                  {/* Row 3: Lead-Lag + Integrated Report */}
                  <div className="detail-grid-2col">
                    <div className="detail-grid-cell">
                      <div className="ontology-detail-section-title">SIGNAL LEAD-LAG ANALYSIS</div>
                      <LeadLagExplainer />
                      <LeadLagAllPairs />
                    </div>
                    <div className="detail-grid-cell">
                      <div className="ontology-detail-section-title">INTEGRATED FORECAST REPORT</div>
                      <ForecastReportPanel regionId={regionId} isAdmin={isAdmin} adminHeaders={adminHeaders} />
                    </div>
                  </div>
                </>
              )}

              {/* ── Disease: DUAL MODEL ── */}
              {selectedInstance.type_id === 'Disease' && (
                <>
                  {/* Row 1: EMA + SARIMAX */}
                  <div className="detail-grid-2col">
                    <div className="detail-grid-cell">
                      <div className="ontology-detail-section-title">4-WEEK FORECAST — EMA + MOMENTUM</div>
                      {diseaseForecastEMA ? <ForecastPanel data={diseaseForecastEMA} /> : <div className="ontology-pane-loading">Computing EMA...</div>}
                    </div>
                    <div className="detail-grid-cell">
                      <div className="ontology-detail-section-title">4-WEEK FORECAST — SARIMAX(1,1,1)</div>
                      {diseaseForecastSARIMAX ? <ForecastPanel data={diseaseForecastSARIMAX} /> : <div className="ontology-pane-loading">Computing SARIMAX...</div>}
                    </div>
                  </div>

                  {/* Row 2: Lead-Lag + Integrated Report */}
                  <div className="detail-grid-2col">
                    <div className="detail-grid-cell">
                      <div className="ontology-detail-section-title">SIGNAL LEAD-LAG ANALYSIS</div>
                      <LeadLagExplainer />
                      <LeadLagAllPairs />
                    </div>
                    <div className="detail-grid-cell">
                      <div className="ontology-detail-section-title">INTEGRATED FORECAST REPORT</div>
                      <DiseaseForecastReportPanel
                        diseaseId={String(selectedInstance.instance.id ?? '')}
                        isAdmin={isAdmin} adminHeaders={adminHeaders} />
                    </div>
                  </div>
                </>
              )}

              {/* ── Snapshot ── */}
              {selectedInstance.type_id === 'Snapshot' && (
                <>
                  <div className="ontology-detail-section-title">TOP RISK HOTSPOTS (multi-week)</div>
                  {hotspots ? <HotspotsPanel data={hotspots} onPickRegion={navigateToRegion} /> : <div className="ontology-pane-loading">Computing forecasts...</div>}

                  <div className="ontology-detail-section-title">SIGNAL LEAD-LAG ANALYSIS</div>
                  <LeadLagExplainer />
                  <LeadLagAllPairs />
                </>
              )}

              {/* Properties (collapsible) */}
              <details className="ontology-detail-props-toggle">
                <summary className="ontology-detail-section-title" style={{ cursor: 'pointer' }}>PROPERTIES ▸</summary>
                <div className="ontology-detail-props">
                  {Object.entries(selectedInstance.instance)
                    .filter(([k]) => !k.startsWith('_'))
                    .map(([k, v]) => (
                      <div key={k} className="ontology-detail-prop">
                        <span className="ontology-detail-prop-key">{k}</span>
                        <span className="ontology-detail-prop-val">{v == null ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                      </div>
                    ))}
                </div>
              </details>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── National Outbreak Scenario panel (fills instances pane) ───────────────

const ENTRY_POINTS = [
  { code: 'ICN', label: '인천국제공항', desc: '수도권 (서울/인천/경기)' },
  { code: 'PUS', label: '김해국제공항', desc: '부산/경남' },
];

function WhatIfStandalonePanel({ isAdmin, adminHeaders, onResult }: {
  isAdmin: boolean; adminHeaders: () => Promise<Record<string, string>>;
  onResult?: (result: NationalOutbreakResult) => void;
}) {
  const [entryPoint, setEntryPoint] = useState('');
  const [disease, setDisease] = useState('');
  const [country, setCountry] = useState('');
  const [severity, setSeverity] = useState('');
  const [useAviation, setUseAviation] = useState(false);
  const [useTraffic, setUseTraffic] = useState(false);
  const [trafficUpdatedAt, setTrafficUpdatedAt] = useState<string | null>(null);
  const [trafficRefreshing, setTrafficRefreshing] = useState(false);
  const [trafficMsg, setTrafficMsg] = useState<string | null>(null);
  const [trafficBase, setTrafficBase] = useState(0.5);
  const [useWeather, setUseWeather] = useState(false);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const runNationalScenario = async () => {
    setLoading(true); setStatusMsg(null);
    try {
      const r = await fetch(`${API_BASE}/ontology/functions/whatIfOutbreakNational`, {
        method: 'POST', headers: await adminHeaders(),
        body: JSON.stringify({ inputs: { entry_point: entryPoint, disease, country, severity, weeks: 4, use_aviation: useAviation, use_traffic: useTraffic, traffic_base: trafficBase, use_weather: useWeather } }),
      });
      const d = await r.json();
      if (!r.ok) {
        setStatusMsg({ ok: false, text: d.detail || d.error || `Server error (${r.status})` });
        return;
      }
      const result = d.result || d;
      if (result.error) {
        setStatusMsg({ ok: false, text: result.error });
      } else {
        setStatusMsg({ ok: true, text: `${result.summary?.escalated_count || 0}개 지역 G-level 상향 예상 — 결과 확인 →` });
        onResult?.(result);
      }
    } catch (e: any) {
      setStatusMsg({ ok: false, text: String(e?.message || e) });
    } finally { setLoading(false); }
  };

  // Show the current traffic-connectivity 기준시각 (default = Monday pipeline).
  useEffect(() => {
    fetch(`${API_BASE}/signals/highway-connectivity`)
      .then((r) => r.json())
      .then((d) => { if (d && d.generated_at) setTrafficUpdatedAt(d.generated_at); })
      .catch(() => {});
  }, []);

  // On-demand '최신 반영' — re-fetch latest highway traffic (backend cooldown-guarded).
  const refreshTraffic = async () => {
    setTrafficRefreshing(true); setTrafficMsg(null);
    try {
      const r = await fetch(`${API_BASE}/ingestion/refresh-highway`, { method: 'POST' });
      const d = await r.json();
      const gen = d?.data?.generated_at;
      if (gen) setTrafficUpdatedAt(gen);
      if (d?.status === 'cooldown') {
        setTrafficMsg(`이미 최신 상태 (${Math.round((d.age_seconds || 0) / 60)}분 전 갱신)`);
      } else if (d?.refreshed) {
        setTrafficMsg('최신 교통 데이터 반영 완료');
      } else if (d?.status === 'skipped') {
        setTrafficMsg('HIGHWAY_API_KEY 미설정 — 수집 불가');
      } else {
        setTrafficMsg('갱신 실패 — 잠시 후 다시 시도');
      }
    } catch (e: any) {
      setTrafficMsg('갱신 실패 — ' + String(e?.message || e));
    } finally { setTrafficRefreshing(false); }
  };

  return (
    <div className="whatif-standalone">
      <div className="whatif-standalone-desc">
        <strong>전국 확산 시나리오</strong> — 해외 감염병이 한국에 유입된다면? 선택한 공항 거점에서 전국 17개 시도로의 확산 패턴을 시뮬레이션합니다. <strong>항공상황 add</strong>를 켜면 발생국의 <strong>인천공항 실측 여객량</strong>으로 이동량(전파 배수)을 객관화해 분석합니다 (끄면 기본 proxy 사용). <strong>교통상황 add</strong>를 켜면 <strong>고속도로 실측 도착 교통량</strong>으로 시도별 연결성을 확산 배수에 반영하고, <strong>기상상황 add</strong>를 켜면 <strong>기상청 실측 기온·절대습도</strong>로 계절 전파력을 반영합니다.<br />
        <span className="whatif-ref-note">참고: 항공 여객량 기반 해외유입 위험 추정은 BlueDot·GLEAM 등 국제 감염병 예측 모델의 표준 방식이며, 시도 간 이동량(연결성) 기반 국내 확산 추정은 COVID-19 시공간 확산 네트워크 연구(대한교통학회·감염 네트워크 연구)에, 기상(저온·저습) 기반 전파력 보정은 Shaman(2009 PNAS)·Shang(2026) 메타분석에 근거합니다.</span>
      </div>
      <div className="whatif-row">
        <label>유입 거점</label>
        <input list="entry-point-list" value={entryPoint} onChange={(e) => setEntryPoint(e.target.value)}
          className="whatif-input" placeholder="공항 코드 또는 직접 입력 (예: ICN, PUS, 무안공항)" />
        <datalist id="entry-point-list">
          {ENTRY_POINTS.map((ep) => (
            <option key={ep.code} value={ep.code}>{ep.label} — {ep.desc}</option>
          ))}
        </datalist>
      </div>
      <div className="whatif-row">
        <label>Disease</label>
        <input value={disease} onChange={(e) => setDisease(e.target.value)} className="whatif-input" placeholder="예: H5N1 Avian Influenza" />
      </div>
      <div className="whatif-row">
        <label>Country</label>
        <input value={country} onChange={(e) => setCountry(e.target.value)} className="whatif-input" placeholder="예: China" />
      </div>
      <div className="whatif-row">
        <label>Severity</label>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="whatif-select">
          <option value="" disabled>선택</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      </div>
      <label className={`whatif-aviation-toggle ${useAviation ? 'is-on' : ''}`}>
        <input type="checkbox" checked={useAviation} onChange={(e) => setUseAviation(e.target.checked)} />
        <span className="whatif-aviation-label">항공상황 add</span>
        <span className="whatif-aviation-hint">발생국 → 인천공항 실측 여객량으로 이동량(해외유입 위험) 객관화 (끄면 기본 proxy)</span>
      </label>
      <label className={`whatif-aviation-toggle ${useTraffic ? 'is-on' : ''}`}>
        <input type="checkbox" checked={useTraffic} onChange={(e) => setUseTraffic(e.target.checked)} />
        <span className="whatif-aviation-label">교통상황 add</span>
        <span className="whatif-aviation-hint">고속도로 실측 도착 교통량으로 지역 연결성을 확산 배수에 반영 — 연결성 높은 허브가 먼 거리도 빨리 확산(웜홀). 대한교통학회·감염 네트워크 연구 기반.</span>
      </label>
      {useTraffic && (
        <div className="whatif-traffic-controls">
          <div className="whatif-traffic-base">
            <label>연결성 base <strong className="whatif-base-val">{trafficBase.toFixed(2)}</strong></label>
            <input type="range" min={0} max={1} step={0.05} value={trafficBase}
              onChange={(e) => setTrafficBase(Number(e.target.value))}
              className="whatif-traffic-base-slider" />
            <div className="whatif-base-presets">
              {([[0.3, '허브집중'], [0.5, '기본'], [0.7, '광역']] as [number, string][]).map(([v, l]) => (
                <button key={v} type="button"
                  className={`whatif-base-preset ${Math.abs(trafficBase - v) < 1e-9 ? 'is-active' : ''}`}
                  onClick={() => setTrafficBase(v)}>{v} {l}</button>
              ))}
            </div>
            <details className="whatif-base-explain">
              <summary>연결성 base가 무엇인가요?</summary>
              <div className="whatif-base-explain-body">
                <p><strong>확산 배수 = base + 연결성(0~1)</strong>. base는 모든 지역에 공통으로 적용되는 <strong>기본 확산력(바닥값)</strong>이고, 여기에 각 지역의 고속도로 실측 <strong>연결성</strong>이 더해져 지역별 확산 배수가 정해집니다.</p>
                <ul>
                  <li><strong>base 높음(예 0.7)</strong> → 연결성 낮은 외진 지역도 배수↑ → <strong>전국 광역 확산</strong> 가정</li>
                  <li><strong>base 낮음(예 0.3)</strong> → 확산이 <strong>연결성 높은 허브에 집중</strong>, 외진 지역은 억제</li>
                  <li>예) base 0.5 → 서울(연결성 1.0) 배수 1.5 · 외진 지역(연결성 0.3) 배수 0.8</li>
                </ul>
                <p>정답이 정해진 값이 아니라 <strong>가정</strong>이므로, 실행 결과에 <strong>선택값 중심 ±0.3 민감도</strong>(예: 0.6 → 0.3/0.6/0.9)를 함께 표시해 값에 따라 결과가 얼마나 달라지는지(견고성)를 볼 수 있게 했습니다. 슬라이더로 임의값도 설정 가능합니다.</p>
              </div>
            </details>
          </div>
          <div className="whatif-traffic-refresh">
            <span className="whatif-traffic-updated">
              {trafficUpdatedAt
                ? `교통데이터 기준: ${new Date(trafficUpdatedAt).toLocaleString('ko-KR')}`
                : '교통데이터 미수집 (기본: 월요일 자동 갱신)'}
            </span>
            <button type="button" className="whatif-traffic-refresh-btn"
              onClick={refreshTraffic} disabled={trafficRefreshing}>
              {trafficRefreshing ? '갱신 중…' : '최신 반영'}
            </button>
            {trafficMsg && <span className="whatif-traffic-msg">{trafficMsg}</span>}
          </div>
        </div>
      )}
      <label className={`whatif-aviation-toggle ${useWeather ? 'is-on' : ''}`}>
        <input type="checkbox" checked={useWeather} onChange={(e) => setUseWeather(e.target.checked)} />
        <span className="whatif-aviation-label">기상상황 add</span>
        <span className="whatif-aviation-hint">기상청 실측 기온·절대습도로 계절 전파력을 반영 — 저온·저습일수록 확산↑. 기온이 최강 예측인자, 절대습도가 인플루엔자 계절성의 물리적 동인 (Shaman 2009 PNAS·Shang 2026 메타분석 기반).</span>
      </label>
      <div className="whatif-presets">
        {WHAT_IF_PRESETS.map((p, i) => (
          <button key={i} type="button" className="whatif-preset-btn"
            onClick={() => { setDisease(p.disease); setCountry(p.country); setSeverity(p.severity); }}>
            {p.disease.split(' ')[0]} / {p.country}
          </button>
        ))}
      </div>
      <button type="button" className="ontology-generate-btn" onClick={runNationalScenario}
        disabled={!isAdmin || loading}>
        {loading ? 'Simulating...' : isAdmin ? 'Run National Scenario (Gemini)' : 'Admin only'}
      </button>
      {statusMsg && (
        <div className={`whatif-status-msg ${statusMsg.ok ? 'whatif-status-success' : 'whatif-status-error'}`}>
          {statusMsg.text}
        </div>
      )}
    </div>
  );
}
