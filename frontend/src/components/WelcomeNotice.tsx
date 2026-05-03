import { useState } from 'react';

type WelcomeNoticeProps = {
  onAccept: () => void;
};

export default function WelcomeNotice({ onAccept }: WelcomeNoticeProps) {
  const [koChecked, setKoChecked] = useState(false);
  const [enChecked, setEnChecked] = useState(false);
  const ready = koChecked && enChecked;

  return (
    <div className="welcome-notice" role="dialog" aria-modal="true" aria-labelledby="welcome-notice-title">
      <div className="welcome-notice-panel">
        <div className="welcome-notice-header">
          <div>
            <span className="welcome-notice-kicker">SENTINEL ORIENTATION</span>
            <h1 id="welcome-notice-title">About Sentinel</h1>
          </div>
          <span className="welcome-notice-status">AI-assisted surveillance dashboard</span>
        </div>

        <div className="welcome-notice-grid">
          <section>
            <span className="welcome-notice-section-title">한국어 안내</span>
            <h2>SENTINEL은 무엇인가</h2>
            <p>
              SENTINEL은 호흡기 감염병 위험 신호를 조기에 파악하기 위한 연구 및 감시형 웹 대시보드입니다.
              KDCA API, ILI/SARI 감시, 하수 기반 감시, 국내외 뉴스, 검색 트렌드, 해외 outbreak 신호를 통합해
              지역별 위험 신호, 주간 변화, AI 분석 요약, 보고서, 질병 키워드 ontology를 제공합니다.
            </p>
            <h2>앞으로의 발전 방향</h2>
            <p>
              주간 archive를 축적해 시간 추세, source 간 일치와 불일치, 반복적으로 등장하는 질병 키워드의 중심성을
              분석하는 방향으로 발전합니다. 운영자는 주별 pipeline을 실행하고, 사용자는 최신 및 과거 결과를 읽기 전용으로 확인합니다.
            </p>
            <h2>주의사항</h2>
            <p>
              본 서비스에는 AI가 생성, 요약, 분류한 정보가 포함됩니다. 원자료와 다르거나 누락, 오분류, 잘못된 해석이 있을 수 있습니다.
              SENTINEL은 의학적 진단, 치료, 공식 방역 판단을 대체하지 않으며 연구와 정보 참고 목적으로만 사용해야 합니다.
              중요한 판단에는 KDCA, WHO 및 관련 공식 기관의 원자료를 반드시 확인해 주세요.
            </p>
            <label className="welcome-notice-check">
              <input type="checkbox" checked={koChecked} onChange={(event) => setKoChecked(event.target.checked)} />
              <span>한국어 안내와 주의사항을 확인했습니다.</span>
            </label>
          </section>

          <section>
            <span className="welcome-notice-section-title">English Notice</span>
            <h2>What Sentinel Is</h2>
            <p>
              SENTINEL is a research-oriented web dashboard for early awareness of respiratory infection signals.
              It integrates KDCA API data, ILI/SARI surveillance, wastewater surveillance, domestic and global news,
              search trends, and global outbreak signals to present regional risk signals, weekly changes,
              AI-generated summaries, reports, and disease keyword ontology maps.
            </p>
            <h2>How It Will Evolve</h2>
            <p>
              SENTINEL will accumulate weekly archives to support trend analysis, cross-source agreement checks,
              and ontology-based disease signal maps. Operators run the weekly pipeline; public users inspect the
              latest and historical results in read-only mode.
            </p>
            <h2>Limitations</h2>
            <p>
              This service includes information generated, summarized, or classified by AI. Results may differ from
              source data and may include omissions, errors, or misinterpretations. SENTINEL does not replace medical
              diagnosis, treatment, public health decisions, or official surveillance systems. For critical decisions,
              verify the original sources from KDCA, WHO, and relevant official agencies.
            </p>
            <label className="welcome-notice-check">
              <input type="checkbox" checked={enChecked} onChange={(event) => setEnChecked(event.target.checked)} />
              <span>I have read and understood the English notice and limitations.</span>
            </label>
          </section>
        </div>

        <button className="welcome-notice-enter" type="button" disabled={!ready} onClick={onAccept}>
          Enter Sentinel
        </button>
      </div>
    </div>
  );
}
