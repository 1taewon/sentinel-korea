const pptxgen = require("pptxgenjs");

const pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
pres.title = "Sentinel Korea MVP Demo";

// Color palette
const C = {
  bg: "0B1120",          // deep navy bg
  bg2: "141D2E",         // card bg
  bg3: "1C2840",         // lighter card
  cyan: "38BDF8",        // primary accent
  blue: "6B8AFF",        // secondary accent
  purple: "A78BFA",      // trends
  green: "34D399",       // kdca
  orange: "F97316",      // ai/gemini
  amber: "F59E0B",       // warning
  white: "F0F4FF",
  muted: "64748B",
  red: "EF4444",
};

const makeShadow = () => ({ type: "outer", blur: 8, offset: 3, angle: 135, color: "000000", opacity: 0.3 });

// ─────────────────────────────────────────────
// SLIDE 1 — TITLE
// ─────────────────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  // Top accent line
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06, fill: { color: C.cyan } });

  // Faint grid lines background decoration
  for (let i = 0; i < 6; i++) {
    s.addShape(pres.shapes.LINE, {
      x: 0, y: 1.0 + i * 0.8, w: 10, h: 0,
      line: { color: "1E2D42", width: 0.5 }
    });
  }

  // Signal wave decoration (circles)
  for (let i = 0; i < 4; i++) {
    s.addShape(pres.shapes.OVAL, {
      x: 7.5 - i * 0.4, y: 1.2 - i * 0.4, w: 1.5 + i * 0.8, h: 1.5 + i * 0.8,
      fill: { color: C.cyan, transparency: 92 - i * 15 },
      line: { color: C.cyan, width: 0.5, transparency: 60 }
    });
  }

  // SENTINEL badge
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.6, y: 1.5, w: 1.4, h: 0.35,
    fill: { color: C.cyan, transparency: 85 },
    line: { color: C.cyan, width: 1 }
  });
  s.addText("SENTINEL", {
    x: 0.6, y: 1.5, w: 1.4, h: 0.35,
    fontSize: 9, bold: true, color: C.cyan, align: "center", valign: "middle",
    charSpacing: 3, margin: 0
  });

  // Main title
  s.addText("SENTINEL KOREA", {
    x: 0.6, y: 1.95, w: 8.5, h: 1.1,
    fontSize: 54, bold: true, color: C.white, fontFace: "Arial Black",
    charSpacing: 4, margin: 0
  });

  // Cyan underline
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.6, y: 3.0, w: 4.2, h: 0.05, fill: { color: C.cyan }
  });

  // Subtitle
  s.addText("AI 기반 다중소스 감염병 조기경보 플랫폼", {
    x: 0.6, y: 3.15, w: 8.5, h: 0.55,
    fontSize: 18, color: C.white, fontFace: "Arial", margin: 0
  });

  // Tagline
  s.addText('"다음 팬데믹을 몇 주 더 빨리 감지합니다"', {
    x: 0.6, y: 3.8, w: 8.5, h: 0.45,
    fontSize: 14, italic: true, color: C.cyan, fontFace: "Arial", margin: 0
  });

  // Bottom bar
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 5.2, w: 10, h: 0.425, fill: { color: "0D1525" } });
  s.addText("MVP Demo  ·  2026  ·  FastAPI + React + Gemini AI", {
    x: 0.6, y: 5.2, w: 8.8, h: 0.425,
    fontSize: 10, color: C.muted, align: "left", valign: "middle", margin: 0
  });
  // Three dots
  ["38BDF8", "6B8AFF", "34D399"].forEach((col, i) => {
    s.addShape(pres.shapes.OVAL, {
      x: 8.8 + i * 0.25, y: 5.36, w: 0.12, h: 0.12, fill: { color: col }
    });
  });
}

