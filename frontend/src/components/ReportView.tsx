import { useEffect, useMemo, useState } from 'react';

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

type SectionKey = 'changed' | 'matters' | 'confidence' | 'actions';

type IntelligenceSection = {
  key: SectionKey;
  label: string;
  title: string;
  body: string;
};

const TYPE_META: Record<ReportType, { label: string; color: string; cadence: string; role: string }> = {
  osint: {
    label: 'OSINT',
    color: '#6b8aff',
    cadence: 'Daily',
    role: 'Imported-risk context and external corroboration.',
  },
  kdca: {
    label: 'KDCA',
    color: '#34d399',
    cadence: 'Weekly',
    role: 'Official Korea surveillance baseline.',
  },
  final: {
    label: 'SENTINEL',
    color: '#38bdf8',
    cadence: 'Weekly',
    role: 'Korea-first respiratory intelligence synthesis.',
  },
};

const TYPE_ORDER: Array<'all' | ReportType> = ['all', 'final', 'kdca', 'osint'];

function titleForReport(item: ReportItem) {
  return item.epiweek || item.snapshot_date || item.stem || item.filename;
}

function cleanLine(line: string) {
  return line
    .replace(/^#+\s*/, '')
    .replace(/^[-*]\s*/, '')
    .replace(/\*\*/g, '')
    .trim();
}

function firstMeaningfulLine(markdown: string) {
  const lines = markdown
    .split(/\r?\n/)
    .map(cleanLine)
    .filter((line) => line && !line.startsWith('|') && !line.startsWith('```'));
  return lines[0] || '';
}

function lineContaining(markdown: string, terms: string[]) {
  const lines = markdown.split(/\r?\n/).map(cleanLine).filter(Boolean);
  return lines.find((line) => terms.some((term) => line.toLowerCase().includes(term))) || '';
}

function sectionBody(markdown: string, heading: string) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return '';
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line.trim())) break;
    const cleaned = cleanLine(line);
    if (cleaned) body.push(cleaned);
  }
  return body.join(' ');
}

function buildReportBrief(item: ReportItem | null, markdown: string): IntelligenceSection[] {
  if (!item) return [];

  const firstLine = firstMeaningfulLine(markdown);
  const changedSection = sectionBody(markdown, 'What changed');
  const mattersSection = sectionBody(markdown, 'Why it matters');
  const confidenceSection = sectionBody(markdown, 'Confidence');
  const actionsSection = sectionBody(markdown, 'Recommended watch actions');
  const confidenceLine = lineContaining(markdown, ['confidence', 'freshness', 'coverage', 'quality']);
  const actionLine = lineContaining(markdown, ['recommend', 'action', 'watch', 'monitor', 'next']);
  const typeMeta = TYPE_META[item.type];

  const changedFallback =
    item.type === 'final'
      ? 'The latest Sentinel synthesis combines KDCA surveillance, OSINT signals, trends, and available corroboration into a Korea regional watch picture.'
      : item.type === 'kdca'
        ? 'The weekly KDCA lane updates the official respiratory baseline used by Sentinel.'
        : 'The OSINT lane refreshes news and trend context without overriding Korea surveillance signals.';

  const mattersFallback =
    item.type === 'final'
      ? 'This is the control-room view: which Korean regions look unusual, why they look unusual, and how much confidence the system assigns.'
      : item.type === 'kdca'
        ? 'Official surveillance anchors the baseline so Sentinel does not mistake media noise for epidemiologic signal.'
        : 'External context is useful as imported-risk watch and corroboration, not as a standalone global score.';

  return [
    {
      key: 'changed',
      label: '01',
      title: 'What changed',
      body: changedSection || firstLine || changedFallback,
    },
    {
      key: 'matters',
      label: '02',
      title: 'Why it matters',
      body: mattersSection || mattersFallback,
    },
    {
      key: 'confidence',
      label: '03',
      title: 'Confidence',
      body:
        confidenceSection ||
        confidenceLine ||
        'Confidence should reflect freshness, coverage, data quality, and independent corroboration. Source count alone is not treated as confidence.',
    },
    {
      key: 'actions',
      label: '04',
      title: 'Recommended watch actions',
      body:
        actionsSection ||
        actionLine ||
        `Use this ${typeMeta.label} report to inspect top regions, review the signal breakdown, and keep global context limited to imported-risk watch.`,
    },
  ];
}

