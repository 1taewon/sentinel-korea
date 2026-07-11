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
  diagnostics?: { aic?: number; bic?: number; rolling_mae?: number; validation_folds?: number };
  peak?: { date: string; value: number };
  narrative: string; error?: string; warning?: string;
}

interface DecompositionResult {
  contributions: { signal: string; label: string; value: number; weight: number; weighted_contribution: number; share_of_score: number }[];
  narrative: string; error?: string; warning?: string;
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
// WhatIfResult / WhatIfComparison removed — replaced by the SEIR epidemiological result.

// National outbreak epidemiological (SEIR) result
interface EpiTimelinePoint {
  day: number; cumulative_cases: number; new_cases: number; cumulative_deaths: number;
  attack_rate: number; effective_cfr: number; score: number; level: string;
}
interface NationalRegionResult {
  region_id: string; region_name: string;
  is_primary_zone?: boolean; is_seed?: boolean; population: number;
  cumulative_cases: number; cumulative_deaths: number; attack_rate: number; effective_cfr: number;
  scenario_level: string; spread_multiplier: number; connectivity?: number;
  timeline: EpiTimelinePoint[];
  error?: string;
}
interface ComparisonVariant {
  total_cases: number; total_deaths: number; attack_rate: number; affected_regions: number;
  national_curve: { day: number; cumulative_cases: number; cumulative_deaths: number }[];
  regions: { code: string; name: string; cumulative_cases: number; cumulative_deaths: number }[];
}
interface NationalOutbreakResult {
  entry_point: { code: string; label: string; primary_zones: string[]; seed_region?: string; seed_region_name?: string };
  scenario: { disease: string; disease_matched?: string; is_novel?: boolean; country: string;
    r0: number; cfr: number; r0_base?: number; cfr_base?: number; incubation_days?: number; infectious_days?: number;
    aviation?: { multiplier: number; arr_passengers: number; country_kr: string; month: string } | null;
    aviation_source?: string; traffic_source?: string; weather_source?: string; traffic_intensity?: number };
  regions: NationalRegionResult[];
  mobility_network?: { source: string; generated_at?: string | null;
    edges: { source: string; target: string; weight: number; traffic_volume?: number | null; mobility_source?: string }[] };
  transmission_edges?: { day: number; source: string; target: string;
    expected_exposures: number; mobility_weight: number; mobility_source?: string; source_new_cases?: number; target_new_cases?: number }[];
  data_sources?: {
    traffic_on: boolean; network_source: string; traffic_source?: string; observed_only: boolean;
    od_pairs: number; od_blend_observed: number; conn_marginal_weights: { road: number; rail: number; air: number };
    generated_at?: string | null; weather_source?: string; aviation_source?: string;
    modes: { key: string; label: string; role: string; modal: string; status: string; reflected: boolean;
      corridors?: number | null; regions?: number | null; reason?: string | null; conn_weight?: number | null }[];
  };
  summary: { total_regions: number; total_cases: number; total_deaths: number; national_cfr: number;
    attack_rate: number; peak_day: number; peak_new_cases: number; affected_regions: number;
    worst_regions: { name: string; cases: number }[];
    national_curve: { day: number; cumulative_cases: number; cumulative_deaths: number; new_cases: number }[];
    sensitivity?: { key: string; label: string; unit: string; low_val: number; cur_val: number; high_val: number; low_cases: number; cur_cases: number; high_cases: number; low_deaths?: number; cur_deaths?: number; high_deaths?: number }[];
    response_playbook?: { stage: string; phase: string; actions: string[] }[];
    comparison?: {
      active: boolean; note: string;
      observed_only?: ComparisonVariant; blended?: ComparisonVariant;
    };
    total_population: number };
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
    desc_kr: 'KDCA 주간 감시 보고서에서 추적하는 8대 호흡기 질환/병원체입니다. 인플루엔자(ILI), 중증폐렴(SARI), RSV, hMPV, 아데노바이러스, 코로나19 등 개별 시계열 데이터를 EMA와 롤링 검증 ARIMA 이중 모델로 예측합니다.',
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
  const col = (data.model_name === 'SARIMAX' || data.model_name === 'ARIMA') ? '#f59e0b' : (data.disease_id ? '#c084fc' : '#38bdf8');
  return (
    <div className="ontology-decision-block">
      <div className="ontology-decision-narrative">{data.narrative}</div>
      {data.warning && <div className="ontology-decision-error">주의: {data.warning}</div>}
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
        {data.diagnostics?.rolling_mae != null && <>| rolling MAE={data.diagnostics.rolling_mae} ({data.diagnostics.validation_folds || 0} folds) </>}
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

// WhatIfPanel (single-region) removed — replaced by WhatIfStandalonePanel (national).

// ─── Korea GeoJSON Map for Epidemic simulation ─────────────────────────────

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

// ─── Animated spread figure: aviation import → connectivity/proximity spread ──
// Plays the backend's day-level timeline (0/3/7/10일 → 2/3/4주) across the landing
// 시도 map: the entry point (항공 유입 거점) seeds, spread edges fan out with each
// region's traffic connectivity, nodes grow with predicted score. Weather (short-term
// forecast) only shapes the ≤10일 points; auto-plays and is manually scrubbable.
function ScenarioSpreadMap({ regions, primaryZones, entryLabel, transmissionEdges = [] }: {
  regions: NationalRegionResult[];
  primaryZones: string[];
  entryLabel: string;
  mobilityNetwork?: NationalOutbreakResult['mobility_network'];
  transmissionEdges?: NonNullable<NationalOutbreakResult['transmission_edges']>;
}) {
  const features = useKoreaGeoJSON();
  const days = useMemo(() => {
    const t = regions.find((r) => r.timeline?.length)?.timeline;
    return t?.map((p) => p.day) ?? Array.from({ length: 29 }, (_, day) => day);
  }, [regions]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);

  const projection = useMemo(() => d3.geoMercator().center([127.8, 36.0]).scale(4800).translate([200, 240]), []);
  const pathGen = useMemo(() => d3.geoPath().projection(projection), [projection]);
  const regionByCode = useMemo(() => new Map(regions.map((r) => [r.region_id, r])), [regions]);
  const centroids = useMemo(() => {
    const m = new Map<string, [number, number]>();
    SIDO_LABELS.forEach((s) => {
      const p = projection([s.lng, s.lat]);
      if (p) m.set(s.code, [p[0], p[1]]);
    });
    return m;
  }, [projection]);

  const casesAt = (r: NationalRegionResult, i: number): number => r.timeline?.[i]?.cumulative_cases ?? 0;
  const maxCasesAt = useMemo(
    () => days.map((_, i) => Math.max(1, ...regions.map((r) => casesAt(r, i)))),
    [regions, days],
  );
  const relAt = (r: NationalRegionResult, i: number): number => casesAt(r, i) / (maxCasesAt[i] || 1);
  const newCasesAt = (r: NationalRegionResult, i: number): number => r.timeline?.[i]?.new_cases ?? 0;
  const maxNewCasesAt = useMemo(
    () => days.map((_, i) => Math.max(1, ...regions.map((r) => newCasesAt(r, i)))),
    [regions, days],
  );
  const levelAt = (r: NationalRegionResult, i: number): string => {
    const modelLevel = r.timeline?.[i]?.level;
    if (modelLevel) return modelLevel;
    const rel = relAt(r, i);
    return rel >= 0.66 ? 'G3' : rel >= 0.33 ? 'G2' : rel >= 0.08 ? 'G1' : 'G0';
  };
  // Node colour encodes cumulative DEATHS (slate = none → amber → red → dark red),
  // scaled to the peak death toll across the whole run so it deepens over time.
  const deathsAt = (r: NationalRegionResult, i: number): number => r.timeline?.[i]?.cumulative_deaths ?? 0;
  const maxDeathsGlobal = useMemo(
    () => Math.max(1, ...regions.flatMap((r) => (r.timeline ?? []).map((p) => p.cumulative_deaths ?? 0))),
    [regions],
  );
  const lerp3 = (a: number[], b: number[], t: number) =>
    `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
  const deathFill = (r: NationalRegionResult | undefined, i: number): string => {
    const deaths = r ? deathsAt(r, i) : 0;
    if (deaths <= 0) return '#64748b'; // no deaths yet — slate
    const rel = Math.min(1, deaths / maxDeathsGlobal);
    const amber = [245, 158, 11], red = [220, 38, 38], dark = [127, 29, 29];
    return rel < 0.5 ? lerp3(amber, red, rel / 0.5) : lerp3(red, dark, (rel - 0.5) / 0.5);
  };

  const polys = useMemo(() => features.map((f: any, i: number) => {
    const sido = String(f.properties?.code || '').substring(0, 2);
    return { key: i, d: pathGen(f) || '', code: GEOJSON_TO_BACKEND[sido] || '' };
  }), [features, pathGen]);
  const originPts = useMemo(
    () => primaryZones.map((c) => centroids.get(c)).filter(Boolean) as [number, number][],
    [primaryZones, centroids],
  );

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setIdx((i) => (i >= days.length - 1 ? 0 : i + 1)), 720);
    return () => clearInterval(id);
  }, [playing, days.length]);

  const dayLabel = (d: number) => (d <= 0 ? '현재 (기준)' : String(d) + '일 후');
  const curDay = days[idx] ?? 0;
  const hasModelEdges = transmissionEdges.length > 0;
  const activeEdges = useMemo(() => {
    const dayEdges = transmissionEdges.filter((edge) => edge.day === curDay)
      .sort((a, b) => b.expected_exposures - a.expected_exposures);
    const seedCodes = new Set(primaryZones);
    const sourceActivity = (edge: NonNullable<NationalOutbreakResult['transmission_edges']>[number]) =>
      edge.source_new_cases ?? regionByCode.get(edge.source)?.timeline?.[idx]?.new_cases ?? 0;
    // Keep each active source's top TWO OD hops (dayEdges is pre-sorted desc), so a real
    // corridor like 서울→경기 AND 서울→부산 both show instead of collapsing to one line —
    // while still capping per source to avoid a radial fan.
    const topBySource = new Map<string, NonNullable<NationalOutbreakResult['transmission_edges']>>();
    for (const edge of dayEdges) {
      const list = topBySource.get(edge.source) ?? [];
      if (list.length < 2) { list.push(edge); topBySource.set(edge.source, list); }
    }
    const chainEdges = [...topBySource.values()].flat()
      .filter((edge) => !seedCodes.has(edge.source) && sourceActivity(edge) > 0)
      .sort((a, b) => (sourceActivity(b) * b.expected_exposures) - (sourceActivity(a) * a.expected_exposures));
    const seedEdges = dayEdges.filter((edge) => seedCodes.has(edge.source)).slice(0, 4);
    // Once secondary regions are infectious, foreground their next OD hops. The seed
    // remains visible but no longer overwhelms the animation as a radial fan.
    return (chainEdges.length ? [...chainEdges.slice(0, 20), ...seedEdges] : dayEdges.slice(0, 14)).slice(0, 24);
  }, [transmissionEdges, curDay, primaryZones, regionByCode, idx]);
  const fallbackEdges = useMemo(() => {
    if (!originPts.length || hasModelEdges) return [] as NonNullable<NationalOutbreakResult['transmission_edges']>;
    const originCode = primaryZones[0];
    return regions
      .filter((r) => r.region_id !== originCode && !r.error && casesAt(r, idx) > 0)
      .map((r) => ({
        day: curDay, source: originCode, target: r.region_id,
        expected_exposures: Math.max(0.01, r.timeline?.[idx]?.new_cases ?? 0),
        mobility_weight: r.connectivity ?? r.spread_multiplier ?? 0,
        mobility_source: 'baseline_gravity',
      }));
  }, [originPts, hasModelEdges, primaryZones, regions, curDay, idx]);
  const visibleEdges = hasModelEdges ? activeEdges : fallbackEdges;
  const maxExposure = Math.max(0.01, ...visibleEdges.map((edge) => edge.expected_exposures));

  const edgePath = (source: [number, number], target: [number, number], sourceCode: string, targetCode: string) => {
    const dx = target[0] - source[0];
    const dy = target[1] - source[1];
    const distance = Math.hypot(dx, dy) || 1;
    const sign = sourceCode < targetCode ? 1 : -1;
    const bend = sign * Math.min(24, distance * 0.12);
    const mx = (source[0] + target[0]) / 2 - (dy / distance) * bend;
    const my = (source[1] + target[1]) / 2 + (dx / distance) * bend;
    return 'M ' + source[0].toFixed(1) + ' ' + source[1].toFixed(1)
      + ' Q ' + mx.toFixed(1) + ' ' + my.toFixed(1)
      + ' ' + target[0].toFixed(1) + ' ' + target[1].toFixed(1);
  };

  return (
    <div className="scenario-spread">
      <div className="scenario-spread-head">
        <div className="scenario-spread-meta">
          <span>SIMULATION TIMELINE</span>
          <small>METAPOPULATION SEIR-D · 17 REGIONS</small>
        </div>
        <button type="button" className="scenario-spread-play" onClick={() => setPlaying((p) => !p)}>
          {playing ? '일시정지' : '재생'}
        </button>
        <span className="scenario-spread-day">DAY <strong>D+{String(curDay).padStart(2, '0')}</strong></span>
        <input type="range" min={0} max={days.length - 1} step={1} value={idx}
          onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)); }}
          aria-label="시뮬레이션 일자"
          className="scenario-spread-slider" />
        <span className="scenario-spread-week">{dayLabel(curDay)}{curDay > 0 && curDay <= 10 ? ' · 기상반영' : ''}</span>
        <span className="scenario-spread-horizon">DAILY STEP · 28 DAYS</span>
      </div>
      <svg viewBox="0 0 400 525" className="scenario-spread-svg korea-geo-svg">
        <defs>
          <filter id="spread-glow">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <marker id="spread-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="rgba(255,120,60,0.85)" />
          </marker>
          <marker id="spread-arrow-proxy" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="rgba(96,165,250,0.9)" />
          </marker>
          <marker id="spread-arrow-prior" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="rgba(148,163,184,0.9)" />
          </marker>
        </defs>
        {polys.map((p) => {
          const r = p.code ? regionByCode.get(p.code) : undefined;
          const level = r ? levelAt(r, idx) : 'G0';
          return (
            <path key={p.key} d={p.d} fill={GLEVEL_COLORS[level] || GLEVEL_COLORS.G0}
              fillOpacity={idx === 0 ? 0.32 : 0.6} stroke="rgba(100,150,200,0.25)" strokeWidth={0.3}
              style={{ transition: 'fill 0.45s ease, fill-opacity 0.45s ease' }} />
          );
        })}
        {visibleEdges.map((edge) => {
          const from = centroids.get(edge.source);
          const to = centroids.get(edge.target);
          if (!from || !to) return null;
          const d = edgePath(from, to, edge.source, edge.target);
          const intensity = Math.max(0.12, Math.sqrt(edge.expected_exposures / maxExposure));
          const duration = (1.8 - intensity * 0.9).toFixed(2);
          const isCapacityProxy = edge.mobility_source === 'scheduled_capacity_proxy';
          const isModelPrior = edge.mobility_source === 'airport_access_prior' || edge.mobility_source === 'baseline_gravity';
          const routeSource = isCapacityProxy ? '운항 일정 수송능력 프록시' : edge.mobility_source === 'airport_access_prior' ? '공항 접근 모형 보완 경로' : edge.mobility_source === 'baseline_gravity' ? '기본 이동모형' : '관측 OD';
          const edgeColor = isCapacityProxy ? 'rgba(96,165,250,0.78)' : isModelPrior ? 'rgba(148,163,184,0.85)' : 'rgba(255,120,60,0.84)';
          const edgeDash = isCapacityProxy ? '2 4' : isModelPrior ? '4 4' : undefined;
          const marker = isCapacityProxy ? 'url(#spread-arrow-proxy)' : isModelPrior ? 'url(#spread-arrow-prior)' : 'url(#spread-arrow)';
          return (
            <g key={String(edge.day) + '-' + edge.source + '-' + edge.target}>
              <title>{edge.source + ' → ' + edge.target + ': 모델 추정 유입 노출 ' + edge.expected_exposures.toFixed(2) + ' · ' + routeSource}</title>
              <path d={d} fill="none" stroke={edgeColor} strokeWidth={0.65 + intensity * 3.2}
                strokeLinecap="round" strokeDasharray={edgeDash} markerEnd={marker} className="scenario-spread-edge" />
              <circle r={1.4 + intensity * 1.6} fill={isCapacityProxy ? '#93c5fd' : isModelPrior ? '#cbd5e1' : '#ffd166'} className="scenario-spread-particle">
                <animateMotion path={d} dur={duration + 's'} repeatCount="indefinite" />
              </circle>
            </g>
          );
        })}
        {SIDO_LABELS.map((s) => {
          const r = regionByCode.get(s.code);
          const pt = centroids.get(s.code);
          if (!pt) return null;
          const level = r ? levelAt(r, idx) : 'G0';
          const incidence = r ? newCasesAt(r, idx) : 0;
          const incidenceRel = incidence / (maxNewCasesAt[idx] || 1);
          const rad = 3 + Math.sqrt(incidenceRel) * 14;
          const isOrigin = primaryZones.includes(s.code) && curDay <= 1;
          const activeSource = visibleEdges.some((edge) => edge.source === s.code);
          const active = incidence > 0 || activeSource;
          return (
            <g key={s.code}>
              {isOrigin && (
                <circle cx={pt[0]} cy={pt[1]} r={rad + 5} fill="none"
                  stroke="rgba(255,90,50,0.75)" strokeWidth={1.6} className="scenario-spread-origin" />
              )}
              {!isOrigin && active && (
                <circle cx={pt[0]} cy={pt[1]} r={rad + 3} fill="none"
                  stroke={deathFill(r, idx)} strokeOpacity={0.5} strokeWidth={1.3}
                  className="scenario-spread-pulse" />
              )}
              <circle cx={pt[0]} cy={pt[1]} r={rad} fill={deathFill(r, idx)}
                fillOpacity={isOrigin ? 0.4 : 0.5} stroke="#fff" strokeWidth={1}
                filter={isOrigin || activeSource || level === 'G3' ? 'url(#spread-glow)' : undefined}
                style={{ transition: 'r 0.45s ease, fill 0.45s ease' }} />
              <text x={pt[0]} y={pt[1] - rad - 3} textAnchor="middle" fontSize={9} fontWeight={700}
                fill="#e5e7eb" stroke="rgba(0,0,0,0.6)" strokeWidth={2} paintOrder="stroke"
                style={{ pointerEvents: 'none' }}>{s.abbr}</text>
            </g>
          );
        })}
      </svg>
      <div className="scenario-spread-legend">
        <span><i className="ssl-origin" /> 유입 거점: {entryLabel}</span>
        <span><i className="ssl-edge" /> 실선 = 관측 OD 기반 전파 기여</span>
        <span><i className="ssl-edge" style={{ background: '#94a3b8' }} /> 점선 = 관측 공백 공항 접근/기본 이동 보완</span>
        <span><i className="ssl-edge" style={{ background: '#60a5fa' }} /> 파란 경로 = 항공 운항일정 수송능력 프록시</span>
        <span><i className="ssl-node" style={{ background: '#dc2626' }} /> 시도 노드(색 = 누적 사망: 회색 0 → 붉을수록↑, 크기 = 해당 일 신규 감염)</span>
      </div>
    </div>
  );
}

// ─── Epidemic curve:// ─── Epidemic curve: cumulative cases + deaths over the day-level timeline ───
function EpiCurveChart({ curve, peakDay }: {
  curve: { day: number; cumulative_cases: number; cumulative_deaths: number; new_cases: number }[];
  peakDay: number;
}) {
  const W = 460, H = 200, padL = 50, padR = 14, padT = 14, padB = 26;
  const maxDay = Math.max(...curve.map((c) => c.day), 1);
  const maxCases = Math.max(...curve.map((c) => c.cumulative_cases), 1);
  const maxDeaths = Math.max(...curve.map((c) => c.cumulative_deaths), 0);
  const x = (d: number) => padL + (d / maxDay) * (W - padL - padR);
  const y = (v: number) => H - padB - (v / maxCases) * (H - padT - padB);
  const line = (key: 'cumulative_cases' | 'cumulative_deaths') =>
    curve.map((c, i) => `${i === 0 ? 'M' : 'L'} ${x(c.day).toFixed(1)} ${y(c[key]).toFixed(1)}`).join(' ');
  const casesLine = line('cumulative_cases');
  const area = `${casesLine} L ${x(maxDay).toFixed(1)} ${(H - padB).toFixed(1)} L ${x(0).toFixed(1)} ${(H - padB).toFixed(1)} Z`;
  return (
    <div className="epi-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="epi-chart-svg">
        {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
          const v = f * maxCases;
          return (
            <g key={i}>
              <line x1={padL} y1={y(v)} x2={W - padR} y2={y(v)} stroke="rgba(148,163,184,0.2)" strokeWidth={0.5} />
              <text x={padL - 5} y={y(v) + 3} textAnchor="end" fontSize={8} fill="var(--text-muted,#94a3b8)">{Math.round(v).toLocaleString()}</text>
            </g>
          );
        })}
        {curve.filter((c) => c.day === 0 || c.day === maxDay || c.day % 7 === 0).map((c) => (
          <text key={c.day} x={x(c.day)} y={H - padB + 12} textAnchor="middle" fontSize={8} fill="var(--text-muted,#94a3b8)">
            {c.day === 0 ? '0' : (c.day / 7) + '주'}
          </text>
        ))}
        <line x1={x(peakDay)} y1={padT} x2={x(peakDay)} y2={H - padB} stroke="rgba(56,189,248,0.55)" strokeWidth={1} strokeDasharray="3 3" />
        <path d={area} fill="rgba(255,159,67,0.15)" />
        <path d={casesLine} fill="none" stroke="#ff9f43" strokeWidth={2} />
        <path d={line('cumulative_deaths')} fill="none" stroke="#ff4d4f" strokeWidth={1.8} />
        {curve.map((c) => <circle key={c.day} cx={x(c.day)} cy={y(c.cumulative_cases)} r={2.2} fill="#ff9f43" />)}
      </svg>
      <div className="epi-chart-legend">
        <span><i style={{ background: '#ff9f43' }} /> 모형 누적 감염 (최대 {maxCases.toLocaleString()})</span>
        <span><i style={{ background: '#ff4d4f' }} /> 누적 사망 (최대 {maxDeaths.toLocaleString()})</span>
        <span className="epi-chart-peak">정점 {peakDay}일차</span>
      </div>
    </div>
  );
}

// ─── Sensitivity tornado: 28일 확진·사망 범위 across each signal's intensity ──
function SensitivityChart({ items }: {
  items: { key: string; label: string; unit: string; low_val: number; cur_val: number; high_val: number;
    low_cases: number; cur_cases: number; high_cases: number;
    low_deaths?: number; cur_deaths?: number; high_deaths?: number }[];
}) {
  const W = 460, rowH = 50, padL = 96, padR = 58, padT = 8;
  const H = padT + items.length * rowH + 8;
  const maxCases = Math.max(...items.map((s) => s.high_cases), 1);
  const maxDeaths = Math.max(...items.map((s) => s.high_deaths ?? 0), 1);
  const xC = (v: number) => padL + (v / maxCases) * (W - padL - padR);
  const xD = (v: number) => padL + (v / maxDeaths) * (W - padL - padR);
  const n = (v: number) => v.toLocaleString();
  return (
    <div className="sens-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="sens-chart-svg">
        {items.map((s, i) => {
          const top = padT + i * rowH;
          const cyC = top + 15, cyD = top + 35;
          const ld = s.low_deaths ?? 0, cd = s.cur_deaths ?? 0, hd = s.high_deaths ?? 0;
          return (
            <g key={s.key}>
              <text x={2} y={top + 19} fontSize={10} fontWeight={700} fill="var(--text-primary, #0f172a)">{s.label}</text>
              <text x={2} y={top + 31} fontSize={8} fill="var(--text-muted, #94a3b8)">{s.low_val}{s.unit} → {s.high_val}{s.unit}</text>
              {/* 모형 감염 범위 */}
              <line x1={xC(s.low_cases)} y1={cyC} x2={xC(s.high_cases)} y2={cyC} stroke="#ff9f43" strokeWidth={7} strokeLinecap="round" opacity={0.5} />
              <text x={xC(s.low_cases) - 4} y={cyC + 3} fontSize={8} textAnchor="end" fill="var(--text-muted, #94a3b8)">{n(s.low_cases)}</text>
              <text x={xC(s.high_cases) + 4} y={cyC + 3} fontSize={9} textAnchor="start" fontWeight={700} fill="var(--text-secondary, #475569)">{n(s.high_cases)}</text>
              <circle cx={xC(s.cur_cases)} cy={cyC} r={3} fill="#e11d48" fillOpacity={0.5} stroke="#fff" strokeWidth={1.1} />
              {/* 사망 범위 */}
              <line x1={xD(ld)} y1={cyD} x2={xD(hd)} y2={cyD} stroke="#fb7185" strokeWidth={7} strokeLinecap="round" opacity={0.5} />
              <text x={xD(ld) - 4} y={cyD + 3} fontSize={8} textAnchor="end" fill="var(--text-muted, #94a3b8)">{n(ld)}</text>
              <text x={xD(hd) + 4} y={cyD + 3} fontSize={9} textAnchor="start" fontWeight={700} fill="#be123c">{n(hd)}</text>
              <circle cx={xD(cd)} cy={cyD} r={3} fill="#e11d48" fillOpacity={0.5} stroke="#fff" strokeWidth={1.1} />
            </g>
          );
        })}
      </svg>
      <div className="epi-chart-legend">
        <span><i style={{ background: '#ff9f43', height: '6px', borderRadius: '3px' }} /> 모형 감염 범위 (위)</span>
        <span><i style={{ background: '#fb7185', height: '6px', borderRadius: '3px' }} /> 사망 범위 (아래)</span>
        <span><i style={{ background: '#e11d48', width: '7px', height: '7px', borderRadius: '50%', opacity: 0.55 }} /> 현재 설정</span>
      </div>
    </div>
  );
}

// ─── OD-treatment comparison: 관측 OD only vs 관측+중력 (side-by-side) ──────────
function ComparisonMiniMap({ regions, maxCases }: { regions: ComparisonVariant['regions']; maxCases: number }) {
  const features = useKoreaGeoJSON();
  const projection = useMemo(() => d3.geoMercator().center([127.8, 36.0]).scale(2880).translate([120, 144]), []);
  const pathGen = useMemo(() => d3.geoPath().projection(projection), [projection]);
  const byCode = useMemo(() => new Map(regions.map((r) => [r.code, r])), [regions]);
  const polys = useMemo(() => features.map((f: any, i: number) => {
    const sido = String(f.properties?.code || '').substring(0, 2);
    return { key: i, d: pathGen(f) || '', code: GEOJSON_TO_BACKEND[sido] || '' };
  }), [features, pathGen]);
  const fill = (code: string) => {
    const c = byCode.get(code)?.cumulative_cases ?? 0;
    if (c <= 0) return 'rgba(148,163,184,0.14)';
    const rel = Math.min(1, c / (maxCases || 1));
    return `rgba(255,110,55,${(0.18 + Math.sqrt(rel) * 0.72).toFixed(2)})`;
  };
  return (
    <svg viewBox="0 0 240 315" className="cmp-mini-map">
      {polys.map((p) => (
        <path key={p.key} d={p.d} fill={p.code ? fill(p.code) : 'rgba(148,163,184,0.1)'}
          stroke="rgba(100,150,200,0.28)" strokeWidth={0.3} />
      ))}
    </svg>
  );
}

function ComparisonMiniCurve({ curve, maxCases }: { curve: ComparisonVariant['national_curve']; maxCases: number }) {
  const W = 240, H = 60, padL = 6, padR = 6, padT = 6, padB = 10;
  const maxD = Math.max(...curve.map((c) => c.day), 1);
  const x = (d: number) => padL + (d / maxD) * (W - padL - padR);
  const y = (v: number) => H - padB - (Math.min(v, maxCases) / (maxCases || 1)) * (H - padT - padB);
  const line = curve.map((c, i) => `${i ? 'L' : 'M'} ${x(c.day).toFixed(1)} ${y(c.cumulative_cases).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="cmp-mini-curve">
      <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="rgba(148,163,184,0.3)" strokeWidth={0.5} />
      <path d={line} fill="none" stroke="#ff9f43" strokeWidth={1.6} />
    </svg>
  );
}

function ComparisonPanel({ comparison }: { comparison: NonNullable<NationalOutbreakResult['summary']['comparison']> }) {
  const a = comparison.observed_only, b = comparison.blended;
  if (!comparison.active || !a || !b) return null;
  const maxRegion = Math.max(1, ...a.regions.map((r) => r.cumulative_cases), ...b.regions.map((r) => r.cumulative_cases));
  const maxCurve = Math.max(1, ...a.national_curve.map((c) => c.cumulative_cases), ...b.national_curve.map((c) => c.cumulative_cases));
  const cols = [
    { title: '관측 OD only', sub: '관측 경로만 · 미관측 지역 고립', data: a },
    { title: '관측 + 중력 (기본)', sub: '관측 우선 + 나머지 중력 보정', data: b },
  ];
  return (
    <div className="whatif-section">
      <div className="whatif-section-title">이동구조 비교 · 관측 OD only ↔ 관측+중력 (같은 파라미터)</div>
      <div className="cmp-grid">
        {cols.map((c) => (
          <div key={c.title} className="cmp-col">
            <div className="cmp-col-head"><strong>{c.title}</strong><span>{c.sub}</span></div>
            <ComparisonMiniMap regions={c.data.regions} maxCases={maxRegion} />
            <ComparisonMiniCurve curve={c.data.national_curve} maxCases={maxCurve} />
            <div className="cmp-totals">
              <span>확진 <strong>{c.data.total_cases.toLocaleString()}</strong></span>
              <span>사망 <strong>{c.data.total_deaths.toLocaleString()}</strong></span>
              <span>확산 <strong>{c.data.affected_regions}/17</strong></span>
            </div>
          </div>
        ))}
      </div>
      <div className="epi-region-caveat">{comparison.note}</div>
    </div>
  );
}

// ─── Data-source & reflection panel — what actually fed THIS run (runtime-derived) ──
const NETWORK_SOURCE_LABEL: Record<string, string> = {
  multimodal_od: '멀티모달 실측 OD (고속도로 + 철도)',
  highway_od: '고속도로 실측 OD',
  srt_od: 'SRT 실측 OD',
  korail_od: 'KORAIL 실측 OD',
  baseline_gravity: '중력모형 (실측 OD 미사용)',
  gravity_prior: '중력모형 (실측 OD 미사용)',
  unavailable: '중력모형 (실측 OD 미사용)',
};

function DataSourcePanel({ ds }: { ds: NonNullable<NationalOutbreakResult['data_sources']> }) {
  const w = ds.conn_marginal_weights || { road: 0.6, rail: 0.25, air: 0.15 };
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const netLabel = NETWORK_SOURCE_LABEL[ds.network_source] || ds.network_source || '중력모형';
  const chip = (m: NonNullable<NationalOutbreakResult['data_sources']>['modes'][number]) => {
    if (!ds.traffic_on) return { text: '교통 OFF', color: '#64748b', bg: 'rgba(100,116,139,0.15)' };
    if (m.reflected) return { text: '반영됨', color: '#22c55e', bg: 'rgba(34,197,94,0.15)' };
    if (m.status === 'skipped') return { text: '키 없음', color: '#94a3b8', bg: 'rgba(148,163,184,0.15)' };
    return { text: '미반영', color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' };
  };
  const detail = (m: NonNullable<NationalOutbreakResult['data_sources']>['modes'][number]) => {
    if (m.role === 'od_edge') return m.reflected ? `corridor ${m.corridors}개` : (m.reason || '미수집');
    return m.reflected ? `${m.regions}개 지역 · conn ${pct(m.conn_weight || 0)}` : (m.reason || '미수집');
  };
  return (
    <div className="whatif-section">
      <div className="whatif-section-title">데이터 출처 · 반영 방식 (이 시뮬레이션 기준)</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>이동 네트워크:</span>
        <strong style={{ fontSize: 13, color: '#e2e8f0' }}>{netLabel}</strong>
        {ds.observed_only && (
          <span style={{ fontSize: 11, color: '#cbd5e1' }}>
            · 관측 구간 = 관측 {pct(ds.od_blend_observed)} + 중력 {pct(1 - ds.od_blend_observed)} 혼합 ({ds.od_pairs}개 OD쌍)
          </span>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8 }}>
        {ds.modes.map((m) => {
          const c = chip(m);
          return (
            <div key={m.key} style={{ border: '1px solid rgba(148,163,184,0.2)', borderRadius: 8, padding: '8px 10px', background: 'rgba(15,23,42,0.4)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                <strong style={{ fontSize: 12.5, color: '#e2e8f0' }}>{m.label}</strong>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: c.color, background: c.bg, padding: '1px 7px', borderRadius: 10 }}>{c.text}</span>
              </div>
              <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 3 }}>
                {m.role === 'od_edge' ? '지역 간 OD 엣지' : '연결도(conn) 마진'} · {detail(m)}
              </div>
            </div>
          );
        })}
      </div>
      <div className="epi-region-caveat">
        반영 방식: 실측 OD가 있는 구간은 <b>관측 {pct(ds.od_blend_observed)} + 중력모형 {pct(1 - ds.od_blend_observed)}</b>로 혼합하고,
        관측이 없는 구간은 <b>중력모형(인구 / 거리² × 연결도)</b>으로 보간합니다.
        연결도(conn)는 <b>고속도로 {pct(w.road)} + 철도(KORAIL 승하차) {pct(w.rail)} + 항공(공항 여객) {pct(w.air)}</b>의
        실측 활동량으로 산출됩니다. 위에서 “미반영”으로 표시된 모달은 이 시뮬레이션 계산·애니메이션에 들어가지 않았습니다.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 8, fontSize: 11, color: '#cbd5e1' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><i style={{ width: 14, height: 3, background: 'rgba(255,120,60,0.9)', borderRadius: 2 }} />관측 OD</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><i style={{ width: 14, height: 3, background: 'rgba(96,165,250,0.9)', borderRadius: 2, borderTop: '1px dashed #60a5fa' }} />수송능력 프록시</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><i style={{ width: 14, height: 3, background: 'rgba(148,163,184,0.9)', borderRadius: 2 }} />중력 추정</span>
      </div>
    </div>
  );
}

// ─── Analyzing loader — shown in the analysis pane while the (slow) SEIR + AI run ──
function WhatIfAnalyzing() {
  const steps = ['SEIR 역학 시뮬레이션 실행', '항공·교통·기상 신호 반영', '강도 민감도 분석 계산', 'Sentinel AI 시나리오 분석 생성'];
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStep((s) => (s + 1) % steps.length), 1400);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="whatif-analyzing">
      <div className="whatif-analyzing-orbit"><span /><span /><span /></div>
      <div className="whatif-analyzing-title">분석 중입니다</div>
      <div className="whatif-analyzing-step">{steps[step]}…</div>
      <div className="whatif-analyzing-sub">SEIR 시뮬레이션과 AI 시나리오 분석을 생성하고 있습니다. 수 초가 걸릴 수 있으니 잠시만 기다려 주세요.</div>
    </div>
  );
}

// ─── National Outbreak Analysis Panel (results in analysis area) ──────────

function NationalAnalysisPanel({ result }: { result: NationalOutbreakResult }) {
  const g = result.gemini_scenario;
  const ep = result.entry_point;

  const regions = result.regions || [];
  const s = result.summary;
  const sc = result.scenario;
  const fmt = (n?: number) => (n ?? 0).toLocaleString('ko-KR');
  const prioKr = (p?: string) => ({ high: '높음', medium: '보통', low: '낮음' } as Record<string, string>)[(p || '').toLowerCase()] || p || '';
  const aiActions = g && !g.error && !g.parse_error ? (g.response_actions || []) : [];
  const aiBucket = (timing?: string) => {
    const t = timing || '';
    if (t.includes('중기')) return '중기';
    if (t.includes('후기') || t.includes('장기')) return '후기';
    return '단기';
  };
  const pct = (n?: number, d = 2) => `${((n ?? 0) * 100).toFixed(d)}%`;

  return (
    <div className="whatif-analysis-panel">
      {/* Header */}
      <div className="whatif-analysis-header">
        <span className="whatif-analysis-tag">EPIDEMIC SIMULATION</span>
        <span className="whatif-analysis-region">{ep?.label || ep?.code || '—'}{ep?.seed_region_name && ep.seed_region_name !== ep.label ? ` → ${ep.seed_region_name}` : ''}</span>
        <span className="whatif-analysis-scenario">{sc?.disease} / {sc?.country}</span>
        <span className="whatif-mobility-badge" title="입력 재생산지수 R0">R0 {sc?.r0}</span>
        <span className="whatif-mobility-badge" title="입력 치명률 CFR">CFR {pct(sc?.cfr, 1)}</span>
        {sc?.is_novel && <span className="whatif-mobility-badge whatif-mobility-badge--real" title="신종감염병 — 직접 설정한 파라미터로 시뮬레이션">신종 파라미터</span>}
        {sc?.aviation_source === 'aviation' && (
          <span className="whatif-mobility-badge whatif-mobility-badge--real" title="발생국→인천 실측 도착 여객량으로 유입 규모(seed) 스케일">항공 유입 반영(실측)</span>
        )}
        {['highway_od', 'multimodal_od'].includes(sc?.traffic_source || '') && (
          <span className="whatif-mobility-badge whatif-mobility-badge--real"
            title={sc?.traffic_source === 'multimodal_od'
              ? '고속도로·KORAIL/KTX·SRT·국내선의 모드별 출처를 보존한 멀티모달 OD 연결성을 지역 간 이동 결합에 반영'
              : sc?.traffic_source === 'highway_od'
                ? '한국도로공사 실측 출발→도착 교통망을 지역 간 이동 결합에 반영'
                : '지역별 고속도로 도착량 지수를 연결성 보조값으로 반영'}>
            {sc?.traffic_source === 'multimodal_od'
              ? '멀티모달 OD 연결성 반영'
              : sc?.traffic_source === 'highway_od' ? '교통 OD 연결성 반영(실측)' : '교통 도착량 지수 반영'}
          </span>
        )}
        {sc?.traffic_source?.startsWith('baseline_mobility') && (
          <span className="whatif-mobility-badge" title="실측 OD 보정은 끈 상태이며, 지역 간 이동은 인구·거리·허브 기반 기본 이동모형으로 계산">기본 이동모형</span>
        )}
        {sc?.weather_source?.startsWith('kma') && (
          <span className="whatif-mobility-badge whatif-mobility-badge--real" title="기상청 예보 기온으로 ≤10일 전파력 보정">기상 전파력 반영</span>
        )}
      </div>

      {/* Epidemiological headline numbers (28일 후) */}
      <div className="national-summary-bar epi">
        <div className="national-summary-stat">
          <span className="national-summary-num">{fmt(s?.total_cases)}</span>
          <span className="national-summary-label">모델 누적 감염 (28일)</span>
        </div>
        <div className="national-summary-stat">
          <span className="national-summary-num death">{fmt(s?.total_deaths)}</span>
          <span className="national-summary-label">누적 사망</span>
        </div>
        <div className="national-summary-stat">
          <span className="national-summary-num">{pct(s?.national_cfr, 1)}</span>
          <span className="national-summary-label">28일 사망비</span>
        </div>
        <div className="national-summary-stat">
          <span className="national-summary-num">{pct(s?.attack_rate, 3)}</span>
          <span className="national-summary-label">전국 발병률</span>
        </div>
        <div className="national-summary-stat">
          <span className="national-summary-num">{s?.affected_regions ?? 0}/17</span>
          <span className="national-summary-label">확산 지역</span>
        </div>
      </div>

      {/* Hero figure: animated spatial spread across the 시도 map */}
      {regions.length > 0 && (
        <div className="whatif-section">
          <div className="whatif-section-title">일별 전파 애니메이션 · 지역 간 유입 기여(노드 크기 = 모델 감염 강도)</div>
          <ScenarioSpreadMap regions={regions}
            primaryZones={ep?.seed_region ? [ep.seed_region] : (ep?.primary_zones || [])}
            entryLabel={ep?.seed_region_name || ep?.label || '유입 거점'}
            mobilityNetwork={result.mobility_network}
            transmissionEdges={result.transmission_edges} />
        </div>
      )}

      {/* Data-source & reflection panel — runtime-derived modal status for this run */}
      {result.data_sources && <DataSourcePanel ds={result.data_sources} />}

      {/* Epidemic curve + sensitivity — side by side on wide screens */}
      {((s?.national_curve && s.national_curve.length > 0) || (s?.sensitivity && s.sensitivity.length > 0)) && (
        <div className="whatif-figrow">
          {s?.national_curve && s.national_curve.length > 0 && (
            <div className="whatif-section whatif-fig">
              <div className="whatif-section-title">전국 유행곡선 · 모형 누적 감염 및 사망 (정점 {s.peak_day}일차)</div>
              <EpiCurveChart curve={s.national_curve} peakDay={s.peak_day} />
            </div>
          )}
          {s?.sensitivity && s.sensitivity.length > 0 && (
            <div className="whatif-section whatif-fig">
              <div className="whatif-section-title">강도 민감도 요약 · 조절강도에 따른 예측치</div>
              <SensitivityChart items={s.sensitivity} />
              <div className="epi-region-caveat">각 신호의 강도를 최저·최고로 바꿔 SEIR을 재실행했을 때의 28일 모형 누적 감염(위)·사망(아래) 범위입니다(나머지 조건은 현재값 고정). 감염·사망은 각각 별도 축으로, 막대가 길수록 그 강도가 결과를 크게 바꾸는 요인입니다.</div>
            </div>
          )}
        </div>
      )}

      {/* OD-treatment comparison (관측 OD only vs 관측+중력) — only when traffic OD is on */}
      {s?.comparison?.active && <ComparisonPanel comparison={s.comparison} />}

      {/* Narrative */}
      <div className="ontology-decision-narrative">{result.narrative}</div>

      {/* Region table — cumulative cases per 시도 across the forecast stages (확진 순) */}
      <div className="whatif-section">
        <div className="whatif-section-title">시도별 역학 지표 · 시기별 모형 누적 감염·사망 (단기 3·7일 / 중기 2·3주 / 28일)</div>
        <div className="epi-region-table epi-region-staged">
          <div className="epi-region-superhead">
            <span></span>
            <span className="epi-grp short" style={{ gridColumn: 'span 2' }}>단기예측</span>
            <span className="epi-grp mid" style={{ gridColumn: 'span 2' }}>중기예측</span>
            <span className="epi-grp final" style={{ gridColumn: 'span 2' }}>최종 (28일)</span>
          </div>
          <div className="epi-region-header">
            <span>지역</span><span>3일</span><span>7일</span><span>2주</span><span>3주</span><span>28일</span><span>사망비*</span>
          </div>
          {regions.map((r) => {
            const casesAt = (day: number) => r.timeline?.find((t) => t.day === day)?.cumulative_cases ?? 0;
            const deathsAt = (day: number) => r.timeline?.find((t) => t.day === day)?.cumulative_deaths ?? 0;
            const cell = (day: number, strong?: boolean) => {
              const d = deathsAt(day);
              return (
                <span className="epi-stage-cell">
                  <span className={`epi-num${strong ? ' strong' : ''}`}>{fmt(casesAt(day))}</span>
                  <span className={`epi-num mini ${d > 0 ? 'death' : 'zero'}`}>{fmt(d)}</span>
                </span>
              );
            };
            return (
              <div key={r.region_id} className={`epi-region-row ${r.is_seed ? 'seed' : ''}`}>
                <span className="epi-region-name">
                  {r.is_seed && <span className="epi-seed-badge">유입</span>}
                  {r.region_name}
                </span>
                {cell(3)}
                {cell(7)}
                {cell(14)}
                {cell(21)}
                {cell(28, true)}
                <span className="epi-num">{pct(r.effective_cfr, 1)}</span>
              </div>
            );
          })}
        </div>
        <div className="epi-region-caveat">각 시점 칸은 <strong>모형 누적 감염</strong>(위) · <strong className="epi-death-word">누적 사망</strong>(아래, 빨강)이며, 사망비는 28일 사망 ÷ 모형 누적 감염 기준입니다. 개입(백신·거리두기) 없는 자연확산 가정의 예시 시나리오이며 예보가 아닙니다. 인구: 행정안전부 주민등록 2026-06.</div>
      </div>

      {/* 시나리오 분석 (Gemini) — 영향·확산 양상·전개·위험 (대응 방안은 아래 전용 섹션) */}
      {g && !g.error && !g.parse_error && (g.impact_summary || g.spread_pattern || (g.timeline && g.timeline.length > 0) || (g.high_risk_regions && g.high_risk_regions.length > 0) || g.best_case || g.worst_case || g.risk_factors) && (
        <div className="whatif-gemini">
          <div className="whatif-section-title whatif-ai-head">시나리오 분석</div>
          {g.impact_summary && (
            <div className="whatif-section">
              <div className="whatif-section-title">영향 요약</div>
              <p>{g.impact_summary}</p>
            </div>
          )}
          {g.spread_pattern && (
            <div className="whatif-section">
              <div className="whatif-section-title">확산 양상</div>
              <p>{g.spread_pattern}</p>
            </div>
          )}
          {g.timeline && g.timeline.length > 0 && (
            <div className="whatif-section">
              <div className="whatif-section-title">주차별 전개</div>
              {g.timeline.map((t, i) => (
                <div key={i} className="whatif-timeline-item">
                  {t.week != null && <span className="whatif-timeline-week">{t.week}주차</span>}
                  <span>{t.description}</span>
                </div>
              ))}
            </div>
          )}
          {g.high_risk_regions && g.high_risk_regions.length > 0 && (
            <div className="whatif-section">
              <div className="whatif-section-title">고위험 지역</div>
              {g.high_risk_regions.map((hr, i) => (
                <div key={i} className="whatif-action-item">
                  <span className="epi-hr-region">{hr.region}</span>
                  <span className="whatif-action-text">{hr.reason}</span>
                </div>
              ))}
            </div>
          )}
          {(g.best_case || g.worst_case) && (
            <div className="whatif-section whatif-cases">
              {g.best_case && <div className="whatif-case best">최선 시나리오: {g.best_case}</div>}
              {g.worst_case && <div className="whatif-case worst">최악 시나리오: {g.worst_case}</div>}
            </div>
          )}
          {g.risk_factors && (
            <div className="whatif-section">
              <div className="whatif-section-title">추가 위험 요인</div>
              <ul className="whatif-risk-list">
                {g.risk_factors.map((rf, i) => <li key={i}>{rf}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* 시기별 대응 방안 — AI (Gemini) 분석이 우선, 없으면 규칙 기반 fallback */}
      {aiActions.length > 0 ? (
        <div className="whatif-section">
          <div className="whatif-section-title">시기별 대응 방안 및 Sentinel AI 분석</div>
          <div className="epi-playbook">
            {(['단기', '중기', '후기'] as const).map((key, idx) => {
              const label = ['단기 (0~7일)', '중기 (1~3주)', '후기 (21~28일)'][idx];
              const items = aiActions.filter((a) => aiBucket(a.timing) === key);
              if (items.length === 0) return null;
              return (
                <div key={key} className="epi-playbook-stage">
                  <div className="epi-playbook-head">
                    <span className="epi-playbook-when">{label}</span>
                  </div>
                  <ul className="epi-playbook-actions">
                    {items.map((a, j) => (
                      <li key={j}>
                        {a.priority && <span className="epi-ai-prio">{prioKr(a.priority)}</span>}
                        {a.action}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
          <div className="epi-region-caveat">Sentinel AI가 위 SEIR 시뮬레이션 결과(정점 시점·입력 CFR·전파력)를 해석해 생성한 시기별 대응 권고 및 분석을 제공합니다. 최종 판단은 정책 결정자의 몫입니다.</div>
        </div>
      ) : (s?.response_playbook && s.response_playbook.length > 0 && (
        <div className="whatif-section">
          <div className="whatif-section-title">시기별 대응 방안 · 유행 단계별 권고</div>
          <div className="epi-playbook">
            {s.response_playbook.map((p, i) => (
              <div key={i} className="epi-playbook-stage">
                <div className="epi-playbook-head">
                  <span className="epi-playbook-when">{p.stage}</span>
                  <span className="epi-playbook-phase">{p.phase}</span>
                </div>
                <ul className="epi-playbook-actions">
                  {p.actions.map((a, j) => <li key={j}>{a}</li>)}
                </ul>
              </div>
            ))}
          </div>
          <div className="epi-region-caveat">AI 분석(Gemini)을 사용할 수 없어 규칙 기반 권고를 표시합니다. K-방역 3T · WHO 봉쇄–완화 단계 프레임워크 기반이며 정점 시점·입력 CFR·전파력에 맞춰 조정됩니다.</div>
        </div>
      ))}
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
          Decomposition + EMA + ARIMA + Hotspots + Lead-Lag 분석 결과를 종합하여
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
          <div className="forecast-report-label">FORECAST CONSENSUS (EMA vs ARIMA)</div>
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
          EMA + ARIMA 이중 모델 예측 결과 + Lead-Lag 조기경보 분석을 종합하여
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
          <div className="forecast-report-label">FORECAST CONSENSUS (EMA vs ARIMA)</div>
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
  const [whatIfLoading, setWhatIfLoading] = useState(false);

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
            Region/Disease/Snapshot 기반 예측 분석 시스템. 질병별 <strong>EMA + ARIMA 이중 모델</strong> 비교,
            지역별 4주 예측 + Gemini AI 추천, Epidemic simulation, Lead-Lag 조기경보.
          </p>
          <div className="ontology-header-features">
            <span>EMA+Momentum</span>
            <span>ARIMA (walk-forward)</span>
            <span>Epidemic simulation</span>
            <span>Lead-Lag</span>
            <span>Gemini AI</span>
          </div>
        </div>

        {/* Object Types */}
        <div className="ontology-sidebar-section">
          <div className="ontology-pane-title">OBJECT TYPES</div>
          <div className="ontology-type-list">
            {/* Order: Disease & Epidemic simulation first (most useful, emphasized), then Region, Snapshot */}
            {(['Disease', 'WhatIf', 'Region', 'Snapshot'] as const).map((tabId) => {
              const featured = tabId === 'Disease' || tabId === 'WhatIf';
              if (tabId === 'WhatIf') {
                return (
                  <button key="WhatIf"
                    className={`ontology-type-card ontology-type-card--featured ${selectedType === 'WhatIf' ? 'is-active' : ''}`}
                    onClick={() => setSelectedType('WhatIf')}
                    style={{ borderLeftColor: '#fb7185' }} type="button">
                    <div className="ontology-type-card-row">
                      <span className="ontology-type-card-name">Epidemic simulation</span>
                    </div>
                    <div className="ontology-type-card-kr">가상 유입·확산 시나리오 분석</div>
                    <div className="ontology-type-card-desc">
                      해외 감염병 유입 또는 국내 지역 발생을 가정해, 선택한 거점(공항·지역)에서 전국 17개 시도로 퍼지는 확산을 메타population SEIR 모델로 시뮬레이션합니다. 실제 인구·질병 파라미터로 시도별 모형 감염·사망·28일 사망비·발병률을 계산하고, 확산 애니메이션과 유행곡선을 제공합니다.
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
                ? <>EPIDEMIC SIMULATION</>
                : <>INSTANCES{currentTypeMeta && <span className="ontology-pane-subtitle"> · {currentTypeMeta.label}</span>}</>
              }
            </div>
          </div>
          {whatIfMode ? (
            <WhatIfStandalonePanel isAdmin={isAdmin} adminHeaders={adminHeaders}
              onResult={(result) => { setWhatIfResult(result); }} onLoading={setWhatIfLoading} />
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
            whatIfLoading ? (
              <WhatIfAnalyzing />
            ) : whatIfResult && !whatIfResult.error ? (
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

                  {/* Row 2: EMA + ARIMA */}
                  <div className="detail-grid-2col">
                    <div className="detail-grid-cell">
                      <div className="ontology-detail-section-title">4-WEEK FORECAST — EMA + OUTBREAK</div>
                      {forecastEMA ? <ForecastPanel data={forecastEMA} /> : <div className="ontology-pane-loading">Computing EMA...</div>}
                    </div>
                    <div className="detail-grid-cell">
                      <div className="ontology-detail-section-title">4-WEEK FORECAST — ARIMA (walk-forward)</div>
                      {forecastSARIMAX ? <ForecastPanel data={forecastSARIMAX} /> : <div className="ontology-pane-loading">Computing ARIMA...</div>}
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
                  {/* Row 1: EMA + ARIMA */}
                  <div className="detail-grid-2col">
                    <div className="detail-grid-cell">
                      <div className="ontology-detail-section-title">4-WEEK FORECAST — EMA + MOMENTUM</div>
                      {diseaseForecastEMA ? <ForecastPanel data={diseaseForecastEMA} /> : <div className="ontology-pane-loading">Computing EMA...</div>}
                    </div>
                    <div className="detail-grid-cell">
                      <div className="ontology-detail-section-title">4-WEEK FORECAST — ARIMA (walk-forward)</div>
                      {diseaseForecastSARIMAX ? <ForecastPanel data={diseaseForecastSARIMAX} /> : <div className="ontology-pane-loading">Computing ARIMA...</div>}
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

// ─── National Epidemic simulation panel (fills instances pane) ───────────────

const ENTRY_POINTS = [
  { code: 'ICN', label: '인천국제공항', desc: '수도권 (서울/인천/경기)' },
  { code: 'PUS', label: '김해국제공항', desc: '부산/경남' },
];

// Disease epidemiological presets (mirror backend _DISEASE_TABLE; order = specific first
// so "H5N1 Avian Influenza" hits h5n1, not influenza). Auto-fill the editable R0/CFR/
// incubation/infectious for known diseases; a novel disease leaves the DEFAULT for the
// user to set. cfr stored as a fraction; the UI edits it as a percent.
const DISEASE_PRESETS: { keys: string[]; r0: number; cfr: number; inc: number; inf: number; label: string }[] = [
  { keys: ['h5n1', 'avian', 'bird flu', '조류독감', '고병원성', 'h5'], r0: 1.8, cfr: 0.30, inc: 3, inf: 5, label: 'H5N1' },
  { keys: ['h7n9', 'h7'], r0: 1.5, cfr: 0.39, inc: 4, inf: 6, label: 'H7N9' },
  { keys: ['sars-cov-1', 'sars', '사스'], r0: 3.0, cfr: 0.10, inc: 5, inf: 7, label: 'SARS' },
  { keys: ['mers', '메르스'], r0: 0.9, cfr: 0.34, inc: 5, inf: 7, label: 'MERS' },
  { keys: ['measles', '홍역', 'rubeola'], r0: 15.0, cfr: 0.002, inc: 12, inf: 8, label: 'Measles' },
  { keys: ['rsv', '호흡기세포융합'], r0: 1.5, cfr: 0.005, inc: 4, inf: 7, label: 'RSV' },
  { keys: ['covid', 'sars-cov-2', '코로나'], r0: 2.5, cfr: 0.010, inc: 5, inf: 6, label: 'COVID-19' },
  { keys: ['influenza', 'flu', '독감', '인플루엔자'], r0: 1.4, cfr: 0.001, inc: 2, inf: 4, label: 'Influenza' },
];
const DISEASE_DEFAULT = { r0: 2.5, cfr: 0.02, inc: 5, inf: 6, label: '신종(기본)' };
function resolveDiseasePreset(name: string) {
  const low = (name || '').toLowerCase();
  return DISEASE_PRESETS.find((p) => p.keys.some((k) => low.includes(k.toLowerCase()))) || null;
}

function WhatIfStandalonePanel({ isAdmin, adminHeaders, onResult, onLoading }: {
  isAdmin: boolean; adminHeaders: () => Promise<Record<string, string>>;
  onResult?: (result: NationalOutbreakResult) => void;
  onLoading?: (loading: boolean) => void;
}) {
  const [entryPoint, setEntryPoint] = useState('');
  const [disease, setDisease] = useState('');
  const [country, setCountry] = useState('');
  const [useAviation, setUseAviation] = useState(false);
  const [aviationIntensity, setAviationIntensity] = useState(1.0);
  const [useTraffic, setUseTraffic] = useState(false);
  const [trafficIntensity, setTrafficIntensity] = useState(0.1);
  const [trafficUpdatedAt, setTrafficUpdatedAt] = useState<string | null>(null);
  const [trafficRefreshing, setTrafficRefreshing] = useState(false);
  const [trafficMsg, setTrafficMsg] = useState<string | null>(null);
  const [useWeather, setUseWeather] = useState(false);
  const [weatherIntensity, setWeatherIntensity] = useState(0.3);
  // Editable epidemiological parameters (auto-filled for known diseases, set manually for novel).
  const [r0, setR0] = useState('');
  const [cfr, setCfr] = useState('');            // percent 0..100 in the UI
  const [incubation, setIncubation] = useState('');
  const [infectious, setInfectious] = useState('');
  const [loading, setLoading] = useState(false);
  const [exampleLoading, setExampleLoading] = useState(false);
  const [exampleMode, setExampleMode] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Auto-fill epidemiological parameters from the disease name (known -> preset,
  // novel -> DEFAULT for manual editing). Fires only on disease change, so manual edits
  // to R0/CFR persist until the disease is changed.
  const diseasePreset = resolveDiseasePreset(disease);
  useEffect(() => {
    const p = resolveDiseasePreset(disease) || DISEASE_DEFAULT;
    setR0(String(p.r0));
    setCfr(String(+(p.cfr * 100).toFixed(3)));
    setIncubation(String(p.inc));
    setInfectious(String(p.inf));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disease]);

  const runNationalScenario = async () => {
    setLoading(true); setStatusMsg(null); setExampleMode(false); onLoading?.(true);
    try {
      const r = await fetch(`${API_BASE}/ontology/functions/whatIfOutbreakNational`, {
        method: 'POST', headers: await adminHeaders(),
        body: JSON.stringify({ inputs: { entry_point: entryPoint, disease, country, use_aviation: useAviation, use_traffic: useTraffic, use_weather: useWeather,
          aviation_intensity: aviationIntensity, traffic_intensity: trafficIntensity, weather_intensity: weatherIntensity,
          r0: Number(r0) || undefined, cfr: cfr !== '' ? Number(cfr) / 100 : undefined,
          incubation_days: Number(incubation) || undefined, infectious_days: Number(infectious) || undefined } }),
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
        setStatusMsg({ ok: true, text: `28일 후 모형 누적 감염 ${(result.summary?.total_cases || 0).toLocaleString()}명 · ${(result.summary?.total_deaths || 0).toLocaleString()}명 사망 — 결과 확인 →` });
        onResult?.(result);
      }
    } catch (e: any) {
      setStatusMsg({ ok: false, text: String(e?.message || e) });
    } finally { setLoading(false); onLoading?.(false); }
  };

  // Public demo — fetch the pre-run H5N1/China scenario for the CURRENT toggle combo
  // so anyone (incl. non-admin / read-only judges) can see how each signal changes it.
  const fetchExample = async () => {
    setExampleLoading(true); setStatusMsg(null); onLoading?.(true);
    try {
      const q = `a=${useAviation ? 1 : 0}&t=${useTraffic ? 1 : 0}&w=${useWeather ? 1 : 0}`;
      const r = await fetch(`${API_BASE}/ontology/scenario-example?${q}`);
      const d = await r.json();
      if (!r.ok || d.error || !d.regions) {
        setStatusMsg({ ok: false, text: d.error || d.detail || '예시를 불러오지 못했습니다.' });
        return;
      }
      onResult?.(d);
      setStatusMsg({ ok: true, text: `예시(H5N1/China) · 항공 ${useAviation ? 'ON' : 'OFF'} / 교통 ${useTraffic ? 'ON' : 'OFF'} / 기상 ${useWeather ? 'ON' : 'OFF'} — 모형 누적 감염 ${(d.summary?.total_cases ?? 0).toLocaleString()}명 · ${(d.summary?.total_deaths ?? 0).toLocaleString()}명 사망` });
    } catch (e: any) {
      setStatusMsg({ ok: false, text: String(e?.message || e) });
    } finally { setExampleLoading(false); onLoading?.(false); }
  };

  // Enter example mode: fill the inputs with the canonical demo (H5N1/China via ICN),
  // turn all signals on at default bases, and show the pre-run result. Flipping any
  // toggle afterwards re-fetches the matching pre-run combination (see effect).
  const loadExample = () => {
    setEntryPoint('ICN'); setDisease('H5N1 Avian Influenza'); setCountry('China');
    setUseAviation(true); setUseTraffic(true); setUseWeather(true);
    setExampleMode(true);
  };

  // In example mode, (re)load the demo whenever a signal toggle flips.
  useEffect(() => {
    if (exampleMode) fetchExample();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exampleMode, useAviation, useTraffic, useWeather]);

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
        <strong>가상 유입·확산 시나리오 (역학 SEIR)</strong> — 해외 감염병 유입 또는 국내 지역 발생을 가정해, 선택한 거점에서 전국 17개 시도로 퍼지는 확산을 <strong>메타population SEIR 모델</strong>로 28일간 시뮬레이션해 시도별 <strong>모형 감염·사망·28일 사망비·발병률</strong>을 계산합니다.
        <details className="whatif-method">
          <summary>분석 방법 — SEIR 모델 및 항공·교통·기상 반영</summary>
          <div className="whatif-method-body">
            <p className="whatif-method-head">SEIR 모델</p>
            <p>전국 17개 시도를 각각 하나의 인구집단으로 보고, 각 집단을 <strong>S(취약)·E(잠복)·I(감염)·R(회복)·D(사망)</strong> 다섯 구획으로 나눈다. 시뮬레이션은 하루 단위로 28일간 진행되며 매일 다음을 계산한다.</p>
            <p><strong>① 지역 내 감염</strong> — 한 지역의 감염자(I)가 취약자(S)를 감염시키는 힘은 전파율 β에 비례한다. <em>β = R0 ÷ 전염기(일)</em>이므로 R0가 크거나 전염기가 길수록 빠르게 확산한다. 새로 감염된 사람은 잠복(E) → 감염(I) → 회복(R) 또는 사망(D)으로 이행하며, 잠복기·전염기가 그 속도를 정한다.</p>
            <p><strong>② 지역 간 이동</strong> — 감염자가 다른 시도로 이동해 새 유행을 일으킨다. <strong>실측 교통 OD 보정</strong>을 켜면 고속도로·KORAIL/KTX·SRT·국내선의 출발→도착(OD) 연결성으로 각 도착 지역 i의 유입 비중 <em>Cᵢⱼ</em>를 정규화한다. 이 모드에서는 관측된 OD 경로만 애니메이션에 표시하며, 표본에 없는 경로를 중력모형으로 실제 연결처럼 만들지 않는다. 보정을 끄면 이동이 사라지는 것이 아니라, 인구·거리·허브 연결성을 이용한 기본 중력/허브 이동모형으로 전환한다. 전체 이동 비율 m은 두 모드 모두에서 지역 간 유입 감염력의 비중을 조절한다.</p>
            <p><strong>③ 사망</strong> — 매일 감염 상태를 벗어나는 사람 중 치명률(CFR) 비율이 사망(D)한다. 인구는 보존되며(사망자는 D에 누적), 개입(백신·거리두기)은 없다고 가정한다. Day 0 = 거점만 감염, 나머지 전 지역은 0에서 시작한다.</p>
            <p className="whatif-method-src">Balcan et al. 2009, <em>PNAS</em>(GLEAM) · Chang et al. 2020, <em>Nature</em>(이동 네트워크 SEIR) · Ding et al. 2020(Flight-SEIR). 인구: 행정안전부 주민등록 2026-06(총 5,109만). 질병 파라미터(R0·CFR·잠복기·전염기)는 WHO/CDC 수준 문헌값을 기본으로 하며 신종은 직접 설정한다.</p>
            <p className="whatif-method-head">항공·교통·기상 신호 반영</p>
            <p>각 신호의 <em>값</em>은 실측 API 데이터가 만들고, 사용자가 조절하는 것은 그 값을 수식에 넣는 <em>강도(계수)</em>뿐이다. 아래에 신호별로 [실측 API] 무엇을 불러오는지, [내가 조절] 어떤 강도를 정하는지, [수식] 그 강도가 SEIR의 어디에 들어가는지를 정리했다.</p>
            <ul className="whatif-flow">
              <li><strong>항공 유입</strong></li>
              <li><span className="wf-k api">실측값 (Open API)</span> 인천공항 도착 여객량(data.go.kr) → 발생국의 국가 여객지수(값 고정)</li>
              <li><span className="wf-k knob">조절값</span> 유입 규모 강도 = ×0.5~3.0 (기본 1.0)</li>
              <li><span className="wf-k eq">수식</span> 초기 감염자 <em>I(0) = 5 × 강도 × 여객지수</em> → 거점의 seed. 강도는 API 여객지수에 곱해지는 배수. BlueDot 등 항공 여객 기반 유입위험 추정 방식.</li>
            </ul>
            <ul className="whatif-flow">
              <li><strong>교통 연결성 · 이동 강도</strong> (두 갈래로 반영)</li>
              <li><span className="wf-k api">실측값 (Open API)</span> 고속도로 OD(도로 내 버스 흐름 포함)·KORAIL·국내선 연결성을 결합. 고속도로·KORAIL/KTX·SRT는 관측 OD가 제공될 때만 사용하고, 국내선은 운항횟수 기반 용량 프록시로 명시</li>
              <li><span className="wf-k eq">수식·어디로</span> <em>Cᵢⱼ = OD(j→i) ÷ Σⱼ OD(j→i)</em>. 즉 도착 지역 i로 유입되는 감염 압력의 출발지역별 비중이며, 각 행의 합은 1. 실측 OD 보정 ON에서는 관측 OD 경로만 사용하며, 관측 누락을 중력 경로로 표시하지 않는다. OFF에서는 기본 중력/허브 이동모형을 사용한다. 모드별 실측/프록시 표기는 데이터 파일에 보존.</li>
              <li><span className="wf-k knob">조절값</span> 교통 이동 강도 m = 0.03~0.25 (기본 0.10)</li>
              <li><span className="wf-k eq">수식·얼마나</span> 감염력 <em>λᵢ = (1−m)·βᵢ·Iᵢ/Nᵢ + m·βᵢ·Σⱼ Cᵢⱼ·Iⱼ/Nⱼ</em>. m은 전체 노출 압력 중 타지역에서 오는 비율 → m↑이면 전국 확산이 빨라진다. 지도 선은 매일의 <em>j→i</em> 모형 추정 유입 노출을 표시한다.</li>
            </ul>
            <ul className="whatif-flow">
              <li><strong>기상 전파력</strong></li>
              <li><span className="wf-k api">실측값 (Open API)</span> 기상청 단기+중기예보 기온(~10일, data.go.kr) → 시도별 저온지수(favorability) 0~1, 추울수록↑ (값 고정)</li>
              <li><span className="wf-k knob">조절값</span> 기상 강도 = 0~1 (기본 0.3)</li>
              <li><span className="wf-k eq">수식</span> 전파율 <em>β_i = β × (1 + 강도 × 저온지수)</em>, 예보 가능한 10일 이내만 적용. 강도는 API 저온지수에 곱해지는 계수. Shang et al. 2026, <em>Environment International</em> meta analysis.</li>
            </ul>
          </div>
        </details>
        <span className="whatif-ref-note">개입(백신·거리두기) 없는 자연확산을 가정한 예시 시나리오입니다.</span>
      </div>
      <div className="whatif-row">
        <label>유입·확산 거점</label>
        <input list="entry-point-list" value={entryPoint} onChange={(e) => setEntryPoint(e.target.value)}
          className="whatif-input" placeholder="공항 코드·지역명 또는 직접 입력 (예: ICN, 대구, 부산)" />
        <datalist id="entry-point-list">
          {ENTRY_POINTS.map((ep) => (
            <option key={ep.code} value={ep.code}>{ep.label} — 해외 유입</option>
          ))}
          {['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'].map((n) => (
            <option key={n} value={n}>{n} — 국내 발생</option>
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
      <div className="whatif-epi-params">
        <div className="whatif-epi-head">
          역학 파라미터
          {diseasePreset
            ? <span className="whatif-epi-known">{diseasePreset.label} 기본값 · 수정 가능</span>
            : <span className="whatif-epi-novel">신종감염병 — 직접 설정</span>}
        </div>
        <div className="whatif-epi-grid">
          <label>R0<input type="number" step="0.1" min="0" value={r0} onChange={(e) => setR0(e.target.value)} className="whatif-input" /></label>
          <label>CFR %<input type="number" step="0.1" min="0" max="100" value={cfr} onChange={(e) => setCfr(e.target.value)} className="whatif-input" /></label>
          <label>잠복기(일)<input type="number" step="1" min="1" value={incubation} onChange={(e) => setIncubation(e.target.value)} className="whatif-input" /></label>
          <label>전염기(일)<input type="number" step="1" min="1" value={infectious} onChange={(e) => setInfectious(e.target.value)} className="whatif-input" /></label>
        </div>
        <div className="whatif-epi-hint">알려진 질병은 논문 기반 기본값이 자동 입력됩니다. 신종감염병은 직접 설정하세요. 전파·사망 규모는 전적으로 이 R0·CFR·잠복기·전염기로 결정됩니다.</div>
      </div>
      <div className="whatif-example-box">
        <button type="button" className={`whatif-example-btn ${exampleMode && !isAdmin ? 'is-on' : ''}`}
          onClick={isAdmin ? runNationalScenario : loadExample}
          disabled={isAdmin ? loading : exampleLoading}>
          {(isAdmin ? loading : exampleLoading) ? '시나리오 분석 중…' : '시나리오 분석'}
        </button>
        <div className="whatif-example-note">
          {isAdmin
            ? '위 입력값(거점·질병·R0·CFR·잠복기·전염기)과 아래 항공·교통·기상 토글로 실제 데이터 SEIR + AI 분석을 실행합니다.'
            : '예시 분석을 실행합니다(H5N1/China 기준). 아래 항공·교통·기상 토글 조합이 반영되어 지도·애니메이션·유행곡선·시도별 지표가 표시됩니다. admin 계정으로 로그인하면 위 입력값으로 실제 데이터 분석이 가능합니다.'}
        </div>
        {statusMsg && (
          <div className={`whatif-status-msg ${statusMsg.ok ? 'whatif-status-success' : 'whatif-status-error'}`}>
            {statusMsg.text}
          </div>
        )}
      </div>
      <label className={`whatif-aviation-toggle ${useAviation ? 'is-on' : ''}`}>
        <input type="checkbox" checked={useAviation} onChange={(e) => setUseAviation(e.target.checked)} />
        <span className="whatif-aviation-label">항공상황 add</span>
        <span className="whatif-aviation-hint">발생국 → 인천공항 실측 여객량으로 유입 규모(초기 감염 seed)를 스케일 (끄면 국가 proxy)</span>
      </label>
      {useAviation && (
        <div className="whatif-intensity">
          <label>유입 규모 강도 <strong className="whatif-base-val">×{aviationIntensity.toFixed(1)}</strong></label>
          <input type="range" min={0.5} max={3} step={0.5} value={aviationIntensity} disabled={exampleMode}
            onChange={(e) => setAviationIntensity(Number(e.target.value))} className="whatif-traffic-base-slider" />
          <span className="whatif-intensity-hint">초기 감염자 = 5 × 강도 × 여객지수 → SEIR의 I(t=0). 클수록 시작 규모↑</span>
        </div>
      )}
      <label className={`whatif-aviation-toggle ${useTraffic ? 'is-on' : ''}`}>
        <input type="checkbox" checked={useTraffic} onChange={(e) => setUseTraffic(e.target.checked)} />
        <span className="whatif-aviation-label">실측 교통 OD 보정</span>
        <span className="whatif-aviation-hint">ON: 고속도로·KORAIL/KTX·SRT·국내선의 관측 출발→도착(OD) 경로만 반영합니다. OFF: 실측값만 제외하며, 기본 중력/허브 이동모형은 계속 적용됩니다. 고속도로에는 도로 내 버스 흐름이 포함됩니다.</span>
      </label>
      <div className="whatif-traffic-controls">
        <div className="whatif-intensity">
          <label>지역 간 이동 강도 (m) <strong className="whatif-base-val">{trafficIntensity.toFixed(2)}</strong></label>
          <input type="range" min={0.03} max={0.25} step={0.01} value={trafficIntensity} disabled={exampleMode}
            onChange={(e) => setTrafficIntensity(Number(e.target.value))} className="whatif-traffic-base-slider" />
          <span className="whatif-intensity-hint">{useTraffic
            ? '실측 OD는 경로(어디로), m은 유입 노출의 비중(얼마나)을 조절합니다. 관측되지 않은 경로는 실측 전파선으로 표시하지 않습니다.'
            : '실측 OD는 제외했지만, m은 인구·거리·허브 기반 기본 이동모형의 지역 간 섞임 비중으로 계속 적용됩니다.'}</span>
        </div>
        {useTraffic && <div className="whatif-traffic-refresh">
          <span className="whatif-traffic-updated">
            {trafficUpdatedAt
              ? `교통데이터 기준: ${new Date(trafficUpdatedAt).toLocaleString('ko-KR')}`
              : '교통데이터 미수집 (기본: 월요일 자동 갱신)'}
          </span>
          <button type="button" className="whatif-traffic-refresh-btn"
            onClick={refreshTraffic} disabled={trafficRefreshing || exampleMode}>
            {trafficRefreshing ? '갱신 중…' : '최신 반영'}
          </button>
          {trafficMsg && <span className="whatif-traffic-msg">{trafficMsg}</span>}
        </div>}
      </div>      <label className={`whatif-aviation-toggle ${useWeather ? 'is-on' : ''}`}>
        <input type="checkbox" checked={useWeather} onChange={(e) => setUseWeather(e.target.checked)} />
        <span className="whatif-aviation-label">기상상황 add</span>
        <span className="whatif-aviation-hint">기상청 예보 기온(~10일)으로 초기 ≤10일 전파력을 보정 — 실행 시 실시간 조회 (끄면 미반영). 방법·출처는 위 설명 참고.</span>
      </label>
      {useWeather && (
        <div className="whatif-intensity">
          <label>기상 강도 <strong className="whatif-base-val">{weatherIntensity.toFixed(1)}</strong></label>
          <input type="range" min={0} max={1} step={0.1} value={weatherIntensity} disabled={exampleMode}
            onChange={(e) => setWeatherIntensity(Number(e.target.value))} className="whatif-traffic-base-slider" />
          <span className="whatif-intensity-hint">β = β × (1 + 강도 × 저온지수) (≤10일). 클수록 계절(추위) 영향↑</span>
        </div>
      )}
    </div>
  );
}
