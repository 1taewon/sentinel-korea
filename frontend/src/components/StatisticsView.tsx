import { useState } from 'react';
import type { KoreaAlert } from '../types';
import ScoringPanel from './ScoringPanel';
import RegionDetailInline from './RegionDetailInline';

interface StatisticsViewProps {
  koreaAlerts: KoreaAlert[];
  onScoringApply: (config: any) => void;
  // `onRegionClick` is still exposed so the parent can observe selections,
  // but by default Statistics now shows the detail inline instead of
  // navigating to the map tab.
  onRegionClick?: (alert: KoreaAlert) => void;
}

export default function StatisticsView({ koreaAlerts, onScoringApply, onRegionClick }: StatisticsViewProps) {
  const [selected, setSelected] = useState<KoreaAlert | null>(null);

  const sorted = [...koreaAlerts].sort((a, b) => b.score - a.score);
  const elevatedCount = koreaAlerts.filter((a) => a.score >= 0.55).length;
  const criticalCount = koreaAlerts.filter((a) => a.score >= 0.75).length;
  const avgScore = koreaAlerts.length
    ? (koreaAlerts.reduce((sum, a) => sum + a.score, 0) / koreaAlerts.length).toFixed(2)
    : '0.00';

  const handleRowClick = (alert: KoreaAlert) => {
    setSelected(alert);
    onRegionClick?.(alert);
  };

  return (
    <div className="statistics-view">
      <section className="stats-intro-card">
        <span>Statistics guide</span>
        <h2>지역별 경보 분포와 점수 민감도를 확인하는 화면</h2>
        <p>
          왼쪽 지표는 현재 snapshot에서 G0-G3가 몇 개 지역에 분포하는지 보여주고,
          아래 순위표는 어느 시·도가 상대적으로 더 이상한지 비교합니다. 오른쪽 가중치 설정은
          공식 감시자료, 폐하수, 뉴스/트렌드 같은 신호가 최종 경보에 미치는 영향도를 조정하는 실험 도구입니다.
        </p>
      </section>

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
                className={`stats-region-row stats-region-row--${alert.level} ${selected?.region_code === alert.region_code ? 'stats-region-row--selected' : ''}`}
                onClick={() => handleRowClick(alert)}
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
          <p className="stats-section-copy">
            같은 raw signal이라도 freshness, coverage, baseline 대비 z-score가 반영된 뒤 가중치가 적용됩니다.
            따라서 이 설정은 “어떤 소스를 더 믿을지”가 아니라 “현재 분석에서 어떤 lane의 영향도를 더 크게 볼지”를 조정합니다.
          </p>
          <ScoringPanel onApply={onScoringApply} />
        </div>
      </div>

      {selected && (
        <div className="stats-detail-section">
          <RegionDetailInline
            alert={selected}
            allAlerts={koreaAlerts}
            onClose={() => setSelected(null)}
            variant="inline"
          />
        </div>
      )}
    </div>
  );
}
