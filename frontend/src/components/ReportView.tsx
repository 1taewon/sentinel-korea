import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { useAuth } from '../contexts/AuthContext';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

type ReportType = 'osint' | 'kdca' | 'final';

interface ReportItem {
  filename: string;
  type: ReportType;
  stem: string;
  epiweek?: string | null;
  snapshot_date?: string | null;
  generated_at?: string;
  size_bytes?: number;
}

interface Recipient {
  email: string;
  name?: string;
}

type SectionKey = 'changed' | 'matters' | 'confidence' | 'actions';

type IntelligenceSection = {
  key: SectionKey;
  label: string;
  title: string;
  body: string;
};

type RelationshipKind = 'report' | 'section' | 'region' | 'signal' | 'topic' | 'action';

type RelationshipNode = {
  id: string;
  label: string;
  kind: RelationshipKind;
  x: number;
  y: number;
  weight: number;
  subtitle?: string;
};

type RelationshipEdge = {
  from: string;
  to: string;
  label: string;
  strength: number;
  tone: 'primary' | 'region' | 'signal' | 'topic' | 'action';
};

type RelationshipFigure = {
  nodes: RelationshipNode[];
  edges: RelationshipEdge[];
  insight: string[];
};

const TYPE_META: Record<ReportType, { label: string; color: string; cadence: string; role: string }> = {
  osint: {
    label: 'OSINT',
    color: '#6b8aff',
    cadence: 'Daily',
    role: 'Imported-risk context and external corroboration.',
  },
  kdca: {
    label: 'KDCA',
    color: '#34d399',
    cadence: 'Weekly',
    role: 'Official Korea surveillance baseline.',
  },
  final: {
    label: 'FINAL',
    color: '#38bdf8',
    cadence: 'Weekly',
    role: 'Korea-first respiratory intelligence synthesis.',
  },
};

const TYPE_ORDER: Array<'all' | ReportType> = ['all', 'final', 'kdca', 'osint'];

const SIGNAL_TERMS = [
  { id: 'signal-kdca', label: 'KDCA official surveillance', terms: ['KDCA', '공식 감시', 'baseline', '감시자료'] },
  { id: 'signal-trends', label: '검색 트렌드', terms: ['Google Trends', '검색 트렌드', 'pneumonia', 'flu', '검색량'] },
  { id: 'signal-news', label: '국내 뉴스', terms: ['뉴스', '보도', '언론', '기사'] },
  { id: 'signal-global', label: '국제/WHO 맥락', terms: ['글로벌', '국제', 'WHO', '해외', '유입'] },
  { id: 'signal-wastewater', label: '폐하수 보조', terms: ['폐하수', '폐수', 'wastewater'] },
];

const TOPIC_TERMS = [
  { id: 'topic-covid', label: 'COVID-19/변이', terms: ['COVID-19', '코로나', '변이', 'coronavirus'] },
  { id: 'topic-flu', label: 'Influenza/flu', terms: ['influenza', 'flu', '인플루엔자', '독감'] },
  { id: 'topic-pneumonia', label: '폐렴/pneumonia', terms: ['폐렴', 'pneumonia'] },
  { id: 'topic-rsv', label: 'RSV', terms: ['RSV', '호흡기세포융합'] },
  { id: 'topic-measles', label: '홍역/measles', terms: ['홍역', 'measles'] },
  { id: 'topic-quality', label: 'freshness/coverage', terms: ['freshness', 'coverage', 'data quality', '신뢰도'] },
];

function titleForReport(item: ReportItem) {
  return item.epiweek || item.snapshot_date || item.stem || item.filename;
}

