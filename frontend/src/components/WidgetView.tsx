import { useState } from 'react';

export default function WidgetView() {
  const [size, setSize] = useState<'small' | 'medium' | 'large'>('medium');
  const sizes = {
    small: { w: 400, h: 300 },
    medium: { w: 800, h: 500 },
    large: { w: 1200, h: 700 },
  };
  const { w, h } = sizes[size];
  const iframeCode = `<iframe src="https://sentinel-korea.vercel.app?embed=1" width="${w}" height="${h}" frameborder="0" allowfullscreen></iframe>`;

  const copyCode = () => {
    navigator.clipboard.writeText(iframeCode);
  };

  return (
    <div className="widget-view">
      <h2 className="widget-title">Sentinel Korea 위젯</h2>
      <p className="widget-desc">
        실시간 대한민국 호흡기 감염병 위험 지도를 여러분의 웹사이트에 임베드하세요.
      </p>

      <div className="widget-size-selector">
        {(['small', 'medium', 'large'] as const).map((s) => (
          <button
            key={s}
            className={`widget-size-btn ${size === s ? 'widget-size-btn--active' : ''}`}
            onClick={() => setSize(s)}
          >
            {s === 'small' ? '소형' : s === 'medium' ? '중형' : '대형'}
            <span className="widget-size-dim">{sizes[s].w}×{sizes[s].h}</span>
          </button>
        ))}
      </div>

      <div className="widget-preview">
        <div className="widget-preview-frame" style={{ width: w, height: h, maxWidth: '100%' }}>
          <div className="widget-preview-placeholder">
            <div className="widget-preview-icon">🛡️</div>
            <div>Sentinel Korea</div>
            <div className="widget-preview-size">{w} × {h} px</div>
          </div>
        </div>
      </div>

      <div className="widget-code-section">
        <div className="widget-code-header">
          <span>임베드 코드</span>
          <button className="widget-code-copy" onClick={copyCode}>복사</button>
        </div>
        <pre className="widget-code-block">{iframeCode}</pre>
      </div>
    </div>
  );
}
