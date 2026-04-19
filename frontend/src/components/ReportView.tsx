import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

type ReportType = 'osint' | 'kdca' | 'final';

interface ReportItem {
  filename: string;
  type: ReportType;
  stem: string;
  epiweek?: string | null;
  snapshot_date?: string | null;
  generated_at?: string;
  size_bytes?: number;
}

interface Recipient {
  email: string;
  name?: string;
}

const TYPE_META: Record<ReportType, { label: string; color: string; cadence: string }> = {
  osint:  { label: 'OSINT',  color: '#6b8aff', cadence: 'Daily'  },
  kdca:   { label: 'KDCA',   color: '#34d399', cadence: 'Weekly' },
  final:  { label: 'FINAL',  color: '#38bdf8', cadence: 'Weekly' },
};

export default function ReportView() {
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [typeFilter, setTypeFilter] = useState<'all' | ReportType>('all');
  const [selected, setSelected] = useState<ReportItem | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [loading, setLoading] = useState(true);

  // Recipients
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    fetchReports();
    fetchRecipients();
  }, []);

  const fetchReports = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/reports/list`);
      const data = await res.json();
      const list: ReportItem[] = Array.isArray(data) ? data : (data.reports || []);
      setReports(list);
      if (list.length && !selected) {
        loadReport(list[0]);
      }
    } catch {
      setReports([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchRecipients = async () => {
    try {
      const res = await fetch(`${API_BASE}/reports/recipients/list`);
      const data = await res.json();
      setRecipients(Array.isArray(data) ? data : []);
    } catch {
      setRecipients([]);
    }
  };

  const loadReport = async (item: ReportItem) => {
    setSelected(item);
    try {
      const res = await fetch(`${API_BASE}/reports/content/${encodeURIComponent(item.filename)}`);
      const data = await res.json();
      setMarkdown(data.content || data.markdown || '리포트를 찾을 수 없습니다.');
    } catch {
      setMarkdown('리포트 로딩 실패');
    }
  };

  const addRecipient = async () => {
    if (!newEmail.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/reports/recipients/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail.trim(), name: newName.trim() }),
      });
      if (res.ok) {
        setNewEmail(''); setNewName('');
        fetchRecipients();
        setStatus('수신자 추가됨');
      } else {
        const err = await res.json();
        setStatus(err.detail || '추가 실패');
      }
    } catch { setStatus('추가 실패'); }
  };

  const removeRecipient = async (email: string) => {
    try {
      await fetch(`${API_BASE}/reports/recipients/${encodeURIComponent(email)}`, { method: 'DELETE' });
      fetchRecipients();
    } catch { /* noop */ }
  };

  const sendEmail = async () => {
    if (!selected) return;
    if (recipients.length === 0) {
      setStatus('등록된 수신자가 없습니다.');
      return;
    }
    setSending(true);
    setStatus('이메일 전송 중...');
    try {
      const res = await fetch(`${API_BASE}/reports/send?filename=${encodeURIComponent(selected.filename)}`, {
        method: 'POST',
      });
      const data = await res.json();
      if (res.ok) {
        setStatus(`전송 요청됨 · ${data.recipients?.length || 0}명`);
      } else {
        setStatus(data.detail || '전송 실패');
      }
    } catch {
      setStatus('전송 실패');
    } finally {
      setSending(false);
    }
  };

  const filtered = typeFilter === 'all' ? reports : reports.filter((r) => r.type === typeFilter);

  return (
    <div className="report-view">
      <div className="report-sidebar">
        <div className="report-sidebar-header">
          <h3>리포트 아카이브</h3>
        </div>

        {/* Type filter */}
        <div className="report-type-tabs">
          {(['all', 'osint', 'kdca', 'final'] as const).map((t) => (
            <button
              key={t}
              className={`report-type-tab ${typeFilter === t ? 'report-type-tab--active' : ''}`}
              onClick={() => setTypeFilter(t)}
              style={t !== 'all' ? { borderLeft: `3px solid ${TYPE_META[t as ReportType].color}` } : undefined}
            >
              {t === 'all' ? 'ALL' : TYPE_META[t as ReportType].label}
              <span className="report-type-tab-count">
                {t === 'all' ? reports.length : reports.filter((r) => r.type === t).length}
              </span>
            </button>
          ))}
        </div>

        {loading ? (
          <div className="report-loading">로딩 중...</div>
        ) : filtered.length === 0 ? (
          <div className="report-empty">리포트 없음. AI ANALYZE 버튼으로 생성하세요.</div>
        ) : (
          <div className="report-list">
            {filtered.map((r) => {
              const meta = TYPE_META[r.type];
              return (
                <button
                  key={r.filename}
                  className={`report-list-item ${selected?.filename === r.filename ? 'report-list-item--active' : ''}`}
                  onClick={() => loadReport(r)}
                  style={{ borderLeft: `3px solid ${meta.color}` }}
                >
                  <div className="report-list-row">
                    <span className="report-list-badge" style={{ color: meta.color }}>{meta.label}</span>
                    <span className="report-list-cadence">{meta.cadence}</span>
                  </div>
                  <div className="report-list-epiweek">{r.epiweek || r.snapshot_date || r.stem}</div>
                  {r.generated_at && (
                    <div className="report-list-date">{new Date(r.generated_at).toLocaleString('ko-KR')}</div>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Recipients */}
        <div className="report-recipients">
          <div className="report-recipients-title">📧 이메일 수신자 ({recipients.length})</div>
          <div className="report-recipients-add">
            <input
              type="email"
              placeholder="email@example.com"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className="report-recipient-input"
            />
            <input
              type="text"
              placeholder="이름 (선택)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="report-recipient-input"
            />
            <button className="report-recipient-add-btn" onClick={addRecipient}>+ 추가</button>
          </div>
          {recipients.map((r) => (
            <div key={r.email} className="report-recipient-row">
              <span className="report-recipient-email">{r.email}</span>
              {r.name && <span className="report-recipient-name">{r.name}</span>}
              <button className="report-recipient-remove" onClick={() => removeRecipient(r.email)}>×</button>
            </div>
          ))}
        </div>
      </div>

      <div className="report-content">
        {selected ? (
          <div className="report-markdown">
            <div className="report-markdown-header">
              <div>
                <span
                  className="report-detail-badge"
                  style={{ color: TYPE_META[selected.type].color, borderColor: TYPE_META[selected.type].color }}
                >
                  {TYPE_META[selected.type].label} · {TYPE_META[selected.type].cadence}
                </span>
                <h2 style={{ margin: '8px 0 0' }}>{selected.epiweek || selected.snapshot_date || selected.stem}</h2>
                <div className="report-detail-meta">{selected.filename}</div>
              </div>
              <div className="report-detail-actions">
                <button
                  className="report-email-send-btn"
                  onClick={sendEmail}
                  disabled={sending || recipients.length === 0}
                >
                  {sending ? '전송 중...' : '📧 이메일 전송'}
                </button>
              </div>
            </div>
            {status && <div className="report-status">{status}</div>}
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