// ─────────────────────────────────────────────
// SLIDE 2 — PROBLEM
// ─────────────────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06, fill: { color: C.red } });

  // Title
  s.addText("문제: 감시체계의 구조적 한계", {
    x: 0.5, y: 0.2, w: 9, h: 0.65,
    fontSize: 28, bold: true, color: C.white, fontFace: "Arial", margin: 0
  });

  // Three problem cards
  const cards = [
    { icon: "⏱", title: "보고 지연", sub: "공식 신고체계", body: "의료기관 신고 → 집계 → 공개까지\n최소 1~2주 시차 발생\n\n유행 초기 골든타임 상실", color: C.red },
    { icon: "🔗", title: "데이터 분절", sub: "통합 판단 불가", body: "뉴스·트렌드·KDCA 감시데이터가\n각기 다른 시스템에 산재\n\n통합적 위험 판단 불가", color: C.amber },
    { icon: "🗺️", title: "지역 경보 부재", sub: "전국 단위만 존재", body: "17개 시도별 실시간\n위험도 평가 체계 부재\n\n맞춤형 지역 대응 불가", color: C.purple },
  ];

  cards.forEach((c, i) => {
    const x = 0.4 + i * 3.1;
    // Card bg
    s.addShape(pres.shapes.RECTANGLE, {
      x, y: 0.95, w: 2.9, h: 3.2,
      fill: { color: C.bg2 }, line: { color: c.color, width: 1.5 },
      shadow: makeShadow()
    });
    // Top accent
    s.addShape(pres.shapes.RECTANGLE, { x, y: 0.95, w: 2.9, h: 0.08, fill: { color: c.color } });
    // Icon
    s.addText(c.icon, { x, y: 1.1, w: 2.9, h: 0.6, fontSize: 28, align: "center", margin: 0 });
    // Title
    s.addText(c.title, {
      x, y: 1.72, w: 2.9, h: 0.42,
      fontSize: 16, bold: true, color: c.color, align: "center", margin: 0
    });
    // Subtitle
    s.addShape(pres.shapes.RECTANGLE, {
      x: x + 0.7, y: 2.18, w: 1.5, h: 0.26,
      fill: { color: c.color, transparency: 82 }, line: { color: c.color, width: 0.5 }
    });
    s.addText(c.sub, {
      x: x + 0.7, y: 2.18, w: 1.5, h: 0.26,
      fontSize: 9, color: c.color, align: "center", valign: "middle", margin: 0
    });
    // Body
    s.addText(c.body, {
      x: x + 0.15, y: 2.52, w: 2.6, h: 1.55,
      fontSize: 11, color: "94A3B8", align: "left", valign: "top", margin: 0
    });
  });

  // Bottom quote
  s.addShape(pres.shapes.RECTANGLE, {
    x: 1.0, y: 4.3, w: 8.0, h: 0.75,
    fill: { color: C.bg2 }, line: { color: C.cyan, width: 1 }
  });
  s.addShape(pres.shapes.RECTANGLE, { x: 1.0, y: 4.3, w: 0.08, h: 0.75, fill: { color: C.cyan } });
  s.addText('"근본적인 문제는 데이터의 부족이 아니라, 통합의 부재입니다."', {
    x: 1.2, y: 4.3, w: 7.7, h: 0.75,
    fontSize: 14, italic: true, color: C.cyan, align: "left", valign: "middle", margin: 0
  });
}

