import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const DISMISS_KEY = 'sk_symptom_report_v1';
const DISMISS_DAYS = 7;

const SYMPTOMS: { key: string; label: string }[] = [
  { key: 'fever', label: '발열' },
  { key: 'cough', label: '기침' },
  { key: 'sore_throat', label: '인후통' },
  { key: 'runny_nose', label: '콧물·코막힘' },
  { key: 'body_ache', label: '몸살' },
  { key: 'none', label: '증상 없음' },
];

const REGIONS = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];

/**
 * Optional, dismissible participatory symptom-report widget for casual visitors.
 * Anonymous (no PII), client-side 7-day dedup via localStorage, non-blocking.
 */
export default function SymptomReportWidget() {
  const [visible, setVisible] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [region, setRegion] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DISMISS_KEY);
      if (raw) {
        const ts = Number(raw);
        if (!Number.isNaN(ts) && Date.now() - ts < DISMISS_DAYS * 86_400_000) return;
      }
    } catch { /* localStorage unavailable — show anyway */ }
    const t = window.setTimeout(() => setVisible(true), 2500);
    return () => window.clearTimeout(t);
  }, []);

  const remember = () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
  };

  const dismiss = () => { remember(); setVisible(false); };

  const toggle = (key: string) => {
    setSelected((prev) => {
      if (key === 'none') return prev.includes('none') ? [] : ['none'];
      const next = prev.filter((s) => s !== 'none');
      return next.includes(key) ? next.filter((s) => s !== key) : [...next, key];
    });
  };

  const submit = async () => {
    if (selected.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      await fetch(`${API_BASE}/participatory/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symptoms: selected, region: region || null }),
      });
    } catch { /* best-effort — still thank the user */ }
    remember();
    setSubmitted(true);
    setSubmitting(false);
    window.setTimeout(() => setVisible(false), 2200);
  };

  if (!visible) return null;

  return (
    <div className="symptom-widget" role="dialog" aria-label="호흡기 증상 자가신고">
      <button className="symptom-widget-close" onClick={dismiss} aria-label="닫기" type="button">×</button>
      {submitted ? (
        <div className="symptom-widget-thanks">감사합니다.<br />익명으로 집계되었습니다.</div>
      ) : (
        <>
          <div className="symptom-widget-title">이번 주 호흡기 증상이 있으세요?</div>
          <div className="symptom-widget-sub">익명 · 감염병 감시 통계에만 사용됩니다 · 선택사항</div>
          <div className="symptom-widget-chips">
            {SYMPTOMS.map((s) => (
              <button
                key={s.key}
                className={`symptom-chip ${selected.includes(s.key) ? 'is-on' : ''} ${s.key === 'none' ? 'symptom-chip--none' : ''}`}
                onClick={() => toggle(s.key)}
                type="button"
              >
                {s.label}
              </button>
            ))}
          </div>
          <select className="symptom-widget-region" value={region} onChange={(e) => setRegion(e.target.value)} aria-label="지역 선택">
            <option value="">지역 (선택)</option>
            {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button className="symptom-widget-submit" disabled={selected.length === 0 || submitting} onClick={submit} type="button">
            {submitting ? '제출 중...' : '제출'}
          </button>
        </>
      )}
    </div>
  );
}