export default function ReportView() {
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [typeFilter, setTypeFilter] = useState<'all' | ReportType>('all');
  const [selected, setSelected] = useState<ReportItem | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string>('');

  const filtered = useMemo(
    () => (typeFilter === 'all' ? reports : reports.filter((report) => report.type === typeFilter)),
    [reports, typeFilter],
  );

  const briefSections = useMemo(() => buildReportBrief(selected, markdown), [selected, markdown]);

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
    setStatus('');
    try {
      const res = await fetch(`${API_BASE}/reports/content/${encodeURIComponent(item.filename)}`);
      const data = await res.json();
      setMarkdown(data.content || data.markdown || 'No report content was returned by the backend.');
    } catch {
      setMarkdown('Report content could not be loaded. Check backend connectivity.');
    }
  };

  const fetchReports = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/reports/list`);
      const data = await res.json();
      const list: ReportItem[] = Array.isArray(data) ? data : data.reports || [];
      setReports(list);
      if (list.length) {
        const next = selected ? list.find((item) => item.filename === selected.filename) || list[0] : list[0];
        await loadReport(next);
      } else {
        setSelected(null);
        setMarkdown('');
      }
    } catch {
      setReports([]);
      setSelected(null);
      setMarkdown('');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReports();
    fetchRecipients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generateFinalReport = async () => {
    setGenerating(true);
    setStatus('Generating Sentinel intelligence report...');
    try {
      const res = await fetch(`${API_BASE}/reports/generate-final`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setStatus(data.detail || 'Report generation failed.');
        return;
      }
      setStatus(`Generated ${data.report_filename || data.epiweek || 'latest Sentinel report'}.`);
      await fetchReports();
      setTypeFilter('final');
    } catch {
      setStatus('Report generation failed. Check backend connectivity.');
    } finally {
      setGenerating(false);
    }
  };

  const addRecipient = async () => {
    if (!newEmail.trim()) return;
    setStatus('');
    try {
      const res = await fetch(`${API_BASE}/reports/recipients/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail.trim(), name: newName.trim() }),
      });
      if (res.ok) {
        setNewEmail('');
        setNewName('');
        setStatus('Recipient added.');
        await fetchRecipients();
      } else {
        const err = await res.json();
        setStatus(err.detail || 'Recipient could not be added.');
      }
    } catch {
      setStatus('Recipient could not be added.');
    }
  };

  const removeRecipient = async (email: string) => {
    try {
      await fetch(`${API_BASE}/reports/recipients/${encodeURIComponent(email)}`, { method: 'DELETE' });
      await fetchRecipients();
    } catch {
      setStatus('Recipient could not be removed.');
    }
  };

  const sendEmail = async () => {
    if (!selected) return;
    if (recipients.length === 0) {
      setStatus('Add at least one recipient before sending.');
      return;
    }
    setSending(true);
    setStatus('Sending report email...');
    try {
      const res = await fetch(`${API_BASE}/reports/send?filename=${encodeURIComponent(selected.filename)}`, {
        method: 'POST',
      });
      const data = await res.json();
      if (res.ok) {
        setStatus(`Send requested for ${data.recipients?.length || recipients.length} recipient(s).`);
      } else {
        setStatus(data.detail || 'Email send failed.');
      }
    } catch {
      setStatus('Email send failed.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="report-view report-view--control-room">
      <div className="report-sidebar">
        <div className="report-sidebar-header">
          <span className="report-kicker">Korea-first respiratory intelligence</span>
          <h3>Intelligence archive</h3>
          <p>Reports are organized as evidence for regional respiratory watch decisions, not as standalone prediction outputs.</p>
        </div>

        <button className="report-generate-btn" onClick={generateFinalReport} disabled={generating}>
          {generating ? 'Generating...' : 'Generate Sentinel report'}
        </button>

        <div className="report-type-tabs">
          {TYPE_ORDER.map((type) => (
            <button
              key={type}
              className={`report-type-tab ${typeFilter === type ? 'report-type-tab--active' : ''}`}
              onClick={() => setTypeFilter(type)}
              style={type !== 'all' ? { borderLeft: `3px solid ${TYPE_META[type].color}` } : undefined}
              type="button"
            >
              <span>{type === 'all' ? 'ALL' : TYPE_META[type].label}</span>
              <span className="report-type-tab-count">
                {type === 'all' ? reports.length : reports.filter((report) => report.type === type).length}
              </span>
            </button>
          ))}
        </div>

        {loading ? (
          <div className="report-loading">Loading reports...</div>
        ) : filtered.length === 0 ? (
          <div className="report-empty">No reports yet. Generate a Sentinel report from the control room.</div>
        ) : (
          <div className="report-list">
            {filtered.map((report) => {
              const meta = TYPE_META[report.type];
              return (
                <button
                  key={report.filename}
                  className={`report-list-item ${selected?.filename === report.filename ? 'report-list-item--active' : ''}`}
                  onClick={() => loadReport(report)}
                  style={{ borderLeft: `3px solid ${meta.color}` }}
                  type="button"
                >
                  <div className="report-list-row">
                    <span className="report-list-badge" style={{ color: meta.color }}>{meta.label}</span>
                    <span className="report-list-cadence">{meta.cadence}</span>
                  </div>
                  <div className="report-list-epiweek">{titleForReport(report)}</div>
                  <div className="report-list-role">{meta.role}</div>
                  {report.generated_at && (
                    <div className="report-list-date">{new Date(report.generated_at).toLocaleString('ko-KR')}</div>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div className="report-recipients">
          <div className="report-recipients-title">Email recipients ({recipients.length})</div>
          <div className="report-recipients-add">
            <input
              type="email"
              placeholder="email@example.com"
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
              className="report-recipient-input"
            />
            <input
              type="text"
              placeholder="name optional"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              className="report-recipient-input"
            />
            <button className="report-recipient-add-btn" onClick={addRecipient} type="button">Add</button>
          </div>
          {recipients.map((recipient) => (
            <div key={recipient.email} className="report-recipient-row">
              <span className="report-recipient-email">{recipient.email}</span>
              {recipient.name && <span className="report-recipient-name">{recipient.name}</span>}
              <button className="report-recipient-remove" onClick={() => removeRecipient(recipient.email)} type="button">x</button>
            </div>
          ))}
        </div>
      </div>

      <div className="report-content">
        {selected ? (
          <div className="report-markdown">
            <div className="report-markdown-header report-markdown-header--control">
              <div>
                <span
                  className="report-detail-badge"
                  style={{ color: TYPE_META[selected.type].color, borderColor: TYPE_META[selected.type].color }}
                >
                  {TYPE_META[selected.type].label} / {TYPE_META[selected.type].cadence}
                </span>
                <h2>{titleForReport(selected)}</h2>
                <div className="report-detail-meta">{selected.filename}</div>
              </div>
              <div className="report-detail-actions">
                <button
                  className="report-email-send-btn"
                  onClick={sendEmail}
                  disabled={sending || recipients.length === 0}
                  type="button"
                >
                  {sending ? 'Sending...' : 'Send email'}
                </button>
              </div>
            </div>

            <div className="report-positioning-card">
              <span>Product frame</span>
              <strong>Sentinel is a Korea-first respiratory intelligence control room.</strong>
              <p>
                The report explains which Korean regions look unusual, why the system believes that,
                and how much confidence the available evidence deserves.
              </p>
            </div>

            <div className="report-brief-grid">
              {briefSections.map((section) => (
                <section className={`report-brief-card report-brief-card--${section.key}`} key={section.key}>
                  <span>{section.label}</span>
                  <h3>{section.title}</h3>
                  <p>{section.body}</p>
                </section>
              ))}
            </div>

            {selected.type === 'osint' && (
              <div className="report-context-note">
                Global and overseas signals are treated as imported-risk context, regional benchmarking,
                and external corroboration. They do not create a standalone global alert score.
              </div>
            )}

            {status && <div className="report-status">{status}</div>}

            <div className="report-raw-header">
              <span>Raw report artifact</span>
              <p>Kept below for auditability and backend traceability.</p>
            </div>
            <pre className="report-markdown-body">{markdown}</pre>
          </div>
        ) : (
          <div className="report-empty-state">
            <div className="report-empty-icon">SR</div>
            <div>Select or generate a Sentinel intelligence report.</div>
          </div>
        )}
      </div>
    </div>
  );
}