function cleanLine(line: string) {
  return line
    .replace(/^#+\s*/, '')
    .replace(/^[-*]\s*/, '')
    .replace(/\*\*/g, '')
    .trim();
}

function firstMeaningfulLine(markdown: string) {
  const lines = markdown
    .split(/\r?\n/)
    .map(cleanLine)
    .filter((line) => line && !line.startsWith('|') && !line.startsWith('```'));
  return lines[0] || '';
}

function lineContaining(markdown: string, terms: string[]) {
  const lines = markdown.split(/\r?\n/).map(cleanLine).filter(Boolean);
  return lines.find((line) => terms.some((term) => line.toLowerCase().includes(term))) || '';
}

function termCount(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  return terms.reduce((sum, term) => {
    const pattern = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return sum + (lower.match(new RegExp(pattern, 'g')) || []).length;
  }, 0);
}

function sectionBody(markdown: string, heading: string) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return '';
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line.trim())) break;
    const cleaned = cleanLine(line);
    if (cleaned) body.push(cleaned);
  }
  return body.join(' ');
}

function buildRelationshipFigure(item: ReportItem | null, markdown: string, _sections: IntelligenceSection[]): RelationshipFigure {
  void _sections;
  void item;
  const text = markdown || '';
  const paragraphs = text.split(/\n{2,}/).map((p) => p.toLowerCase());

  // Cliverad-style interactive ontology — no central hub, no rigid left/right
  // columns. Signals occupy the left half-circle and topics the right half-circle
  // around an empty negative-space center, with stronger nodes pulled toward the
  // middle so the heaviest signal-disease relationships visually cluster. Edges
  // are curved bezier paths that cross the empty middle, producing the web-like
  // ontology look.
  const CX = 600;
  const CY = 360;
  const VIEW_H = 720;

  const nodes: RelationshipNode[] = [];
  const edges: RelationshipEdge[] = [];

  // ── Detect signals (sources)
  const detectedSignals = SIGNAL_TERMS
    .map((signal) => ({ ...signal, count: termCount(text, signal.terms) }))
    .filter((signal) => signal.count > 0)
    .sort((a, b) => b.count - a.count);

  // ── Detect topics (diseases/keywords)
  const detectedTopics = TOPIC_TERMS
    .map((topic) => ({ ...topic, count: termCount(text, topic.terms) }))
    .filter((topic) => topic.count > 0)
    .sort((a, b) => b.count - a.count);

  const maxMentions = Math.max(
    1,
    ...detectedSignals.map((s) => s.count),
    ...detectedTopics.map((t) => t.count),
  );

  /** Place nodes on a half-circle arc.
   *  side: 'left'   → angles from 110° to 250° (counter-clockwise around left)
   *  side: 'right'  → angles from -70° to  70° (right hemisphere)
   *  Heaviest mention count gets the largest arc radius (pushed slightly inward
   *  toward the empty center so important nodes cluster). Light nodes pushed
   *  further out so the arc fans like a sunburst. */
  function arcCoord(side: 'left' | 'right', index: number, total: number, weight: number) {
    const baseRadius = 285;
    const radiusJitter = 18 - weight * 22;       // heavier → slightly smaller r → closer to centre
    const r = baseRadius + radiusJitter;
    const startDeg = side === 'left' ? 110 : -70;
    const endDeg = side === 'left' ? 250 : 70;
    const span = endDeg - startDeg;
    const t = total <= 1 ? 0.5 : index / (total - 1);
    const angle = ((startDeg + span * t) * Math.PI) / 180;
    const x = CX + Math.cos(angle) * r;
    const y = CY + Math.sin(angle) * (r * 0.95);  // slight vertical compression so it fits 720px
    return { x: Math.max(120, Math.min(1080, x)), y: Math.max(70, Math.min(VIEW_H - 70, y)) };
  }

  detectedSignals.forEach((signal, index) => {
    const weight = Math.max(0.18, signal.count / maxMentions);
    const { x, y } = arcCoord('left', index, detectedSignals.length, weight);
    nodes.push({
      id: signal.id,
      label: signal.label,
      kind: 'signal',
      x,
      y,
      weight,
      subtitle: `${signal.count}회 언급`,
    });
  });

  detectedTopics.forEach((topic, index) => {
    const weight = Math.max(0.18, topic.count / maxMentions);
    const { x, y } = arcCoord('right', index, detectedTopics.length, weight);
    nodes.push({
      id: topic.id,
      label: topic.label,
      kind: 'topic',
      x,
      y,
      weight,
      subtitle: `${topic.count}회 언급`,
    });
  });

  // ── Co-occurrence: signal × topic edges (which signal mentions which disease)
  // Edge strength = number of paragraphs containing both terms.
  detectedSignals.forEach((signal) => {
    const sigTerms = signal.terms.map((t) => t.toLowerCase());
    detectedTopics.forEach((topic) => {
      const topicTerms = topic.terms.map((t) => t.toLowerCase());
      let coOccur = 0;
      for (const para of paragraphs) {
        const hasSig = sigTerms.some((t) => para.includes(t));
        const hasTopic = topicTerms.some((t) => para.includes(t));
        if (hasSig && hasTopic) coOccur += 1;
      }
      if (coOccur > 0) {
        edges.push({
          from: signal.id,
          to: topic.id,
          label: `${coOccur}회 동시 등장`,
          strength: Math.min(1, 0.3 + coOccur * 0.18),
          tone: 'primary',
        });
      }
    });
  });

  // Fallback edges so isolated signals/topics still reach the other side
  // (use a thin "association" edge between every detected signal and the
  // strongest topic, and vice versa).
  if (edges.length === 0 && detectedSignals.length && detectedTopics.length) {
    const topTopicId = detectedTopics[0].id;
    detectedSignals.forEach((signal) => {
      edges.push({ from: signal.id, to: topTopicId, label: 'association', strength: 0.35, tone: 'signal' });
    });
  }

  // ── Insight text (질병 / 신호원 중심)
  const topTopic = detectedTopics[0];
  const topSignal = detectedSignals[0];
  const insight: string[] = [];
  if (topTopic) {
    insight.push(`가장 많이 언급된 질병/키워드: ${topTopic.label} (${topTopic.count}회).`);
  }
  if (topSignal) {
    insight.push(`주요 신호원: ${topSignal.label} (${topSignal.count}회 등장).`);
  }
  if (detectedTopics.length && detectedSignals.length) {
    insight.push(`노드가 클수록 보고서에서 더 자주 언급된 신호원 또는 질병/키워드입니다.`);
    insight.push(`신호원-질병 연결선이 굵을수록 같은 문단 안에서 함께 등장한 빈도가 높다는 뜻입니다.`);
  }
  if (!detectedTopics.length) insight.push('질병/키워드: 명시적 언급이 적게 감지되었습니다.');
  if (!detectedSignals.length) insight.push('신호원: 명시된 source 용어가 부족합니다.');

  return { nodes, edges, insight };
}

