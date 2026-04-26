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

const REGION_TERMS = [
  '서울특별시',
  '부산광역시',
  '대구광역시',
  '인천광역시',
  '광주광역시',
  '대전광역시',
  '울산광역시',
  '세종특별자치시',
  '경기도',
  '강원특별자치도',
  '충청북도',
  '충청남도',
  '전북특별자치도',
  '전라남도',
  '경상북도',
  '경상남도',
  '제주특별자치도',
];

const SIGNAL_TERMS = [
  { id: 'signal-kdca', label: 'KDCA 공식감시', terms: ['KDCA', '질병청', '공식 감시', 'baseline', '감시자료'] },
  { id: 'signal-osint', label: 'OSINT 신호', terms: ['OSINT', '국내 뉴스', '뉴스', '증상탐색행동', '증상 탐색 행동'] },
  { id: 'signal-trends', label: '검색 트렌드', terms: ['Google Trends', '검색 트렌드', 'pneumonia', 'flu', '검색량'] },
  { id: 'signal-global', label: '국제/WHO 맥락', terms: ['글로벌', '국제', 'WHO', '해외', '유입'] },
  { id: 'signal-wastewater', label: '폐하수 보조', terms: ['폐하수', '폐수', 'wastewater'] },
  { id: 'signal-cxr', label: 'CXR 집계', terms: ['CXR', '영상', 'corroboration'] },
];

const TOPIC_TERMS = [
  { id: 'topic-covid', label: 'COVID-19/변이', terms: ['COVID-19', '코로나', '변이', 'coronavirus'] },
  { id: 'topic-flu', label: 'Influenza/flu', terms: ['influenza', 'flu', '인플루엔자', '독감'] },
  { id: 'topic-pneumonia', label: '폐렴/pneumonia', terms: ['폐렴', 'pneumonia'] },
  { id: 'topic-rsv', label: 'RSV', terms: ['RSV', '호흡기세포융합'] },
  { id: 'topic-measles', label: '홍역/measles', terms: ['홍역', 'measles'] },
  { id: 'topic-quality', label: 'freshness/coverage', terms: ['freshness', 'coverage', 'data quality', '신뢰도'] },
];

