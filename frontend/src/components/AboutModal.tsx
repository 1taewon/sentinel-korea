import { useState } from 'react';

interface AboutModalProps {
  open: boolean;
  onClose: () => void;
}

export default function AboutModal({ open, onClose }: AboutModalProps) {
  const [tab, setTab] = useState<'about' | 'data' | 'independence'>('about');

  if (!open) return null;

  return (
    <div className="about-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="about-modal">
        <div className="about-modal-header">
          <div>
            <span className="about-modal-kicker">ABOUT SENTINEL KOREA</span>
            <h2>Sentinel Korea (outbreakmonitor.kr)</h2>
          </div>
          <button className="about-modal-close" onClick={onClose} type="button">&times;</button>
        </div>

        <div className="about-modal-tabs">
          <button className={tab === 'about' ? 'active' : ''} onClick={() => setTab('about')} type="button">About</button>
          <button className={tab === 'data' ? 'active' : ''} onClick={() => setTab('data')} type="button">데이터 출처와 한계</button>
          <button className={tab === 'independence' ? 'active' : ''} onClick={() => setTab('independence')} type="button">독립성 및 면책</button>
        </div>

        <div className="about-modal-body">
          {tab === 'about' && (
            <>
              {/* ── 한 줄 정의 ── */}
              <section>
                <h3>한 줄 정의</h3>
                <p>
                  Sentinel Korea는 개인 자격으로 운영하는 보완적 감염병 신호 통합 플랫폼(complementary signal integration platform)입니다.
                  공개된 다출처 데이터 &mdash; 질병관리청(KDCA) 공식 감시 자료, 해외 보건당국 발표, OSINT(Open-Source Intelligence),
                  검색 트렌드 등 &mdash; 를 정해진 방법론에 따라 통합하여 주간 단위로 위험 신호를 시각화합니다.
                </p>
                <p><strong>본 플랫폼은 공식 감시체계를 대체하지 않으며, 보완(complement)할 뿐입니다.</strong></p>
              </section>

              {/* ── 왜 한 명의 의사가 ── */}
              <section>
                <h3>왜 한 명의 의사가 이런 일을 하는가</h3>
                <p>
                  2020년 코로나19 대유행은 두 가지를 동시에 가르쳐 주었습니다. 첫째, 국가 차원의 공식 감시체계는 위기 대응의 근간이라는 사실.
                  둘째, 그것만으로는 충분하지 않다는 사실입니다.
                </p>
                <p>
                  당시 전 세계 의사결정자와 시민들이 가장 빠르게 의지했던 자원 중 하나는 미국 존스홉킨스대학교 시스템과학공학센터(CSSE)의
                  COVID-19 Dashboard였습니다. WHO나 미국 CDC의 공식 채널이 아니라, 대학 연구자들이 공개 데이터를 통합&middot;시각화한
                  보완적 도구였습니다. HealthMap(하버드 의대), ProMED-mail(국제감염병학회), FluTrackers와 같은 시민&middot;전문가 주도
                  감시 네트워크도 같은 전통 위에 서 있으며, 이들은 이미 수십 년간 공식 시스템보다 먼저 신호를 포착해 온 사례를
                  누적해 왔습니다.
                </p>
                <p>
                  본 플랫폼은 그러한 보완적 감시(complementary surveillance)의 한국판 시도입니다. 의료 현장에서 일하는 한 명의
                  의사로서, 공개된 데이터를 통합적으로 읽어내는 작업이 &mdash; 공식 권한이 아닌 공개 정보에 대한 시민&middot;전문가의
                  알 권리와 분석할 자유에 근거하여 &mdash; 공공의 정보 비대칭을 일부 해소하는 데 기여할 수 있다고 판단했기 때문입니다.
                </p>
              </section>

              {/* ── Interpretive notes의 존재 이유 ── */}
              <section>
                <h3>왜 단순 시각화에서 멈추지 않는가 (Interpretive notes의 존재 이유)</h3>
                <p>
                  본 플랫폼의 주간 리포트에는 &lsquo;Watch points&rsquo; 또는 &lsquo;Author&apos;s interpretive notes&rsquo; 섹션이 포함됩니다.
                  이 부분은 데이터의 수동적 표시(passive display)를 넘어, 관찰된 신호를 어떻게 읽어야 하는지에 대한 운영자의 해석적 메모를 제공합니다.
                </p>
                <p>
                  이러한 해석적 메모를 함께 제공하는 이유는, 감시(surveillance)라는 행위가 본래 데이터의 수집&middot;시각화에서 완성되는 것이 아니라
                  데이터가 의사결정에 유의미하게 번역(translation)될 때 비로소 감시로서 기능하기 때문입니다.
                  시각화만 있고 해석이 없는 대시보드는 보는 사람마다 자의적 결론에 이르기 쉽고, 오히려 위험할 수 있습니다.
                  본 플랫폼은 시민과학 감시의 책임 있는 형태로서 해석의 책임도 명시적으로 진다는 입장입니다.
                  다만 이러한 해석은 어디까지나 공개 정보에 대한 한 명의 의사의 견해이며, 어떠한 공식성도 갖지 않습니다.
                </p>
              </section>

              {/* ── 무엇이 아닌가 (NOT) ── */}
              <section>
                <h3>무엇이 아닌가 (NOT)</h3>
                <p>오해의 여지를 줄이기 위해, 본 플랫폼이 아닌 것을 먼저 분명히 합니다.</p>
                <ul>
                  <li><strong>공식 정부 발표가 아닙니다.</strong> 질병관리청, 보건복지부, 또는 그 어떤 정부&middot;공공 기관의 공식 입장과도 무관합니다.</li>
                  <li><strong>정책 권고가 아닙니다.</strong> 본 플랫폼의 &lsquo;Watch points / interpretive notes&rsquo;는 공개 데이터에 근거한 운영자 개인 및 AI의 해석적 견해이며, 어떠한 행정 행위, 공중보건 조치, 의료기관의 방침, 또는 시민의 행동도 구속하지 않습니다.</li>
                  <li><strong>진료 지침이 아닙니다.</strong> 특정 환자의 진단&middot;치료&middot;검사 결정에 본 플랫폼의 위험 평가를 1차 근거로 사용해서는 안 됩니다.</li>
                  <li><strong>공식 감시 데이터의 대체재가 아닙니다.</strong> 정책 의사결정자, 의료기관, 연구자는 반드시 KDCA의 공식 발표와 감시 데이터를 우선 참조해야 합니다.</li>
                  <li><strong>법정감염병 신고 채널이 아닙니다.</strong> 의심 사례 발견 시 「감염병의 예방 및 관리에 관한 법률」에 따라 관할 보건소에 신고해 주시기 바랍니다.</li>
                </ul>
              </section>

              {/* ── 어떻게 보아야 하는가 ── */}
              <section>
                <h3>어떻게 보아야 하는가 (How to read this)</h3>
                <p>본 플랫폼은 다음과 같이 활용될 때 본래의 목적에 부합합니다.</p>
                <ul>
                  <li><strong>시민:</strong> 일반적 인지(awareness) 차원에서, 현재 어떤 감염병 신호가 국내외에서 관찰되고 있는지 개괄적으로 파악</li>
                  <li><strong>의료진:</strong> 진료 시 환자의 여행력&middot;노출력 청취에 활용할 수 있는 참고 정보로 (단, 진단의 1차 근거가 아닌 보조 정보로서)</li>
                  <li><strong>연구자&middot;언론:</strong> 다출처 신호 통합 분석의 한 사례로서 방법론 검토 및 비판적 참조의 대상으로</li>
                  <li><strong>공공기관:</strong> 공식 감시와 독립적인 외부 시각으로서, 신호 수렴 여부를 교차 점검할 보완 자료로</li>
                </ul>
              </section>
            </>
          )}

          {tab === 'data' && (
            <>
              {/* ── 데이터 출처와 한계 ── */}
              <section>
                <h3>데이터 출처와 한계</h3>
                <div className="about-data-table">
                  <div className="about-data-row about-data-header">
                    <span>데이터 출처</span><span>갱신 주기</span><span>주된 한계</span>
                  </div>
                  <div className="about-data-row">
                    <span>KDCA 감염병 포털</span>
                    <span>주간</span>
                    <span>보고 latency(통상 1&ndash;2주), 무증상&middot;경증 누락</span>
                  </div>
                  <div className="about-data-row">
                    <span>해외 보건당국 발표</span>
                    <span>비정기</span>
                    <span>국가별 보고 기준 상이, 정치적 검열 가능성</span>
                  </div>
                  <div className="about-data-row">
                    <span>OSINT (언론&middot;SNS)</span>
                    <span>실시간</span>
                    <span>검증되지 않은 보도, 과대&middot;과소 보고 편향</span>
                  </div>
                  <div className="about-data-row">
                    <span>검색 트렌드</span>
                    <span>일간</span>
                    <span>실제 발생이 아닌 관심&middot;우려의 반영</span>
                  </div>
                </div>
              </section>

              {/* ── 중요한 구조적 한계 ── */}
              <section>
                <h3>중요한 구조적 한계</h3>
                <ul>
                  <li>본 플랫폼의 위험 등급(G0&ndash;G3)은 자체 분류 체계이며, KDCA의 공식 위기 단계(관심&middot;주의&middot;경계&middot;심각)와 직접 매핑되지 않습니다.</li>
                  <li>일부 주에는 KDCA 공식 데이터가 제공되지 않을 수 있으며, 그러한 경우 본 플랫폼의 신호는 외부 신호에 한정된 부분적 그림임을 보고서에 명시합니다.</li>
                  <li>예측(Forecasting) 섹션이 표시되는 경우, 이는 실험적(experimental) 분석이며 통계적 검증이나 외부 동료 검토를 거치지 않았습니다.</li>
                </ul>
              </section>

              {/* ── Watch points의 성격 ── */}
              <section>
                <h3>해석적 메모(Watch points)의 성격</h3>
                <p>본 플랫폼의 Watch points는 공개된 정보에 대한 한 명의 의사의 해석적 메모입니다. 구체적으로:</p>
                <ul>
                  <li>알고리즘적 신호 통합의 결과 위에 작성자의 의학적 판단이 개입합니다.</li>
                  <li>한 사람의 분석이므로 단일 분석가 편향(single-analyst bias)을 갖습니다.</li>
                  <li>동료 검토(peer review)나 공식 자문위원회의 검증을 거치지 않습니다.</li>
                  <li>따라서 본 메모에 동의하지 않는 다른 전문가의 견해가 존재할 수 있으며, 그러한 견해 다양성은 정상적이고 건강한 것입니다.</li>
                  <li><strong>본 플랫폼의 메모와 공식 채널의 권고가 충돌할 경우, 반드시 공식 채널의 판단을 우선하십시오.</strong></li>
                </ul>
              </section>
            </>
          )}

          {tab === 'independence' && (
            <>
              {/* ── 운영자의 독립성 ── */}
              <section>
                <h3>운영자의 독립성 (Institutional Independence)</h3>
                <p>
                  본 플랫폼의 운영은 운영자 개인의 시간&middot;자원&middot;판단에 전적으로 의존하며, 어떠한 기관과도 운영상&middot;법적&middot;재정적 관계가 없습니다.
                </p>
              </section>

              {/* ── KDCA 및 정부기관과의 관계 ── */}
              <section>
                <h3>질병관리청(KDCA) 및 정부기관과의 관계</h3>
                <p>
                  본 플랫폼은 질병관리청, 보건복지부, 그 산하 기관, 지방자치단체 보건당국과 어떠한 형태의 협력&middot;위탁&middot;자문 관계도 없습니다.
                  본 플랫폼은 KDCA의 공개 감시 데이터를 일반에 공개된 형태로만 활용하며, KDCA의 내부 데이터&middot;미공개 정보&middot;사전 통보에 접근하지 않습니다.
                  본 플랫폼의 모든 견해는 KDCA의 공식 입장과 무관하며, KDCA가 본 플랫폼의 운영을 인지&middot;승인&middot;감독하지 않습니다.
                </p>
              </section>

              {/* ── 소속 의료기관과의 관계 ── */}
              <section>
                <h3>소속 의료기관과의 관계</h3>
                <p>본 플랫폼은 운영자가 소속 의료기관과 완전히 분리된 개인 자격으로 운영하는 것입니다. 구체적으로:</p>
                <ul>
                  <li>본 플랫폼은 소속 병원의 공식 입장&middot;견해&middot;정책을 대표하지 않습니다.</li>
                  <li>본 플랫폼은 운영자의 개인 시간과 비용으로 유지됩니다.</li>
                  <li>소속 병원은 본 플랫폼의 운영에 어떠한 형태로도 관여하지 않으며, 본 플랫폼의 콘텐츠에 대한 법적&middot;도의적 책임을 지지 않습니다.</li>
                </ul>
                <p>
                  운영자의 소속은 약력의 투명한 공개 목적으로만 기재되며, 본 플랫폼의 신뢰성을 보증하는 근거로 사용되어서는 안 됩니다.
                </p>
              </section>

              {/* ── 책임의 한계 ── */}
              <section>
                <h3>책임의 한계</h3>
                <p>
                  본 플랫폼의 모든 콘텐츠는 정보 제공을 목적으로 하며, 데이터의 완전성&middot;정확성&middot;시의성에 관하여 어떠한 명시적 또는 묵시적 보증도 하지 않습니다.
                  본 플랫폼은 무상 공개되며, 어떠한 상업적 이해관계, 광고, 외부 자금 지원 없이 운영자의 개인 시간과 비용으로 유지됩니다.
                  운영자는 본 플랫폼 활동을 통해 직&middot;간접적 금전적 보상을 받지 않습니다.
                </p>
              </section>

              {/* ── 연락처 ── */}
              <section>
                <h3>운영자 연락처</h3>
                <p>
                  운영 관련 문의: <strong>poqwelkjas@naver.com</strong>
                </p>
                <p>
                  Outbreak Scenario를 실제 데이터로 직접 실행하려면 admin 계정이 필요합니다.
                  위 이메일로 소속&middot;용도를 남겨 주시면 계정을 발급해 드립니다.
                  (심사&middot;평가용 열람은 로그인 없이 &ldquo;예시 보기&rdquo;로 가능합니다.)
                </p>
                <p>
                  오류 신고&middot;수정 요청&middot;방법론 비판 환영합니다.
                  본 플랫폼은 공개 데이터를 다루며, 그 분석은 비판과 수정에 열려 있습니다.
                  오류, 누락, 더 나은 방법론에 대한 제안을 적극 환영합니다.
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
