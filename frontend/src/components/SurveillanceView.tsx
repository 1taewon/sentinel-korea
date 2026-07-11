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
    desc: 'V-World 위성영상 위에 냉각탑(위성 판독 좌표)·고위험 시설·위험 히트맵을 얹고, 비식별 역학조사서를 올리면 공통 노출원을 좁혀 조사 우선순위 Hotspot을 제시합니다. 위험도는 환경 오염 경향이며 환자 발생 예측이 아닙니다.',
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
