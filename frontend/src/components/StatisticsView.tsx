import { useState } from 'react';
import type { KoreaAlert } from '../types';
import KoreaMap from './KoreaMap';
import RegionDetailInline from './RegionDetailInline';
import AberrationPanel from './AberrationPanel';

interface StatisticsViewProps {
  koreaAlerts: KoreaAlert[];
  // `onRegionClick` is still exposed so the parent can observe selections,
  // but by default Statistics now shows the detail inline instead of
  // navigating to the map tab.
  onRegionClick?: (alert: KoreaAlert) => void;
}

export default function StatisticsView({ koreaAlerts, onRegionClick }: StatisticsViewProps) {
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
          위 지표는 현재 snapshot에서 G0-G3가 몇 개 지역에 분포하는지 보여주고, 아래 순위표와
          오른쪽 지도로 어느 시·도가 상대적으로 더 이상한지 나란히 비교합니다.
          (경보 가중치·신호 소스 설정은 PIPELINE 탭 하단으로 이동했습니다.)
        </p>
        <p className="stats-regional-note">
          시/도별 지도 위험도는 하수감시 호흡기 병원체(COVID-19, Influenza) 데이터에 기반합니다. 다른 표본감시 지표(ARI, ILI, SARI)는 전국 수준 종합 신호로만 활용됩니다.
        </p>
        <p className="stats-regional-note">
          아래에는 전수감시 감염병의 <strong>통계적 이상징후 탐지(Farrington Flexible)</strong>도 함께 제공합니다 — 과거 같은 시기의 기저선과 계절성을 반영한 기대범위를 넘어서는 관측값(급증·aberration)을 질환별로 표시합니다.
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

        <div className="stats-mini-map-panel">
          <h3 className="stats-section-title">지역 위험 지도</h3>
          <p className="stats-section-copy">지역을 누르면 상세가 아래에 열립니다.</p>
          <div className="stats-mini-map">
            <KoreaMap koreaAlerts={koreaAlerts} onRegionClick={handleRowClick} activeLayers={['respiratory']} />
          </div>
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

      {/* 전수감시 감염병 통계적 이상징후 탐지 (Farrington Flexible) — 질환별 국가 단위 */}
      <div className="stats-detail-section">
        <AberrationPanel />
      </div>
    </div>
  );
}
