import { useEffect, useMemo, useState } from 'react';

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
    label: 'SENTINEL',
    color: '#38bdf8',
    cadence: 'Weekly',
    role: 'Korea-first respiratory intelligence synthesis.',
  },
};

const TYPE_ORDER: Array<'all' | ReportType> = ['all', 'final', 'kdca', 'osint'];

const SIGNAL_TERMS = [
  { id: 'signal-kdca', label: 'KDCA 공식감시', terms: ['KDCA', '질병청', '공식 감시', 'baseline', '감시자료'] },
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

function splitLabel(label: string, maxLength = 12) {
  if (label.length <= maxLength) return [label];
  if (label.includes('/')) return label.split('/').map((part, index) => (index === 0 ? part : `/${part}`));
  if (label.includes('(')) {
    const [main, rest] = label.split('(');
    return [main, `(${rest}`];
  }
  const midpoint = Math.ceil(label.length / 2);
  return [label.slice(0, midpoint), label.slice(midpoint)];
}

/** Compute node visible radius based on kind + weight (must match ReportRelationshipFigure). */
function nodeRadius(node: RelationshipNode): number {
  if (node.kind === 'report') return 50;
  return 30 + node.weight * 14;
}

/** Build a curved path from one node's edge to another's edge (so arrows do
 *  not penetrate the node circles). Subtracts each node's radius from the
 *  segment endpoints along the connecting direction. */
function relationshipPath(from: RelationshipNode, to: RelationshipNode) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const fr = nodeRadius(from) + 4;  // tiny gap so the arrow head is visible
  const tr = nodeRadius(to) + 6;    // extra room so the arrow tip stops outside
  const startX = from.x + (dx / dist) * fr;
  const startY = from.y + (dy / dist) * fr;
  const endX = to.x - (dx / dist) * tr;
  const endY = to.y - (dy / dist) * tr;
  // Gentle horizontal curve: control points pulled toward midpoint X
  const midX = (startX + endX) / 2;
  return `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`;
}

