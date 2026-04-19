import { useEffect, useMemo, useState } from 'react';
import type { ScoringConfig } from '../types';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const fallbackConfig: ScoringConfig = {
  signals: {
    notifiable_disease: {
      label: 'Notifiable disease',
      description: 'KDCA reported respiratory notifiable disease activity.',
      source: 'KDCA notifiable disease API',
      enabled: true,
    },
    influenza_like: {
      label: 'ILI/SARI',
      description: 'Weekly influenza-like illness and severe acute respiratory infection surveillance.',
      source: 'KDCA sentinel surveillance',
      enabled: true,
    },
    wastewater_pathogen: {
      label: 'Wastewater pathogen',
      description: 'Regional wastewater respiratory pathogen concentration trend.',
      source: 'KDCA wastewater surveillance',
      enabled: true,
    },
    clinical_cxr_aware: {
      label: 'CXR corroboration',
      description: 'Future aggregate-only hospital corroboration signal from internal AI summaries.',
      source: 'CXR_AWARE phase 3',
      enabled: false,
    },
    news_trends_ai: {
      label: 'News/Trends by AI',
      description: 'AI-analyzed risk signal from news articles and Google Trends data.',
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
  convergence_note: 'Confidence increases when independent respiratory surveillance sources align and data quality remains healthy.',
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
            Scoring focus & advanced settings
          </div>
          <div className="formula-display" style={{ marginTop: '10px' }}>{formulaPreview || 'No signals enabled'}</div>
          <div className="formula-note" style={{ marginTop: '8px', marginBottom: '14px' }}>{config.convergence_note}</div>

          <div className="scoring-section-title" style={{ marginBottom: '8px' }}>Signal weights</div>
          {Object.entries(config.signals).map(([key, signal]) => (
            <div className="weight-row" key={`weight-${key}`}>
              <span className="weight-label" style={{ width: '120px', flexShrink: 0 }}>{signal.label}</span>
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
