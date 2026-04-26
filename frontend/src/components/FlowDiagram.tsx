import { useCallback, useEffect, useMemo, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

type Lang = 'ko' | 'en';
type NodeStatus = 'idle' | 'running' | 'done' | 'error';
type StageTone = 'blue' | 'green' | 'amber' | 'red' | 'slate';

type Copy = {
  ko: string;
  en: string;
};

type PipelineControl = {
  id: string;
  label: Copy;
  description: Copy;
  endpoints?: string[];
  result: Copy;
};

type PipelineStage = {
  id: string;
  title: Copy;
  subtitle: Copy;
  artifact: string;
  tone: StageTone;
  lanes: Copy[];
  controls: PipelineControl[];
  checklist: Copy[];
};

type OntologyNode = {
  id: string;
  label: Copy;
  x: number;
  y: number;
  kind: 'source' | 'concept' | 'output';
};

type OntologyEdge = {
  from: string;
  to: string;
  strength: number;
  phase: 'ingest' | 'digest' | 'fusion' | 'report';
};

interface Props {
  onClose: () => void;
  onDataRefreshed: () => void;
  snapshotDate?: string;
  embedded?: boolean;
}

const PIPELINE_STAGES: PipelineStage[] = [
  {
    id: 'ingest',
    title: { ko: '소스 수집', en: 'Source ingest' },
    subtitle: {
      ko: '질병청 중심 감시자료와 국내 뉴스/검색 트렌드를 우선 수집하고, WHO/국제 뉴스는 Globe 참고 패널로 분리합니다.',
      en: 'Prioritize KDCA surveillance plus Korea news/trends; keep international signals as a separate support layer.',
    },
    artifact: 'raw_signal',
    tone: 'blue',
    lanes: [
      { ko: '질병청 ILI/SARI 표', en: 'KDCA ILI/SARI tables' },
      { ko: '폐하수 PDF 공보', en: 'Wastewater PDF bulletin' },
      { ko: '국내 뉴스', en: 'Korea news feeds' },
      { ko: '국내 검색 트렌드', en: 'Korea search trends' },
    ],
    controls: [
      {
        id: 'refresh-official',
        label: { ko: '공식 감시 갱신', en: 'Refresh official lane' },
        description: { ko: '질병청/국내 감시 신호를 다시 불러옵니다.', en: 'Reload the Korea surveillance lane.' },
        endpoints: ['/ingestion/refresh-korea'],
        result: { ko: '공식 감시 신호 갱신 완료.', en: 'Official surveillance lane refreshed.' },
      },
      {
        id: 'refresh-osint',
        label: { ko: '뉴스/트렌드 갱신', en: 'Refresh OSINT lanes' },
        description: { ko: '국내 뉴스/검색 트렌드를 갱신합니다. WHO/국제 뉴스는 Globe 패널에서 별도로 확인합니다.', en: 'Refresh Korea news/trends. WHO/international news is reviewed separately in the Globe panel.' },
        endpoints: ['/ingestion/refresh-trends'],
        result: { ko: '뉴스/트렌드 신호 갱신 완료.', en: 'News and trend lanes refreshed.' },
      },
    ],
    checklist: [
      { ko: '폐하수는 현재 문서-only 보조 신호입니다.', en: 'Wastewater remains a document-only corroboration lane.' },
      { ko: 'WHO/국제 뉴스는 국내 OSINT와 섞지 않고 Globe 패널에서 별도로 설명합니다.', en: 'WHO/international news is shown separately in the Globe panel.' },
    ],
  },
  {
    id: 'qa',
    title: { ko: '품질 확인', en: 'Quality control' },
    subtitle: {
      ko: 'epiweek, freshness, coverage, document-only 여부를 점수화 전에 확인합니다.',
      en: 'Align epiweeks, freshness, coverage, and document-only flags before scoring.',
    },
    artifact: 'source_catalog',
    tone: 'green',
    lanes: [
      { ko: '역학주 정렬', en: 'Epiweek resolver' },
      { ko: '최신성 점검', en: 'Freshness score' },
      { ko: '문서-only 표시', en: 'Document-only flag' },
      { ko: '지역 커버리지', en: 'Coverage flag' },
    ],
    controls: [
      {
        id: 'qa-status',
        label: { ko: '품질 상태 확인', en: 'Check source quality' },
        description: { ko: '각 소스가 점수에 들어갈 준비가 되었는지 확인합니다.', en: 'Review whether each lane is ready for scoring.' },
        result: {
          ko: '품질 확인 단계는 현재 모니터링 단계입니다. freshness/coverage 저하는 confidence에 반영해야 합니다.',
          en: 'Quality control is monitored here. Freshness and coverage degradation should lower confidence.',
        },
      },
    ],
    checklist: [
      { ko: 'source count보다 source independence를 우선합니다.', en: 'Source independence matters more than raw source count.' },
      { ko: '자동 PDF 추출은 아직 보류 상태로 표시합니다.', en: 'Automatic PDF extraction is explicitly deferred.' },
    ],
  },
  {
    id: 'digest',
    title: { ko: 'AI 요약', en: 'AI digest' },
    subtitle: {
      ko: '각 evidence lane을 먼저 요약해 약한 신호가 합성 과정에서 사라지지 않게 합니다.',
      en: 'Summarize each evidence lane before fusion so weak signals stay visible.',
    },
    artifact: 'evidence_digest',
    tone: 'amber',
    lanes: [
      { ko: '뉴스 요약', en: 'News digest' },
      { ko: '트렌드 요약', en: 'Trend digest' },
      { ko: 'KDCA 요약', en: 'KDCA digest' },
      { ko: '폐하수 메모', en: 'Wastewater note' },
    ],
    controls: [
      {
        id: 'generate-digests',
        label: { ko: 'Evidence 요약 생성', en: 'Generate evidence digests' },
        description: { ko: '뉴스, 트렌드, KDCA lane의 AI digest를 생성합니다.', en: 'Generate news, trends, and KDCA AI digests.' },
        endpoints: ['/risk-analysis/news-digest', '/risk-analysis/trends-digest', '/risk-analysis/kdca-digest'],
        result: { ko: 'Evidence digest 생성 완료.', en: 'Evidence digests generated.' },
      },
    ],
    checklist: [
      { ko: '요약은 경보 점수의 근거 설명에 사용됩니다.', en: 'Digests feed the alert explanation layer.' },
      { ko: '뉴스/트렌드는 보조 corroboration으로 취급합니다.', en: 'News and trends remain corroborating signals.' },
    ],
  },
  {
    id: 'fusion',
    title: { ko: 'Sentinel 합성', en: 'Sentinel fusion' },
    subtitle: {
      ko: '독립 evidence group을 결합해 지역별 경보, 신뢰도, 설명을 만듭니다.',
      en: 'Combine independent evidence groups into region-level alert explanations.',
    },
    artifact: 'alert_snapshot',
    tone: 'red',
    lanes: [
      { ko: 'Composite score', en: 'Composite score' },
      { ko: 'Confidence', en: 'Confidence' },
      { ko: '자연어 설명', en: 'Explanation' },
      { ko: '지역 순위', en: 'Region ranking' },
    ],
    controls: [
      {
        id: 'sentinel-fusion',
        label: { ko: 'Sentinel 분석 실행', en: 'Run Sentinel fusion' },
        description: { ko: 'OSINT와 KDCA 근거를 결합해 최신 alert snapshot을 계산합니다.', en: 'Fuse OSINT and KDCA evidence into the latest alert snapshot.' },
        result: { ko: 'Sentinel 합성 완료.', en: 'Sentinel fusion complete.' },
      },
    ],
    checklist: [
      { ko: '점수와 confidence를 분리해 설명합니다.', en: 'Score and confidence are explained separately.' },
      { ko: '왜 특정 시도에서 alert가 떴는지 설명 가능해야 합니다.', en: 'Each region alert should be explainable.' },
    ],
  },
  {
    id: 'report',
    title: { ko: '보고서 출력', en: 'Report output' },
    subtitle: {
      ko: 'What changed, Why it matters, Confidence, Watch actions 구조로 보고서를 만듭니다.',
      en: 'Publish what changed, why it matters, confidence, and watch actions.',
    },
    artifact: 'sentinel_report',
    tone: 'slate',
    lanes: [
      { ko: 'Ontology figure', en: 'Ontology figure' },
      { ko: '4-part brief', en: '4-part brief' },
      { ko: 'Globe 참고 패널', en: 'Globe reference panel' },
      { ko: 'Vercel dashboard', en: 'Vercel dashboard' },
    ],
    controls: [
      {
        id: 'generate-report',
        label: { ko: 'Sentinel 보고서 생성', en: 'Generate Sentinel report' },
        description: { ko: '최신 snapshot 기준 통합 보고서를 생성합니다.', en: 'Generate the integrated report for the selected snapshot.' },
        result: { ko: '보고서 생성 완료.', en: 'Report generated.' },
      },
    ],
    checklist: [
      { ko: 'Ontology figure는 AI 해석 근거를 시각화합니다.', en: 'The ontology figure visualizes how AI grouped the evidence.' },
      { ko: '보고서 원문 artifact는 audit trail로 보존합니다.', en: 'The raw report artifact remains as an audit trail.' },
    ],
  },
];

const ONTOLOGY_NODES: OntologyNode[] = [
  { id: 'kdca', label: { ko: '질병청 감시', en: 'KDCA surveillance' }, x: 84, y: 58, kind: 'source' },
  { id: 'wastewater', label: { ko: '폐하수 PDF', en: 'Wastewater PDF' }, x: 86, y: 134, kind: 'source' },
  { id: 'news', label: { ko: '국내 뉴스', en: 'Korea news' }, x: 86, y: 214, kind: 'source' },
  { id: 'trends', label: { ko: '국내 검색 트렌드', en: 'Korea search trends' }, x: 86, y: 292, kind: 'source' },
  { id: 'respiratory', label: { ko: '호흡기 활동성', en: 'Respiratory activity' }, x: 322, y: 100, kind: 'concept' },
  { id: 'environment', label: { ko: '환경 보조근거', en: 'Environmental corroboration' }, x: 330, y: 205, kind: 'concept' },
  { id: 'behavior', label: { ko: '증상탐색행동(OSINT 신호)', en: 'Symptom-seeking behavior (OSINT signal)' }, x: 342, y: 318, kind: 'concept' },
  { id: 'burden', label: { ko: '폐렴 부담 가설', en: 'Pneumonia burden hypothesis' }, x: 548, y: 142, kind: 'concept' },
  { id: 'report', label: { ko: 'Sentinel 종합보고서', en: 'Sentinel analysis report' }, x: 720, y: 220, kind: 'output' },
];

const ONTOLOGY_EDGES: OntologyEdge[] = [
  { from: 'kdca', to: 'respiratory', strength: 0.86, phase: 'ingest' },
  { from: 'wastewater', to: 'environment', strength: 0.72, phase: 'ingest' },
  { from: 'news', to: 'behavior', strength: 0.48, phase: 'digest' },
  { from: 'trends', to: 'behavior', strength: 0.58, phase: 'digest' },
  { from: 'respiratory', to: 'burden', strength: 0.82, phase: 'fusion' },
  { from: 'environment', to: 'burden', strength: 0.64, phase: 'fusion' },
  { from: 'burden', to: 'report', strength: 0.9, phase: 'report' },
  { from: 'behavior', to: 'report', strength: 0.78, phase: 'report' },
];

const STATUS_LABELS: Record<Lang, Record<NodeStatus, string>> = {
  ko: {
    idle: '대기',
    running: '실행 중',
    done: '완료',
    error: '오류',
  },
  en: {
    idle: 'Ready',
    running: 'Running',
    done: 'Complete',
    error: 'Error',
  },
};

const INITIAL_DETAIL: Copy = {
  ko: 'Pipeline ready. 단계를 선택하거나 하위 컨트롤을 실행하세요.',
  en: 'Pipeline ready. Select a stage or run a sub-control action.',
};

function copy(text: Copy, lang: Lang) {
  return text[lang];
}

function nodeById(id: string) {
  return ONTOLOGY_NODES.find((node) => node.id === id);
}

function edgePath(edge: OntologyEdge) {
  const from = nodeById(edge.from);
  const to = nodeById(edge.to);
  if (!from || !to) return '';
  const midX = (from.x + to.x) / 2;
  return `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`;
}

function nodeLabelLines(node: OntologyNode, lang: Lang) {
  const label = copy(node.label, lang);
  if (lang === 'ko' && label.includes('(')) {
    const [main, detail] = label.split('(');
    return [main, `(${detail}`];
  }
  if (lang === 'en' && label.length > 26) {
    return label.replace(' (', '\n(').split('\n');
  }
  return [label];
}

export default function FlowDiagram({ onClose, onDataRefreshed, snapshotDate, embedded }: Props) {
  const [lang, setLang] = useState<Lang>('ko');
  const [statuses, setStatuses] = useState<Record<string, NodeStatus>>({});
  const [controlStatuses, setControlStatuses] = useState<Record<string, NodeStatus>>({});
  const [selectedStage, setSelectedStage] = useState<string>('ingest');
  const [detailResult, setDetailResult] = useState(INITIAL_DETAIL.ko);

  const setStageStatus = (id: string, status: NodeStatus) => {
    setStatuses((prev) => ({ ...prev, [id]: status }));
  };

  const setControlStatus = (id: string, status: NodeStatus) => {
    setControlStatuses((prev) => ({ ...prev, [id]: status }));
  };

  const checkStatuses = useCallback(async () => {
    try {
      const [newsK, trendsK, newsD, trendsD, kdcaD] = await Promise.allSettled([
        fetch(`${API_BASE}/news/korea?limit=1`).then((res) => res.json()),
        fetch(`${API_BASE}/trends/korea`).then((res) => res.json()),
        fetch(`${API_BASE}/risk-analysis/news-digest`).then((res) => res.json()),
        fetch(`${API_BASE}/risk-analysis/trends-digest`).then((res) => res.json()),
        fetch(`${API_BASE}/risk-analysis/kdca-digest`).then((res) => res.json()),
      ]);
      const next: Record<string, NodeStatus> = {};
      if (newsK.status === 'fulfilled' && Array.isArray(newsK.value) && newsK.value.length > 0) next.ingest = 'done';
      if (trendsK.status === 'fulfilled' && trendsK.value?.series?.length > 0) next.ingest = 'done';
      if (newsD.status === 'fulfilled' && newsD.value?.status === 'ok') next.digest = 'done';
      if (trendsD.status === 'fulfilled' && trendsD.value?.status === 'ok') next.digest = 'done';
      if (kdcaD.status === 'fulfilled' && kdcaD.value?.status === 'ok') next.qa = 'done';
      setStatuses(next);
    } catch {
      setDetailResult(lang === 'ko' ? '백엔드 연결이 없어 상태 확인을 건너뛰었습니다.' : 'Status check skipped because the backend is not reachable.');
    }
  }, [lang]);

  useEffect(() => {
    checkStatuses();
  }, [checkStatuses]);

  const selected = useMemo(
    () => PIPELINE_STAGES.find((stage) => stage.id === selectedStage) ?? PIPELINE_STAGES[0],
    [selectedStage],
  );

  const activePhases = useMemo(() => {
    if (selectedStage === 'ingest' || selectedStage === 'qa') return new Set(['ingest']);
    if (selectedStage === 'digest') return new Set(['digest', 'ingest']);
    if (selectedStage === 'fusion') return new Set(['fusion', 'digest']);
    return new Set(['report', 'fusion']);
  }, [selectedStage]);

  const runControl = async (stage: PipelineStage, control: PipelineControl) => {
    setControlStatus(control.id, 'running');
    setStageStatus(stage.id, 'running');
    setDetailResult(`${copy(control.label, lang)}...`);

    try {
      if (control.id === 'sentinel-fusion') {
        const response = await fetch(`${API_BASE}/risk-analysis/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ include_kdca: true }),
        });
        const data = await response.json();
        setStageStatus('fusion', 'done');
        setStageStatus('report', 'done');
        setControlStatus(control.id, 'done');
        setDetailResult(data.summary || copy(control.result, lang));
        onDataRefreshed();
        return;
      }

      if (control.id === 'generate-report') {
        const qs = snapshotDate ? `?snapshot_date=${snapshotDate}` : '';
        const response = await fetch(`${API_BASE}/reports/generate-final${qs}`, { method: 'POST' });
        const data = await response.json();
        setStageStatus(stage.id, 'done');
        setControlStatus(control.id, 'done');
        setDetailResult(`${copy(control.result, lang)} ${data.report_filename || data.epiweek || snapshotDate || ''}`.trim());
        return;
      }

      if (control.endpoints?.length) {
        await Promise.all(control.endpoints.map((endpoint) => fetch(`${API_BASE}${endpoint}`, { method: 'POST' })));
        setStageStatus(stage.id, 'done');
        setControlStatus(control.id, 'done');
        setDetailResult(copy(control.result, lang));
        onDataRefreshed();
        return;
      }

      setStageStatus(stage.id, 'done');
      setControlStatus(control.id, 'done');
      setDetailResult(copy(control.result, lang));
    } catch {
      setStageStatus(stage.id, 'error');
      setControlStatus(control.id, 'error');
      setDetailResult(lang === 'ko' ? '실행 실패: 백엔드 연결, API key, snapshot 상태를 확인하세요.' : 'Run failed. Check backend connectivity, API keys, and snapshot availability.');
    }
  };

  const shellClass = embedded ? 'flow-embedded' : 'flow-overlay';

  return (
    <div className={shellClass} onClick={embedded ? undefined : onClose}>
      <div className="flow-container flow-container--control" onClick={(event) => event.stopPropagation()}>
        <div className="flow-header flow-header--control">
          <div>
            <h3 className="flow-title">{lang === 'ko' ? '파이프라인 컨트롤' : 'Pipeline Control'}</h3>
            <span className="flow-subtitle">
              {lang === 'ko'
                ? '한국형 호흡기 감염 인텔리전스: evidence, fusion, explanation, report를 한 화면에서 제어합니다.'
                : 'Korea-first respiratory intelligence control room: evidence, fusion, explanation, and report.'}
            </span>
          </div>
          <div className="flow-header-actions">
            <div className="pipeline-lang-toggle" aria-label="language switch">
              <button className={lang === 'ko' ? 'active' : ''} onClick={() => setLang('ko')} type="button">KO</button>
              <button className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')} type="button">EN</button>
            </div>
            {!embedded && <button className="flow-close-btn" onClick={onClose}>x</button>}
          </div>
        </div>

        <div className="pipeline-control-body">
          <section className="pipeline-control-panel">
            <div className="pipeline-control-strip">
              {PIPELINE_STAGES.map((stage, index) => {
                const status = statuses[stage.id] ?? 'idle';
                return (
                  <div className="pipeline-stage-shell" key={stage.id}>
                    <button
                      className={`pipeline-stage-card tone-${stage.tone} ${selectedStage === stage.id ? 'is-selected' : ''}`}
                      onClick={() => setSelectedStage(stage.id)}
                      type="button"
                    >
                      <div className="pipeline-stage-topline">
                        <span>{String(index + 1).padStart(2, '0')}</span>
                        <span className={`pipeline-status status-${status}`}>{STATUS_LABELS[lang][status]}</span>
                      </div>
                      <h4>{copy(stage.title, lang)}</h4>
                      {lang === 'ko' && <span className="pipeline-title-en">{stage.title.en}</span>}
                      <p>{copy(stage.subtitle, lang)}</p>
                      <div className="pipeline-artifact">{stage.artifact}</div>
                      <div className="pipeline-lanes">
                        {stage.lanes.map((lane) => (
                          <span key={lane.en}>{copy(lane, lang)}</span>
                        ))}
                      </div>
                    </button>
                    {index < PIPELINE_STAGES.length - 1 && <div className="pipeline-stage-arrow">-&gt;</div>}
                  </div>
                );
              })}
            </div>

            <div className="pipeline-stage-detail">
              <div>
                <span className="pipeline-detail-kicker">{lang === 'ko' ? '선택된 운영 단계' : 'Selected control stage'}</span>
                <h4>{copy(selected.title, lang)}</h4>
                <p>{copy(selected.subtitle, lang)}</p>
              </div>
              <div className="pipeline-detail-meta">
                <span>Snapshot {snapshotDate || 'latest'}</span>
                <span>Artifact {selected.artifact}</span>
                <span>Status {STATUS_LABELS[lang][statuses[selected.id] ?? 'idle']}</span>
              </div>

              <div className="pipeline-control-actions">
                {selected.controls.map((control) => {
                  const status = controlStatuses[control.id] ?? 'idle';
                  return (
                    <button
                      className={`pipeline-subcontrol-btn status-${status}`}
                      key={control.id}
                      onClick={() => runControl(selected, control)}
                      disabled={status === 'running'}
                      type="button"
                    >
                      <span>{status === 'running' ? (lang === 'ko' ? '실행 중...' : 'Running...') : copy(control.label, lang)}</span>
                      <small>{copy(control.description, lang)}</small>
                      <em>{STATUS_LABELS[lang][status]}</em>
                    </button>
                  );
                })}
              </div>

              <div className="pipeline-checklist">
                {selected.checklist.map((item) => (
                  <span key={item.en}>{copy(item, lang)}</span>
                ))}
              </div>

              <div className="pipeline-result-box">{detailResult}</div>
            </div>
          </section>

          <section className="ontology-control-panel">
            <div className="ontology-header">
              <div>
                <span className="pipeline-detail-kicker">Sentinel ontology figure</span>
                <h4>{lang === 'ko' ? 'AI가 해석한 신호 관계도' : 'AI interpretation of signal relationships'}</h4>
                <p className="ontology-header-copy">
                  {lang === 'ko'
                    ? '점선과 pulse는 raw signal이 개념 노드로 묶이고, 최종 보고서로 흘러가는 과정을 보여줍니다.'
                    : 'Dashed pulses show raw signals being grouped into concept nodes and routed into the report.'}
                </p>
              </div>
              <span className="ontology-badge">{lang === 'ko' ? '설명 가능한 figure' : 'explainable figure'}</span>
            </div>

            <svg className="ontology-map-svg" viewBox="0 0 820 420" role="img" aria-label="Sentinel evidence ontology map">
              {ONTOLOGY_EDGES.map((edge, index) => {
                const d = edgePath(edge);
                if (!d) return null;
                const active = activePhases.has(edge.phase);
                return (
                  <g key={`${edge.from}-${edge.to}`}>
                    <path
                      className={`ontology-link ${edge.from === 'behavior' && edge.to === 'report' ? 'is-osint-report-link' : ''} ${active ? 'is-active' : ''}`}
                      d={d}
                      style={{ strokeWidth: 1 + edge.strength * 4, opacity: active ? 0.88 : 0.22 + edge.strength * 0.3 }}
                    />
                    <circle className={`ontology-pulse ${edge.from === 'behavior' && edge.to === 'report' ? 'is-osint-report-link' : ''} ${active ? 'is-active' : ''}`} r={active ? 4.3 : 2.8}>
                      <animateMotion
                        dur={`${5.2 - edge.strength * 1.8}s`}
                        repeatCount="indefinite"
                        path={d}
                        begin={`${index * 0.22}s`}
                      />
                    </circle>
                  </g>
                );
              })}
              {ONTOLOGY_NODES.map((node) => (
                <g className={`ontology-map-node node-${node.kind}`} key={node.id} transform={`translate(${node.x}, ${node.y})`}>
                  <circle r={node.kind === 'output' ? 34 : node.kind === 'concept' ? 27 : 22} />
                  <text y={node.kind === 'output' ? 52 : 42}>
                    {nodeLabelLines(node, lang).map((line, index) => (
                      <tspan key={line} x="0" dy={index === 0 ? 0 : 14}>{line}</tspan>
                    ))}
                  </text>
                </g>
              ))}
            </svg>

            <div className="ontology-legend">
              <span><i className="legend-dot source" /> {lang === 'ko' ? '원천 신호' : 'Source signal'}</span>
              <span><i className="legend-dot concept" /> {lang === 'ko' ? 'AI 개념 묶음' : 'AI concept group'}</span>
              <span><i className="legend-dot output" /> {lang === 'ko' ? '보고서 산출물' : 'Report output'}</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
