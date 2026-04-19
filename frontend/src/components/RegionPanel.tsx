import { useEffect, useMemo, useState } from 'react';
import type { GlobalSignal, KoreaAlert, TimelinePoint } from '../types';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

function signalColor(value: number): string {
  if (value >= 0.75) return '#ff4d4f';
  if (value >= 0.55) return '#ff9f43';
  if (value >= 0.3) return '#f6e05e';
  return '#34d399';
}

function confidenceTone(confidence: string): string {
  if (confidence === 'High') return 'var(--accent-cyan)';
  if (confidence === 'Moderate') return 'var(--accent-amber)';
  return 'var(--text-secondary)';
}

function RegionTrend({ timeline }: { timeline: TimelinePoint[] }) {
  const width = 320;
  const height = 92;
  const padding = 12;
  const points = useMemo(() => {
    if (!timeline.length) return [];
    const stepX = timeline.length > 1 ? (width - padding * 2) / (timeline.length - 1) : 0;
    return timeline.map((point, index) => ({
      x: padding + index * stepX,
      y: height - padding - point.score * (height - padding * 2),
      label: point.snapshot_date.slice(5),
      value: point.score,
    }));
  }, [timeline]);

  const pathD = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');

  return (
    <div className="trend-container">
      <div className="section-title">Timeline Replay</div>
      {points.length ? (
        <>
          <svg className="trend-svg" viewBox={`0 0 ${width} ${height}`}>
            <path className="trend-line" d={pathD} />
            {points.map((point) => (
              <circle key={`${point.label}-${point.x}`} className="trend-point" cx={point.x} cy={point.y} r={3} />
            ))}
          </svg>
          <div className="timeline-mini-labels">
            {timeline.length > 0 && (
              <>
                <span>{timeline[0].snapshot_date.slice(5)}</span>
                <span>{timeline[timeline.length - 1].snapshot_date.slice(5)}</span>
              </>
            )}
          </div>
        </>
      ) : (
        <div className="empty-state">Timeline data is not available yet.</div>
      )}
    </div>
  );
}

function KoreaDetail({ alert }: { alert: KoreaAlert }) {
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);

  useEffect(() => {
    const fetchTimeline = async () => {
      try {
        const res = await fetch(`${API_BASE}/timeline/${alert.region_code}`);
        const data: TimelinePoint[] = await res.json();
        setTimeline(data);
      } catch {
        setTimeline([]);
      }
    };
    fetchTimeline();
  }, [alert.region_code]);

  return (
    <>
      <div className="detail-topline">
        <div className={`score-badge ${alert.level}`}>
          {alert.score.toFixed(2)}
          <span className="score-label">{alert.level} composite alert</span>
        </div>
        <div className="detail-meta-grid">
          <div className="meta-card">
            <span className="meta-label">Snapshot</span>
            <strong>{alert.snapshot_date}</strong>
          </div>
          <div className="meta-card">
            <span className="meta-label">Epiweek</span>
            <strong>{alert.epiweek}</strong>
          </div>
          <div className="meta-card">
            <span className="meta-label">Confidence</span>
            <strong style={{ color: confidenceTone(alert.confidence) }}>{alert.confidence}</strong>
          </div>
          <div className="meta-card">
            <span className="meta-label">Data quality</span>
            <strong>{alert.data_quality.label}</strong>
          </div>
        </div>
      </div>

      <div className="confidence-row">
        <div className="confidence-badge">Active sources {alert.active_sources}</div>
        <div className="confidence-badge">Independent sources {alert.independent_sources}</div>
      </div>

      <RegionTrend timeline={timeline} />

      <div>
        <div className="section-title">Signal Breakdown</div>
        {Object.entries(alert.signal_details).map(([key, detail]) => {
          const value = alert.signals[key];
          return (
            <div className="signal-row" key={key}>
              <div className="signal-column">
                <span className="signal-name">{detail.label}</span>
                <span className="signal-subtext">coverage {(detail.coverage * 100).toFixed(0)}% • freshness {detail.freshness_days.toFixed(0)}d</span>
              </div>
              {value !== null ? (
                <>
                  <div className="signal-bar-bg">
                    <div className="signal-bar-fill" style={{ width: `${value * 100}%`, background: signalColor(value) }} />
                  </div>
                  <span className="signal-value">{value.toFixed(2)}</span>
                </>
              ) : (
                <span className="signal-disabled">Planned</span>
              )}
            </div>
          );
        })}
      </div>

      <div>
        <div className="section-title">Alert Explanation</div>
        <ul className="explanation-list">
          {alert.alert_explanation.map((message) => (
            <li className="explanation-item" key={message}>{message}</li>
          ))}
        </ul>
      </div>

      <div className="governance-card">
        <div className="section-title">Governance note</div>
        <p>CXR_AWARE is treated as a future corroboration layer only. The contract assumes aggregate hospital AI summaries, not raw images or patient-level DICOM data.</p>
      </div>
    </>
  );
}

function GlobalDetail({ signal }: { signal: GlobalSignal }) {
  return (
    <>
      <div className="confidence-row">
        <div className="confidence-badge">{signal.source.replace('_', ' ')}</div>
        <div className="confidence-badge">{signal.date}</div>
        <div className="confidence-badge">{signal.severity}</div>
      </div>
      {signal.title && <p className="global-description">{signal.title}</p>}
      {signal.keyword && <p className="global-description">Keyword: {signal.keyword}</p>}
      <div className="governance-card">
        <div className="section-title">Global context role</div>
        <p>This layer supports imported-risk watch, regional benchmarking, and external corroboration. It does not replace Korea deep scoring.</p>
      </div>
    </>
  );
}

type Props = {
  selectedKorea: KoreaAlert | null;
  selectedGlobal: GlobalSignal | null;
  onClose: () => void;
};

export default function RegionPanel({ selectedKorea, selectedGlobal, onClose }: Props) {
  const isOpen = selectedKorea !== null || selectedGlobal !== null;
  const title = selectedKorea ? selectedKorea.region_name_en : selectedGlobal?.title || selectedGlobal?.keyword || 'Signal';
  const subtitle = selectedKorea ? selectedKorea.region_name_kr : selectedGlobal?.country || selectedGlobal?.disease || '';

  return (
    <div className={`panel-overlay ${isOpen ? 'open' : ''}`}>
      <div className="panel-header">
        <div>
          <div className="panel-title">{title}</div>
          <div className="panel-subtitle">{subtitle}</div>
        </div>
        <button className="panel-close" onClick={onClose}>×</button>
      </div>
      <div className="panel-body">
        {selectedKorea && <KoreaDetail alert={selectedKorea} />}
        {selectedGlobal && <GlobalDetail signal={selectedGlobal} />}
      </div>
    </div>
  );
}
