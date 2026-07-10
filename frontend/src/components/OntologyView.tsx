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
interface NationalOutbreakResult {
  entry_point: { code: string; label: string; primary_zones: string[]; seed_region?: string; seed_region_name?: string };
  scenario: { disease: string; disease_matched?: string; is_novel?: boolean; country: string; severity: string;
    r0: number; cfr: number; r0_base?: number; cfr_base?: number; incubation_days?: number; infectious_days?: number;
    aviation?: { multiplier: number; arr_passengers: number; country_kr: string; month: string } | null;
    aviation_source?: string; traffic_source?: string; weather_source?: string };
  regions: NationalRegionResult[];
  summary: { total_regions: number; total_cases: number; total_deaths: number; national_cfr: number;
    attack_rate: number; peak_day: number; peak_new_cases: number; affected_regions: number;
    worst_regions: { name: string; cases: number }[];
    national_curve: { day: number; cumulative_cases: number; cumulative_deaths: number; new_cases: number }[];
    sensitivity?: { key: string; label: string; unit: string; low_val: number; cur_val: number; high_val: number; low_cases: number; cur_cases: number; high_cases: number }[];
    response_playbook?: { stage: string; phase: string; actions: string[] }[];
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

// ─── Animated spread figure: aviation import → connectivity/proximity spread ──
// Plays the backend's day-level timeline (0/3/7/10일 → 2/3/4주) across the landing
// 시도 map: the entry point (항공 유입 거점) seeds, spread edges fan out with each
// region's traffic connectivity, nodes grow with predicted score. Weather (short-term
// forecast) only shapes the ≤10일 points; auto-plays and is manually scrubbable.
function ScenarioSpreadMap({ regions, primaryZones, entryLabel }: {
  regions: NationalRegionResult[];
  primaryZones: string[];
  entryLabel: string;
}) {
  const features = useKoreaGeoJSON();
  const days = useMemo(() => {
    const t = regions.find((r) => r.timeline?.length)?.timeline;
    return t?.map((p) => p.day) ?? [0, 3, 7, 10, 14, 21, 28];
  }, [regions]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);

  const projection = useMemo(() => d3.geoMercator().center([127.8, 36.0]).scale(4800).translate([200, 240]), []);
  const pathGen = useMemo(() => d3.geoPath().projection(projection), [projection]);

  const regionByCode = useMemo(() => new Map(regions.map((r) => [r.region_id, r])), [regions]);
  const centroids = useMemo(() => {
    const m = new Map<string, [number, number]>();
    SIDO_LABELS.forEach((s) => { const p = projection([s.lng, s.lat]); if (p) m.set(s.code, [p[0], p[1]]); });
    return m;
  }, [projection]);

  // Visualise RELATIVE spread: each region's cumulative cases vs the current worst
  // region that frame, so the map lights up and the diffusion pattern is legible even
  // while absolute attack rates are still tiny early on. (Table shows absolute numbers.)
  const casesAt = (r: NationalRegionResult, i: number): number => r.timeline?.[i]?.cumulative_cases ?? 0;
  const maxCasesAt = useMemo(
    () => days.map((_, i) => Math.max(1, ...regions.map((r) => casesAt(r, i)))),
    [regions, days]);
  const relAt = (r: NationalRegionResult, i: number): number => casesAt(r, i) / (maxCasesAt[i] || 1);
  const levelAt = (r: NationalRegionResult, i: number): string => {
    const rel = relAt(r, i);
    return rel >= 0.66 ? 'G3' : rel >= 0.33 ? 'G2' : rel >= 0.08 ? 'G1' : 'G0';
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
      .map((r) => { const c = centroids.get(r.region_id); return c ? { code: r.region_id, from: o, to: c, mult: (r.connectivity ?? r.spread_multiplier) || 0 } : null; })
      .filter(Boolean) as { code: string; from: [number, number]; to: [number, number]; mult: number }[];
  }, [regions, originPts, centroids, primaryZones]);
  const maxMult = useMemo(() => Math.max(1, ...edges.map((e) => e.mult)), [edges]);
  const minMult = useMemo(() => Math.min(1, ...edges.map((e) => e.mult)), [edges]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setIdx((i) => (i >= days.length - 1 ? 0 : i + 1)), 1050);
    return () => clearInterval(id);
  }, [playing, days.length]);

  const dayLabel = (d: number) => (d <= 0 ? '현재 (기준)' : d < 14 ? `${d}일 후` : `${d / 7}주 후`);
  const curDay = days[idx] ?? 0;

  return (
    <div className="scenario-spread">
      <div className="scenario-spread-head">
        <button type="button" className="scenario-spread-play" onClick={() => setPlaying((p) => !p)}>
          {playing ? '일시정지' : '재생'}
        </button>
        <input type="range" min={0} max={days.length - 1} step={1} value={idx}
          onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)); }}
          className="scenario-spread-slider" />
        <span className="scenario-spread-week">{dayLabel(curDay)}{curDay > 0 && curDay <= 10 ? ' · 기상반영' : ''}</span>
      </div>
      <svg viewBox="0 0 400 525" className="scenario-spread-svg korea-geo-svg">
        <defs>
          <filter id="spread-glow">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {polys.map((p) => {
          const r = p.code ? regionByCode.get(p.code) : undefined;
          const level = r ? levelAt(r, idx) : 'G0';
          return (
            <path key={p.key} d={p.d} fill={GLEVEL_COLORS[level] || GLEVEL_COLORS.G0}
              fillOpacity={idx === 0 ? 0.32 : 0.6} stroke="rgba(100,150,200,0.25)" strokeWidth={0.3}
              style={{ transition: 'fill 0.7s ease, fill-opacity 0.7s ease' }} />
          );
        })}
        {idx >= 1 && edges.map((e) => {
          const r = regionByCode.get(e.code);
          if (!r || casesAt(r, idx) <= 0) return null;
          // Thickness + dash density scale with traffic connectivity (spread_multiplier):
          // busier corridors get thicker, denser-dashed spread paths.
          const norm = maxMult > minMult ? (e.mult - minMult) / (maxMult - minMult) : 0.5;
          return (
            <line key={e.code} x1={e.from[0]} y1={e.from[1]} x2={e.to[0]} y2={e.to[1]}
              stroke="rgba(255,120,60,0.62)" strokeWidth={0.6 + 3.4 * norm}
              strokeLinecap="round" strokeDasharray={`${(2 + 3 * norm).toFixed(1)} ${(6 - 3 * norm).toFixed(1)}`}
              className="scenario-spread-edge" />
          );
        })}
        {SIDO_LABELS.map((s) => {
          const r = regionByCode.get(s.code);
          const pt = centroids.get(s.code);
          if (!pt) return null;
          const level = r ? levelAt(r, idx) : 'G0';
          const rel = r ? relAt(r, idx) : 0;
          const rad = 3 + rel * 14;
          const isOrigin = primaryZones.includes(s.code);
          const active = rel > 0.1;
          return (
            <g key={s.code}>
              {isOrigin && (
                <circle cx={pt[0]} cy={pt[1]} r={rad + 5} fill="none"
                  stroke="rgba(255,90,50,0.75)" strokeWidth={1.6} className="scenario-spread-origin" />
              )}
              {!isOrigin && active && (
                <circle cx={pt[0]} cy={pt[1]} r={rad + 3} fill="none"
                  stroke={GLEVEL_COLORS[level] || GLEVEL_COLORS.G0} strokeOpacity={0.55} strokeWidth={1.3}
                  className="scenario-spread-pulse" />
              )}
              <circle cx={pt[0]} cy={pt[1]} r={rad} fill={GLEVEL_COLORS[level] || GLEVEL_COLORS.G0}
                fillOpacity={isOrigin ? 0.68 : 1} stroke="#fff" strokeWidth={1}
                filter={isOrigin || level === 'G3' ? 'url(#spread-glow)' : undefined}
                style={{ transition: 'r 0.6s ease, fill 0.6s ease' }} />
              <text x={pt[0]} y={pt[1] - rad - 3} textAnchor="middle" fontSize={9} fontWeight={700}
                fill="#e5e7eb" stroke="rgba(0,0,0,0.6)" strokeWidth={2} paintOrder="stroke"
                style={{ pointerEvents: 'none' }}>{s.abbr}</text>
            </g>
          );
        })}
      </svg>
      <div className="scenario-spread-legend">
        <span><i className="ssl-origin" /> 유입 거점: {entryLabel}</span>
        <span><i className="ssl-edge" /> 확산 경로 (굵기·밀도 = 교통 연결성)</span>
        <span><i className="ssl-node" /> 시도 감염 규모 (크기·색 = 최다 지역 대비 상대)</span>
      </div>
    </div>
  );
}