const ACTION_TERMS = [
  { id: 'action-watch', label: '지역 watch', terms: ['watch', '감시', '주시', '관찰'] },
  { id: 'action-breakdown', label: '신호 breakdown', terms: ['breakdown', '원천자료', '신호 breakdown'] },
  { id: 'action-globe', label: 'globe raw 확인', terms: ['globe', 'Korea relevance', 'raw data', '국제 신호'] },
  { id: 'action-prevention', label: '예방/접종', terms: ['예방', '접종', '기침 예절', '손 씻기'] },
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

function regionLevel(markdown: string, region: string) {
  const match = new RegExp(`${region}[^\\n]{0,90}(G[0-3])|\\[(G[0-3])[^\\n]{0,90}${region}`).exec(markdown);
  return match?.[1] || match?.[2] || '';
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

function relationshipPath(from: RelationshipNode, to: RelationshipNode) {
  const midX = (from.x + to.x) / 2;
  const bend = from.kind === 'topic' || to.kind === 'topic' ? 28 : 0;
  return `M ${from.x} ${from.y} C ${midX} ${from.y - bend}, ${midX} ${to.y + bend}, ${to.x} ${to.y}`;
}

function buildRelationshipFigure(item: ReportItem | null, markdown: string, sections: IntelligenceSection[]): RelationshipFigure {
  const text = markdown || '';
  const nodes: RelationshipNode[] = [
    { id: 'report', label: item ? titleForReport(item) : 'Sentinel report', kind: 'report', x: 430, y: 222, weight: 1, subtitle: item ? TYPE_META[item.type].label : 'REPORT' },
    { id: 'section-changed', label: 'What changed', kind: 'section', x: 184, y: 88, weight: 0.86 },
    { id: 'section-matters', label: 'Why it matters', kind: 'section', x: 676, y: 96, weight: 0.78 },
    { id: 'section-confidence', label: 'Confidence', kind: 'section', x: 678, y: 345, weight: 0.74 },
    { id: 'section-actions', label: 'Watch actions', kind: 'action', x: 184, y: 346, weight: 0.82 },
  ];
  const edges: RelationshipEdge[] = [
    { from: 'section-changed', to: 'report', label: 'change', strength: 0.82, tone: 'primary' },
    { from: 'section-matters', to: 'report', label: 'meaning', strength: 0.78, tone: 'primary' },
    { from: 'section-confidence', to: 'report', label: 'trust', strength: 0.7, tone: 'primary' },
    { from: 'section-actions', to: 'report', label: 'response', strength: 0.74, tone: 'action' },
  ];

  const detectedRegions = REGION_TERMS
    .map((region) => ({ region, count: termCount(text, [region]), level: regionLevel(text, region) }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => {
      const levelDelta = (b.level ? Number(b.level.slice(1)) : 0) - (a.level ? Number(a.level.slice(1)) : 0);
      return levelDelta || b.count - a.count;
    })
    .slice(0, 5);

  detectedRegions.forEach((entry, index) => {
    const id = `region-${index}`;
    nodes.push({
      id,
      label: entry.region.replace('특별자치시', '').replace('특별자치도', '').replace('광역시', '').replace('특별시', ''),
      kind: 'region',
      x: 78,
      y: 140 + index * 48,
      weight: Math.min(1, 0.42 + entry.count * 0.12),
      subtitle: entry.level || 'watch',
    });
    edges.push({ from: id, to: 'section-changed', label: entry.level || 'region', strength: Math.min(1, 0.45 + entry.count * 0.08), tone: 'region' });
  });

  const detectedSignals = SIGNAL_TERMS
    .map((signal) => ({ ...signal, count: termCount(text, signal.terms) }))
    .filter((signal) => signal.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const signalPositions = [
    { x: 296, y: 112 },
    { x: 312, y: 360 },
    { x: 486, y: 372 },
    { x: 560, y: 110 },
    { x: 532, y: 250 },
  ];
  detectedSignals.forEach((signal, index) => {
    nodes.push({
      id: signal.id,
      label: signal.label,
      kind: 'signal',
      x: signalPositions[index].x,
      y: signalPositions[index].y,
      weight: Math.min(1, 0.38 + signal.count * 0.09),
      subtitle: `${signal.count} hits`,
    });
    const target = signal.id === 'signal-kdca'
      ? 'section-confidence'
      : signal.id === 'signal-global'
        ? 'section-actions'
        : signal.id === 'signal-trends' || signal.id === 'signal-osint'
          ? 'section-changed'
          : 'section-matters';
    edges.push({ from: signal.id, to: target, label: 'evidence', strength: Math.min(1, 0.45 + signal.count * 0.05), tone: 'signal' });
    edges.push({ from: signal.id, to: 'report', label: 'synthesis', strength: 0.45, tone: 'signal' });
  });

  const detectedTopics = TOPIC_TERMS
    .map((topic) => ({ ...topic, count: termCount(text, topic.terms) }))
    .filter((topic) => topic.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  detectedTopics.forEach((topic, index) => {
    nodes.push({
      id: topic.id,
      label: topic.label,
      kind: 'topic',
      x: 188 + index * 116,
      y: 455,
      weight: Math.min(1, 0.34 + topic.count * 0.08),
      subtitle: `${topic.count} mentions`,
    });
    const target = topic.id === 'topic-quality'
      ? 'section-confidence'
      : topic.id === 'topic-measles' || topic.id === 'topic-covid'
        ? 'signal-global'
        : 'signal-trends';
    if (nodes.some((node) => node.id === target)) {
      edges.push({ from: topic.id, to: target, label: 'topic', strength: Math.min(1, 0.38 + topic.count * 0.04), tone: 'topic' });
    } else {
      edges.push({ from: topic.id, to: 'report', label: 'topic', strength: 0.42, tone: 'topic' });
    }
  });

  const detectedActions = ACTION_TERMS
    .map((action) => ({ ...action, count: termCount(text, action.terms) }))
    .filter((action) => action.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  detectedActions.forEach((action, index) => {
    nodes.push({
      id: action.id,
      label: action.label,
      kind: 'action',
      x: 770,
      y: 190 + index * 56,
      weight: Math.min(1, 0.36 + action.count * 0.06),
      subtitle: `${action.count} hits`,
    });
    edges.push({ from: action.id, to: 'section-actions', label: 'action', strength: Math.min(1, 0.42 + action.count * 0.04), tone: 'action' });
  });

  const sectionInsights = sections
    .filter((section) => section.body)
    .slice(0, 2)
    .map((section) => `${section.title}: ${section.body.slice(0, 96)}${section.body.length > 96 ? '...' : ''}`);
  const insight = [
    detectedRegions.length ? `지역 노드: ${detectedRegions.map((entry) => `${entry.region}${entry.level ? ` ${entry.level}` : ''}`).join(', ')}` : '지역 노드: 보고서 내 명시 지역이 적어 중심 report node 위주로 표시합니다.',
    detectedSignals.length ? `신호 lane: ${detectedSignals.map((signal) => signal.label).join(' / ')}` : '신호 lane: 명시된 source 용어가 부족합니다.',
    detectedTopics.length ? `반복 topic: ${detectedTopics.map((topic) => topic.label).join(' / ')}` : '반복 topic: 주요 질병/품질 키워드가 적게 감지되었습니다.',
    ...sectionInsights,
  ].slice(0, 5);

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

  return (
    <section className="report-relationship-card">
      <div className="report-relationship-header">
        <div>
          <span>Report relationship figure</span>
          <h3>보고서 텍스트 기반 의미 관계도</h3>
          <p>
            RAW report artifact에서 지역, 신호원, 질병/키워드, action 용어를 추출해
            이번 보고서의 숨은 흐름을 시각화합니다.
          </p>
        </div>
        <strong>derived from raw report</strong>
      </div>

      <div className="report-relationship-layout">
        <svg className="report-relationship-svg" viewBox="0 0 860 520" role="img" aria-label="Report semantic relationship map">
          <defs>
            <marker id="report-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
              <path d="M 0 0 L 8 4 L 0 8 z" className="report-arrow-marker" />
            </marker>
            <radialGradient id="reportCoreGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#38d8ff" stopOpacity="0.34" />
              <stop offset="100%" stopColor="#38d8ff" stopOpacity="0" />
            </radialGradient>
          </defs>

          <circle cx="430" cy="222" r="154" fill="url(#reportCoreGlow)" />

          {figure.edges.map((edge, index) => {
            const from = nodeById.get(edge.from);
            const to = nodeById.get(edge.to);
            if (!from || !to) return null;
            const d = relationshipPath(from, to);
            return (
              <g className={`report-rel-edge edge-${edge.tone}`} key={`${edge.from}-${edge.to}-${index}`}>
                <path
                  d={d}
                  style={{ strokeWidth: 0.8 + edge.strength * 3.3, opacity: 0.28 + edge.strength * 0.52 }}
                  markerEnd="url(#report-arrow)"
                />
                <circle r={2.4 + edge.strength * 2} className="report-rel-pulse">
                  <animateMotion
                    dur={`${5.1 - edge.strength * 1.8}s`}
                    repeatCount="indefinite"
                    path={d}
                    begin={`${index * 0.18}s`}
                  />
                </circle>
              </g>
            );
          })}

          {figure.nodes.map((node) => {
            const radius = node.kind === 'report' ? 43 : node.kind === 'section' || node.kind === 'action' ? 30 : 23 + node.weight * 9;
            return (
              <g className={`report-rel-node node-${node.kind}`} key={node.id} transform={`translate(${node.x}, ${node.y})`}>
                <circle r={radius} />
                <text y={node.kind === 'report' ? -4 : 4}>
                  {splitLabel(node.label, node.kind === 'report' ? 14 : 11).slice(0, 2).map((line, index) => (
                    <tspan key={`${node.id}-${line}`} x="0" dy={index === 0 ? 0 : 13}>{line}</tspan>
                  ))}
                </text>
                {node.subtitle && <text className="report-rel-subtitle" y={node.kind === 'report' ? 24 : radius + 15}>{node.subtitle}</text>}
              </g>
            );
          })}
        </svg>

        <aside className="report-relationship-insights">
          <span>Figure interpretation</span>
          <h4>무엇을 읽어야 하나?</h4>
          {figure.insight.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <div className="report-relationship-legend">
            <span><i className="rel-dot region" /> 지역</span>
            <span><i className="rel-dot signal" /> 신호원</span>
            <span><i className="rel-dot topic" /> 질병/키워드</span>
            <span><i className="rel-dot action" /> 조치</span>
          </div>
        </aside>
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
