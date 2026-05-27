import { useState } from 'react';

interface AboutModalProps {
  open: boolean;
  onClose: () => void;
}

export default function AboutModal({ open, onClose }: AboutModalProps) {
  const [tab, setTab] = useState<'about' | 'data' | 'limits'>('about');

  if (!open) return null;

  return (
    <div className="about-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="about-modal">
        <div className="about-modal-header">
          <div>
            <span className="about-modal-kicker">ABOUT SENTINEL KOREA</span>
            <h2>Sentinel Korea (outbreakmonitor.kr)</h2>
            <p>한국 호흡기 감염병 조기 경보 시스템</p>
          </div>
          <button className="about-modal-close" onClick={onClose} type="button">×</button>
        </div>

        <div className="about-modal-tabs">
          <button className={tab === 'about' ? 'active' : ''} onClick={() => setTab('about')} type="button">플랫폼 소개</button>
          <button className={tab === 'data' ? 'active' : ''} onClick={() => setTab('data')} type="button">데이터 소스</button>
          <button className={tab === 'limits' ? 'active' : ''} onClick={() => setTab('limits')} type="button">한계 및 면책</button>
        </div>

        <div className="about-modal-body">
          {tab === 'about' && (
            <>
              <section>
                <h3>플랫폼이란?</h3>
                <p>
                  Sentinel Korea는 한국 17개 시·도의 호흡기 감염병 위험 수준을 KDCA 공식 감시자료, 국내 뉴스/검색 트렌드(OSINT),
                  하수감시, WHO/해외 outbreak 신호를 결합하여 시각화하고 주간 AI 분석 보고서를 생성하는 <strong>비공식 독립 감시 도구</strong>입니다.
                </p>
              </section>

              <section>
                <h3>왜 의사가 운영하나?</h3>
                <p>
                  운영자는 현직 의사(호흡기내과 전공)로, 임상 현장에서 느낀 공식 감시 데이터의 시차와 OSINT 신호의 잠재력을
                  결합하면 호흡기 감염병 위험 징후를 더 빠르게 포착할 수 있다는 가설 아래 이 시스템을 개발했습니다.
                  병원 소속이 아닌 개인 프로젝트이며, KDCA 위탁이나 공식 용역이 아닙니다.
                </p>
              </section>

              <section>
                <h3>해석 참고사항</h3>
                <p>
                  각 지역의 위험 수준(G0~G3)은 여러 신호를 가중합산한 composite score이며,
                  확진자 수나 사망자 수를 직접 반영하지 않습니다.
                  뉴스/검색 트렌드는 <strong>증상탐색행동(symptom-seeking behavior)</strong>의 proxy로 해석하며,
                  공식 감시자료와 수렴할 때 설명력이 높아집니다.
                </p>
              </section>

              <section>
                <h3>이것은 아닙니다 (5가지)</h3>
                <ul>
                  <li><strong>공식 감시 시스템이 아닙니다.</strong> KDCA나 보건당국의 공식 발표를 대체하지 않습니다.</li>
                  <li><strong>진단/치료 도구가 아닙니다.</strong> 개인의 건강 상태 판단이나 의료 결정에 사용해서는 안 됩니다.</li>
                  <li><strong>예측 시스템이 아닙니다.</strong> 현 시점 관찰 데이터의 종합이며, 미래를 예측하지 않습니다. (FORECASTING 탭은 BETA 실험입니다.)</li>
                  <li><strong>실시간 시스템이 아닙니다.</strong> 각 데이터 소스의 reporting lag이 다르며 (뉴스 ~실시간, ILI ~1주, SARI ~1~2주, 하수 ~수일), 갱신 주기는 주 1회입니다.</li>
                  <li><strong>개인정보를 수집하지 않습니다.</strong> 이메일 구독 등록 외에 사용자 데이터를 수집·저장하지 않습니다.</li>
                </ul>
              </section>

              <section>
                <h3>어떻게 읽어야 하나?</h3>
                <ul>
                  <li><strong>MAP 탭:</strong> 17개 시·도의 현재 위험 수준을 시각적으로 확인합니다. 색이 진할수록 관심 필요.</li>
                  <li><strong>REPORT 탭:</strong> AI가 생성한 주간 보고서를 읽고, 어떤 지역이 왜 높은지 근거를 확인합니다.</li>
                  <li><strong>PIPELINE 탭:</strong> 데이터 수집 → AI 분석 → 리포트 생성 과정을 추적합니다 (운영자 전용 기능 포함).</li>
                  <li><strong>FORECASTING 탭 (BETA):</strong> EMA/SARIMAX 시험적 예측입니다. 정식 검증 미완료.</li>
                </ul>
              </section>

              <section>
                <h3>운영 독립성</h3>
                <p>
                  Sentinel Korea는 KDCA, 소속 병원, 또는 기타 기관과 무관한 개인 독립 프로젝트입니다.
                  KDCA의 공개 데이터(OpenAPI, 하수감시 PDF)를 활용하되, KDCA의 공식 의견이나 판단을 대리하지 않습니다.
                  모든 분석과 해석은 운영자 개인의 판단이며, KDCA 또는 정부의 입장을 반영하지 않습니다.
                </p>
              </section>
            </>
          )}

          {tab === 'data' && (
            <>
              <section>
                <h3>데이터 소스 및 제한사항</h3>
                <div className="about-data-table">
                  <div className="about-data-row about-data-header">
                    <span>소스</span><span>유형</span><span>주기</span><span>제한</span>
                  </div>
                  <div className="about-data-row">
                    <span>KDCA 하수감시 PDF</span>
                    <span>공식</span>
                    <span>주 1회 수동</span>
                    <span>API 미제공, PDF 수동 업로드 필요. 호흡기 병원체(COVID-19, Influenza)만 포함.</span>
                  </div>
                  <div className="about-data-row">
                    <span>KDCA 전수감시 API</span>
                    <span>공식</span>
                    <span>주 1회 자동</span>
                    <span>법정감염병 전수신고. 시·도별 주간 집계. 최신 주차 1~2주 지연 가능.</span>
                  </div>
                  <div className="about-data-row">
                    <span>KDCA 표본감시 (ILI/ARI/SARI)</span>
                    <span>공식</span>
                    <span>주 1회</span>
                    <span>전국 수준 신호만 활용. 시·도별 분리 불가 (KDCA 확인).</span>
                  </div>
                  <div className="about-data-row">
                    <span>국내 뉴스 (Naver/NewsAPI)</span>
                    <span>OSINT</span>
                    <span>수동/일간</span>
                    <span>키워드 기반 수집. 오보·과잉보도 포함 가능. 공식 자료와 교차 확인 필요.</span>
                  </div>
                  <div className="about-data-row">
                    <span>Google Trends</span>
                    <span>OSINT</span>
                    <span>수동/일간</span>
                    <span>상대 검색량(0~100). 절대 수치 아님. 지역별 정밀도 낮음.</span>
                  </div>
                  <div className="about-data-row">
                    <span>WHO DON / CDC / ECDC</span>
                    <span>국제 공식</span>
                    <span>부정기</span>
                    <span>해외 outbreak 맥락. 한국 직접 관련성은 scoring으로 필터링.</span>
                  </div>
                  <div className="about-data-row">
                    <span>HealthMap / Google News</span>
                    <span>국제 OSINT</span>
                    <span>자동</span>
                    <span>비공식 해외 보도. 검증 수준 다양. 보조 맥락으로만 활용.</span>
                  </div>
                </div>
              </section>

              <section>
                <h3>구조적 한계</h3>
                <ul>
                  <li><strong>시점 정합성:</strong> 각 신호의 reporting lag이 다릅니다. Composite score가 정확히 "언제"의 상황인지 명확하지 않을 수 있습니다.</li>
                  <li><strong>지역별 해상도:</strong> 시·도별 위험도는 현재 하수감시 데이터에 크게 의존합니다. 표본감시(ILI/ARI/SARI)는 전국 수준만 반영됩니다.</li>
                  <li><strong>AI 분석 한계:</strong> Gemini AI가 생성하는 보고서는 hallucination 가능성이 있으며, 전문가 검토를 대체하지 않습니다.</li>
                  <li><strong>데이터 갱신:</strong> 주 1회 갱신 주기로, 급격한 상황 변화를 실시간으로 반영하지 못합니다.</li>
                </ul>
              </section>
            </>
          )}

          {tab === 'limits' && (
            <>
              <section>
                <h3>Watch Point의 본질</h3>
                <p>
                  Sentinel Korea가 표시하는 위험 수준(G0~G3)은 "이 지역을 주시할 필요가 있다"는 <strong>관심 신호(watch point)</strong>이지,
                  "이 지역에서 유행이 발생했다"는 확정 판단이 아닙니다.
                  G2/G3으로 올라간 지역이 실제로는 데이터 보고 지연이나 일시적 뉴스 급증 때문일 수 있습니다.
                  반드시 원천 자료와 공식 발표를 교차 확인하세요.
                </p>
              </section>

              <section>
                <h3>면책 조항 (Disclaimer)</h3>
                <p>
                  Sentinel Korea는 호흡기 감염병 상황에 대한 <strong>보조적 참고 자료</strong>로만 제공됩니다.
                </p>
                <ul>
                  <li>본 플랫폼의 정보를 근거로 한 어떠한 의사결정(의료, 정책, 개인 행동)에 대해 운영자는 책임을 지지 않습니다.</li>
                  <li>데이터의 정확성, 완전성, 적시성을 보장하지 않습니다.</li>
                  <li>AI 생성 보고서는 참고용이며, 전문가의 판단을 대체하지 않습니다.</li>
                  <li>공식적인 감염병 정보는 KDCA (질병관리청) 및 WHO의 공식 발표를 확인하세요.</li>
                </ul>
              </section>

              <section>
                <h3>연락처</h3>
                <p>
                  운영 관련 문의: 플랫폼 내 OPERATOR LOGIN으로 접속하거나,
                  outbreakmonitor.kr을 통해 연락해주세요.
                </p>
                <p className="about-version">
                  Version: Sentinel Korea v2.0 (2026)
                </p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
