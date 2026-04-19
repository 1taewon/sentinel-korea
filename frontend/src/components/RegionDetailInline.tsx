import { useEffect, useMemo, useState } from 'react';
import type { KoreaAlert, TimelinePoint } from '../types';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

function signalColor(value: number): string {
  if (value >= 0.75) return '#ff4d4f';
  if (value >= 0.55) return '#ff9f43';
  if (value >= 0.3) return '#f6e05e';
  return '#34d399';
}

function TimelineGraph({ timeline }: { timeline: TimelinePoint[] }) {
  const width = 520;
  const height = 140;
  const padding = 18;
  const points = useMemo(() => {
    if (!timeline.length) return [];
    const stepX = timeline.length > 1 ? (width - padding * 2) / (timeline.length - 1) : 0;
    return timeline.map((point, index) => ({
      x: padding + index * stepX,
      y: height - padding - point.score * (height - padding * 2),
      label: point.snapshot_date.slice(5),
      value: point.score,
      date: point.snapshot_date,
    }));
  }, [timeline]);

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaD = points.length
    ? `M ${points[0].x} ${height - padding} ${points.map((p) => `L ${p.x} ${p.y}`).join(' ')} L ${points[points.length - 1].x} ${height - padding} Z`
    : '';

  if (!points.length) {
    return <div className="empty-state">Timeline data is not available yet.</div>;
  }

  const latest = points[points.length - 1];
  const first = points[0];
  const delta = latest.value - first.value;
  const trendLabel = delta > 0.05 ? '↑ 상승' : delta < -0.05 ? '↓ 하락' : '→ 유지';
  const trendColor = delta > 0.05 ? '#ff4d4f' : delta < -0.05 ? '#34d399' : '#94a3b8';

  return (
    <div className="region-timeline-graph">
      <svg className="region-timeline-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {/* grid lines at thresholds */}
        {[0.75, 0.55, 0.3].map((thr) => {
          const y = height - padding - thr * (height - padding * 2);
          return (
            <line
              key={thr}
              x1={padding}
              x2={width - padding}
              y1={y}
              y2={y}
              stroke="var(--border)"
              strokeDasharray="2 3"
              strokeWidth={0.6}
              opacity={0.5}
            />
          );
        })}
        <path d={areaD} fill="rgba(0, 212, 255, 0.10)" />
        <path d={pathD} fill="none" stroke="#00d4ff" strokeWidth={1.8} />
        {points.map((p) => (
          <circle
            key={`${p.label}-${p.x}`}
            cx={p.x}
            cy={p.y}
            r={3}
            fill={signalColor(p.value)}
            stroke="var(--bg-card)"
            strokeWidth={1.5}
          >
            <title>{`${p.date} · ${p.value.toFixed(2)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="region-timeline-meta">
        <span>{first.label}</span>
        <span className="region-timeline-trend" style={{ color: trendColor }}>
          {trendLabel} ({delta >= 0 ? '+' : ''}{delta.toFixed(2)})
        </span>
        <span>{latest.label}</span>
      </div>
    </div>
  );
}

interface Props {
  alert: KoreaAlert;
  allAlerts: KoreaAlert[];
  onClose?: () => void;
  variant?: 'floating' | 'inline';
}

const SIGNAL_LABELS: Record<string, string> = {
  notifiable_disease: '법정감염병',
  influenza_like: 'ILI/SARI',
  wastewater_pathogen: '폐수 감시',
  clinical_cxr_aware: 'CXR (예정)',
  news_trends_ai: 'News/Trends AI',
};

export default function RegionDetailInline({ alert, allAlerts, onClose, variant = 'inline' }: Props) {
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`${API_BASE}/timeline/${alert.region_code}`);
        if (!res.ok) throw new Error('timeline fetch failed');
        const data: TimelinePoint[] = await res.json();
        if (!cancelled) setTimeline(data);
      } catch {
        if (!cancelled) setTimeline([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [alert.region_code]);

  const rank = useMemo(() => {
    const sorted = [...allAlerts].sort((a, b) => b.score - a.score);
    return sorted.findIndex((a) => a.region_code === alert.region_code) + 1;
  }, [allAlerts, alert.region_code]);

  return (
    <div className={`region-detail-inline region-detail-inline--${variant}`}>
      <div className="region-detail-header">
        <div>
          <div className="region-detail-name">{alert.region_name_kr}</div>
          <div className="region-detail-sub">
            {alert.region_name_en} · #{rank || '—'} 위험도 순위 · {alert.epiweek || ''}
          </div>
        </div>
        <div className={`region-detail-score kas-level-${alert.level}`}>
          {alert.score.toFixed(2)}
          <span className="region-detail-level">{alert.level.toUpperCase()}</span>
        </div>
        {onClose && (
          <button className="region-detail-close" onClick={onClose} title="닫기">×</button>
        )}
      </div>

      <div className="region-detail-section">
        <div className="region-detail-section-title">Risk Timeline</div>
        {loading ? (
          <div className="empty-state">Loading timeline...</div>
        ) : (
          <TimelineGraph timeline={timeline} />
        )}
      </div>

      <div className="region-detail-section">
        <div className="region-detail-section-title">Signal Breakdown</div>
        <div className="region-detail-signals">
          {Object.entries(alert.signals || {}).map(([key, value]) => {
            const label = SIGNAL_LABELS[key] || key;
            const v = value == null ? null : Number(value);
            return (
              <div className="region-detail-signal-row" key={key}>
                <span className="region-detail-signal-label">{label}</span>
                {v === null ? (
                  <span className="region-detail-signal-disabled">—</span>
                ) : (
                  <>
                    <div className="region-detail-signal-bar">
                      <div
                        className="region-detail-signal-fill"
                        style={{ width: `${v * 100}%`, background: signalColor(v) }}
                      />
                    </div>
                    <span className="region-detail-signal-value">{v.toFixed(2)}</span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {alert.alert_explanation && alert.alert_explanation.length > 0 && (
        <div className="region-detail-section">
          <div className="region-detail-section-title">Alert Explanation</div>
          <ul className="region-detail-explanation">
            {alert.alert_explanation.map((msg: string, i: number) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