// ─────────────────────────────────────────────
// SLIDE 3 — SOLUTION ARCHITECTURE
// ─────────────────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06, fill: { color: C.cyan } });

  s.addText("해결책: Sentinel Korea 아키텍처", {
    x: 0.5, y: 0.15, w: 9, h: 0.55,
    fontSize: 24, bold: true, color: C.white, fontFace: "Arial", margin: 0
  });

  // 3 columns
  const cols = [
    { label: "NEWS", color: C.cyan, x: 0.25,
      sources: "Naver News\nNewsAPI\nWHO DON",
      refresh: "NEWS Refresh",
      digest: "News Digest (Gemini AI)",
      panel: "NEWS Panel" },
    { label: "TRENDS", color: C.purple, x: 3.52,
      sources: "Google Trends\nNaver Trends",
      refresh: "TRENDS Refresh",
      digest: "Trends Digest (Gemini AI)",
      panel: "TRENDS Panel" },
    { label: "KDCA", color: C.green, x: 6.78,
      sources: "KDCA Data\n(ILI/SARI/Wastewater)",
      refresh: "Data Upload",
      digest: "KDCA Digest (Gemini AI)",
      panel: "KDCA Panel" },
  ];

  const rowY = [0.82, 1.6, 2.38, 3.12];
  const rowLabels = ["DATA SOURCES", "REFRESH", "AI DIGEST", "DISPLAY"];

  // Row labels (left-aligned)
  rowLabels.forEach((lbl, i) => {
    s.addText(lbl, {
      x: 0.0, y: rowY[i], w: 0.25, h: 0.55,
      fontSize: 6, bold: true, color: C.muted, align: "center", valign: "top", margin: 0
    });
  });

  cols.forEach((col) => {
    const w = 2.9;
    // Column header
    s.addShape(pres.shapes.RECTANGLE, {
      x: col.x, y: 0.75, w, h: 0.28,
      fill: { color: col.color, transparency: 80 }, line: { color: col.color, width: 1 }
    });
    s.addText(col.label, {
      x: col.x, y: 0.75, w, h: 0.28,
      fontSize: 10, bold: true, color: col.color, align: "center", valign: "middle", margin: 0, charSpacing: 2
    });

    // Sources box
    s.addShape(pres.shapes.RECTANGLE, {
      x: col.x, y: rowY[0], w, h: 0.55,
      fill: { color: C.bg3 }, line: { color: col.color, width: 0.8 }
    });
    s.addText(col.sources, {
      x: col.x + 0.05, y: rowY[0], w: w - 0.1, h: 0.55,
      fontSize: 9, color: col.color, align: "center", valign: "middle", margin: 0
    });

    // Arrow down
    s.addShape(pres.shapes.LINE, {
      x: col.x + w / 2, y: rowY[0] + 0.55, w: 0, h: 0.12,
      line: { color: col.color, width: 1.5 }
    });

    // Refresh box
    s.addShape(pres.shapes.RECTANGLE, {
      x: col.x, y: rowY[1], w, h: 0.55,
      fill: { color: C.bg2 }, line: { color: col.color, width: 1.5 }
    });
    s.addText(col.refresh, {
      x: col.x + 0.05, y: rowY[1], w: w - 0.1, h: 0.55,
      fontSize: 10, bold: true, color: col.color, align: "center", valign: "middle", margin: 0
    });

    // Arrow down
    s.addShape(pres.shapes.LINE, {
      x: col.x + w / 2, y: rowY[1] + 0.55, w: 0, h: 0.12,
      line: { color: C.orange, width: 1.5 }
    });

    // Digest box
    s.addShape(pres.shapes.RECTANGLE, {
      x: col.x, y: rowY[2], w, h: 0.55,
      fill: { color: C.bg2 }, line: { color: C.orange, width: 1.5 }
    });
    s.addText(col.digest, {
      x: col.x + 0.05, y: rowY[2], w: w - 0.1, h: 0.55,
      fontSize: 9.5, bold: true, color: C.orange, align: "center", valign: "middle", margin: 0
    });

    // Arrow down
    s.addShape(pres.shapes.LINE, {
      x: col.x + w / 2, y: rowY[2] + 0.55, w: 0, h: 0.12,
      line: { color: C.muted, width: 1 }
    });

    // Panel display box
    s.addShape(pres.shapes.RECTANGLE, {
      x: col.x, y: rowY[3], w, h: 0.48,
      fill: { color: "1A2540" }, line: { color: "334155", width: 1 }
    });
    s.addText(col.panel, {
      x: col.x + 0.05, y: rowY[3], w: w - 0.1, h: 0.48,
      fontSize: 10, color: "CBD5E1", align: "center", valign: "middle", margin: 0
    });
  });

  // Convergence arrows from panels to OSINT
  // NEWS + TRENDS → OSINT
  s.addShape(pres.shapes.LINE, {
    x: 0.25 + 2.9 / 2, y: rowY[3] + 0.48, w: 0, h: 0.28,
    line: { color: C.blue, width: 1.5 }
  });
  s.addShape(pres.shapes.LINE, {
    x: 3.52 + 2.9 / 2, y: rowY[3] + 0.48, w: 0, h: 0.28,
    line: { color: C.blue, width: 1.5 }
  });

  // OSINT box
  s.addShape(pres.shapes.RECTANGLE, {
    x: 1.2, y: 3.88, w: 4.0, h: 0.45,
    fill: { color: C.bg2 }, line: { color: C.blue, width: 2 }, shadow: makeShadow()
  });
  s.addText("OSINT Analysis  (NEWS + TRENDS)", {
    x: 1.2, y: 3.88, w: 4.0, h: 0.45,
    fontSize: 11, bold: true, color: C.blue, align: "center", valign: "middle", margin: 0
  });

  // KDCA panel → SENTINEL
  s.addShape(pres.shapes.LINE, {
    x: 6.78 + 2.9 / 2, y: rowY[3] + 0.48, w: 0, h: 0.65,
    line: { color: C.green, width: 1.5 }
  });
  // OSINT → SENTINEL
  s.addShape(pres.shapes.LINE, {
    x: 3.2, y: 4.33, w: 0, h: 0.35,
    line: { color: C.cyan, width: 1.5 }
  });

  // SENTINEL box
  s.addShape(pres.shapes.RECTANGLE, {
    x: 1.5, y: 4.68, w: 7.0, h: 0.5,
    fill: { color: "0A1628" }, line: { color: C.cyan, width: 2.5 }, shadow: makeShadow()
  });
  s.addText("⚡  SENTINEL ANALYSIS  (OSINT + KDCA 통합)", {
    x: 1.5, y: 4.68, w: 7.0, h: 0.5,
    fontSize: 13, bold: true, color: C.cyan, align: "center", valign: "middle", margin: 0
  });

  // Final report
  s.addShape(pres.shapes.LINE, { x: 5, y: 5.18, w: 0, h: 0.2, line: { color: C.cyan, width: 1.5 } });
  s.addText("Final Report  +  Korea Map Visualization", {
    x: 2.5, y: 5.38, w: 5.0, h: 0.26,
    fontSize: 9, color: "64748B", align: "center", margin: 0
  });
}

