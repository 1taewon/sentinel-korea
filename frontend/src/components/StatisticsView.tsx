import type { KoreaAlert } from '../types';
import ScoringPanel from './ScoringPanel';

interface StatisticsViewProps {
  koreaAlerts: KoreaAlert[];
  onScoringApply: (config: any) => void;
  onRegionClick: (alert: KoreaAlert) => void;
}

export default function StatisticsView({ koreaAlerts, onScoringApply, onRegionClick }: StatisticsViewProps) {
  const sorted = [...koreaAlerts].sort((a, b) => b.score - a.score);
  const elevatedCount = koreaAlerts.filter((a) => a.score >= 0.55).length;
  const criticalCount = koreaAlerts.filter((a) => a.score >= 0.75).length;
  const avgScore = koreaAlerts.length
    ? (koreaAlerts.reduce((sum, a) => sum + a.score, 0) / koreaAlerts.length).toFixed(2)
    : '0.00';

  return (
    <div className="statistics-view">
      <div className="stats-grid">
        <div className="stats-card stats-card--critical">
          <div className="stats-card-label">위험 (G3)</div>
          <div className="stats-card-value">{criticalCount}</div>
          <div className="stats-card-meta">score ≥ 0.75</div>
        </div>
        <div className="stats-card stats-card--elevated">
          <div className="stats-card-label">경계 (G2)</div>
          <div className="stats-card-value">{elevatedCount - criticalCount}</div>
          <div className="stats-card-meta">0.55 ≤ score &lt; 0.75</div>
        </div>
        <div className="stats-card stats-card--total">
          <div className="stats-card-label">전체 지역</div>
          <div className="stats-card-value">{koreaAlerts.length}</div>
          <div className="stats-card-meta">17 시·도</div>
        </div>
        <div className="stats-card stats-card--avg">
          <div className="stats-card-label">평균 점수</div>
          <div className="stats-card-value">{avgScore}</div>
          <div className="stats-card-meta">composite</div>
        </div>
      </div>

      <div className="stats-two-col">
        <div className="stats-region-list">
          <h3 className="stats-section-title">지역별 위험 순위</h3>
          <div className="stats-region-rows">
            {sorted.map((alert, i) => (
              <button
                key={alert.region_code}
                className={`stats-region-row stats-region-row--${alert.level}`}
                onClick={() => onRegionClick(alert)}
              >
                <span className="stats-region-rank">{i + 1}</span>
                <span className="stats-region-name">{alert.region_name_kr}</span>
                <span className="stats-region-score">{alert.score.toFixed(2)}</span>
                <span className={`stats-region-level stats-region-level--${alert.level}`}>
                  {alert.level.toUpperCase()}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="stats-scoring-panel">
          <h3 className="stats-section-title">가중치 설정</h3>
          <ScoringPanel onApply={onScoringApply} />
        </div>
      </div>
    </div>
  );
}