// ─── Epidemic curve: cumulative cases + deaths over the day-level timeline ───
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
        {curve.map((c) => (
          <text key={c.day} x={x(c.day)} y={H - padB + 12} textAnchor="middle" fontSize={8} fill="var(--text-muted,#94a3b8)">
            {c.day === 0 ? '0' : c.day < 14 ? `${c.day}일` : `${c.day / 7}주`}
          </text>
        ))}
        <line x1={x(peakDay)} y1={padT} x2={x(peakDay)} y2={H - padB} stroke="rgba(56,189,248,0.55)" strokeWidth={1} strokeDasharray="3 3" />
        <path d={area} fill="rgba(255,159,67,0.15)" />
        <path d={casesLine} fill="none" stroke="#ff9f43" strokeWidth={2} />
        <path d={line('cumulative_deaths')} fill="none" stroke="#ff4d4f" strokeWidth={1.8} />
        {curve.map((c) => <circle key={c.day} cx={x(c.day)} cy={y(c.cumulative_cases)} r={2.2} fill="#ff9f43" />)}
      </svg>
      <div className="epi-chart-legend">
        <span><i style={{ background: '#ff9f43' }} /> 누적 확진 (최대 {maxCases.toLocaleString()})</span>
        <span><i style={{ background: '#ff4d4f' }} /> 누적 사망 (최대 {maxDeaths.toLocaleString()})</span>
        <span className="epi-chart-peak">정점 {peakDay}일차</span>
      </div>
    </div>
  );
}

