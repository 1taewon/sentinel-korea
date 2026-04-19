import { useCallback, useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

type NodeStatus = 'idle' | 'running' | 'done' | 'error';

interface NodeDef {
  id: string;
  label: string;
  sublabel: string;
  type: 'source' | 'action' | 'ai' | 'display' | 'analysis' | 'output';
  x: number; y: number; w: number; h: number;
  color: string;
  description: string;
}

interface EdgeDef { from: string; to: string; dashed?: boolean; }

interface Props {
  onClose: () => void;
  onDataRefreshed: () => void;
  embedded?: boolean;
}

/* ── 3-Column Layout: NEWS (left) | TRENDS (center) | KDCA (right) ── */
// Column centers: NEWS=160, TRENDS=430, KDCA=700
// Layer Y positions: Sources=35, Refresh=125, AI Digest=225, Display=325, Analysis=430, Sentinel=540, Output=640

const NODES: NodeDef[] = [
  // ═══ Column 1: NEWS ═══
  { id: 'naver_news', label: 'Naver News', sublabel: 'Korean', type: 'source', x: 18, y: 35, w: 100, h: 38, color: '#38bdf8', description: 'Naver Search API를 통해 한국어 호흡기 관련 뉴스를 수집합니다.' },
  { id: 'newsapi', label: 'NewsAPI', sublabel: 'English', type: 'source', x: 126, y: 35, w: 100, h: 38, color: '#38bdf8', description: 'NewsAPI에서 영어 호흡기 관련 뉴스를 수집합니다.' },
  { id: 'who_don', label: 'WHO DON', sublabel: 'Outbreaks', type: 'source', x: 234, y: 35, w: 100, h: 38, color: '#38bdf8', description: 'WHO Disease Outbreak News에서 글로벌 질병 발생 정보를 수집합니다.' },
  { id: 'news_refresh', label: 'NEWS Refresh', sublabel: 'Collect news', type: 'action', x: 95, y: 125, w: 160, h: 46, color: '#38bdf8', description: 'Naver News + NewsAPI + WHO DON 데이터를 수집하고 News Digest AI 분석을 실행합니다.' },
  { id: 'news_digest', label: 'News Digest', sublabel: 'Gemini AI', type: 'ai', x: 75, y: 225, w: 200, h: 50, color: '#f97316', description: 'Gemini AI가 수집된 뉴스를 분석하여 Korea/Global 요약, 위험 평가, 핵심 알림을 생성합니다.' },
  { id: 'news_panel', label: 'NEWS Panel', sublabel: 'AI Summary + Sources', type: 'display', x: 105, y: 325, w: 140, h: 40, color: '#475569', description: 'AI 요약을 기본 표시하고, "View Raw Sources" 토글로 원본 뉴스 목록을 확인할 수 있습니다.' },

  // ═══ Column 2: TRENDS ═══
  { id: 'google_trends', label: 'Google Trends', sublabel: 'EN keywords', type: 'source', x: 362, y: 35, w: 115, h: 38, color: '#a78bfa', description: 'Google Trends에서 영어 호흡기 키워드 검색량을 수집합니다.' },
  { id: 'naver_trends', label: 'Naver Trends', sublabel: 'KR keywords', type: 'source', x: 485, y: 35, w: 115, h: 38, color: '#a78bfa', description: 'Naver DataLab에서 한국어 호흡기 키워드 검색량을 수집합니다.' },
  { id: 'trends_refresh', label: 'TRENDS Refresh', sublabel: 'Collect trends', type: 'action', x: 370, y: 125, w: 160, h: 46, color: '#a78bfa', description: 'Google Trends + Naver Trends 데이터를 수집하고 Trends Digest AI 분석을 실행합니다.' },
  { id: 'trends_digest', label: 'Trends Digest', sublabel: 'Gemini AI', type: 'ai', x: 350, y: 225, w: 200, h: 50, color: '#f97316', description: 'Gemini AI가 검색 트렌드를 분석하여 급상승 키워드, 트렌드 신호, 위험 평가를 생성합니다.' },
  { id: 'trends_panel', label: 'TRENDS Panel', sublabel: 'AI Summary + Charts', type: 'display', x: 380, y: 325, w: 140, h: 40, color: '#475569', description: 'AI 요약을 기본 표시하고, "View Raw Charts" 토글로 원본 차트를 확인할 수 있습니다.' },

  // ═══ Column 3: KDCA ═══
  { id: 'kdca', label: 'KDCA Data', sublabel: 'ILI/SARI/Wastewater', type: 'source', x: 650, y: 35, w: 140, h: 38, color: '#34d399', description: 'KDCA 공식 감시 데이터: 법정감염병, ILI/SARI 감시, 하수감시 데이터' },
  { id: 'data_upload', label: 'Data Upload', sublabel: 'Excel upload', type: 'action', x: 640, y: 125, w: 160, h: 46, color: '#34d399', description: 'KDCA Excel 파일을 업로드하여 감시 데이터를 시스템에 반영합니다.' },
  { id: 'kdca_digest', label: 'KDCA Digest', sublabel: 'Gemini AI', type: 'ai', x: 620, y: 225, w: 200, h: 50, color: '#f97316', description: 'Gemini AI가 KDCA 감시 데이터를 분석하여 지역별 위험도, 핵심 지표, 위험 평가를 생성합니다.' },
  { id: 'kdca_panel', label: 'KDCA Panel', sublabel: 'AI Summary + Data', type: 'display', x: 650, y: 325, w: 140, h: 40, color: '#475569', description: 'AI 요약을 기본 표시하고, "View Raw Data" 토글로 업로드 이력과 원본 데이터를 확인할 수 있습니다.' },

  // ═══ OSINT Analysis (NEWS + TRENDS merge) ═══
  { id: 'osint', label: 'OSINT Analysis', sublabel: 'NEWS + TRENDS combined', type: 'analysis', x: 175, y: 430, w: 250, h: 52, color: '#6b8aff', description: 'NEWS와 TRENDS를 결합하여 17개 시도별 위험도 점수를 산출합니다. 결과를 Korea Map에 시각화할 수 있습니다.' },

  // ═══ SENTINEL ANALYSIS (OSINT + KDCA) ═══
  { id: 'sentinel', label: 'SENTINEL ANALYSIS', sublabel: 'OSINT + KDCA integrated', type: 'analysis', x: 250, y: 540, w: 340, h: 58, color: '#38bdf8', description: 'OSINT(NEWS+TRENDS)와 KDCA 데이터를 통합 분석하여 최종 위험도 계층화 및 보고서를 생성합니다. Korea Map에 시각화 가능.' },

  // ═══ Output ═══
  { id: 'output', label: 'Final Report', sublabel: 'Scores + Signals + Visualization', type: 'output', x: 315, y: 640, w: 210, h: 40, color: '#38bdf8', description: '최종 위험도 보고서. 각 분석(OSINT/KDCA/Sentinel) 결과를 Korea Map에 시각화할 수 있습니다.' },

  // ═══ Chat (side) ═══
  { id: 'chat', label: 'Sentinel Chat', sublabel: 'Interactive Q&A', type: 'display', x: 665, y: 548, w: 130, h: 40, color: '#475569', description: 'Gemini AI 기반 대화형 분석 도우미. 대시보드 해석, 보고서 작성 등을 지원합니다.' },
];

const EDGES: EdgeDef[] = [
  // NEWS column
  { from: 'naver_news', to: 'news_refresh' },
  { from: 'newsapi', to: 'news_refresh' },
  { from: 'who_don', to: 'news_refresh' },
  { from: 'news_refresh', to: 'news_digest' },
  { from: 'news_digest', to: 'news_panel' },
  // TRENDS column
  { from: 'google_trends', to: 'trends_refresh' },
  { from: 'naver_trends', to: 'trends_refresh' },
  { from: 'trends_refresh', to: 'trends_digest' },
  { from: 'trends_digest', to: 'trends_panel' },
  // KDCA column
  { from: 'kdca', to: 'data_upload' },
  { from: 'data_upload', to: 'kdca_digest' },
  { from: 'kdca_digest', to: 'kdca_panel' },
  // NEWS + TRENDS → OSINT
  { from: 'news_panel', to: 'osint' },
  { from: 'trends_panel', to: 'osint' },
  // OSINT + KDCA → Sentinel
  { from: 'osint', to: 'sentinel' },
  { from: 'kdca_panel', to: 'sentinel' },
  // Sentinel → Output
  { from: 'sentinel', to: 'output' },
  // Chat (side)
  { from: 'sentinel', to: 'chat', dashed: true },
];

const nodeMap = Object.fromEntries(NODES.map(n => [n.id, n]));

function getEdgePath(from: NodeDef, to: NodeDef): string {
  const fx = from.x + from.w / 2;
  const fy = from.y + from.h;
  const tx = to.x + to.w / 2;
  const ty = to.y;
  const cy1 = fy + (ty - fy) * 0.4;
  const cy2 = fy + (ty - fy) * 0.6;
  return `M${fx},${fy} C${fx},${cy1} ${tx},${cy2} ${tx},${ty}`;
}

const STATUS_COLORS: Record<NodeStatus, string> = {
  idle: '#475569',
  running: '#f59e42',
  done: '#22c55e',
  error: '#ef4444',
};

export default function FlowDiagram({ onClose, onDataRefreshed }: Props) {
  const [statuses, setStatuses] = useState<Record<string, NodeStatus>>({});
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [detailResult, setDetailResult] = useState<string>('');

  const setNodeStatus = (id: string, s: NodeStatus) =>
    setStatuses(prev => ({ ...prev, [id]: s }));

  // Check initial data availability
  const checkStatuses = useCallback(async () => {
    try {
      const [newsK, trendsK, newsD, trendsD, kdcaD] = await Promise.allSettled([
        fetch(`${API_BASE}/news/korea?limit=1`).then(r => r.json()),
        fetch(`${API_BASE}/trends/korea`).then(r => r.json()),
        fetch(`${API_BASE}/risk-analysis/news-digest`).then(r => r.json()),
        fetch(`${API_BASE}/risk-analysis/trends-digest`).then(r => r.json()),
        fetch(`${API_BASE}/risk-analysis/kdca-digest`).then(r => r.json()),
      ]);
      const s: Record<string, NodeStatus> = {};
      if (newsK.status === 'fulfilled' && Array.isArray(newsK.value) && newsK.value.length > 0) {
        s.naver_news = 'done'; s.newsapi = 'done'; s.who_don = 'done'; s.news_refresh = 'done';
      }
      if (trendsK.status === 'fulfilled' && trendsK.value?.series?.length > 0) {
        s.google_trends = 'done'; s.naver_trends = 'done'; s.trends_refresh = 'done';
      }
      if (newsD.status === 'fulfilled' && newsD.value?.status === 'ok') {
        s.news_digest = 'done'; s.news_panel = 'done';
      }
      if (trendsD.status === 'fulfilled' && trendsD.value?.status === 'ok') {
        s.trends_digest = 'done'; s.trends_panel = 'done';
      }
      if (kdcaD.status === 'fulfilled' && kdcaD.value?.status === 'ok') {
        s.kdca = 'done'; s.data_upload = 'done'; s.kdca_digest = 'done'; s.kdca_panel = 'done';
      }
      setStatuses(s);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { checkStatuses(); }, [checkStatuses]);

  /* ── Action handlers ── */
  const runNewsRefresh = async () => {
    setNodeStatus('news_refresh', 'running');
    setNodeStatus('news_digest', 'idle');
    try {
      await fetch(`${API_BASE}/ingestion/refresh-korea`, { method: 'POST' });
      await fetch(`${API_BASE}/ingestion/refresh-global`, { method: 'POST' });
      setNodeStatus('news_refresh', 'done');
      setNodeStatus('naver_news', 'done');
      setNodeStatus('newsapi', 'done');
      setNodeStatus('who_don', 'done');
      // Auto-trigger News Digest
      setNodeStatus('news_digest', 'running');
      const res = await fetch(`${API_BASE}/risk-analysis/news-digest`, { method: 'POST' });
      if (res.ok) {
        setNodeStatus('news_digest', 'done');
        setNodeStatus('news_panel', 'done');
        setDetailResult('News Digest generated successfully.');
      } else {
        setNodeStatus('news_digest', 'error');
      }
    } catch {
      setNodeStatus('news_refresh', 'error');
    }
  };

  const runTrendsRefresh = async () => {
    setNodeStatus('trends_refresh', 'running');
    setNodeStatus('trends_digest', 'idle');
    try {
      await fetch(`${API_BASE}/ingestion/refresh-trends`, { method: 'POST' });
      setNodeStatus('trends_refresh', 'done');
      setNodeStatus('google_trends', 'done');
      setNodeStatus('naver_trends', 'done');
      // Auto-trigger Trends Digest
      setNodeStatus('trends_digest', 'running');
      const res = await fetch(`${API_BASE}/risk-analysis/trends-digest`, { method: 'POST' });
      if (res.ok) {
        setNodeStatus('trends_digest', 'done');
        setNodeStatus('trends_panel', 'done');
        setDetailResult('Trends Digest generated successfully.');
      } else {
        setNodeStatus('trends_digest', 'error');
      }
    } catch {
      setNodeStatus('trends_refresh', 'error');
    }
  };

  const runOsintAnalysis = async () => {
    setNodeStatus('osint', 'running');
    try {
      const res = await fetch(`${API_BASE}/risk-analysis/analyze-news-trends`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const data = await res.json();
      setNodeStatus('osint', 'done');
      setDetailResult(data.summary || 'OSINT analysis complete.');
      onDataRefreshed();
    } catch {
      setNodeStatus('osint', 'error');
    }
  };

  const runKdcaDigest = async () => {
    setNodeStatus('kdca_digest', 'running');
    try {
      const res = await fetch(`${API_BASE}/risk-analysis/kdca-digest`, { method: 'POST' });
      if (res.ok) {
        setNodeStatus('kdca_digest', 'done');
        setNodeStatus('kdca_panel', 'done');
        setDetailResult('KDCA Digest generated successfully.');
      } else {
        setNodeStatus('kdca_digest', 'error');
        setDetailResult('KDCA Digest failed. Upload KDCA data first.');
      }
    } catch {
      setNodeStatus('kdca_digest', 'error');
    }
  };

  const runSentinelAnalysis = async () => {
    setNodeStatus('sentinel', 'running');
    try {
      const res = await fetch(`${API_BASE}/risk-analysis/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ include_kdca: true }),
      });
      const data = await res.json();
      setNodeStatus('sentinel', 'done');
      setNodeStatus('output', 'done');
      setDetailResult(data.summary || 'Sentinel analysis complete.');
      onDataRefreshed();
    } catch {
      setNodeStatus('sentinel', 'error');
    }
  };

  const handleNodeClick = (nodeId: string) => {
    setSelectedNode(prev => prev === nodeId ? null : nodeId);
    setDetailResult('');
  };

  const handleAction = (nodeId: string) => {
    switch (nodeId) {
      case 'news_refresh': return runNewsRefresh();
      case 'trends_refresh': return runTrendsRefresh();
      case 'data_upload':
        onClose();
        return;
      case 'kdca_digest': return runKdcaDigest();
      case 'osint': return runOsintAnalysis();
      case 'sentinel': return runSentinelAnalysis();
    }
  };

  const isActionNode = (type: string) => type === 'action' || type === 'analysis' || type === 'ai';
  const sel = selectedNode ? nodeMap[selectedNode] : null;

  return (
    <div className="flow-overlay" onClick={onClose}>
      <div className="flow-container" onClick={e => e.stopPropagation()}>
        <div className="flow-header">
          <div>
            <h3 className="flow-title">Pipeline Control</h3>
            <span className="flow-subtitle">Click nodes to view details. Click action buttons to execute.</span>
          </div>
          <button className="flow-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="flow-body">
          {/* SVG Diagram */}
          <div className="flow-svg-wrap">
            <svg viewBox="0 0 860 700" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <marker id="fa" viewBox="0 0 10 8" refX="9" refY="4" markerWidth="7" markerHeight="5" orient="auto">
                  <path d="M0,0 L10,4 L0,8 Z" fill="#334155"/>
                </marker>
                <filter id="glow">
                  <feGaussianBlur stdDeviation="3" result="blur"/>
                  <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
                </filter>
              </defs>

              {/* Column headers */}
              <text x="175" y="22" textAnchor="middle" fill="#38bdf8" fontSize="10" fontWeight="700" letterSpacing="1" opacity="0.5">NEWS</text>
              <text x="450" y="22" textAnchor="middle" fill="#a78bfa" fontSize="10" fontWeight="700" letterSpacing="1" opacity="0.5">TRENDS</text>
              <text x="720" y="22" textAnchor="middle" fill="#34d399" fontSize="10" fontWeight="700" letterSpacing="1" opacity="0.5">KDCA</text>

              {/* Left-aligned layer labels */}
              <text x="4" y="52" textAnchor="start" fill="#334155" fontSize="8" fontWeight="600" letterSpacing="1.5" transform="rotate(-90, 4, 52)">SOURCES</text>
              <text x="4" y="145" textAnchor="start" fill="#334155" fontSize="8" fontWeight="600" letterSpacing="1.5" transform="rotate(-90, 4, 145)">REFRESH</text>
              <text x="4" y="248" textAnchor="start" fill="#334155" fontSize="8" fontWeight="600" letterSpacing="1.5" transform="rotate(-90, 4, 248)">AI DIGEST</text>
              <text x="4" y="340" textAnchor="start" fill="#334155" fontSize="8" fontWeight="600" letterSpacing="1.5" transform="rotate(-90, 4, 340)">DISPLAY</text>
              <text x="4" y="448" textAnchor="start" fill="#334155" fontSize="8" fontWeight="600" letterSpacing="1.5" transform="rotate(-90, 4, 448)">ANALYSIS</text>
              <text x="4" y="560" textAnchor="start" fill="#334155" fontSize="8" fontWeight="600" letterSpacing="1.5" transform="rotate(-90, 4, 560)">SENTINEL</text>

              {/* Edges */}
              {EDGES.map((e, i) => {
                const from = nodeMap[e.from];
                const to = nodeMap[e.to];
                if (!from || !to) return null;
                const d = getEdgePath(from, to);
                const isRunning = statuses[e.to] === 'running';
                return (
                  <path key={i} d={d} fill="none"
                    stroke={isRunning ? '#f59e42' : '#1e293b'}
                    strokeWidth={isRunning ? 2 : 1.2}
                    strokeDasharray={e.dashed ? '6,4' : isRunning ? '8,4' : 'none'}
                    markerEnd="url(#fa)"
                    className={isRunning ? 'flow-edge-running' : ''}
                  />
                );
              })}

              {/* Nodes */}
              {NODES.map(n => {
                const status = statuses[n.id] || 'idle';
                const isSelected = selectedNode === n.id;
                const isAction = isActionNode(n.type);
                const isAnalysis = n.type === 'analysis';

                return (
                  <g key={n.id}
                    className={`flow-node ${isAction ? 'flow-node--action' : ''} ${isSelected ? 'flow-node--selected' : ''}`}
                    onClick={() => handleNodeClick(n.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <rect x={n.x} y={n.y} width={n.w} height={n.h}
                      rx={isAnalysis ? 12 : 8}
                      fill={isSelected ? 'rgba(255,255,255,0.08)' : '#0f1520'}
                      stroke={isSelected ? n.color : `${n.color}88`}
                      strokeWidth={isSelected ? 2 : isAction ? 1.5 : 1}
                      filter={status === 'running' ? 'url(#glow)' : undefined}
                    />

                    {/* Label */}
                    <text x={n.x + n.w / 2} y={n.y + (n.sublabel ? n.h * 0.42 : n.h * 0.58)}
                      textAnchor="middle" fill={isAction || isAnalysis ? n.color : '#e2e8f0'}
                      fontSize={isAnalysis ? 12 : 10} fontWeight={isAction ? 700 : 500}
                    >{n.label}</text>

                    {n.sublabel && (
                      <text x={n.x + n.w / 2} y={n.y + n.h * 0.72}
                        textAnchor="middle" fill="#475569" fontSize={8}
                      >{n.sublabel}</text>
                    )}

                    {/* Status indicator */}
                    <circle cx={n.x + n.w - 8} cy={n.y + 8} r={4}
                      fill={STATUS_COLORS[status]}
                      className={status === 'running' ? 'flow-status-pulse' : ''}
                    />

                    {/* Action play icon for action nodes */}
                    {isAction && status !== 'running' && (
                      <g className="flow-play-icon" opacity={0.4}>
                        <polygon
                          points={`${n.x + 10},${n.y + n.h / 2 - 5} ${n.x + 10},${n.y + n.h / 2 + 5} ${n.x + 18},${n.y + n.h / 2}`}
                          fill={n.color}
                        />
                      </g>
                    )}

                    {status === 'running' && (
                      <foreignObject x={n.x + 6} y={n.y + n.h / 2 - 6} width={12} height={12}>
                        <div className="news-spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
                      </foreignObject>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Detail Panel (right side) */}
          <div className={`flow-detail ${sel ? 'flow-detail--open' : ''}`}>
            {sel ? (
              <>
                <div className="flow-detail-header" style={{ borderColor: sel.color }}>
                  <span className="flow-detail-type" style={{ color: sel.color }}>
                    {sel.type.toUpperCase()}
                  </span>
                  <h4 className="flow-detail-name">{sel.label}</h4>
                </div>

                <div className="flow-detail-status">
                  <span className="flow-detail-dot" style={{ background: STATUS_COLORS[statuses[sel.id] || 'idle'] }} />
                  <span>{statuses[sel.id] === 'running' ? 'Running...' : statuses[sel.id] === 'done' ? 'Complete' : statuses[sel.id] === 'error' ? 'Error' : 'Ready'}</span>
                </div>

                <p className="flow-detail-desc">{sel.description}</p>

                {detailResult && selectedNode && (statuses[selectedNode] === 'done' || statuses[selectedNode] === 'error') && (
                  <div className="flow-detail-result">
                    <div className="flow-detail-result-title">Result</div>
                    <p>{detailResult.substring(0, 300)}{detailResult.length > 300 ? '...' : ''}</p>
                  </div>
                )}

                {isActionNode(sel.type) && (
                  <button
                    className="flow-detail-action"
                    style={{ borderColor: sel.color, color: sel.color }}
                    onClick={() => handleAction(sel.id)}
                    disabled={statuses[sel.id] === 'running'}
                  >
                    {statuses[sel.id] === 'running' ? 'Running...' :
                     sel.id === 'data_upload' ? 'Go to Upload Tab' :
                     sel.id === 'kdca_digest' ? 'Generate KDCA Digest' :
                     `Run ${sel.label}`}
                  </button>
                )}
              </>
            ) : (
              <div className="flow-detail-placeholder">
                <div className="flow-detail-placeholder-icon">&#9878;</div>
                <p>Click any node to view details and run actions</p>
                <div className="flow-detail-legend">
                  <div><span className="flow-detail-dot" style={{ background: '#475569' }} /> Idle</div>
                  <div><span className="flow-detail-dot" style={{ background: '#f59e42' }} /> Running</div>
                  <div><span className="flow-detail-dot" style={{ background: '#22c55e' }} /> Done</div>
                  <div><span className="flow-detail-dot" style={{ background: '#ef4444' }} /> Error</div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