function buildReportBrief(item: ReportItem | null, markdown: string): IntelligenceSection[] {
  if (!item) return [];

  const firstLine = firstMeaningfulLine(markdown);
  const changedSection = sectionBody(markdown, 'What changed');
  const mattersSection = sectionBody(markdown, 'Why it matters');
  const confidenceSection = sectionBody(markdown, 'Confidence');
  const actionsSection = sectionBody(markdown, 'Recommended watch actions');
  const confidenceLine = lineContaining(markdown, ['confidence', 'freshness', 'coverage', 'quality']);
  const actionLine = lineContaining(markdown, ['recommend', 'action', 'watch', 'monitor', 'next']);
  const typeMeta = TYPE_META[item.type];

  const changedFallback =
    item.type === 'final'
      ? 'The latest Sentinel synthesis combines KDCA surveillance, OSINT signals, trends, and available corroboration into a Korea regional watch picture.'
      : item.type === 'kdca'
        ? 'The weekly KDCA lane updates the official respiratory baseline used by Sentinel.'
        : 'The OSINT lane refreshes news and trend context without overriding Korea surveillance signals.';

  const mattersFallback =
    item.type === 'final'
      ? 'This is the control-room view: which Korean regions look unusual, why they look unusual, and how much confidence the system assigns.'
      : item.type === 'kdca'
        ? 'Official surveillance anchors the baseline so Sentinel does not mistake media noise for epidemiologic signal.'
        : 'External context is useful as imported-risk watch and corroboration, not as a standalone global score.';

  return [
    {
      key: 'changed',
      label: '01',
      title: 'What changed',
      body: changedSection || firstLine || changedFallback,
    },
    {
      key: 'matters',
      label: '02',
      title: 'Why it matters',
      body: mattersSection || mattersFallback,
    },
    {
      key: 'confidence',
      label: '03',
      title: 'Confidence',
      body:
        confidenceSection ||
        confidenceLine ||
        'Confidence should reflect freshness, coverage, data quality, and independent corroboration. Source count alone is not treated as confidence.',
    },
    {
      key: 'actions',
      label: '04',
      title: 'Recommended watch actions',
      body:
        actionsSection ||
        actionLine ||
        `Use this ${typeMeta.label} report to inspect top regions, review the signal breakdown, and keep global context limited to imported-risk watch.`,
    },
  ];
}

