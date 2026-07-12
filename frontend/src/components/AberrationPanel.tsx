import { useCallback, useEffect, useMemo, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// ── 타입 ──────────────────────────────────────────────────────────────────
interface WeekResult {
  epiweek: string | null;
  index: number;
  observed: number | null;
  expected: number | null;
  threshold: number | null;
  alarm: boolean;
  exceedance_score: number | null;
  trend?: boolean;
  note?: string | null;
}

interface OverviewRow {
  disease: string;
  category?: string;
  is_respiratory_virus?: boolean;
  latest: WeekResult;
  alarm: boolean;
  recent_max_observed?: number;
  baseline_elevated?: boolean;
  recent_alarm_count?: number;
  recent_alarm_weeks?: (string | null)[];
  max_exceedance?: number | null;
}

interface Overview {
  status: string;
  source?: string;
  is_synthetic?: boolean;
  method?: string;
  region?: string;
  latest_epiweek?: string;
  alarm_count?: number;
  diseases: OverviewRow[];
}

interface DetectResponse {
  status: string;
  disease: string;
  region: string;
  is_synthetic?: boolean;
  series_weeks: number;
  results: WeekResult[];
  summary?: { alarm_count: number; alarm_weeks: (string | null)[] };
}

// ── 유틸 ──────────────────────────────────────────────────────────────────
function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (Math.abs(v) >= 100) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

// ── 시계열 + threshold 곡선 차트 (순수 SVG) ─────────────────────────────────
function AberrationChart({ results }: { results: WeekResult[] }) {
  const pts = results.filter((r) => r.observed !== null);
  if (pts.length < 2) return <div className="aberration-empty">차트를 그릴 데이터가 부족합니다.</div>;

  const W = 720;
  const H = 300;
  const PAD = { top: 16, right: 16, bottom: 40, left: 44 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const obs = pts.map((p) => p.observed as number);
  const obsMax = Math.max(...obs, 1);
  const thrVals = pts.map((p) => p.threshold).filter((v): v is number => v !== null);
  // Farrington은 대규모 다년 유행이 baseline에 남으면 threshold가 폭증할 수 있어
  // (예: 백일해), y축이 관측치를 못 보게 되는 것을 막기 위해 상한을 캡한다.
  const thrCap = obsMax * 4 + 10;
  const thrMaxCapped = thrVals.length ? Math.min(Math.max(...thrVals), thrCap) : 0;
  const yMax = Math.max(obsMax * 1.15, thrMaxCapped * 1.05, 5);

  const x = (i: number) => (i / (pts.length - 1)) * chartW;
  const y = (v: number) => {
    const clamped = Math.max(0, Math.min(v, yMax));
    return chartH - (clamped / yMax) * chartH;
  };

  const obsPath = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(PAD.left + x(i)).toFixed(1)},${(PAD.top + y(p.observed as number)).toFixed(1)}`)
    .join(' ');

  // Threshold는 null 구간에서 끊어 그린다.
  const thrSegments: string[] = [];
  let cur = '';
  pts.forEach((p, i) => {
    if (p.threshold === null) {
      if (cur) { thrSegments.push(cur); cur = ''; }
      return;
    }
    const cmd = cur === '' ? 'M' : 'L';
    cur += `${cmd}${(PAD.left + x(i)).toFixed(1)},${(PAD.top + y(p.threshold)).toFixed(1)} `;
  });
  if (cur) thrSegments.push(cur);

  const gridVals = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * yMax));
  const labelIdx = [0, Math.floor(pts.length / 3), Math.floor((2 * pts.length) / 3), pts.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="aberration-svg" style={{ width: '100%', height: 'auto' }}>
      <rect x={PAD.left} y={PAD.top} width={chartW} height={chartH} fill="rgba(15,23,42,0.55)" rx={4} />

      {/* y 그리드 */}
      {gridVals.map((v, i) => (
        <g key={i}>
          <line x1={PAD.left} x2={PAD.left + chartW} y1={PAD.top + y(v)} y2={PAD.top + y(v)}
            stroke="rgba(255,255,255,0.07)" strokeWidth={1} />
          <text x={PAD.left - 6} y={PAD.top + y(v) + 4} fill="#64748b" fontSize={9} textAnchor="end">{fmt(v)}</text>
        </g>
      ))}

      {/* threshold 곡선 (점선, 상한) */}
      {thrSegments.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="#fb923c" strokeWidth={1.6} strokeDasharray="5 4" opacity={0.9} />
      ))}

      {/* 관측 시계열 */}
      <path d={obsPath} fill="none" stroke="#38bdf8" strokeWidth={1.8} strokeLinecap="round" />

      {/* alarm 주차 마커 */}
      {pts.map((p, i) =>
        p.alarm ? (
          <circle key={i} cx={PAD.left + x(i)} cy={PAD.top + y(p.observed as number)} r={4.5}
            fill="#ef4444" stroke="#fff" strokeWidth={1} />
        ) : null,
      )}

      {/* x 라벨 */}
      {labelIdx.map((i) => (
        <text key={i} x={PAD.left + x(i)} y={H - 20} fill="#64748b" fontSize={9} textAnchor="middle">
          {pts[i].epiweek}
        </text>
      ))}

      {/* 범례 */}
      <g transform={`translate(${PAD.left + 6},${PAD.top + 6})`}>
        <line x1={0} x2={16} y1={0} y2={0} stroke="#38bdf8" strokeWidth={2} />
        <text x={20} y={3} fill="#94a3b8" fontSize={9}>관측</text>
        <line x1={62} x2={78} y1={0} y2={0} stroke="#fb923c" strokeWidth={2} strokeDasharray="5 4" />
        <text x={82} y={3} fill="#94a3b8" fontSize={9}>상한(threshold)</text>
        <circle cx={168} cy={0} r={4} fill="#ef4444" />
        <text x={176} y={3} fill="#94a3b8" fontSize={9}>경보</text>
      </g>
    </svg>
  );
}

// ── 메인 패널 ──────────────────────────────────────────────────────────────
export default function AberrationPanel() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetectResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/aberration/overview?n_weeks=8&respiratory_only=true`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: Overview = await res.json();
      setOverview(data);
    } catch (e: any) {
      setError(
        '이상징후 데이터를 불러오지 못했습니다. 다년 KDCA 시계열이 수집되어 있어야 합니다 ' +
        '(scripts/fetch_kdca_timeseries.py).',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchOverview(); }, [fetchOverview]);

  const openDetail = useCallback(async (disease: string) => {
    setSelected(disease);
    setDetail(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`${API_BASE}/aberration/detect/${encodeURIComponent(disease)}?n_weeks=104`);
      if (res.ok) setDetail(await res.json());
    } catch { /* ignore */ } finally {
      setDetailLoading(false);
    }
  }, []);

  // Open the first disease by default so it's obvious that a row expands into a chart.
  useEffect(() => {
    if (!selected && overview?.diseases?.length) openDetail(overview.diseases[0].disease);
  }, [overview, selected, openDetail]);

  const rows = overview?.diseases ?? [];
  const alarmCount = overview?.alarm_count ?? 0;
  const isSynthetic = overview?.is_synthetic ?? false;

  const maxExceedForBar = useMemo(() => {
    const vals = rows
      .map((r) => r.latest?.exceedance_score)
      .filter((v): v is number => v !== null && v !== undefined && v > 0);
    return Math.max(1, ...vals);
  }, [rows]);

  return (
    <section className="aberration-panel">
      <div className="aberration-head">
        <h3 className="stats-section-title">통계적 이상징후 탐지 · 질환별 (Farrington Flexible)</h3>
        <button className="trends-refresh-btn" onClick={fetchOverview} disabled={loading}>
          {loading ? '… ' : '↻ '}갱신
        </button>
      </div>

      <p className="stats-section-copy" style={{ marginTop: 0 }}>
        KDCA 전수신고 <strong>국가 단위</strong> 주간 건수(2016~현재, 실데이터)에 Farrington Flexible
        (Noufaily et al. 2013)을 적용해, 관측치가 과거 5년 baseline 기반 예측구간 상한(threshold)을
        초과한 주를 통계적 <strong>경보</strong>로 판정합니다. exceedance ≥ 1.0 이면 경보입니다.
      </p>

      <div className="aberration-scope-note">
        <span className="aberration-scope-badge">국가 단위</span>
        17개 시도 <strong>지역 단위</strong> 주간 시계열은 KDCA가 제공하지 않아(전수신고는 국내/해외유입
        구분만 존재) 현재 질환별 국가 단위로만 산출합니다. 지역 단위 이상징후 탐지는 지역별 주간 데이터가
        축적되면 확장 가능합니다.
        {isSynthetic && <strong style={{ color: '#fb923c' }}> ⚠ 현재 표시 데이터는 합성(SYNTHETIC)입니다.</strong>}
      </div>

      {loading ? (
        <div className="aberration-loading"><div className="news-spinner" /><span>이상징후 분석 로딩 중…</span></div>
      ) : error ? (
        <div className="aberration-empty">{error}</div>
      ) : rows.length === 0 ? (
        <div className="aberration-empty">평가 가능한 질환 시계열이 없습니다.</div>
      ) : (
        <>
          <div className="aberration-summary-line">
            최신 주차 <code>{overview?.latest_epiweek ?? '—'}</code> · 호흡기 감시대상 감염병{' '}
            <strong>{rows.length}</strong>종 중 통계적 경보{' '}
            <strong style={{ color: alarmCount > 0 ? '#ef4444' : '#34d399' }}>{alarmCount}건</strong>
          </div>

          <div className="aberration-rows">
            {rows.map((r) => {
              const score = r.latest?.exceedance_score ?? null;
              const barPct = score && score > 0 ? Math.min(100, (score / maxExceedForBar) * 100) : 0;
              const isSparse = r.latest?.note === 'sparse_baseline';
              return (
                <button
                  key={r.disease}
                  className={`aberration-row ${r.alarm ? 'aberration-row--alarm' : ''} ${selected === r.disease ? 'aberration-row--selected' : ''}`}
                  onClick={() => openDetail(r.disease)}
                >
                  <span className="aberration-row-name">
                    {r.disease}
                    {r.baseline_elevated && <span className="aberration-flag" title="baseline가 과거 대유행을 포함해 기대·상한이 상향 적응됨">†</span>}
                  </span>
                  <span className="aberration-row-metrics">
                    <span className="aberration-metric"><em>관측</em>{fmt(r.latest?.observed)}</span>
                    <span className="aberration-metric"><em>기대</em>{fmt(r.latest?.expected)}</span>
                    <span className="aberration-metric"><em>상한</em>{fmt(r.latest?.threshold)}</span>
                  </span>
                  <span className="aberration-row-bar">
                    <span className="aberration-bar-track">
                      <span className="aberration-bar-fill" style={{ width: `${barPct}%`, background: r.alarm ? '#ef4444' : '#38bdf8' }} />
                    </span>
                    <span className="aberration-score-text">{score === null ? '—' : score.toFixed(2)}</span>
                  </span>
                  <span className={`aberration-verdict ${r.alarm ? 'aberration-verdict--alarm' : isSparse ? 'aberration-verdict--sparse' : ''}`}>
                    {r.alarm ? '🔴 경보' : isSparse ? '희소' : '정상'}
                  </span>
                </button>
              );
            })}
          </div>

          {selected && (
            <div className="aberration-detail">
              <div className="aberration-detail-head">
                <h4>{selected} · 국가 주간 시계열 (최근 2년)</h4>
                <button className="modal-close-btn" onClick={() => { setSelected(null); setDetail(null); }}>×</button>
              </div>
              {detailLoading ? (
                <div className="aberration-loading"><div className="news-spinner" /><span>시계열 로딩 중…</span></div>
              ) : detail && detail.results.length ? (
                <>
                  <AberrationChart results={detail.results} />
                  {(() => {
                    const alarms = detail.results.filter((r) => r.alarm);
                    return (
                      <div className="aberration-detail-note">
                        {alarms.length ? (
                          <>
                            <strong style={{ color: '#ef4444' }}>{alarms.length}개 주차 경보</strong>
                            {': '}
                            {alarms.slice(-8).map((a) => a.epiweek).join(', ')}
                            {alarms.length > 8 ? ' …' : ''}
                          </>
                        ) : (
                          <span>최근 2년 내 이 질환의 통계적 경보 주차가 없습니다.</span>
                        )}
                      </div>
                    );
                  })()}
                </>
              ) : (
                <div className="aberration-empty">시계열을 불러오지 못했습니다.</div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