// ─────────────────────────────────────────────
// SLIDE 4 — Dashboard & Settings
// ─────────────────────────────────────────────
function demoSlide(pres, num, title, bullets, screenshotLabel) {
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06, fill: { color: C.cyan } });

  // Slide number badge
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.5, y: 0.2, w: 0.55, h: 0.55,
    fill: { color: C.cyan, transparency: 80 }, line: { color: C.cyan, width: 1.5 }
  });
  s.addText(num, {
    x: 0.5, y: 0.2, w: 0.55, h: 0.55,
    fontSize: 16, bold: true, color: C.cyan, align: "center", valign: "middle", margin: 0
  });

  // Title
  s.addText(title, {
    x: 1.2, y: 0.22, w: 8.3, h: 0.52,
    fontSize: 20, bold: true, color: C.white, fontFace: "Arial", margin: 0
  });

  // Divider
  s.addShape(pres.shapes.LINE, { x: 0.5, y: 0.82, w: 9, h: 0, line: { color: "1E2D42", width: 1 } });

  // Left: bullet list
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.4, y: 0.92, w: 4.1, h: 4.35,
    fill: { color: C.bg2 }, line: { color: "1E3A5F", width: 1 }
  });

  const bulletItems = bullets.map((b, i) => {
    const items = [];
    if (b.startsWith("  ")) {
      items.push({ text: b.trim(), options: { bullet: true, indentLevel: 1, fontSize: 11, color: "94A3B8", breakLine: i < bullets.length - 1 } });
    } else {
      items.push({ text: b, options: { bullet: true, fontSize: 12, color: C.white, breakLine: i < bullets.length - 1 } });
    }
    return items[0];
  });

  s.addText(bulletItems, {
    x: 0.55, y: 0.98, w: 3.85, h: 4.2,
    paraSpaceAfter: 4, margin: 0
  });

  // Right: screenshot placeholder
  s.addShape(pres.shapes.RECTANGLE, {
    x: 4.7, y: 0.92, w: 4.85, h: 4.35,
    fill: { color: "0D1525" }, line: { color: "1E3A5F", width: 1 }
  });

  // Corner brackets for screenshot frame
  const bw = 0.3;
  [
    [4.7, 0.92], [4.7 + 4.85 - bw, 0.92],
    [4.7, 0.92 + 4.35 - bw], [4.7 + 4.85 - bw, 0.92 + 4.35 - bw]
  ].forEach(([x, y]) => {
    s.addShape(pres.shapes.RECTANGLE, { x, y, w: bw, h: 0.04, fill: { color: C.cyan } });
    s.addShape(pres.shapes.RECTANGLE, { x, y, w: 0.04, h: bw, fill: { color: C.cyan } });
    s.addShape(pres.shapes.RECTANGLE, { x: x + bw - 0.04, y: y + bw - 0.04, w: 0.04, h: bw - 0.04, fill: { color: C.cyan } });
    s.addShape(pres.shapes.RECTANGLE, { x: x + bw - 0.04, y: y + bw - 0.04, w: bw - 0.04, h: 0.04, fill: { color: C.cyan } });
  });

  s.addText(screenshotLabel, {
    x: 4.7, y: 2.7, w: 4.85, h: 0.85,
    fontSize: 11, color: "334155", align: "center", valign: "middle", margin: 0
  });
  s.addText("[ 실제 MVP 화면 ]", {
    x: 4.7, y: 3.3, w: 4.85, h: 0.5,
    fontSize: 13, bold: true, color: "1E3A5F", align: "center", margin: 0
  });

  return s;
}

