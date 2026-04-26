import { useCallback, useEffect, useMemo, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

type NodeStatus = 'idle' | 'running' | 'done' | 'error';
type StageTone = 'blue' | 'green' | 'amber' | 'red' | 'slate';

type PipelineStage = {
  id: string;
  title: string;
  subtitle: string;
  artifact: string;
  tone: StageTone;
  lanes: string[];
  actionLabel?: string;
};

type OntologyNode = {
  id: string;
  label: string;
  x: number;
  y: number;
  kind: 'source' | 'concept' | 'output';
};

type OntologyEdge = {
  from: string;
  to: string;
  strength: number;
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
    title: 'Source ingest',
    subtitle: 'Collect Korea respiratory evidence plus supporting imported-risk context.',
    artifact: 'raw_signal',
    tone: 'blue',
    lanes: ['KDCA ILI/SARI tables', 'Wastewater PDF bulletin', 'News feeds', 'Search trends', 'Imported-risk watch'],
    actionLabel: 'Refresh sources',
  },
  {
    id: 'qa',
    title: 'Quality control',
    subtitle: 'Align epiweeks, check freshness, and mark coverage gaps before any scoring.',
    artifact: 'source_catalog',
    tone: 'green',
    lanes: ['Epiweek resolver', 'Freshness score', 'Document-only flag', 'Coverage flag'],
  },
  {
    id: 'digest',
    title: 'AI digest',
    subtitle: 'Summarize each evidence lane before fusion so weak signals stay visible.',
    artifact: 'evidence_digest',
    tone: 'amber',
    lanes: ['News digest', 'Trend digest', 'KDCA digest', 'Wastewater note'],
    actionLabel: 'Generate digests',
  },
  {
    id: 'fusion',
    title: 'Sentinel fusion',
    subtitle: 'Combine independent evidence groups into a Korea region alert explanation.',
    artifact: 'alert_snapshot',
    tone: 'red',
    lanes: ['Composite score', 'Confidence', 'Explanation', 'Region ranking'],
    actionLabel: 'Run Sentinel',
  },
  {
    id: 'report',
    title: 'Report output',
    subtitle: 'Publish what changed, why it matters, confidence, and watch actions.',
    artifact: 'sentinel_report',
    tone: 'slate',
    lanes: ['Ontology figure', '4-part brief', 'Imported-risk note', 'Vercel dashboard'],
    actionLabel: 'Generate report',
  },
];

const ONTOLOGY_NODES: OntologyNode[] = [
  { id: 'kdca', label: 'KDCA surveillance', x: 84, y: 72, kind: 'source' },
  { id: 'wastewater', label: 'Wastewater PDF', x: 86, y: 158, kind: 'source' },
  { id: 'news', label: 'News signals', x: 86, y: 248, kind: 'source' },
  { id: 'trends', label: 'Search trends', x: 86, y: 334, kind: 'source' },
  { id: 'respiratory', label: 'Respiratory activity', x: 322, y: 100, kind: 'concept' },
  { id: 'environment', label: 'Environmental corroboration', x: 330, y: 205, kind: 'concept' },
  { id: 'behavior', label: 'Symptom-seeking behavior', x: 342, y: 318, kind: 'concept' },
  { id: 'imported', label: 'Imported-risk context', x: 548, y: 292, kind: 'concept' },
  { id: 'burden', label: 'Pneumonia burden hypothesis', x: 548, y: 142, kind: 'concept' },
  { id: 'report', label: 'Sentinel analysis report', x: 720, y: 220, kind: 'output' },
];

const ONTOLOGY_EDGES: OntologyEdge[] = [
  { from: 'kdca', to: 'respiratory', strength: 0.86 },
  { from: 'wastewater', to: 'environment', strength: 0.72 },
  { from: 'news', to: 'imported', strength: 0.66 },
  { from: 'trends', to: 'behavior', strength: 0.58 },
  { from: 'respiratory', to: 'burden', strength: 0.82 },
  { from: 'environment', to: 'burden', strength: 0.64 },
  { from: 'behavior', to: 'imported', strength: 0.38 },
  { from: 'imported', to: 'report', strength: 0.62 },
  { from: 'burden', to: 'report', strength: 0.9 },
];

