import { useEffect, useRef, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

interface UploadResult {
  success: boolean;
  filename?: string;
  file_type?: string;
  records_parsed?: number;
  snapshots_updated?: number;
  updated_dates?: string[];
  error?: string;
}

interface HistoryItem {
  filename: string;
  file_type: string;
  uploaded_at: string;
  snapshot_count: number;
}

interface ReportItem {
  filename: string;
  epiweek: string;
  generated_at: string;
  size_bytes: number;
}

interface KdcaDigest {
  status: string;
  kdca_summary?: string;
  regional_highlights?: { region: string; finding: string; severity: string }[];
  risk_assessment?: string;
  key_indicators?: { indicator: string; trend: string; detail: string }[];
  sources_used?: string[];
  generated_at?: string;
  raw_summary?: string;
}

type TabType = 'upload' | 'reports';

interface KdcaUploadPanelProps {
  // 'summary'  → AI 분석 결과만 표시 (좌측 리포트 영역 용)
  // 'console'  → 업로드/리포트/수신자 탭 + raw data 만 표시 (우측 콘솔 영역 용)
  // 'full'(기본) → 기존과 동일하게 전부 표시
  view?: 'summary' | 'console' | 'full';
  readOnly?: boolean;
  getAdminHeaders?: (json?: boolean) => Promise<HeadersInit>;
}

export default function KdcaUploadPanel({ view = 'full', readOnly = false, getAdminHeaders }: KdcaUploadPanelProps) {
  const [activeTab, setActiveTab] = useState<TabType>('upload');
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [reportContent, setReportContent] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [statusType, setStatusType] = useState<'ok' | 'error' | 'pending'>('ok');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // AI analysis state
  const [digest, setDigest] = useState<KdcaDigest | null>(null);
  const [digestLoading, setDigestLoading] = useState(false);
  const [showRawData, setShowRawData] = useState(false);

  const setStatus = (msg: string, type: 'ok' | 'error' | 'pending') => {
    setStatusMsg(msg);
    setStatusType(type);
  };

  const fetchDigest = async () => {
    try {
      const res = await fetch(`${API_BASE}/risk-analysis/kdca-digest`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'ok' || data.status === 'partial') setDigest(data);
      }
    } catch { /* ignore */ }
  };

  const generateDigest = async () => {
    if (readOnly) {
      setStatus('Read-only mode. Only the Sentinel operator can refresh AI analysis.', 'error');
      return;
    }
    setDigestLoading(true);
    try {
      const res = await fetch(`${API_BASE}/risk-analysis/kdca-digest`, { method: 'POST', headers: await getAdminHeaders?.(false) });
      if (res.ok) {
        const data = await res.json();
        setDigest(data);
      }
    } catch { /* ignore */ }
    setDigestLoading(false);
  };

  const fetchData = async () => {
    const [histRes, repRes] = await Promise.all([
      fetch(`${API_BASE}/ingestion/upload-history`),
      fetch(`${API_BASE}/reports/list`),
    ]);
    if (histRes.ok) setHistory(await histRes.json());
    if (repRes.ok) setReports(await repRes.json());
  };

  useEffect(() => { fetchData(); fetchDigest(); }, []);

  const handleFile = async (file: File) => {
    if (readOnly) {
      setStatus('Read-only mode. Only the Sentinel operator can upload source files.', 'error');
      return;
    }
    setUploading(true);
    setUploadResult(null);
    setStatusMsg('');
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await fetch(`${API_BASE}/ingestion/upload-kdca`, { method: 'POST', body: form, headers: await getAdminHeaders?.(false) });
      const data = await res.json();
      setUploadResult(data);
      if (data.success) {
        setStatus(`${data.snapshots_updated} snapshots updated. Generating AI analysis...`, 'pending');
        fetchData();
        generateDigest().then(() => setStatus('Upload complete. AI analysis generated.', 'ok'));
      } else {
        setStatus(data.error || 'Processing failed', 'error');
      }
    } catch {
      setStatus('Upload failed — check server connection.', 'error');
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = '';
  };

  const handleScanFolder = async () => {
    if (readOnly) {
      setStatus('Read-only mode. Only the Sentinel operator can scan source folders.', 'error');
      return;
    }
    setUploading(true);
    setStatus('Scanning folder...', 'pending');
    try {
      const res = await fetch(`${API_BASE}/ingestion/process-folder`, { method: 'POST', headers: await getAdminHeaders?.(false) });
      const data = await res.json();
      setStatus(`${data.files_processed} files processed successfully.`, 'ok');
      fetchData();
    } catch {
      setStatus('Folder scan failed.', 'error');
    } finally {
      setUploading(false);
    }
  };

  // handleGenerateReport removed — report generation is now triggered from
  // AI ANALYZE > KDCA DATA ANALYZE button in the right console (App.tsx).

  const handleSendReport = async () => {
    if (readOnly) {
      setStatus('Read-only mode. Only the Sentinel operator can send reports.', 'error');
      return;
    }
    setSendingEmail(true);
    setStatus('Sending email...', 'pending');
    try {
      const res = await fetch(`${API_BASE}/reports/send`, { method: 'POST', headers: await getAdminHeaders?.(false) });
      const data = await res.json();
      if (res.ok) {
        setStatus(`Sent to ${data.recipients?.length} recipients.`, 'ok');
      } else {
        setStatus(data.detail, 'error');
      }
    } catch {
      setStatus('Email sending failed.', 'error');
    } finally {
      setSendingEmail(false);
    }
  };

  // handleAddRecipient / handleRemoveRecipient removed — managed in REPORT tab.

  const handleLoadReport = async (filename: string) => {
    const res = await fetch(`${API_BASE}/reports/content/${filename}`);
    if (res.ok) {
      const d = await res.json();
      setReportContent(d.content);
    }
  };

  // ─── SUMMARY-ONLY VIEW (좌측 리포트 영역) ───
  if (view === 'summary') {
    return (
      <div className="kdca-panel kdca-panel--summary">
        {digestLoading && (
          <div className="news-loading">
            <div className="news-spinner" />
            <span>Analyzing KDCA data...</span>
          </div>
        )}

        {!digestLoading && digest && digest.status === 'ok' && (
          <div className="news-digest-section">
            <div className="news-digest-content">
              {digest.kdca_summary && (
                <div className="digest-block" style={{ borderLeftColor: '#34d399' }}>
                  <div className="digest-block-title" style={{ color: '#34d399' }}>KDCA Summary</div>
                  <p className="digest-text">{digest.kdca_summary}</p>
                </div>
              )}
              {digest.risk_assessment && (
                <div className="digest-block digest-risk">
                  <div className="digest-block-title">Risk Assessment</div>
                  <p className="digest-text">{digest.risk_assessment}</p>
                </div>
              )}
              {digest.regional_highlights && digest.regional_highlights.length > 0 && (
                <div className="digest-alerts">
                  <div className="digest-block-title" style={{ padding: '0 2px', color: '#94a3b8' }}>Regional Highlights</div>
                  {digest.regional_highlights.map((r, i) => (
                    <div key={i} className="digest-alert-item">
                      <span className="digest-alert-dot" style={{ background: r.severity === 'high' ? '#ef4444' : r.severity === 'medium' ? '#f59e42' : '#22c55e' }} />
                      <div>
                        <strong>{r.region}</strong>
                        <p className="digest-alert-detail">{r.finding}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {digest.key_indicators && digest.key_indicators.length > 0 && (
                <div className="digest-alerts">
                  <div className="digest-block-title" style={{ padding: '0 2px', color: '#94a3b8' }}>Key Indicators</div>
                  {digest.key_indicators.map((k, i) => (
                    <div key={i} className="digest-alert-item">
                      <span className="digest-alert-dot" style={{
                        background: k.trend === '상승' ? '#ef4444' : k.trend === '하락' ? '#22c55e' : '#f59e42',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        width: 16, height: 16, fontSize: 10, color: '#fff', borderRadius: '50%'
                      }}>
                        {k.trend === '상승' ? '↑' : k.trend === '하락' ? '↓' : '→'}
                      </span>
                      <div>
                        <strong>{k.indicator}</strong>
                        <p className="digest-alert-detail">{k.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {digest.generated_at && (
                <div className="digest-source-count">
                  Generated: {new Date(digest.generated_at).toLocaleString('ko-KR')}
                  {digest.sources_used && ` · Sources: ${digest.sources_used.join(', ')}`}
                </div>
              )}
            </div>
          </div>
        )}

        {!digestLoading && digest && digest.status === 'partial' && (
          <div className="news-digest-section">
            <div className="digest-block">
              <p className="digest-text">{digest.raw_summary}</p>
            </div>
          </div>
        )}

        {!digestLoading && (!digest || digest.status === 'empty') && (
          <div className="trends-empty">
            <p>No KDCA AI analysis available.</p>
            <p className="news-empty-hint">Upload KDCA data from the right console to generate an AI analysis.</p>
          </div>
        )}
      </div>
    );
  }

  // ─── CONSOLE VIEW (우측 데이터 소스 콘솔) ───
  // view === 'console' 이면 업로드 탭에서 AI summary 블록을 건너뛰고 항상 raw data 를 보여줍니다.
  const forceRawData = view === 'console' ? true : showRawData;

  return (
    <div className="kdca-panel" id="kdca-panel">
      {/* 탭 */}
      <div className="kdca-tabs">
        {(['upload', 'reports'] as TabType[]).map(tab => (
          <button
            key={tab}
            className={`kdca-tab${activeTab === tab ? ' kdca-tab--active' : ''}`}
            onClick={() => setActiveTab(tab)}
            id={`tab-${tab}`}
          >
            {tab === 'upload' && 'Upload'}
            {tab === 'reports' && `Reports (${reports.length})`}
          </button>
        ))}
      </div>

      {/* 상태 메시지 */}
      {statusMsg && (
        <div className={`kdca-status kdca-status--${statusType}`}>
          {statusMsg}
        </div>
      )}

      {/* 업로드 탭 */}
      {activeTab === 'upload' && (
        <div className="kdca-content">
          {/* AI analysis section — console 모드에서는 좌측 summary 패널이 대신 담당하므로 숨깁니다 */}
          {view !== 'console' && digestLoading && (
            <div className="news-loading">
              <div className="news-spinner" />
              <span>Analyzing KDCA data...</span>
            </div>
          )}

          {view !== 'console' && !digestLoading && digest && digest.status === 'ok' && !showRawData && (
            <div className="news-digest-section">
              <div className="news-digest-content">
                {digest.kdca_summary && (
                  <div className="digest-block" style={{ borderLeftColor: '#34d399' }}>
                    <div className="digest-block-title" style={{ color: '#34d399' }}>KDCA Summary</div>
                    <p className="digest-text">{digest.kdca_summary}</p>
                  </div>
                )}
                {digest.risk_assessment && (
                  <div className="digest-block digest-risk">
                    <div className="digest-block-title">Risk Assessment</div>
                    <p className="digest-text">{digest.risk_assessment}</p>
                  </div>
                )}
                {digest.regional_highlights && digest.regional_highlights.length > 0 && (
                  <div className="digest-alerts">
                    <div className="digest-block-title" style={{ padding: '0 2px', color: '#94a3b8' }}>Regional Highlights</div>
                    {digest.regional_highlights.map((r, i) => (
                      <div key={i} className="digest-alert-item">
                        <span className="digest-alert-dot" style={{ background: r.severity === 'high' ? '#ef4444' : r.severity === 'medium' ? '#f59e42' : '#22c55e' }} />
                        <div>
                          <strong>{r.region}</strong>
                          <p className="digest-alert-detail">{r.finding}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {digest.key_indicators && digest.key_indicators.length > 0 && (
                  <div className="digest-alerts">
                    <div className="digest-block-title" style={{ padding: '0 2px', color: '#94a3b8' }}>Key Indicators</div>
                    {digest.key_indicators.map((k, i) => (
                      <div key={i} className="digest-alert-item">
                        <span className="digest-alert-dot" style={{
                          background: k.trend === '상승' ? '#ef4444' : k.trend === '하락' ? '#22c55e' : '#f59e42',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          width: 16, height: 16, fontSize: 10, color: '#fff', borderRadius: '50%'
                        }}>
                          {k.trend === '상승' ? '↑' : k.trend === '하락' ? '↓' : '→'}
                        </span>
                        <div>
                          <strong>{k.indicator}</strong>
                          <p className="digest-alert-detail">{k.detail}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {digest.generated_at && (
                  <div className="digest-source-count">
                    Generated: {new Date(digest.generated_at).toLocaleString('ko-KR')}
                    {digest.sources_used && ` · Sources: ${digest.sources_used.join(', ')}`}
                  </div>
                )}
              </div>
            </div>
          )}

          {view !== 'console' && !digestLoading && digest && digest.status === 'partial' && !showRawData && (
            <div className="news-digest-section">
              <div className="digest-block">
                <p className="digest-text">{digest.raw_summary}</p>
              </div>
            </div>
          )}

          {view !== 'console' && !digestLoading && (!digest || digest.status === 'empty') && !showRawData && (
            <div className="trends-empty">
              <p>No KDCA AI analysis available.</p>
              <p className="news-empty-hint">Upload KDCA data to generate an AI analysis.</p>
            </div>
          )}

          {/* Toggle: AI analysis ↔ Raw Data — console 모드에서는 Refresh 만 노출 */}
          {view !== 'console' && (
            <div style={{ display: 'flex', gap: 8, margin: '6px 10px' }}>
              <button
                className="news-sources-toggle"
                style={{ flex: 1, width: 'auto', margin: 0 }}
                onClick={() => setShowRawData(!showRawData)}
              >
                {showRawData ? 'View AI Analysis' : 'View Raw Data'}
              </button>
              {!showRawData && (
                <button
                  className="news-sources-toggle"
                  style={{ flex: 1, width: 'auto', margin: 0, opacity: digestLoading ? 0.5 : 1 }}
                  onClick={generateDigest}
                  disabled={digestLoading}
                >
                  {digestLoading ? 'Analyzing...' : 'Refresh Analysis'}
                </button>
              )}
            </div>
          )}
          {/* "Refresh AI Analysis" removed — consolidated into AI ANALYZE > KDCA DATA ANALYZE */}

          {/* Raw Data View */}
          {forceRawData && (
            <>
              <div className="kdca-upload-guide">
                <strong>업로드 형식 가이드</strong>
                <p>
                  파일명에 급성호흡기, 인플루엔자, 중증급성 중 하나가 들어가야 parser가 ARI/ILI/SARI lane을 구분합니다.
                  첫 번째 시트 또는 CSV의 주차, 연도, 총계/발생률 열을 기준으로 snapshot을 갱신합니다.
                </p>
              </div>

              {/* 드래그앤드롭 존 */}
              <div
                className={`kdca-dropzone${dragging ? ' kdca-dropzone--active' : ''}`}
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                onClick={() => readOnly ? setStatus('Read-only mode. Operator login is required to upload files.', 'error') : fileInputRef.current?.click()}
                id="kdca-dropzone"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.xlsx,.pdf"
                  onChange={onFileChange}
                  style={{ display: 'none' }}
                  id="kdca-file-input"
                />
                {uploading ? (
                  <div className="kdca-uploading">
                    <div className="news-spinner" />
                    <span>Processing...</span>
                  </div>
                ) : (
                  <>
                    <div className="kdca-dropzone-text">
                      {readOnly ? 'KDCA upload is operator-only' : 'Drop KDCA file here or click to upload'}
                    </div>
                    <div className="kdca-dropzone-hint">{readOnly ? 'Public users can inspect source status and history only.' : 'CSV, XLSX, PDF supported'}</div>
                    <div className="kdca-dropzone-hint">PDF supported: 하수기반 / 표본감시 주간소식지 / 전 세계 감염병 발생 동향</div>
                    <div className="kdca-dropzone-hint" style={{ marginTop: 4, color: '#6366f1' }}>
                      Filename must contain: 급성호흡기, 인플루엔자, 중증급성, 하수기반, 표본감시, or 전 세계 감염병
                    </div>
                  </>
                )}
              </div>

              {/* 폴더 스캔 */}
              <button className="kdca-btn kdca-btn--secondary" onClick={handleScanFolder} disabled={uploading || readOnly}>
                {readOnly ? 'Operator only · Scan disabled' : 'Scan Sentinel_data folder'}
              </button>

              {/* 업로드 결과 */}
              {uploadResult && uploadResult.success && (
                <div className="kdca-result">
                  <div className="kdca-result-row">
                    <span>File type</span>
                    <span className="kdca-result-value">{uploadResult.file_type}</span>
                  </div>
                  <div className="kdca-result-row">
                    <span>Records parsed</span>
                    <span className="kdca-result-value">{uploadResult.records_parsed}</span>
                  </div>
                  <div className="kdca-result-row">
                    <span>Snapshots updated</span>
                    <span className="kdca-result-value">{uploadResult.snapshots_updated}</span>
                  </div>
                </div>
              )}

              {/* 업로드 이력 */}
              {history.length > 0 && (
                <div className="kdca-history">
                  <div className="kdca-section-title">Upload History</div>
                  {history.slice(-5).reverse().map((h, i) => (
                    <div key={i} className="kdca-history-item">
                      <span className="kdca-history-name">{h.filename}</span>
                      <span className="kdca-history-meta">{h.file_type} · {h.snapshot_count} snapshots</span>
                    </div>
                  ))}
                </div>
              )}

              {/* "Generate Weekly AI Report" removed — consolidated into AI ANALYZE > KDCA DATA ANALYZE */}
            </>
          )}
        </div>
      )}

      {/* 보고서 탭 */}
      {activeTab === 'reports' && (
        <div className="kdca-content">
          {reportContent && (
            <div className="kdca-report-preview">
              <div className="kdca-section-title">
                Latest Report Preview
                <button
                  className="kdca-send-btn"
                  onClick={handleSendReport}
                  disabled={sendingEmail || readOnly}
                  id="send-report-btn"
                >
                  {readOnly ? 'Operator only' : sendingEmail ? 'Sending...' : 'Send Email'}
                </button>
              </div>
              <pre className="kdca-report-text">{reportContent}</pre>
            </div>
          )}

          <div className="kdca-section-title">Saved Reports</div>
          {reports.length === 0 ? (
            <div className="trends-empty">
              <p>No reports generated yet.</p>
              <p className="news-empty-hint">Generate an AI report from the Upload tab.</p>
            </div>
          ) : (
            reports.map((r, i) => (
              <div key={i} className="kdca-report-item" onClick={() => handleLoadReport(r.filename)}>
                <div className="kdca-report-name">{r.epiweek}</div>
                <div className="kdca-report-meta">
                  {new Date(r.generated_at).toLocaleDateString('ko-KR')} ·&nbsp;
                  {(r.size_bytes / 1024).toFixed(1)}KB
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* 수신자 탭 삭제 — Report 탭으로 이동 */}
    </div>
  );
}