/** Cliverad-style force-directed ontology graph (matches RadAssist OntologyGraph). */
function ReportRelationshipFigure({ figure }: { figure: RelationshipFigure }) {
  const fgRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ width: 0, height: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Track stage size with ResizeObserver so the graph fills available area.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setDims({ width: w, height: h });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const raf = requestAnimationFrame(update);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  // Build force-graph data — node `val` controls size (Math.sqrt(val)*3 in canvas).
  // Heaviest node ≈ val 30 → r≈16; light node ≈ val 4 → r≈6 (clear visual difference).
  const graphData = useMemo(() => {
    const maxMentions = Math.max(1, ...figure.nodes.map((n) => Number(n.subtitle?.match(/(\d+)/)?.[1]) || 1));
    const nodes = figure.nodes.map((n) => {
      const mentions = Number(n.subtitle?.match(/(\d+)/)?.[1]) || 1;
      const val = 4 + (mentions / maxMentions) * 26;       // 4..30
      const color = n.kind === 'signal' ? '#34d399' : '#c084fc';
      return {
        id: n.id,
        label: n.label,
        kind: n.kind,
        mentions,
        val,
        color,
      };
    });
    const links = figure.edges.map((e) => ({
      source: e.from,
      target: e.to,
      strength: e.strength,
    }));
    return { nodes, links };
  }, [figure]);

  // Tune forces so the layout is balanced and fits in view.
  useEffect(() => {
    if (!fgRef.current || dims.width === 0) return;
    try {
      const charge = fgRef.current.d3Force('charge');
      if (charge) {
        charge.strength(-160);
        if (typeof charge.distanceMax === 'function') charge.distanceMax(220);
      }
      const link = fgRef.current.d3Force('link');
      if (link) link.distance(80);
    } catch { /* ignore */ }
    const t = setTimeout(() => { try { fgRef.current?.zoomToFit(400, 60); } catch { /* ignore */ } }, 700);
    return () => clearTimeout(t);
  }, [graphData, dims.width, dims.height]);

  const wrapText = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] => {
    const words = text.split(/\s+|(?=[/])/);
    const lines: string[] = [];
    let current = '';
    for (const w of words) {
      const test = current ? current + ' ' + w : w;
      if (ctx.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = w;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    return lines;
  };

  const nodeCanvasObject = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    if (typeof node.x !== 'number' || typeof node.y !== 'number') return;
    const r = Math.sqrt(node.val) * 3;
    const fontSize = Math.max(11 / globalScale, 3);
    const isSelected = selectedId === node.id;

    // Outer ring on selected node + multi-mention badge
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r * 1.45, 0, 2 * Math.PI);
      ctx.strokeStyle = node.color;
      ctx.lineWidth = 1.5 / globalScale;
      ctx.stroke();
    }

    // Filled circle (color tinted, scaled by mention count)
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = node.color + '38';
    ctx.fill();
    ctx.strokeStyle = node.color;
    ctx.lineWidth = 2.4 / globalScale;
    ctx.stroke();

    // Mention count badge inside the node when meaningful (>=2)
    if (node.mentions >= 2) {
      ctx.font = `bold ${Math.max(fontSize * 0.95, 5)}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#0f172a';
      ctx.fillText(String(node.mentions), node.x, node.y);
    }

    // Label outside the node (does not collide with circle)
    ctx.font = `${fontSize * 0.95}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = node.color;
    const labelStartY = node.y + r + 4 / globalScale;
    const lines = wrapText(ctx, node.label, 130);
    const lineH = fontSize * 0.95 * 1.25;
    lines.forEach((line, i) => {
      ctx.fillText(line, node.x, labelStartY + i * lineH);
    });
  }, [selectedId]);

  const handleNodeClick = useCallback((node: any) => {
    if (!node) return;
    setSelectedId((prev) => (prev === node.id ? null : node.id));
  }, []);

  const selectedDetail = useMemo(() => {
    if (!selectedId) return null;
    const node = graphData.nodes.find((n: any) => n.id === selectedId);
    if (!node) return null;
    const related = graphData.links
      .filter((l: any) => l.source === selectedId || l.target === selectedId || l.source?.id === selectedId || l.target?.id === selectedId)
      .map((l: any) => {
        const otherId = (l.source?.id ?? l.source) === selectedId ? (l.target?.id ?? l.target) : (l.source?.id ?? l.source);
        const other = graphData.nodes.find((n: any) => n.id === otherId);
        return { other, strength: l.strength };
      })
      .filter((x: any) => x.other);
    return { node, related };
  }, [selectedId, graphData]);

  return (
    <section className="report-relationship-card report-relationship-card--wide">
      <div className="report-relationship-header">
        <div>
          <span>Report relationship figure</span>
          <h3>신호원 ↔ 질병/키워드 ontology</h3>
          <p>
            보고서 본문에서 추출한 <strong>신호원(녹색)</strong>과 <strong>질병/키워드(보라)</strong> 를
            force-directed graph로 표시합니다. 노드 크기는 언급횟수, 연결선은 같은 문단 안 동시 등장.
            노드를 클릭하면 연결된 항목이 우측 패널에 나타납니다.
          </p>
        </div>
        <strong>force-directed ontology</strong>
      </div>

      <div className="report-relationship-stage" ref={containerRef} style={{ position: 'relative', minHeight: 480 }}>
        {dims.width > 0 && dims.height > 0 ? (
          <ForceGraph2D
            ref={fgRef}
            graphData={graphData}
            nodeCanvasObject={nodeCanvasObject}
            nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
              if (typeof node.x !== 'number' || typeof node.y !== 'number') return;
              const r = Math.sqrt(node.val) * 3;
              ctx.beginPath();
              ctx.arc(node.x, node.y, r + 6, 0, 2 * Math.PI);
              ctx.fillStyle = color;
              ctx.fill();
            }}
            onNodeClick={handleNodeClick}
            onBackgroundClick={() => setSelectedId(null)}
            onEngineStop={() => {
              // Pin every node at its settled position so future drags only
              // move the grabbed node — the rest of the web stays still
              // (RadAssist/Cliverad behaviour).
              graphData.nodes.forEach((n: any) => {
                if (typeof n.x === 'number' && typeof n.y === 'number') {
                  n.fx = n.x;
                  n.fy = n.y;
                }
              });
            }}
            onNodeDragEnd={(node: any) => {
              // Keep dragged node fixed where the user dropped it.
              node.fx = node.x;
              node.fy = node.y;
            }}
            linkColor={() => 'rgba(56, 189, 248, 0.45)'}
            linkWidth={(l: any) => 0.8 + (l.strength || 0.4) * 2.4}
            linkDirectionalArrowLength={0}
            linkDirectionalParticles={2}
            linkDirectionalParticleWidth={(l: any) => 1.5 + (l.strength || 0.4) * 1.5}
            linkDirectionalParticleSpeed={0.006}
            linkDirectionalParticleColor={() => '#38bdf8'}
            linkHoverPrecision={6}
            backgroundColor="rgba(0,0,0,0)"
            width={dims.width}
            height={dims.height}
            cooldownTime={2500}
            warmupTicks={60}
            d3AlphaDecay={0.025}
            d3VelocityDecay={0.4}
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
            Loading ontology...
          </div>
        )}

        {selectedDetail && (
          <div className="ontology-detail-panel">
            <div className="ontology-detail-header">
              <div>
                <span className="ontology-detail-kicker">{selectedDetail.node.kind === 'signal' ? 'SIGNAL SOURCE · 신호원' : 'DISEASE / KEYWORD · 질병/키워드'}</span>
                <h4>{selectedDetail.node.label}</h4>
                <span className="ontology-detail-mentions">{selectedDetail.node.mentions}회 언급</span>
              </div>
              <button onClick={() => setSelectedId(null)} aria-label="Close" type="button">×</button>
            </div>
            <div className="ontology-detail-body">
              <div className="ontology-detail-section-title">Connected ({selectedDetail.related.length})</div>
              <ul>
                {selectedDetail.related.map((r: any) => (
                  <li key={r.other.id} onClick={() => setSelectedId(r.other.id)} role="button" tabIndex={0}>
                    <span className="ontology-detail-dot" style={{ background: r.other.color }} />
                    <span className="ontology-detail-name">{r.other.label}</span>
                    <span className="ontology-detail-strength">{Math.round((r.strength || 0) * 100)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>

      <div className="report-relationship-belowfig">
        <div className="report-relationship-insights-row">
          <div>
            <span>Figure interpretation</span>
            <h4>무엇을 읽어야 하나?</h4>
            {figure.insight.length === 0 ? (
              <p>아직 분석 가능한 키워드가 부족합니다. 보고서가 충분히 길어지면 관계도가 채워집니다.</p>
            ) : (
              figure.insight.map((line) => <p key={line}>{line}</p>)
            )}
          </div>
          <div className="report-relationship-legend">
            <span><i className="rel-dot signal" /> 신호원 (녹색)</span>
            <span><i className="rel-dot topic" /> 질병/키워드 (보라)</span>
            <span><i className="rel-dot size" /> 노드 크기 = 언급횟수</span>
            <span><i className="rel-edge-sample" /> 동시 등장 빈도</span>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function ReportView() {
  const { isAdmin, getIdToken } = useAuth();
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [typeFilter, setTypeFilter] = useState<'all' | ReportType>('all');
  const [selected, setSelected] = useState<ReportItem | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string>('');

  const filtered = useMemo(
    () => (typeFilter === 'all' ? reports : reports.filter((report) => report.type === typeFilter)),
    [reports, typeFilter],
  );

  const adminHeaders = async (json = true): Promise<HeadersInit> => {
    const headers: Record<string, string> = {};
    if (json) headers['Content-Type'] = 'application/json';
    const token = await getIdToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  };

  const requireAdmin = (label: string) => {
    if (isAdmin) return true;
    setStatus(`${label} is available only to the Sentinel operator. Public users can read the report archive.`);
    return false;
  };

  const briefSections = useMemo(() => buildReportBrief(selected, markdown), [selected, markdown]);
  const relationshipFigure = useMemo(
    () => buildRelationshipFigure(selected, markdown, briefSections),
    [selected, markdown, briefSections],
  );

  const fetchRecipients = async () => {
    try {
      const res = await fetch(`${API_BASE}/reports/recipients/list`);
      const data = await res.json();
      setRecipients(Array.isArray(data) ? data : []);
    } catch {
      setRecipients([]);
    }
  };

  const loadReport = async (item: ReportItem) => {
    setSelected(item);
    setStatus('');
    try {
      const res = await fetch(`${API_BASE}/reports/content/${encodeURIComponent(item.filename)}`);
      const data = await res.json();
      setMarkdown(data.content || data.markdown || 'No report content was returned by the backend.');
    } catch {
      setMarkdown('Report content could not be loaded. Check backend connectivity.');
    }
  };

  const fetchReports = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/reports/list`);
      const data = await res.json();
      const list: ReportItem[] = Array.isArray(data) ? data : data.reports || [];
      setReports(list);
      if (list.length) {
        const next = selected ? list.find((item) => item.filename === selected.filename) || list[0] : list[0];
        await loadReport(next);
      } else {
        setSelected(null);
        setMarkdown('');
      }
    } catch {
      setReports([]);
      setSelected(null);
      setMarkdown('');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReports();
    fetchRecipients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generateFinalReport = async () => {
    if (!requireAdmin('Report generation')) return;
    setGenerating(true);
    setStatus('Generating FINAL intelligence report...');
    try {
      const res = await fetch(`${API_BASE}/reports/generate-final`, { method: 'POST', headers: await adminHeaders(false) });
      const data = await res.json();
      if (!res.ok) {
        setStatus(data.detail || 'Report generation failed.');
        return;
      }
      setStatus(`Generated ${data.report_filename || data.epiweek || 'latest Sentinel report'}.`);
      await fetchReports();
      setTypeFilter('final');
    } catch {
      setStatus('Report generation failed. Check backend connectivity.');
    } finally {
      setGenerating(false);
    }
  };

  const addRecipient = async () => {
    if (!requireAdmin('Recipient management')) return;
    if (!newEmail.trim()) return;
    setStatus('');
    try {
      const res = await fetch(`${API_BASE}/reports/recipients/add`, {
        method: 'POST',
        headers: await adminHeaders(),
        body: JSON.stringify({ email: newEmail.trim(), name: newName.trim() }),
      });
      if (res.ok) {
        setNewEmail('');
        setNewName('');
        setStatus('Recipient added.');
        await fetchRecipients();
      } else {
        const err = await res.json();
        setStatus(err.detail || 'Recipient could not be added.');
      }
    } catch {
      setStatus('Recipient could not be added.');
    }
  };

  const removeRecipient = async (email: string) => {
    if (!requireAdmin('Recipient management')) return;
    try {
      await fetch(`${API_BASE}/reports/recipients/${encodeURIComponent(email)}`, { method: 'DELETE', headers: await adminHeaders(false) });
      await fetchRecipients();
    } catch {
      setStatus('Recipient could not be removed.');
    }
  };

  const sendEmail = async () => {
    if (!requireAdmin('Report email sending')) return;
    if (!selected) return;
    if (recipients.length === 0) {
      setStatus('Add at least one recipient before sending.');
      return;
    }
    setSending(true);
    setStatus('Sending report email...');
    try {
      const res = await fetch(`${API_BASE}/reports/send?filename=${encodeURIComponent(selected.filename)}`, {
        method: 'POST',
        headers: await adminHeaders(false),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus(`Send requested for ${data.recipients?.length || recipients.length} recipient(s).`);
      } else {
        setStatus(data.detail || 'Email send failed.');
      }
    } catch {
      setStatus('Email send failed.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="report-view report-view--control-room">
      <div className="report-sidebar">
        <div className="report-sidebar-header">
          <span className="report-kicker">Korea-first respiratory intelligence</span>
          <h3>Intelligence archive</h3>
          <p>Reports are organized as evidence for regional respiratory watch decisions, not as standalone prediction outputs.</p>
        </div>

        <button className="report-generate-btn" onClick={generateFinalReport} disabled={!isAdmin || generating}>
          {generating ? 'Generating...' : 'Generate FINAL report'}
        </button>

        <div className="report-type-tabs">
          {TYPE_ORDER.map((type) => (
            <button
              key={type}
              className={`report-type-tab ${typeFilter === type ? 'report-type-tab--active' : ''}`}
              onClick={() => setTypeFilter(type)}
              style={type !== 'all' ? { borderLeft: `3px solid ${TYPE_META[type].color}` } : undefined}
              type="button"
            >
              <span>{type === 'all' ? 'ALL' : TYPE_META[type].label}</span>
              <span className="report-type-tab-count">
                {type === 'all' ? reports.length : reports.filter((report) => report.type === type).length}
              </span>
            </button>
          ))}
        </div>

        {loading ? (
          <div className="report-loading">Loading reports...</div>
        ) : filtered.length === 0 ? (
          <div className="report-empty">No reports yet. Generate a FINAL report from the control room.</div>
        ) : (
          <div className="report-list">
            {filtered.map((report) => {
              const meta = TYPE_META[report.type];
              return (
                <button
                  key={report.filename}
                  className={`report-list-item ${selected?.filename === report.filename ? 'report-list-item--active' : ''}`}
                  onClick={() => loadReport(report)}
                  style={{ borderLeft: `3px solid ${meta.color}` }}
                  type="button"
                >
                  <div className="report-list-row">
                    <span className="report-list-badge" style={{ color: meta.color }}>{meta.label}</span>
                    <span className="report-list-cadence">{meta.cadence}</span>
                  </div>
                  <div className="report-list-epiweek">{titleForReport(report)}</div>
                  <div className="report-list-role">{meta.role}</div>
                  {report.generated_at && (
                    <div className="report-list-date">{new Date(report.generated_at).toLocaleString('ko-KR')}</div>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div className="report-recipients">
          <div className="report-recipients-title">Email recipients ({recipients.length})</div>
          <div className="report-recipients-add">
            <input
              type="email"
              placeholder="email@example.com"
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
              className="report-recipient-input"
            />
            <input
              type="text"
              placeholder="name optional"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              className="report-recipient-input"
            />
            <button className="report-recipient-add-btn" onClick={addRecipient} type="button">Add</button>
          </div>
          {recipients.map((recipient) => (
            <div key={recipient.email} className="report-recipient-row">
              <span className="report-recipient-email">{recipient.email}</span>
              {recipient.name && <span className="report-recipient-name">{recipient.name}</span>}
              <button className="report-recipient-remove" onClick={() => removeRecipient(recipient.email)} type="button">x</button>
            </div>
          ))}
        </div>
      </div>

      <div className="report-content">
        {selected ? (
          <div className="report-markdown">
            <div className="report-markdown-header report-markdown-header--control">
              <div>
                <span
                  className="report-detail-badge"
                  style={{ color: TYPE_META[selected.type].color, borderColor: TYPE_META[selected.type].color }}
                >
                  {TYPE_META[selected.type].label} / {TYPE_META[selected.type].cadence}
                </span>
                <h2>{titleForReport(selected)}</h2>
                <div className="report-detail-meta">{selected.filename}</div>
              </div>
              <div className="report-detail-actions">
                <button
                  className="report-email-send-btn"
                  onClick={sendEmail}
                  disabled={sending || recipients.length === 0}
                  type="button"
                >
                  {sending ? 'Sending...' : 'Send email'}
                </button>
              </div>
            </div>

            <div className="report-positioning-card">
              <span>Product frame</span>
              <strong>Sentinel is a Korea-first respiratory intelligence control room.</strong>
              <p>
                The report explains which Korean regions look unusual, why the system believes that,
                and how much confidence the available evidence deserves.
              </p>
            </div>

            <div className="report-brief-grid">
              {briefSections.map((section) => (
                <section className={`report-brief-card report-brief-card--${section.key}`} key={section.key}>
                  <span>{section.label}</span>
                  <h3>{section.title}</h3>
                  <p>{section.body}</p>
                </section>
              ))}
            </div>

            <ReportRelationshipFigure figure={relationshipFigure} />

            {selected.type === 'osint' && (
              <div className="report-context-note">
                Global and overseas signals are treated as imported-risk context, regional benchmarking,
                and external corroboration. They do not create a standalone global alert score.
              </div>
            )}

            {status && <div className="report-status">{status}</div>}

            <div className="report-raw-header">
              <span>Raw report artifact</span>
              <p>Kept below for auditability and backend traceability.</p>
            </div>
            <pre className="report-markdown-body">{markdown}</pre>
          </div>
        ) : (
          <div className="report-empty-state">
            <div className="report-empty-icon">SR</div>
            <div>Select or generate a Sentinel intelligence report.</div>
          </div>
        )}
      </div>
    </div>
  );
}