function buildRelationshipFigure(item: ReportItem | null, markdown: string, _sections: IntelligenceSection[]): RelationshipFigure {
  void _sections;
  void item;
  const text = markdown || '';
  const paragraphs = text.split(/\n{2,}/).map((p) => p.toLowerCase());

  // Pure bipartite mind-map: signals on LEFT, diseases/keywords on RIGHT.
  // No central report node — edges go signal → topic directly so the user can
  // read "this signal source is about which disease" at a glance.
  // viewBox is 1200x720 (matches SVG element)
  const VIEW_H = 720;
  const LEFT_X = 220;
  const RIGHT_X = 980;

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

  const sigCount = Math.max(1, detectedSignals.length);
  const topCount = Math.max(1, detectedTopics.length);
  const verticalPad = 80;

  detectedSignals.forEach((signal, index) => {
    const y = sigCount === 1
      ? VIEW_H / 2
      : verticalPad + ((VIEW_H - 2 * verticalPad) / (sigCount - 1)) * index;
    nodes.push({
      id: signal.id,
      label: signal.label,
      kind: 'signal',
      x: LEFT_X,
      y,
      weight: Math.min(1, 0.42 + signal.count * 0.07),
      subtitle: `${signal.count}회 언급`,
    });
  });

  detectedTopics.forEach((topic, index) => {
    const y = topCount === 1
      ? VIEW_H / 2
      : verticalPad + ((VIEW_H - 2 * verticalPad) / (topCount - 1)) * index;
    nodes.push({
      id: topic.id,
      label: topic.label,
      kind: 'topic',
      x: RIGHT_X,
      y,
      weight: Math.min(1, 0.42 + topic.count * 0.08),
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
    insight.push(`연결선이 굵을수록 같은 문단 안에서 신호원과 질병이 함께 등장한 빈도가 높다는 뜻입니다.`);
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

function ReportRelationshipFigure({ figure }: { figure: RelationshipFigure }) {
  const nodeById = new Map(figure.nodes.map((node) => [node.id, node]));
  const [hoverNode, setHoverNode] = useState<string | null>(null);

  // Set of edges/nodes that should be highlighted when a node is hovered
  const isEdgeRelated = (edge: RelationshipEdge) =>
    !hoverNode || edge.from === hoverNode || edge.to === hoverNode;
  const isNodeRelated = (id: string) => {
    if (!hoverNode) return true;
    if (id === hoverNode) return true;
    return figure.edges.some(
      (e) => (e.from === hoverNode && e.to === id) || (e.to === hoverNode && e.from === id),
    );
  };

  return (
    <section className="report-relationship-card report-relationship-card--wide">
      <div className="report-relationship-header">
        <div>
          <span>Report relationship figure</span>
          <h3>신호원 ↔ 질병/키워드 관계도</h3>
          <p>
            보고서 본문에서 추출한 <strong>신호원(좌)</strong>과 <strong>질병/키워드(우)</strong>의 동시 등장 관계입니다.
            노드에 마우스를 올리면 해당 신호원이 어떤 질병으로 퍼지는지(또는 질병이 어디서 오는지) 강조됩니다.
            연결선 굵기 = 같은 문단 안에서 함께 등장한 빈도.
          </p>
        </div>
        <strong>bipartite mind map</strong>
      </div>

      <div className="report-relationship-stage">
        <svg className="report-relationship-svg" viewBox="0 0 1200 720" role="img" aria-label="Signal source × disease bipartite mind map">
          <defs>
            <marker id="report-arrow" markerWidth="9" markerHeight="9" refX="6" refY="4" orient="auto" markerUnits="strokeWidth">
              <path d="M 0 0 L 8 4 L 0 8 z" className="report-arrow-marker" />
            </marker>
          </defs>

          {/* Lane labels */}
          <text x="220" y="40" className="rel-lane-label" textAnchor="middle">SIGNAL SOURCES · 신호원</text>
          <text x="980" y="40" className="rel-lane-label" textAnchor="middle">DISEASE / KEYWORDS · 질병/키워드</text>

          {/* Edges (rendered first so nodes overlay them) */}
          {figure.edges.map((edge, index) => {
            const from = nodeById.get(edge.from);
            const to = nodeById.get(edge.to);
            if (!from || !to) return null;
            const d = relationshipPath(from, to);
            const dim = !isEdgeRelated(edge) ? 0.12 : 1;
            return (
              <g
                className={`report-rel-edge edge-${edge.tone} ${isEdgeRelated(edge) ? 'is-active' : 'is-dim'}`}
                key={`${edge.from}-${edge.to}-${index}`}
              >
                <path
                  d={d}
                  style={{
                    strokeWidth: 0.8 + edge.strength * 4,
                    opacity: (0.22 + edge.strength * 0.6) * dim,
                  }}
                  markerEnd="url(#report-arrow)"
                />
                <circle r={2.4 + edge.strength * 2.4} className="report-rel-pulse" style={{ opacity: dim }}>
                  <animateMotion
                    dur={`${5.4 - edge.strength * 2}s`}
                    repeatCount="indefinite"
                    path={d}
                    begin={`${index * 0.18}s`}
                  />
                </circle>
              </g>
            );
          })}

          {/* Nodes */}
          {figure.nodes.map((node) => {
            const radius = nodeRadius(node);
            const related = isNodeRelated(node.id);
            return (
              <g
                className={`report-rel-node node-${node.kind} ${related ? 'is-active' : 'is-dim'}`}
                key={node.id}
                transform={`translate(${node.x}, ${node.y})`}
                onMouseEnter={() => setHoverNode(node.id)}
                onMouseLeave={() => setHoverNode(null)}
                style={{ cursor: 'pointer' }}
              >
                <circle r={radius} />
                {/* Label centered inside the node circle */}
                <text textAnchor="middle" dominantBaseline="middle">
                  {splitLabel(node.label, 12).slice(0, 2).map((line, idx, arr) => (
                    <tspan
                      key={`${node.id}-${line}-${idx}`}
                      x="0"
                      dy={idx === 0 ? (arr.length > 1 ? -7 : 0) : 14}
                    >
                      {line}
                    </tspan>
                  ))}
                </text>
                {node.subtitle && (
                  <text className="report-rel-subtitle" y={radius + 16} textAnchor="middle">
                    {node.subtitle}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
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
            <span><i className="rel-dot signal" /> 신호원</span>
            <span><i className="rel-dot topic" /> 질병/키워드</span>
            <span><i className="rel-edge-sample" /> 동시 등장 빈도</span>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function ReportView() {
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
    setGenerating(true);
    setStatus('Generating Sentinel intelligence report...');
    try {
      const res = await fetch(`${API_BASE}/reports/generate-final`, { method: 'POST' });
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
    if (!newEmail.trim()) return;
    setStatus('');
    try {
      const res = await fetch(`${API_BASE}/reports/recipients/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    try {
      await fetch(`${API_BASE}/reports/recipients/${encodeURIComponent(email)}`, { method: 'DELETE' });
      await fetchRecipients();
    } catch {
      setStatus('Recipient could not be removed.');
    }
  };

  const sendEmail = async () => {
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

        <button className="report-generate-btn" onClick={generateFinalReport} disabled={generating}>
          {generating ? 'Generating...' : 'Generate Sentinel report'}
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
          <div className="report-empty">No reports yet. Generate a Sentinel report from the control room.</div>
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