const STATUS_LABELS: Record<NodeStatus, string> = {
  idle: 'Ready',
  running: 'Running',
  done: 'Complete',
  error: 'Error',
};

function nodeById(id: string) {
  return ONTOLOGY_NODES.find((node) => node.id === id);
}

export default function FlowDiagram({ onClose, onDataRefreshed, snapshotDate, embedded }: Props) {
  const [statuses, setStatuses] = useState<Record<string, NodeStatus>>({});
  const [selectedStage, setSelectedStage] = useState<string>('ingest');
  const [detailResult, setDetailResult] = useState('Pipeline ready. Select a stage or run a control action.');

  const setStageStatus = (id: string, status: NodeStatus) => {
    setStatuses((prev) => ({ ...prev, [id]: status }));
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
      setDetailResult('Status check skipped because the backend is not reachable.');
    }
  }, []);

  useEffect(() => {
    checkStatuses();
  }, [checkStatuses]);

  const selected = useMemo(
    () => PIPELINE_STAGES.find((stage) => stage.id === selectedStage) ?? PIPELINE_STAGES[0],
    [selectedStage],
  );

  const runSourceRefresh = async () => {
    setStageStatus('ingest', 'running');
    setDetailResult('Refreshing Korea news, trend feeds, and imported-risk context...');
    try {
      await fetch(`${API_BASE}/ingestion/refresh-korea`, { method: 'POST' });
      await fetch(`${API_BASE}/ingestion/refresh-global`, { method: 'POST' });
      await fetch(`${API_BASE}/ingestion/refresh-trends`, { method: 'POST' });
      setStageStatus('ingest', 'done');
      setDetailResult('Source refresh complete. Wastewater remains a document-only lane for now; automatic PDF extraction is deferred.');
      onDataRefreshed();
    } catch {
      setStageStatus('ingest', 'error');
      setDetailResult('Source refresh failed. Check backend connectivity and external API keys.');
    }
  };

  const runDigests = async () => {
    setStageStatus('digest', 'running');
    setDetailResult('Generating evidence-lane digests...');
    try {
      await fetch(`${API_BASE}/risk-analysis/news-digest`, { method: 'POST' });
      await fetch(`${API_BASE}/risk-analysis/trends-digest`, { method: 'POST' });
      await fetch(`${API_BASE}/risk-analysis/kdca-digest`, { method: 'POST' });
      setStageStatus('digest', 'done');
      setDetailResult('Evidence digests complete: news, trends, and KDCA lanes are ready for Sentinel fusion.');
    } catch {
      setStageStatus('digest', 'error');
      setDetailResult('Digest generation failed. Run each evidence lane separately to isolate the failing source.');
    }
  };

  const runSentinelFusion = async () => {
    setStageStatus('fusion', 'running');
    setDetailResult('Running Sentinel fusion across Korea surveillance, OSINT, trends, and corroboration lanes...');
    try {
      const response = await fetch(`${API_BASE}/risk-analysis/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ include_kdca: true }),
      });
      const data = await response.json();
      setStageStatus('fusion', 'done');
      setStageStatus('report', 'done');
      setDetailResult(data.summary || 'Sentinel fusion complete. The alert snapshot and report output are available.');
      onDataRefreshed();
    } catch {
      setStageStatus('fusion', 'error');
      setDetailResult('Sentinel fusion failed. Check AI provider settings and snapshot availability.');
    }
  };

  const runReport = async () => {
    setStageStatus('report', 'running');
    setDetailResult('Generating final integrated report...');
    try {
      const qs = snapshotDate ? `?snapshot_date=${snapshotDate}` : '';
      const response = await fetch(`${API_BASE}/reports/generate-final${qs}`, { method: 'POST' });
      const data = await response.json();
      setStageStatus('report', 'done');
      setDetailResult(`Report generated: ${data.report_filename || data.epiweek || 'latest snapshot'}.`);
    } catch {
      setStageStatus('report', 'error');
      setDetailResult('Report generation failed. Verify report storage and backend logs.');
    }
  };

  const handleRunStage = (stageId: string) => {
    if (stageId === 'ingest') return runSourceRefresh();
    if (stageId === 'digest') return runDigests();
    if (stageId === 'fusion') return runSentinelFusion();
    if (stageId === 'report') return runReport();
    setSelectedStage(stageId);
    setDetailResult('This stage is monitored here. Run the adjacent actionable stage to update it.');
  };

  const shellClass = embedded ? 'flow-embedded' : 'flow-overlay';

  return (
    <div className={shellClass} onClick={embedded ? undefined : onClose}>
      <div className="flow-container flow-container--control" onClick={(event) => event.stopPropagation()}>
        <div className="flow-header">
          <div>
            <h3 className="flow-title">Pipeline Control</h3>
            <span className="flow-subtitle">Korea-first respiratory intelligence control room: evidence, fusion, explanation, and report.</span>
          </div>
          {!embedded && <button className="flow-close-btn" onClick={onClose}>x</button>}
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
                        <span className={`pipeline-status status-${status}`}>{STATUS_LABELS[status]}</span>
                      </div>
                      <h4>{stage.title}</h4>
                      <p>{stage.subtitle}</p>
                      <div className="pipeline-artifact">{stage.artifact}</div>
                      <div className="pipeline-lanes">
                        {stage.lanes.map((lane) => (
                          <span key={lane}>{lane}</span>
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
                <span className="pipeline-detail-kicker">Selected control</span>
                <h4>{selected.title}</h4>
                <p>{selected.subtitle}</p>
              </div>
              <div className="pipeline-detail-meta">
                <span>Snapshot {snapshotDate || 'latest'}</span>
                <span>Artifact {selected.artifact}</span>
                <span>Status {STATUS_LABELS[statuses[selected.id] ?? 'idle']}</span>
              </div>
              {selected.actionLabel && (
                <button
                  className="pipeline-run-btn"
                  onClick={() => handleRunStage(selected.id)}
                  disabled={statuses[selected.id] === 'running'}
                  type="button"
                >
                  {statuses[selected.id] === 'running' ? 'Running...' : selected.actionLabel}
                </button>
              )}
              <div className="pipeline-result-box">{detailResult}</div>
            </div>
          </section>

          <section className="ontology-control-panel">
            <div className="ontology-header">
              <div>
                <span className="pipeline-detail-kicker">Sentinel ontology figure</span>
                <h4>AI interpretation of signal relationships</h4>
              </div>
              <span className="ontology-badge">explainable figure</span>
            </div>

            <svg className="ontology-map-svg" viewBox="0 0 820 420" role="img" aria-label="Sentinel evidence ontology map">
              {ONTOLOGY_EDGES.map((edge) => {
                const from = nodeById(edge.from);
                const to = nodeById(edge.to);
                if (!from || !to) return null;
                const midX = (from.x + to.x) / 2;
                return (
                  <path
                    key={`${edge.from}-${edge.to}`}
                    className="ontology-link"
                    d={`M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`}
                    style={{ strokeWidth: 1 + edge.strength * 4, opacity: 0.22 + edge.strength * 0.58 }}
                  />
                );
              })}
              {ONTOLOGY_NODES.map((node) => (
                <g className={`ontology-map-node node-${node.kind}`} key={node.id} transform={`translate(${node.x}, ${node.y})`}>
                  <circle r={node.kind === 'output' ? 34 : node.kind === 'concept' ? 27 : 22} />
                  <text y={node.kind === 'output' ? 52 : 42}>{node.label}</text>
                </g>
              ))}
            </svg>

            <div className="ontology-report-grid">
              <div>
                <span>Figure role</span>
                <strong>Not decoration</strong>
                <p>Shows how Sentinel groups raw signals into concepts before creating a regional alert explanation.</p>
              </div>
              <div>
                <span>Report contract</span>
                <strong>Changed, matters, confidence, actions</strong>
                <p>Every Sentinel report should use these four sections so the user can audit the alert logic quickly.</p>
              </div>
              <div>
                <span>Global layer</span>
                <strong>Imported-risk context only</strong>
                <p>Overseas news and neighbor-country activity corroborate risk; they do not replace Korea regional scoring.</p>
              </div>
              <div>
                <span>Deferred lane</span>
                <strong>Wastewater PDF automation later</strong>
                <p>For now, wastewater stays visible as a document-only corroboration lane until extraction review is added.</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