demoSlide(pres, "①", "MVP 화면 ①  —  메인 대시보드 (Settings)", [
  "3개 탭 구조: Settings / OSINT / Data Upload",
  "KDCA 신호 소스별 가중치 직접 설정",
  "  Notifiable disease: 0.40",
  "  ILI/SARI: 0.35",
  "  Wastewater pathogen: 0.25",
  "G0~G3 경보 임계값 커스터마이징",
  "17개 시도 Korea Map 실시간 시각화",
  "상단 현황: 17 Regions / Elevated / Critical",
  "Sentinel Analysis 버튼으로 통합 분석 즉시 실행",
], "스크린샷: 메인 대시보드\n(Settings 탭)");

demoSlide(pres, "②", "MVP 화면 ②  —  NEWS OSINT AI Digest", [
  "3개 소스 통합 수집: Naver News + NewsAPI + WHO DON",
  "Gemini AI가 자동 분석 후 즉시 표시",
  "Korea 요약 + Global 요약 분리 표시",
  "Risk Assessment 자동 생성",
  "Key Alerts (심각도별: High / Medium / Low)",
  "\"View Raw Sources\" 토글로 원본 뉴스 확인",
  "Refresh 버튼으로 실시간 재수집·재분석",
], "스크린샷: OSINT 탭\nNews AI Digest");

demoSlide(pres, "③", "MVP 화면 ③  —  KDCA 공식 감시데이터 AI Digest", [
  "KDCA 공식 데이터 Excel/CSV 직접 업로드",
  "Gemini AI 즉시 분석:",
  "  KDCA Summary (종합 분석)",
  "  Risk Assessment",
  "  Regional Highlights (지역별 주요 발견)",
  "  Key Indicators (핵심 지표 추세)",
  "\"View Raw Data\" 토글로 업로드 이력 확인",
  "주간 AI 보고서 자동 생성 → 이메일 자동 발송",
  "추후 KDCA API 실시간 연동으로 확장 예정",
], "스크린샷: Data Upload 탭\nKDCA AI Digest");

demoSlide(pres, "④", "MVP 화면 ④  —  Pipeline Control (파이프라인 제어)", [
  "전체 분석 파이프라인 인터랙티브 시각화",
  "3-Column 구조: NEWS | TRENDS | KDCA",
  "각 노드 클릭 → 상태 확인 + 즉시 실행",
  "실시간 상태: Idle / Running / Done / Error",
  "NEWS Refresh → News Digest 자동 연결",
  "TRENDS Refresh → Trends Digest 자동 연결",
  "KDCA Digest 독립 실행 가능",
  "OSINT Analysis: NEWS+TRENDS 통합",
  "SENTINEL ANALYSIS: 전체 통합 최종 분석",
], "스크린샷: Pipeline Control\n3-Column 다이어그램");

