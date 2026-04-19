import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

interface ReportItem {
  epiweek: string;
  snapshot_date?: string;
  generated_at?: string;
}

export default function ReportView() {
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    fetchReports();
  }, []);

  const fetchReports = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/reports/list`);
      const data = await res.json();
      setReports(data.reports || []);
      if (data.reports?.length && !selected) {
        loadReport(data.reports[0].epiweek);
      }
    } catch {
      setReports([]);
    } finally {
      setLoading(false);
    }
  };

  const loadReport = async (epiweek: string) => {
    setSelected(epiweek);
    try {
      const res = await fetch(`${API_BASE}/reports/${epiweek}`);
      const data = await res.json();
      setMarkdown(data.markdown || '리포트를 찾을 수 없습니다.');
    } catch {
      setMarkdown('리포트 로딩 실패');
    }
  };

  const generateNew = async () => {
    setGenerating(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      await fetch(`${API_BASE}/reports/generate?snapshot_date=${today}`, { method: 'POST' });
      await fetchReports();
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="report-view">
      <div className="report-sidebar">
        <div className="report-sidebar-header">
          <h3>주간 리포트</h3>
          <button className="report-generate-btn" onClick={generateNew} disabled={generating}>
            {generating ? '생성 중...' : '+ 새 리포트'}
          </button>
        </div>
        {loading ? (
          <div className="report-loading">로딩 중...</div>
        ) : reports.length === 0 ? (
          <div className="report-empty">리포트가 없습니다. 새 리포트를 생성해보세요.</div>
        ) : (
          <div className="report-list">
            {reports.map((r) => (
              <button
                key={r.epiweek}
                className={`report-list-item ${selected === r.epiweek ? 'report-list-item--active' : ''}`}
                onClick={() => loadReport(r.epiweek)}
              >
                <div className="report-list-epiweek">{r.epiweek}</div>
                {r.snapshot_date && <div className="report-list-date">{r.snapshot_date}</div>}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="report-content">
        {selected ? (
          <div className="report-markdown">
            <div className="report-markdown-header">
              <h2>{selected}</h2>
            </div>
            <pre className="report-markdown-body">{markdown}</pre>
          </div>
        ) : (
          <div className="report-empty-state">
            <div className="report-empty-icon">📄</div>
            <div>리포트를 선택하세요</div>
          </div>
        )}
      </div>
    </div>
  );
}
