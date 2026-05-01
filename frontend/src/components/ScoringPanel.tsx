import { useEffect, useMemo, useState } from 'react';
import type { ScoringConfig } from '../types';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const fallbackConfig: ScoringConfig = {
  signals: {
    notifiable_disease: {
      label: '법정감염병 신고',
      description: '질병관리청 법정감염병 신고 자료에서 호흡기 관련 이상 증가를 확인합니다.',
      source: 'KDCA notifiable disease API',
      enabled: true,
    },
    influenza_like: {
      label: 'ILI/SARI 표본감시',
      description: '인플루엔자 의사환자와 중증급성호흡기감염증 주간 표본감시 흐름을 반영합니다.',
      source: 'KDCA sentinel surveillance reports',
      enabled: true,
    },
    wastewater_pathogen: {
      label: '폐하수 병원체',
      description: '폐하수 감시에서 호흡기 병원체 농도 변화가 공식 감시자료를 보강하는지 봅니다.',
      source: 'KDCA wastewater surveillance',
      enabled: true,
    },
    clinical_cxr_aware: {
      label: 'CXR 집계 보조',
      description: '향후 병원 내부 AI가 산출한 집계형 폐렴 burden 지표만 보조 신호로 받는 레이어입니다.',
      source: 'CXR_AWARE phase 3',
      enabled: false,
    },
    news_trends_ai: {
      label: '뉴스/트렌드 AI 분석',
      description: '국내 뉴스와 검색 행동에서 공식 감시보다 빠르게 나타나는 보조 경고신호를 해석합니다.',
      source: 'Gemini AI analysis',
      enabled: true,
    },
  },
  weights: {
    notifiable_disease: 0.40,
    influenza_like: 0.35,
    wastewater_pathogen: 0.25,
    clinical_cxr_aware: 0,
    news_trends_ai: 0.20,
  },
  active_threshold: 0.55,
  level_thresholds: {
    G3: 0.75,
    G2: 0.55,
    G1: 0.3,
    G0: 0,
  },
  formula: 'quality_adjusted_signal = normalized_score x freshness_penalty x coverage_penalty; composite = sum(weight_i x quality_adjusted_signal_i)',
  convergence_note: '신뢰도는 단순 source 개수보다 독립적인 감시 신호가 같은 방향으로 움직이고 freshness/coverage가 충분할 때 올라갑니다.',
};

type Props = {
  onApply: (config: ScoringConfig) => void;
};

export default function ScoringPanel({ onApply }: Props) {
  const [config, setConfig] = useState<ScoringConfig>(fallbackConfig);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res = await fetch(`${API_BASE}/scoring/config`);
        const data: ScoringConfig = await res.json();
        setConfig(data);
      } catch {
        setConfig(fallbackConfig);
      }
    };
    fetchConfig();
  }, []);

  const enabledSignals = useMemo(
    () => Object.entries(config.signals).filter(([, signal]) => signal.enabled),
    [config],
  );

  const formulaPreview = enabledSignals
    .map(([key, signal]) => `${config.weights[key]?.toFixed(2) || '0.00'} x ${signal.label}`)
    .join(' + ');

  const handleWeightChange = (key: string, value: number) => {
    setConfig((prev) => ({ ...prev, weights: { ...prev.weights, [key]: value } }));
  };

  const handleToggleSignal = (key: string) => {
    setConfig((prev) => ({
      ...prev,
      signals: {
        ...prev.signals,
        [key]: { ...prev.signals[key], enabled: !prev.signals[key].enabled },
      },
    }));
  };

  const handleApply = async () => {
    setLoading(true);
    try {
      await fetch(`${API_BASE}/scoring/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
    } catch {
      // Fallback to client-side state if the API is unavailable.
    }
    onApply(config);
    setLoading(false);
  };

  return (
    <div className="sidebar-content">
      <section className="scoring-section">
        <div className="scoring-details">
          <div className="scoring-section-title" style={{ userSelect: 'none' }}>
            경보 점수 계산 방식
          </div>
          <div className="formula-display" style={{ marginTop: '10px' }}>{formulaPreview || 'No signals enabled'}</div>
          <div className="formula-note" style={{ marginTop: '8px', marginBottom: '14px' }}>{config.convergence_note}</div>

          <div className="scoring-section-title" style={{ marginBottom: '8px' }}>Signal weights</div>
          <p className="scoring-helper-text">
            가중치는 각 데이터 lane이 composite alert에 얼마나 크게 반영되는지 정하는 값입니다.
            공식 감시자료는 기준선을 만들고, 뉴스/트렌드와 폐하수는 보조 근거로 점수를 보강합니다.
          </p>
          {Object.entries(config.signals).map(([key, signal]) => (
            <div className="weight-row" key={`weight-${key}`}>
              <span className="weight-label">{signal.label}</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                className="weight-slider"
                value={config.weights[key] || 0}
                onChange={(event) => handleWeightChange(key, parseFloat(event.target.value))}
              />
              <span className="weight-value">{(config.weights[key] || 0).toFixed(2)}</span>
            </div>
          ))}

          <div className="scoring-section-title" style={{ marginTop: '16px', marginBottom: '8px' }}>Thresholds</div>
          <p className="scoring-helper-text">
            Threshold는 종합점수를 G0-G3 단계로 나누는 절단값입니다.
            값을 낮추면 민감도는 올라가지만 false alert가 늘 수 있고, 값을 높이면 더 보수적으로 경보가 뜹니다.
          </p>
          <div className="threshold-row">
            <span className="threshold-label" style={{ flex: 1 }}>Active source threshold</span>
            <input
              type="number"
              min="0"
              max="1"
              step="0.05"
              className="threshold-input"
              value={config.active_threshold}
              onChange={(event) => setConfig((prev) => ({ ...prev, active_threshold: parseFloat(event.target.value) }))}
            />
          </div>
          {(['G3', 'G2', 'G1', 'G0'] as const).map((level) => (
            <div className="threshold-row" key={`thresh-${level}`}>
              <span className="threshold-label" style={{ flex: 1 }}>{level}</span>
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                className="threshold-input"
                value={config.level_thresholds[level]}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    level_thresholds: {
                      ...prev.level_thresholds,
                      [level]: parseFloat(event.target.value),
                    },
                  }))
                }
              />
            </div>
          ))}
        </div>
      </section>

      <section className="scoring-section">
        <div className="scoring-section-title">Signal sources</div>
        <p className="scoring-helper-text">
          체크를 끄면 해당 source는 이번 계산에서 제외됩니다. 데이터 품질이 낮거나 수집이 지연된 lane을 임시로 분리할 때 사용합니다.
        </p>
        {Object.entries(config.signals).map(([key, signal]) => (
          <div className="signal-toggle-row" key={key}>
            <div className="signal-toggle-info">
              <div className="signal-toggle-name">{signal.label}</div>
              <div className="signal-toggle-desc">{signal.description}</div>
              <div className="signal-toggle-source">{signal.source}</div>
            </div>
            <label className="toggle-switch">
              <input type="checkbox" checked={signal.enabled} onChange={() => handleToggleSignal(key)} />
              <span className="toggle-slider" />
            </label>
          </div>
        ))}
      </section>

      <section className="scoring-section">
        <button className="apply-btn" onClick={handleApply} disabled={loading}>
          {loading ? 'Applying...' : 'Apply and re-score'}
        </button>
      </section>
    </div>
  );
}