demoSlide(pres, "⑤", "MVP 화면 ⑤  —  Sentinel Chat (AI 대화형 분석)", [
  "Gemini AI 기반 대화형 분석 도우미",
  "Quick Actions: Dashboard Analysis / News Summary",
  "Weekly Report 자동 생성 요청 가능",
  "현재 감시 데이터 기반 즉시 답변",
  "보고서 작성 · 상황 해석 · 위험 판단 지원",
  "한국어 완전 지원",
], "스크린샷: Sentinel Chat\n인터페이스");

// ─────────────────────────────────────────────
// SLIDE 9 — ROADMAP
// ─────────────────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06, fill: { color: C.cyan } });

  s.addText("로드맵 및 확장 계획", {
    x: 0.5, y: 0.18, w: 9, h: 0.55,
    fontSize: 26, bold: true, color: C.white, fontFace: "Arial", margin: 0
  });

  // Timeline connector
  s.addShape(pres.shapes.LINE, { x: 1.5, y: 2.35, w: 7.0, h: 0, line: { color: "1E3A5F", width: 3 } });

  const phases = [
    {
      num: "01", label: "Phase 1", status: "✅ MVP 완성", color: C.cyan, x: 0.35,
      items: ["Korea Deep Layer\n(KDCA + 하수감시 + ILI)", "NEWS/TRENDS OSINT 통합", "AI Digest 3개 파이프라인\n(Gemini)", "17개 시도 Korea Map", "Sentinel Chat", "자동 주간 보고서"]
    },
    {
      num: "02", label: "Phase 2", status: "글로벌 확장", color: C.purple, x: 3.52,
      items: ["3D 지구본 Global Light Layer", "HealthMap + ProMED 통합", "타국 보건당국 참여\n→ Deep Layer 활성화", "글로벌 복합경보 시스템"]
    },
    {
      num: "03", label: "Phase 3", status: "임상 데이터 레이어", color: C.green, x: 6.68,
      items: ["CXR_AWARE: 응급실\n흉부 X선 AI 폐렴 감지", "임상 Ground Truth 추가", "병원 네트워크 연결", "\"환자의 폐에서 직접\n폐렴을 감지\""]
    },
  ];

  phases.forEach((p) => {
    const w = 2.95;
    // Circle on timeline
    s.addShape(pres.shapes.OVAL, {
      x: p.x + w / 2 - 0.22, y: 2.15, w: 0.44, h: 0.44,
      fill: { color: p.color }, line: { color: p.color, width: 0 }
    });
    s.addText(p.num, {
      x: p.x + w / 2 - 0.22, y: 2.15, w: 0.44, h: 0.44,
      fontSize: 10, bold: true, color: C.bg, align: "center", valign: "middle", margin: 0
    });

    // Card
    s.addShape(pres.shapes.RECTANGLE, {
      x: p.x, y: 0.85, w, h: 1.2,
      fill: { color: C.bg2 }, line: { color: p.color, width: 1.5 }
    });
    s.addShape(pres.shapes.RECTANGLE, { x: p.x, y: 0.85, w, h: 0.07, fill: { color: p.color } });
    s.addText(p.label, {
      x: p.x, y: 0.92, w, h: 0.38,
      fontSize: 14, bold: true, color: p.color, align: "center", margin: 0
    });
    s.addShape(pres.shapes.RECTANGLE, {
      x: p.x + 0.3, y: 1.32, w: w - 0.6, h: 0.28,
      fill: { color: p.color, transparency: 82 }, line: { color: p.color, width: 0.5 }
    });
    s.addText(p.status, {
      x: p.x + 0.3, y: 1.32, w: w - 0.6, h: 0.28,
      fontSize: 9, bold: true, color: p.color, align: "center", valign: "middle", margin: 0
    });

    // Item list below timeline
    s.addShape(pres.shapes.RECTANGLE, {
      x: p.x, y: 2.7, w, h: 2.65,
      fill: { color: C.bg2 }, line: { color: "1E3A5F", width: 1 }
    });
    const itemTexts = p.items.map((item, idx) => ({
      text: item,
      options: { bullet: true, fontSize: 10, color: "94A3B8", breakLine: idx < p.items.length - 1 }
    }));
    s.addText(itemTexts, {
      x: p.x + 0.12, y: 2.78, w: w - 0.24, h: 2.5,
      paraSpaceAfter: 5, margin: 0
    });
  });
}