// ─── Sensitivity tornado: how much each signal's intensity drives the case total ──
function SensitivityChart({ items }: {
  items: { key: string; label: string; unit: string; low_val: number; cur_val: number; high_val: number; low_cases: number; cur_cases: number; high_cases: number }[];
}) {
  const W = 460, rowH = 40, padL = 96, padR = 58, padT = 6;
  const H = padT + items.length * rowH + 8;
  const maxCases = Math.max(...items.map((s) => s.high_cases), 1);
  const x = (v: number) => padL + (v / maxCases) * (W - padL - padR);
  return (
    <div className="sens-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="sens-chart-svg">
        {items.map((s, i) => {
          const cy = padT + i * rowH + rowH / 2 - 4;
          return (
            <g key={s.key}>
              <text x={2} y={cy - 1} fontSize={10} fontWeight={700} fill="var(--text-primary, #0f172a)">{s.label}</text>
              <text x={2} y={cy + 11} fontSize={8} fill="var(--text-muted, #94a3b8)">{s.low_val}{s.unit} → {s.high_val}{s.unit}</text>
              <line x1={x(s.low_cases)} y1={cy} x2={x(s.high_cases)} y2={cy} stroke="#ff9f43" strokeWidth={8} strokeLinecap="round" opacity={0.45} />
              <text x={x(s.low_cases) - 4} y={cy + 3} fontSize={8} textAnchor="end" fill="var(--text-muted, #94a3b8)">{s.low_cases.toLocaleString()}</text>
              <text x={x(s.high_cases) + 4} y={cy + 3} fontSize={9} textAnchor="start" fontWeight={700} fill="var(--text-secondary, #475569)">{s.high_cases.toLocaleString()}</text>
              <circle cx={x(s.cur_cases)} cy={cy} r={4} fill="#ff4d4f" stroke="#fff" strokeWidth={1.5} />
            </g>
          );
        })}
      </svg>
      <div className="epi-chart-legend">
        <span><i style={{ background: '#ff9f43', height: '6px', borderRadius: '3px' }} /> 강도 최저↔최고 시 28일 확진 범위</span>
        <span><i style={{ background: '#ff4d4f', width: '9px', height: '9px', borderRadius: '50%' }} /> 현재 설정</span>
      </div>
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
        <span className="whatif-analysis-tag">OUTBREAK EPIDEMIC SIMULATION</span>
        <span className="whatif-analysis-region">{ep?.label || ep?.code || '—'}{ep?.seed_region_name && ep.seed_region_name !== ep.label ? ` → ${ep.seed_region_name}` : ''}</span>
        <span className="whatif-analysis-scenario">{sc?.disease} / {sc?.country} / {sc?.severity}</span>
        <span className="whatif-mobility-badge" title="유효 기초감염재생산수 (severity 반영)">R0 {sc?.r0}</span>
        <span className="whatif-mobility-badge" title="유효 치명률 (severity 반영, 최대 50%)">CFR {pct(sc?.cfr, 1)}</span>
        {sc?.is_novel && <span className="whatif-mobility-badge whatif-mobility-badge--real" title="신종감염병 — 직접 설정한 파라미터로 시뮬레이션">신종 파라미터</span>}
        {sc?.aviation_source === 'aviation' && (
          <span className="whatif-mobility-badge whatif-mobility-badge--real" title="발생국→인천 실측 도착 여객량으로 유입 규모(seed) 스케일">항공 유입 반영(실측)</span>
        )}
        {sc?.traffic_source === 'highway' && (
          <span className="whatif-mobility-badge whatif-mobility-badge--real" title="고속도로 실측 교통 연결성을 지역 간 이동 결합에 반영">교통 연결성 반영(실측)</span>
        )}
        {sc?.weather_source === 'kma' && (
          <span className="whatif-mobility-badge whatif-mobility-badge--real" title="기상청 예보 기온으로 ≤10일 전파력 보정">기상 전파력 반영</span>
        )}
      </div>

      {/* Epidemiological headline numbers (28일 후) */}
      <div className="national-summary-bar epi">
        <div className="national-summary-stat">
          <span className="national-summary-num">{fmt(s?.total_cases)}</span>
          <span className="national-summary-label">누적 확진 (28일)</span>
        </div>
        <div className="national-summary-stat">
          <span className="national-summary-num death">{fmt(s?.total_deaths)}</span>
          <span className="national-summary-label">누적 사망</span>
        </div>
        <div className="national-summary-stat">
          <span className="national-summary-num">{pct(s?.national_cfr, 1)}</span>
          <span className="national-summary-label">전국 치명률</span>
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
          <div className="whatif-section-title">확산 시뮬레이션 · 유입 거점 → 전국 (노드 크기 = 예측 감염 강도)</div>
          <ScenarioSpreadMap regions={regions}
            primaryZones={ep?.seed_region ? [ep.seed_region] : (ep?.primary_zones || [])}
            entryLabel={ep?.seed_region_name || ep?.label || '유입 거점'} />
        </div>
      )}

      {/* Epidemic curve + sensitivity — side by side on wide screens */}
      {((s?.national_curve && s.national_curve.length > 0) || (s?.sensitivity && s.sensitivity.length > 0)) && (
        <div className="whatif-figrow">
          {s?.national_curve && s.national_curve.length > 0 && (
            <div className="whatif-section whatif-fig">
              <div className="whatif-section-title">전국 유행곡선 · 누적 확진 및 사망 (정점 {s.peak_day}일차)</div>
              <EpiCurveChart curve={s.national_curve} peakDay={s.peak_day} />
            </div>
          )}
          {s?.sensitivity && s.sensitivity.length > 0 && (
            <div className="whatif-section whatif-fig">
              <div className="whatif-section-title">강도 민감도 요약 · 어떤 신호가 결과를 가장 좌우하나</div>
              <SensitivityChart items={s.sensitivity} />
              <div className="epi-region-caveat">각 신호의 강도를 최저·최고로 바꿔 SEIR을 재실행했을 때의 28일 누적 확진 범위입니다(나머지 조건은 현재값 고정). 막대가 길수록 결과를 크게 좌우하는 요인입니다.</div>
            </div>
          )}
        </div>
      )}

      {/* Narrative */}
      <div className="ontology-decision-narrative">{result.narrative}</div>

      {/* Region table — cumulative cases per 시도 across the forecast stages (확진 순) */}
      <div className="whatif-section">
        <div className="whatif-section-title">시도별 역학 지표 · 시기별 누적 확진 (단기 3·7일 / 중기 2·3주 / 28일)</div>
        <div className="epi-region-table epi-region-staged">
          <div className="epi-region-superhead">
            <span></span>
            <span className="epi-grp short" style={{ gridColumn: 'span 2' }}>단기예측</span>
            <span className="epi-grp mid" style={{ gridColumn: 'span 2' }}>중기예측</span>
            <span className="epi-grp final">최종</span>
            <span style={{ gridColumn: 'span 2' }}>28일 기준</span>
          </div>
          <div className="epi-region-header">
            <span>지역</span><span>3일</span><span>7일</span><span>2주</span><span>3주</span><span>28일</span><span>사망</span><span>치명률</span>
          </div>
          {regions.map((r) => {
            const at = (day: number) => r.timeline?.find((t) => t.day === day)?.cumulative_cases ?? 0;
            return (
              <div key={r.region_id} className={`epi-region-row ${r.is_seed ? 'seed' : ''}`}>
                <span className="epi-region-name">
                  {r.is_seed && <span className="epi-seed-badge">유입</span>}
                  {r.region_name}
                </span>
                <span className="epi-num small">{fmt(at(3))}</span>
                <span className="epi-num small">{fmt(at(7))}</span>
                <span className="epi-num">{fmt(at(14))}</span>
                <span className="epi-num">{fmt(at(21))}</span>
                <span className="epi-num strong">{fmt(r.cumulative_cases)}</span>
                <span className="epi-num death">{fmt(r.cumulative_deaths)}</span>
                <span className="epi-num">{pct(r.effective_cfr, 1)}</span>
              </div>
            );
          })}
        </div>
        <div className="epi-region-caveat">단기·중기 열은 각 시점의 <strong>누적 확진</strong>, 사망·치명률은 28일 기준입니다. 개입(백신·거리두기) 없는 자연확산 가정의 예시 시나리오이며 예보가 아닙니다. 인구: 행정안전부 주민등록 2026-06.</div>
      </div>

      {/* 시기별 대응 방안 — AI (Gemini) 분석이 우선, 없으면 규칙 기반 fallback */}
      {aiActions.length > 0 ? (
        <div className="whatif-section">
          <div className="whatif-section-title">시기별 대응 방안 · AI 분석 (Gemini)</div>
          <div className="epi-playbook">
            {(['단기', '중기', '후기'] as const).map((key, idx) => {
              const label = ['단기 (0~7일)', '중기 (1~3주)', '후기 (21~28일)'][idx];
              const items = aiActions.filter((a) => aiBucket(a.timing) === key);
              if (items.length === 0) return null;
              return (
                <div key={key} className="epi-playbook-stage">
                  <div className="epi-playbook-head">
                    <span className="epi-playbook-when">{label}</span>
                    <span className="epi-playbook-phase">AI 권고</span>
                  </div>
                  <ul className="epi-playbook-actions">
                    {items.map((a, j) => (
                      <li key={j}>
                        {a.priority && <span className={`epi-ai-prio ${(a.priority || '').toLowerCase()}`}>{prioKr(a.priority)}</span>}
                        {a.action}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
          <div className="epi-region-caveat">Sentinel AI(Gemini)가 위 SEIR 시뮬레이션 결과(정점 시점·치명률·전파력)를 해석해 생성한 시기별 대응 권고입니다.</div>
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
          <div className="epi-region-caveat">AI 분석(Gemini)을 사용할 수 없어 규칙 기반 권고를 표시합니다. K-방역 3T · WHO 봉쇄–완화 단계 프레임워크 기반이며 정점 시점·치명률·전파력에 맞춰 조정됩니다.</div>
        </div>
      ))}

      {/* AI 시나리오 분석 (Gemini) — 영향·확산 양상·전개·위험 (대응 방안은 위 전용 섹션) */}
      {g && !g.error && !g.parse_error && (g.impact_summary || g.spread_pattern || (g.timeline && g.timeline.length > 0) || (g.high_risk_regions && g.high_risk_regions.length > 0) || g.best_case || g.worst_case || g.risk_factors) && (
        <div className="whatif-gemini">
          <div className="whatif-section-title whatif-ai-head">AI 시나리오 분석 (Gemini)</div>
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
                  <span className="ontology-pill ontology-rec-priority-HIGH">{hr.region}</span>
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
                    <div className="ontology-type-card-kr">가상 유입·확산 시나리오 분석</div>
                    <div className="ontology-type-card-desc">
                      해외 감염병 유입 또는 국내 지역 발생을 가정해, 선택한 거점(공항·지역)에서 전국 17개 시도로 퍼지는 확산을 메타population SEIR 모델로 시뮬레이션합니다. 실제 인구·질병 파라미터로 시도별 확진·사망·치명률·발병률을 계산하고, 확산 애니메이션과 유행곡선을 제공합니다.
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

function WhatIfStandalonePanel({ isAdmin, adminHeaders, onResult }: {
  isAdmin: boolean; adminHeaders: () => Promise<Record<string, string>>;
  onResult?: (result: NationalOutbreakResult) => void;
}) {
  const [entryPoint, setEntryPoint] = useState('');
  const [disease, setDisease] = useState('');
  const [country, setCountry] = useState('');
  const [severity, setSeverity] = useState('');
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
    setLoading(true); setStatusMsg(null); setExampleMode(false);
    try {
      const r = await fetch(`${API_BASE}/ontology/functions/whatIfOutbreakNational`, {
        method: 'POST', headers: await adminHeaders(),
        body: JSON.stringify({ inputs: { entry_point: entryPoint, disease, country, severity, use_aviation: useAviation, use_traffic: useTraffic, use_weather: useWeather,
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
        setStatusMsg({ ok: true, text: `28일 후 누적 ${(result.summary?.total_cases || 0).toLocaleString()}명 확진 · ${(result.summary?.total_deaths || 0).toLocaleString()}명 사망 예상 — 결과 확인 →` });
        onResult?.(result);
      }
    } catch (e: any) {
      setStatusMsg({ ok: false, text: String(e?.message || e) });
    } finally { setLoading(false); }
  };

  // Public demo — fetch the pre-run H5N1/China scenario for the CURRENT toggle combo
  // so anyone (incl. non-admin / read-only judges) can see how each signal changes it.
  const fetchExample = async () => {
    setExampleLoading(true); setStatusMsg(null);
    try {
      const q = `a=${useAviation ? 1 : 0}&t=${useTraffic ? 1 : 0}&w=${useWeather ? 1 : 0}`;
      const r = await fetch(`${API_BASE}/ontology/scenario-example?${q}`);
      const d = await r.json();
      if (!r.ok || d.error || !d.regions) {
        setStatusMsg({ ok: false, text: d.error || d.detail || '예시를 불러오지 못했습니다.' });
        return;
      }
      onResult?.(d);
      setStatusMsg({ ok: true, text: `예시(H5N1/China) · 항공 ${useAviation ? 'ON' : 'OFF'} / 교통 ${useTraffic ? 'ON' : 'OFF'} / 기상 ${useWeather ? 'ON' : 'OFF'} — 누적 ${(d.summary?.total_cases ?? 0).toLocaleString()}명 확진 · ${(d.summary?.total_deaths ?? 0).toLocaleString()}명 사망` });
    } catch (e: any) {
      setStatusMsg({ ok: false, text: String(e?.message || e) });
    } finally { setExampleLoading(false); }
  };

  // Enter example mode: fill the inputs with the canonical demo (H5N1/China via ICN),
  // turn all signals on at default bases, and show the pre-run result. Flipping any
  // toggle afterwards re-fetches the matching pre-run combination (see effect).
  const loadExample = () => {
    setEntryPoint('ICN'); setDisease('H5N1 Avian Influenza'); setCountry('China'); setSeverity('high');
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
        <strong>가상 유입·확산 시나리오 (역학 SEIR)</strong> — 해외 감염병 유입 또는 국내 지역 발생을 가정해, 선택한 거점에서 전국 17개 시도로 퍼지는 확산을 <strong>메타population SEIR 모델</strong>로 28일간 시뮬레이션해 시도별 <strong>확진·사망·치명률·발병률</strong>을 계산합니다.
        <details className="whatif-method">
          <summary>분석 방법 — SEIR 모델 및 항공·교통·기상 반영</summary>
          <div className="whatif-method-body">
            <p className="whatif-method-head">SEIR 모델</p>
            <p>전국 17개 시도를 각각 하나의 인구집단으로 보고, 각 집단을 <strong>S(취약)·E(잠복)·I(감염)·R(회복)·D(사망)</strong> 다섯 구획으로 나눈다. 시뮬레이션은 하루 단위로 28일간 진행되며 매일 다음을 계산한다.</p>
            <p><strong>① 지역 내 감염</strong> — 한 지역의 감염자(I)가 취약자(S)를 감염시키는 힘은 전파율 β에 비례한다. <em>β = R0 ÷ 전염기(일)</em>이므로 R0가 크거나 전염기가 길수록 빠르게 확산한다. 새로 감염된 사람은 잠복(E) → 감염(I) → 회복(R) 또는 사망(D)으로 이행하며, 잠복기·전염기가 그 속도를 정한다.</p>
            <p><strong>② 지역 간 이동</strong> — 감염자가 다른 시도로 이동해 새 유행을 일으킨다. 두 지역의 결합 강도는 <em>중력 모형</em>(인구가 많고 가까울수록 강함)에 지역별 연결성(교통 add 시 실측 교통량, 아니면 허브 가중치)을 곱해 만든 17×17 연결행렬 C로 정하고, 전체 이동 비율 m으로 조절한다. 연결성·이동 강도의 계산은 아래 신호 반영에 정리했다.</p>
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
              <li><span className="wf-k api">실측값 (Open API)</span> 고속도로 도착 교통량(data.ex.co.kr) → 시도별 연결성 가중치(값 고정)</li>
              <li><span className="wf-k eq">수식·어디로</span> 확산 결합 <em>C_ij = 인구_j ÷ 거리² × 연결성_j</em> (중력모형 = 인접성 × 연결성). 교통 add를 끄면 허브 가중치(서울·인천 1.0 / 경기 0.9 / 부산 0.8 / 제주 0.7 / 대구·경남 0.6 / 그 외 0.5), 켜면 실측 교통량을 연결성_j에 사용. 지도 확산 경로의 굵기·밀도가 이 값.</li>
              <li><span className="wf-k knob">조절값</span> 교통 이동 강도 m = 0.03~0.25 (기본 0.10)</li>
              <li><span className="wf-k eq">수식·얼마나</span> 감염력 <em>λ = (1−m)·지역내 + m·β·Σ C·(타지역 감염)</em>. m은 전체 감염력 중 타지역에서 오는 비율 → m↑이면 전국 확산이 빨라진다. 시도 간 이동량 기반 COVID-19 확산 네트워크 연구에 근거.</li>
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
        <div className="whatif-epi-hint">알려진 질병은 논문 기반 기본값이 자동 입력됩니다. 신종감염병은 직접 설정하세요. Severity가 R0·CFR에 배수로 적용됩니다(결과 배지 참고).</div>
      </div>
      <div className="whatif-example-box">
        <button type="button" className={`whatif-example-btn ${exampleMode ? 'is-on' : ''}`}
          onClick={loadExample} disabled={exampleLoading}>
          {exampleLoading ? '예시 분석 중…' : '예시 분석 · H5N1 China 조류독감'}
        </button>
        <div className="whatif-example-note">
          예시 분석을 실행합니다. 클릭하면 지도·확산 애니메이션·유행곡선·시도별 역학 지표(확진·사망·치명률)가 표시됩니다. 예시는 H5N1 기본 파라미터로 분석됩니다. 실제 데이터로 직접 실행하려면 상단 (i)의 이메일로 admin 계정을 문의해 주세요.
        </div>
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
        <span className="whatif-aviation-label">교통상황 add</span>
        <span className="whatif-aviation-hint">고속도로 실측 교통 연결성을 지역 간 이동·확산 경로에 반영 (끄면 인구·거리 기본). 방법·출처는 위 설명 참고.</span>
      </label>
      {useTraffic && (
        <div className="whatif-traffic-controls">
          <div className="whatif-intensity">
            <label>교통 이동 강도 (m) <strong className="whatif-base-val">{trafficIntensity.toFixed(2)}</strong></label>
            <input type="range" min={0.03} max={0.25} step={0.01} value={trafficIntensity} disabled={exampleMode}
              onChange={(e) => setTrafficIntensity(Number(e.target.value))} className="whatif-traffic-base-slider" />
            <span className="whatif-intensity-hint">지역 간 섞임 전체 세기 m — 경로(어디로)는 실측 교통량이 결정, m은 그 세기(얼마나)를 조절. λ = (1−m)·지역내 + m·β·타지역. m↑이면 전국 확산↑</span>
          </div>
          <div className="whatif-traffic-refresh">
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
          </div>
        </div>
      )}
      <label className={`whatif-aviation-toggle ${useWeather ? 'is-on' : ''}`}>
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
