import { useCallback, useEffect, useRef, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

interface TrendPoint { date: string; value: number; }
interface TrendSeries { keyword: string; points: TrendPoint[]; }
interface TrendsData { keywords?: string[]; series?: TrendSeries[]; updated_at?: string; fetched_at?: string; source?: string; error?: string; }

interface TrendsDigest {
  status?: string;
  trends_insight?: string;
  rising_keywords?: string[];
  risk_assessment?: string;
  key_signals?: { keyword: string; trend: string; insight: string }[];
  generated_at?: string;
  raw_summary?: string;
  message?: string;
}

type TrendSource = 'google' | 'naver';

const COLORS = ['#38bdf8', '#a78bfa', '#34d399', '#fb923c', '#f472b6', '#f87171', '#facc15', '#2dd4bf'];

const KEYWORD_DESCRIPTIONS: Record<string, string> = {
  'pneumonia': '폐렴 관련 검색량. 지역 내 호흡기 질환 발생의 선행 지표로 활용됩니다.',
  'respiratory symptoms': '기침, 가래, 호흡곤란 등 전반적인 호흡기 증상에 대한 관심도입니다.',
  'flu': '독감(신종플루 포함) 관련 일반인들의 검색 트렌드입니다.',
  'influenza': '인플루엔자 바이러스 및 백신, 증상에 대한 전문적인 검색 비중을 포함합니다.',
  'cough': '단순 기침 증상 발현 시 검색량이 급증하는 경향이 있습니다.',
  'fever': '고열 및 발열 증상 관련 데이터로, 감염병 유행의 강력한 초기 신호입니다.',
  'dyspnea': '호흡 곤란 증상으로, 중증 호흡기 질환(SARI) 가능성을 시사합니다.',
  'asthma': '천식 및 알레르기성 호흡기 질환과 관련된 검색량입니다.',
  '폐렴': '폐렴 관련 네이버 검색량. 한국 내 호흡기 질환 발생 선행 지표.',
  '독감': '독감/인플루엔자 관련 네이버 검색 트렌드.',
  '기침': '기침 증상 검색량. 호흡기 감염 초기 신호.',
  '호흡곤란': '호흡 곤란 증상 검색량. 중증 호흡기 질환 가능성.',
  '발열': '고열/발열 관련 검색량. 감염병 유행의 초기 신호.',
};

export default function TrendsChart() {
  const [trendSource, setTrendSource] = useState<TrendSource>('google');
  const [googleData, setGoogleData] = useState<TrendsData>({});
  const [naverData, setNaverData] = useState<TrendsData>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [selectedKeyword, setSelectedKeyword] = useState<string | null>(null);
  const [trendsDigest, setTrendsDigest] = useState<TrendsDigest | null>(null);
  const [digestLoading, setDigestLoading] = useState(false);
  const [showRawChart, setShowRawChart] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  const currentData = trendSource === 'google' ? googleData : naverData;

  const fetchTrends = useCallback(async () => {
    setLoading(true);
    try {
      const [gRes, nRes] = await Promise.allSettled([
        fetch(`${API_BASE}/trends/korea`),
        fetch(`${API_BASE}/trends/naver`),
      ]);
      if (gRes.status === 'fulfilled' && gRes.value.ok) setGoogleData(await gRes.value.json());
      if (nRes.status === 'fulfilled' && nRes.value.ok) setNaverData(await nRes.value.json());
    } catch (e) {
      console.error('트렌드 로드 실패:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDigest = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/risk-analysis/trends-digest`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'ok') setTrendsDigest(data);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchTrends(); fetchDigest(); }, [fetchTrends, fetchDigest]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setDigestLoading(true);
    try {
      await fetch(`${API_BASE}/ingestion/refresh-trends`, { method: 'POST' });
      await fetchTrends();
      // Generate AI trends digest
      const digestRes = await fetch(`${API_BASE}/risk-analysis/trends-digest`, { method: 'POST' });
      if (digestRes.ok) {
        const data = await digestRes.json();
        setTrendsDigest(data);
      }
    } catch (e) {
      console.error('트렌드 새로고침 실패:', e);
    } finally {
      setRefreshing(false);
      setDigestLoading(false);
    }
  };

  const renderChart = (isFullScreen = false, highlightKeyword: string | null = null) => {
    const series = currentData.series || [];
    if (series.length === 0) return null;

    const W = isFullScreen ? 800 : 340;
    const H = isFullScreen ? 400 : 140;
    const PAD = { top: 12, right: 10, bottom: 28, left: 30 };
    const chartW = W - PAD.left - PAD.right;
    const chartH = H - PAD.top - PAD.bottom;

    const allPoints = series.flatMap(s => s.points);
    const dates = [...new Set(allPoints.map(p => p.date))].sort();
    if (dates.length < 2) return null;

    const xScale = (d: string) => (dates.indexOf(d) / (dates.length - 1)) * chartW;
    const yScale = (v: number) => chartH - (v / 100) * chartH;

    const gridLines = [0, 25, 50, 75, 100].map(v => ({
      y: yScale(v), label: String(v),
    }));

    const gradPrefix = isFullScreen ? 'fs-' : '';

    return (
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="trends-svg"
        aria-label={`${trendSource === 'google' ? 'Google' : 'Naver'} Trends chart`}
      >
        <rect x={PAD.left} y={PAD.top} width={chartW} height={chartH}
          fill="rgba(15,23,42,0.6)" rx={4} />

        {gridLines.map(g => (
          <g key={g.label}>
            <line x1={PAD.left} x2={PAD.left + chartW}
              y1={PAD.top + g.y} y2={PAD.top + g.y}
              stroke="rgba(255,255,255,0.07)" strokeWidth={1} />
            <text x={PAD.left - 4} y={PAD.top + g.y + 4}
              fill="#475569" fontSize={8} textAnchor="end">{g.label}</text>
          </g>
        ))}

        {[0, Math.floor(dates.length / 2), dates.length - 1].map(idx => {
          const d = dates[idx];
          const x = PAD.left + xScale(d);
          return (
            <text key={d} x={x} y={H - 4}
              fill="#475569" fontSize={7} textAnchor="middle">
              {d.slice(5)}
            </text>
          );
        })}

        {series.map((s, si) => {
          const color = COLORS[si % COLORS.length];
          const pts = s.points.filter(p => dates.includes(p.date));
          if (pts.length < 2) return null;

          const isHighlighted = !highlightKeyword || s.keyword === highlightKeyword;
          const isDimmed = highlightKeyword && s.keyword !== highlightKeyword;

          const lineOpacity = isDimmed ? 0.12 : 1;
          const lineWidth = isHighlighted && highlightKeyword ? 3 : 1.5;
          const areaOpacity = isDimmed ? 0.03 : 1;
          const dotRadius = isHighlighted && highlightKeyword ? 5 : 3;

          const pathD = pts.map((p, pi) => {
            const x = PAD.left + xScale(p.date);
            const y = PAD.top + yScale(p.value);
            return `${pi === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
          }).join(' ');

          const areaD = pathD +
            ` L${PAD.left + xScale(pts[pts.length - 1].date)},${PAD.top + chartH}` +
            ` L${PAD.left + xScale(pts[0].date)},${PAD.top + chartH} Z`;

          return (
            <g key={s.keyword} style={{ transition: 'opacity 0.3s' }} opacity={lineOpacity}>
              <defs>
                <linearGradient id={`${gradPrefix}grad-${si}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <path d={areaD} fill={`url(#${gradPrefix}grad-${si})`} opacity={areaOpacity}
                style={{ transition: 'opacity 0.3s' }} />
              <path d={pathD} fill="none" stroke={color}
                strokeWidth={lineWidth} strokeLinecap="round"
                style={{ transition: 'stroke-width 0.3s, opacity 0.3s' }} />

              {(() => {
                const last = pts[pts.length - 1];
                const lx = PAD.left + xScale(last.date);
                const ly = PAD.top + yScale(last.value);
                return (
                  <g>
                    <circle cx={lx} cy={ly} r={dotRadius} fill={color}
                      style={{ transition: 'r 0.3s' }} />
                    <text x={lx + 4} y={ly + 3} fill={color} fontSize={8}>{last.value}</text>
                  </g>
                );
              })()}
            </g>
          );
        })}
      </svg>
    );
  };

  const series = currentData.series || [];
  const lastUpdated = currentData.fetched_at || currentData.updated_at;

  return (
    <div className="trends-card" id="trends-chart">
      {/* 헤더 */}
      <div className="trends-header">
        <div className="trends-title">
          <span>TRENDS</span>
          <span className="trends-badge">Korea</span>
        </div>
        <button
          className="trends-refresh-btn"
          onClick={handleRefresh}
          disabled={refreshing || loading}
          title="Refresh trends"
        >
          {refreshing ? <span>… Refreshing</span> : <span>↻ Refresh</span>}
        </button>
      </div>

      {/* AI Digest or Raw Chart toggle */}
      {trendsDigest && trendsDigest.status === 'ok' && !showRawChart ? (
        <div className="news-digest-section">
          <div className="news-digest-content">
            {trendsDigest.trends_insight && (
              <div className="digest-block">
                <div className="digest-block-title">Trends Insight</div>
                <p className="digest-text">{trendsDigest.trends_insight}</p>
              </div>
            )}
            {trendsDigest.risk_assessment && (
              <div className="digest-block digest-risk">
                <div className="digest-block-title">Risk Assessment</div>
                <p className="digest-text">{trendsDigest.risk_assessment}</p>
              </div>
            )}
            {trendsDigest.key_signals && trendsDigest.key_signals.length > 0 && (
              <div className="digest-block">
                <div className="digest-block-title">Key Signals</div>
                <div className="digest-alerts">
                  {trendsDigest.key_signals.map((sig, i) => (
                    <div key={i} className="digest-alert-item">
                      <span className="digest-alert-dot" style={{
                        background: sig.trend === '상승' || sig.trend === 'rising' ? '#ef4444' :
                          sig.trend === '하락' || sig.trend === 'declining' ? '#22c55e' : '#f97316'
                      }} />
                      <div>
                        <strong>{sig.keyword}</strong>
                        <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-secondary)' }}>({sig.trend})</span>
                        <p className="digest-alert-detail">{sig.insight}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {trendsDigest.rising_keywords && trendsDigest.rising_keywords.length > 0 && (
              <div className="digest-block">
                <div className="digest-block-title">Rising Keywords</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {trendsDigest.rising_keywords.map((kw, i) => (
                    <span key={i} className="news-badge-naver" style={{ fontSize: 10 }}>{kw}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button className="news-sources-toggle" onClick={() => setShowRawChart(true)}>
            View Raw Charts
          </button>
          {trendsDigest.generated_at && (
            <div className="trends-updated">
              AI analyzed: {new Date(trendsDigest.generated_at).toLocaleDateString('ko-KR')}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Google / Naver 소스 탭 */}
          <div className="news-tabs" style={{ marginBottom: '4px' }}>
            <button
              className={`news-tab ${trendSource === 'google' ? 'news-tab--active' : ''}`}
              onClick={() => setTrendSource('google')}
            >
              Google Trends
            </button>
            <button
              className={`news-tab ${trendSource === 'naver' ? 'news-tab--active' : ''}`}
              onClick={() => setTrendSource('naver')}
            >
              Naver Trends
            </button>
          </div>

          {/* 범례 */}
          {series.length > 0 && (
            <div className="trends-legend">
              {series.map((s, i) => (
                <div key={s.keyword} className="trends-legend-item">
                  <span className="trends-legend-dot" style={{ background: COLORS[i % COLORS.length] }} />
                  <span className="trends-legend-label">{s.keyword}</span>
                </div>
              ))}
            </div>
          )}

          {/* 차트 */}
          <div
            className="trends-chart-area"
            onClick={() => {
              if (series.length > 0) {
                setSelectedKeyword(series[0].keyword);
                setShowModal(true);
              }
            }}
            style={{ cursor: series.length > 0 ? 'pointer' : 'default' }}
          >
            {loading || digestLoading ? (
              <div className="trends-loading">
                <div className="news-spinner" />
                <span>{digestLoading ? 'AI analyzing trends...' : 'Loading trends...'}</span>
              </div>
            ) : series.length === 0 ? (
              <div className="trends-empty">
                <p>No trend data available</p>
                <p className="news-empty-hint">
                  {trendSource === 'naver' && naverData.error
                    ? 'Naver API credentials not configured. Add NAVER_CLIENT_ID/SECRET to .env'
                    : 'Click refresh to collect data.'}
                </p>
              </div>
            ) : (
              renderChart(false)
            )}
          </div>

          {lastUpdated && (
            <div className="trends-updated">
              Last collected: {new Date(lastUpdated).toLocaleDateString('ko-KR')}
            </div>
          )}

          {trendsDigest && trendsDigest.status === 'ok' && showRawChart && (
            <button className="news-sources-toggle" onClick={() => setShowRawChart(false)}>
              View AI Summary
            </button>
          )}
        </>
      )}

      {/* 모달 */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal-content" style={{ width: '850px' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                Trend Details — {trendSource === 'google' ? 'Google' : 'Naver'}
              </h3>
              <button className="modal-close-btn" onClick={() => setShowModal(false)}>×</button>
            </div>

            {/* 키워드 탭 */}
            <div className="news-tabs" style={{ padding: '0 20px', background: 'var(--bg-soft)' }}>
              {series.map(s => (
                <button
                  key={s.keyword}
                  className={`news-tab ${selectedKeyword === s.keyword ? 'news-tab--active' : ''}`}
                  onClick={() => setSelectedKeyword(s.keyword)}
                >
                  {s.keyword}
                </button>
              ))}
            </div>

            <div className="modal-body" style={{ padding: '20px' }}>
              {/* 큰 차트 — 선택 키워드 강조 */}
              <div className="enlarged-chart-container">
                {renderChart(true, selectedKeyword)}
              </div>

              <div className="trends-detail-grid">
                <div className="keyword-info-panel">
                  <h4 className="detail-section-title">
                    <span className="trends-legend-dot" style={{ background: COLORS[series.findIndex(s => s.keyword === selectedKeyword) % COLORS.length] }} />
                    {selectedKeyword} Analysis
                  </h4>
                  <p className="keyword-description-text">
                    {selectedKeyword && (KEYWORD_DESCRIPTIONS[selectedKeyword.toLowerCase()] || KEYWORD_DESCRIPTIONS[selectedKeyword] || '해당 키워드에 대한 소셜/검색 신호를 분석 중입니다. 유행 경로 파악에 중요한 지표입니다.')}
                  </p>

                  <div className="keyword-stats-mini">
                    <div className="mini-stat">
                      <span className="mini-stat-label">Current Interest</span>
                      <span className="mini-stat-value">
                        {series.find(s => s.keyword === selectedKeyword)?.points.slice(-1)[0]?.value ?? '-'} / 100
                      </span>
                    </div>
                    <div className="mini-stat">
                      <span className="mini-stat-label">Trend Status</span>
                      <span className="mini-stat-value" style={{
                        color: (() => {
                          const pts = series.find(s => s.keyword === selectedKeyword)?.points || [];
                          if (pts.length < 2) return '#22c55e';
                          const last = pts[pts.length - 1].value;
                          const prev = pts[Math.max(0, pts.length - 4)].value;
                          if (last > prev * 1.3) return '#ef4444';
                          if (last > prev * 1.1) return '#f97316';
                          return '#22c55e';
                        })(),
                      }}>
                        {(() => {
                          const pts = series.find(s => s.keyword === selectedKeyword)?.points || [];
                          if (pts.length < 2) return 'Stable';
                          const last = pts[pts.length - 1].value;
                          const prev = pts[Math.max(0, pts.length - 4)].value;
                          if (last > prev * 1.3) return 'Rising';
                          if (last > prev * 1.1) return 'Increasing';
                          if (last < prev * 0.8) return 'Declining';
                          return 'Stable';
                        })()}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="raw-data-panel">
                  <h4 className="detail-section-title">Historical Search Index</h4>
                  <div className="trends-table-wrapper">
                    <table className="trends-data-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th style={{ textAlign: 'right' }}>Index</th>
                        </tr>
                      </thead>
                      <tbody>
                        {series.find(s => s.keyword === selectedKeyword)?.points.slice().reverse().map((p, i) => (
                          <tr key={i}>
                            <td>{p.date}</td>
                            <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{p.value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
