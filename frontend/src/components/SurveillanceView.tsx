import { useState } from 'react';
import LegionellaView from './LegionellaView';

// Surveillance Intelligence — a container of surveillance methodologies (Object Types).
// Mirrors the Forecasting tab's "Decision Intelligence" left panel: pick a methodology,
// then enter its tool. New methodologies are added to METHODOLOGIES below.
const METHODOLOGIES = [
  {
    id: 'legionella',
    name: 'Legionella surveillance',
    nameKr: '레지오넬라 위험지도 · 조사 우선순위',
    color: '#22d3ee',
    desc: '역학조사서와 위성영상분석(냉각탑·고위험시설 등)을 바탕으로 AI 기반 역학조사 지원 및 초안을 생성합니다.',
    ready: true,
  },
];

export default function SurveillanceView() {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="ontology-view">
      {/* ── LEFT SIDEBAR: Surveillance Intelligence + Object Types ── */}
      <div className="ontology-sidebar">
        <div className="ontology-sidebar-header">
          <span className="ontology-kicker">SENTINEL SURVEILLANCE</span>
          <h2>Surveillance Intelligence</h2>
          <p>
            방법론(Object Type)을 선택해 해당 감시 도구로 들어갑니다. 새 방법론은 계속 추가됩니다.
          </p>
        </div>

        <div className="ontology-sidebar-section">
          <div className="ontology-pane-title">OBJECT TYPES</div>
          <div className="ontology-type-list">
            {METHODOLOGIES.map((m) => (
              <button key={m.id} type="button"
                className={`ontology-type-card ontology-type-card--featured ${selected === m.id ? 'is-active' : ''}`}
                onClick={() => setSelected(m.id)} style={{ borderLeftColor: m.color }}>
                <div className="ontology-type-card-row">
                  <span className="ontology-type-card-name">{m.name}</span>
                </div>
                <div className="ontology-type-card-kr">{m.nameKr}</div>
                <div className="ontology-type-card-desc">{m.desc}</div>
              </button>
            ))}
            <div className="surveillance-more">다른 방법론 추가 예정</div>
          </div>
        </div>

        {selected === 'legionella' && (
          <div className="surveillance-detail">
            <div className="surveillance-detail-title">방법론 상세</div>
            <p>
              비식별 역학조사서와 위성영상 분석을 결합해 <strong>AI 기반</strong>으로 역학조사를 지원하고
              조사 우선순위·추정 감염경로 초안을 생성합니다.
            </p>

            <div className="surveillance-detail-h">위험 히트맵 — 환경 오염 경향</div>
            <p>
              V-World 위성영상 위에 냉각탑(위성 수동 판독)·목욕장업·고위험 병원을 <strong>PHWR 시설유형별
              검출률</strong>로 가중해 가우시안 KDE로 표출합니다.
            </p>
            <code className="surveillance-formula">risk(x) = Σᵢ wᵢ · exp( −d(x,pᵢ)² / 2σ² )</code>
            <p className="surveillance-detail-note">
              wᵢ = 가중치, pᵢ = 시설 위치, σ = 대역폭. <strong>환경 오염 경향이며 환자 발생 예측이
              아닙니다</strong>(2021 PHWR).
            </p>
            <p className="surveillance-detail-note">
              가중치(시설유형): 온천 0.394 · 찜질방 0.375 · 상급종합 0.35 · 대형목욕탕 0.328 ·
              종합병원 0.263 · 요양병원 0.20 · 냉각탑 0.5.
            </p>

            <div className="surveillance-detail-h">조사 우선순위 Hotspot</div>
            <p>
              업로드된 비식별 조사서를 파싱(G-6 위험요인·Z 감염경로)하고, 발병 전 2~14일 노출 시간창과
              반경 500m에서 공통 노출후보를 찾아 <strong>케이스 수렴</strong>을 우선한 KDE 피크를 조사
              우선순위로 제시합니다.
            </p>
            <code className="surveillance-formula">공통점수 = 케이스수 × 가중 × 근접도</code>
            <p className="surveillance-detail-note">
              Hotspot은 <strong>AI 기반 역학조사 분석으로 도출한 환경조사 우선 대상</strong>이며, 확정
              감염원이 아닙니다 — 채수·배양에서 환자와 동일 병원체가 일치할 때 확정하고, 최종 판단은
              역학조사관이 합니다.
            </p>

            <div className="surveillance-detail-h">참고 · References</div>
            <ul className="surveillance-refs">
              <li>
                냉각탑 = 위성 판독 좌표(공개 등록부 없음, <strong>자동 탐지 아님</strong>). 자동 탐지 참고:
                <em> TowerScout</em> — 항공·위성 영상 기반 냉각탑 탐지 오픈소스(CC BY-NC-SA 4.0), 미국
                레지오넬라 발생 조사 활용.
              </li>
              <li>
                PHWR 가중치 근거: 질병관리청 <em>주간 건강과 질병(PHWR)</em> 2021, 레지오넬라증 환경검사
                결과 분석(시설유형별 검출률).
              </li>
              <li>공개데이터: 목욕장업(행정안전부)·병원정보서비스(건강보험심사평가원)·V-World 위성영상(국토교통부).</li>
            </ul>
          </div>
        )}
      </div>

      {/* ── RIGHT MAIN: selected methodology ── */}
      <div className="ontology-main surveillance-main">
        {selected === 'legionella' ? (
          <LegionellaView />
        ) : (
          <div className="surveillance-empty">
            <div className="surveillance-empty-title">Surveillance Intelligence</div>
            <div className="surveillance-empty-sub">좌측 OBJECT TYPES에서 감시 방법론을 선택하세요.</div>
          </div>
        )}
      </div>
    </div>
  );
}