// ─────────────────────────────────────────────
// SLIDE 10 — CLOSING
// ─────────────────────────────────────────────
{
  const s = pres.addSlide();
  s.background = { color: C.bg };
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.06, fill: { color: C.cyan } });

  // Background decoration circles
  for (let i = 0; i < 5; i++) {
    s.addShape(pres.shapes.OVAL, {
      x: 5.0 - i * 0.7, y: 0.5 - i * 0.5, w: 2.5 + i * 1.4, h: 2.5 + i * 1.4,
      fill: { color: C.cyan, transparency: 96 - i * 5 },
      line: { color: C.cyan, width: 0.5, transparency: 70 }
    });
  }

  s.addText("SENTINEL KOREA", {
    x: 0.5, y: 0.4, w: 9, h: 0.9,
    fontSize: 44, bold: true, color: C.white, fontFace: "Arial Black",
    align: "center", charSpacing: 4, margin: 0
  });

  s.addShape(pres.shapes.LINE, { x: 2.5, y: 1.32, w: 5.0, h: 0, line: { color: C.cyan, width: 2 } });

  s.addText('"한국이 증명한 모델을, 세계가 복제한다"', {
    x: 0.5, y: 1.4, w: 9, h: 0.55,
    fontSize: 16, italic: true, color: C.cyan, align: "center", margin: 0
  });

  // 3 impact stats
  const stats = [
    { num: "수주", sub: "조기경보", detail: "OSINT 선행 신호 기반", color: C.cyan },
    { num: "17개", sub: "시도 위험도", detail: "지역별 맞춤 대응", color: C.purple },
    { num: "90%+", sub: "분석 시간 단축", detail: "AI 자동화", color: C.green },
  ];

  stats.forEach((st, i) => {
    const x = 0.65 + i * 3.0;
    s.addShape(pres.shapes.RECTANGLE, {
      x, y: 2.15, w: 2.7, h: 2.2,
      fill: { color: C.bg2 }, line: { color: st.color, width: 1.5 }, shadow: makeShadow()
    });
    s.addShape(pres.shapes.RECTANGLE, { x, y: 2.15, w: 2.7, h: 0.07, fill: { color: st.color } });
    s.addText(st.num, {
      x, y: 2.3, w: 2.7, h: 0.85,
      fontSize: 42, bold: true, color: st.color, align: "center", margin: 0
    });
    s.addText(st.sub, {
      x, y: 3.15, w: 2.7, h: 0.4,
      fontSize: 13, bold: true, color: C.white, align: "center", margin: 0
    });
    s.addText(st.detail, {
      x, y: 3.58, w: 2.7, h: 0.7,
      fontSize: 10, color: "64748B", align: "center", margin: 0
    });
  });

  // Bottom
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 5.2, w: 10, h: 0.425, fill: { color: "080E1A" } });
  s.addText("Built with  FastAPI  ·  React + TypeScript  ·  Gemini AI  ·  Korea Map", {
    x: 0.5, y: 5.2, w: 9, h: 0.425,
    fontSize: 10, color: C.muted, align: "center", valign: "middle", margin: 0
  });
}

// Write file
pres.writeFile({ fileName: "C:\\Users\\han75\\OneDrive\\Desktop\\Sentinel pneumonia\\docs\\Sentinel_Korea_MVP_Demo.pptx" })
  .then(() => console.log("✅ PPTX saved successfully"))
  .catch(err => { console.error("❌ Error:", err); process.exit(1); });
