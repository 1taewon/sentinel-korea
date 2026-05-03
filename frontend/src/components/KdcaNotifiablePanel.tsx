import { useEffect, useMemo, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

type DiseaseRow = {
  disease: string;
  category?: string;
  is_respiratory_virus?: boolean;
  total: number;
  domestic: number;
  imported: number;
};

type WeeklyRow = {
  epiweek: string;
  period: string;
  total: number;
  domestic: number;
  imported: number;
  normalized_score?: number;
  diseases?: DiseaseRow[];
};

type NotifiablePayload = {
  status: string;
  definition?: string;
  source?: string;
  scope?: string;
  year?: number;
  latest_epiweek?: string;
  latest_period?: string;
  all_record_count?: number;
  respiratory_record_count?: number;
  respiratory_virus_record_count?: number;
  all_weekly?: WeeklyRow[];
  respiratory_weekly?: WeeklyRow[];
  respiratory_virus_weekly?: WeeklyRow[];
  respiratory_diseases?: string[];
  respiratory_virus_diseases?: string[];
  validation?: {
    mismatch_count?: number;
    period_basic_records?: number;
  };
};

const fmt = (value?: number) => Math.round(value || 0).toLocaleString('ko-KR');

function buildMap(rows?: WeeklyRow[]) {
  return new Map((rows || []).map((row) => [row.epiweek, row]));
}

function diseaseSummary(row?: WeeklyRow, empty = '발생 없음') {
  const diseases = (row?.diseases || []).filter((item) => item.total > 0).slice(0, 4);
  if (!diseases.length) return empty;
  return diseases.map((item) => `${item.disease} ${fmt(item.total)}`).join(' · ');
}

type KdcaNotifiablePanelProps = {
  readOnly?: boolean;
  getAdminHeaders?: (json?: boolean) => Promise<HeadersInit>;
};

export default function KdcaNotifiablePanel({ readOnly = false, getAdminHeaders }: KdcaNotifiablePanelProps) {
  const [data, setData] = useState<NotifiablePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const fetchData = async () => {
    setError('');
    try {
      const res = await fetch(`${API_BASE}/ingestion/kdca-notifiable`);
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.detail || 'KDCA notifiable fetch failed');
      setData(payload);
    } catch {
      setError('Could not load Notifiable Disease (KDCA API) weekly data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const refresh = async () => {
    if (readOnly) {
      setError('Read-only mode. Only the Sentinel operator can refresh Notifiable Disease (KDCA API) data.');
      return;
    }
    setRefreshing(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/ingestion/refresh-kdca-notifiable`, { method: 'POST', headers: await getAdminHeaders?.(false) });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.detail || 'KDCA API refresh failed');
      await fetchData();
    } catch {
      setError('Notifiable Disease (KDCA API) refresh failed. Check the API key, network, and public data endpoint status.');
    } finally {
      setRefreshing(false);
    }
  };

  const rows = useMemo(() => {
    const respiratory = buildMap(data?.respiratory_weekly);
    const virus = buildMap(data?.respiratory_virus_weekly);
    return [...(data?.all_weekly || [])]
      .sort((a, b) => (b.epiweek || '').localeCompare(a.epiweek || ''))
      .map((all) => ({
        all,
        respiratory: respiratory.get(all.epiweek),
        virus: virus.get(all.epiweek),
      }));
  }, [data]);

  if (loading) {
    return (
      <div className="notifiable-panel notifiable-panel--loading">
        <div className="news-spinner" />
        <span>Loading Notifiable Disease (KDCA API) data...</span>
      </div>
    );
  }

  return (
    <div className="notifiable-panel">
      <div className="notifiable-header">
        <div>
          <span className="notifiable-kicker">KDCA EIDAPI</span>
          <h4>Notifiable Disease (KDCA API)</h4>
          <p>
            {data?.definition ||
              'Notifiable Disease (KDCA API) contains weekly legally notifiable infectious disease records. Sentinel keeps the full source payload and separately parses respiratory subsets.'}
          </p>
        </div>
        <button className="notifiable-refresh-btn" onClick={refresh} disabled={refreshing}>
          {refreshing ? '갱신 중...' : 'Real data 갱신'}
        </button>
      </div>

      <div className="notifiable-scope-note">
        <strong>중요한 해석</strong>
        <span>
          PeriodRegion은 현재 17개 시도별 값이 아니라 전국 주차별 발생값에 국내/해외유입 값을 붙인 API입니다.
          따라서 지역별 경보는 ILI/ARI/SARI xlsx/csv와 폐하수 지역자료를 파싱해 보강해야 합니다.
        </span>
      </div>

      {error && <div className="kdca-status kdca-status--error">{error}</div>}

      <div className="notifiable-metrics">
        <div>
          <span>최신 주차</span>
          <strong>{data?.latest_period || data?.latest_epiweek || 'n/a'}</strong>
        </div>
        <div>
          <span>All Notifiable Disease (KDCA API) rows</span>
          <strong>{fmt(data?.all_record_count)}</strong>
        </div>
        <div>
          <span>호흡기 관련 rows</span>
          <strong>{fmt(data?.respiratory_record_count)}</strong>
        </div>
        <div>
          <span>호흡기/공기전파 바이러스 rows</span>
          <strong>{fmt(data?.respiratory_virus_record_count)}</strong>
        </div>
        <div>
          <span>PeriodBasic 검산</span>
          <strong>{data?.validation?.mismatch_count === 0 ? '0 mismatch' : `${data?.validation?.mismatch_count ?? 'n/a'} mismatch`}</strong>
        </div>
      </div>

      <div className="notifiable-subsets">
        <div>
          <span>Sentinel 호흡기 관련 파싱 목록</span>
          <p>{(data?.respiratory_diseases || []).join(', ') || '아직 없음'}</p>
        </div>
        <div>
          <span>호흡기/공기전파 바이러스 subset</span>
          <p>{(data?.respiratory_virus_diseases || []).join(', ') || '아직 없음'}</p>
        </div>
      </div>

      <div className="notifiable-table-wrap">
        <table className="notifiable-table">
          <thead>
            <tr>
              <th>주차</th>
              <th>All Notifiable Disease (KDCA API)</th>
              <th>호흡기 관련</th>
              <th>호흡기/공기전파 바이러스</th>
              <th>해외유입</th>
              <th>주요 호흡기 질환</th>
              <th>바이러스 subset</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ all, respiratory, virus }) => (
              <tr key={all.epiweek}>
                <td>
                  <strong>{all.period || all.epiweek}</strong>
                  <small>{all.epiweek}</small>
                </td>
                <td>{fmt(all.total)}</td>
                <td>{fmt(respiratory?.total)}</td>
                <td>{fmt(virus?.total)}</td>
                <td>{fmt(all.imported)}</td>
                <td>{diseaseSummary(respiratory)}</td>
                <td>{diseaseSummary(virus, '바이러스 발생 없음')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="trends-empty">
            <p>No Notifiable Disease (KDCA API) data is available yet.</p>
            <p className="news-empty-hint">Use Refresh Notifiable Disease (KDCA API) to collect PeriodRegion data.</p>
          </div>
        )}
      </div>
    </div>
  );
}
