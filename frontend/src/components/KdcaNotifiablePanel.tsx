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

export default function KdcaNotifiablePanel() {
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
      setError('KDCA 법정감염병 주차별 데이터를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/ingestion/refresh-kdca-notifiable`, { method: 'POST' });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.detail || 'KDCA API refresh failed');
      await fetchData();
    } catch {
      setError('KDCA 법정감염병 API 갱신에 실패했습니다. API key, 네트워크, 공공데이터포털 상태를 확인하세요.');
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
        <span>KDCA 법정감염병 real data 로딩 중...</span>
      </div>
    );
  }

  return (
    <div className="notifiable-panel">
      <div className="notifiable-header">
        <div>
          <span className="notifiable-kicker">KDCA EIDAPI REAL DATA</span>
          <h4>법정감염병(Notifiable disease) 주차별 원자료</h4>
          <p>
            {data?.definition ||
              '법정감염병은 법률에 따라 신고·감시되는 감염병입니다. Sentinel은 전체 원자료를 보관하고 호흡기 관련 subset만 별도 파싱합니다.'}
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
          <span>전체 법정감염병 rows</span>
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
              <th>전체 법정감염병</th>
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
            <p>아직 KDCA 법정감염병 API real data가 없습니다.</p>
            <p className="news-empty-hint">Real data 갱신 버튼을 눌러 PeriodRegion 데이터를 수집하세요.</p>
          </div>
        )}
      </div>
    </div>
  );
}
