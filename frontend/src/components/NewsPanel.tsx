import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

interface NewsItem {
  title: string;
  date: string;
  url?: string;
  publisher?: string;
  source?: string;
  snippet?: string;
  severity?: string;
  is_respiratory?: boolean;
}

interface KeyAlert {
  title: string;
  detail: string;
  severity: string;
}

interface NewsDigest {
  status?: string;
  korea_summary?: string;
  global_summary?: string;
  trends_insight?: string;
  risk_assessment?: string;
  key_alerts?: KeyAlert[];
  source_count?: Record<string, number>;
  generated_at?: string;
  raw_summary?: string;
  message?: string;
}

const DEFAULT_CONFIG = {
  korea_queries_ko: '폐렴 유행\n마이코플라스마 폐렴\n호흡기 감염병\n독감 유행\n코로나 확산\nRSV 유행\n호흡기질환 증가',
  korea_queries_en: 'pneumonia Korea\nrespiratory outbreak South Korea\ninfluenza Korea\nCOVID Korea\nKDCA warning\nmycoplasma Korea\nRSV Korea',
  korea_exclude_ko: '',
  korea_exclude_en: '-journal -study -nature.com -plos -lancet -review -editorial -cureus -"market size" -"market research" -forecast -CAGR',
  global_queries: 'respiratory virus outbreak\npneumonia cluster\ninfluenza surge global\nMERS outbreak\navian influenza H5N1\nRSV wave\nCOVID new variant\nmycoplasma pneumonia outbreak\nWHO respiratory emergency',
  global_exclude: '-journal -study -nature.com -plos -lancet -cureus -review -editorial',
  trends_queries: 'pneumonia\nrespiratory symptoms\nflu\ninfluenza\ncough\nfever\ndyspnea',
  naver_queries: '폐렴\n독감\n기침\n호흡곤란\n발열\n마이코플라스마\nRSV',
};

type ConfigSection = 'korea' | 'global' | 'google_trends' | 'naver_trends';

interface NewsPanelProps {
  // 우측 콘솔의 Keywords Editor로 중복되는 경우 내부 버튼을 숨깁니다.
  hideKeywordsButton?: boolean;
}

export default function NewsPanel({ hideKeywordsButton = false }: NewsPanelProps = {}) {
  const [koreaNews, setKoreaNews] = useState<NewsItem[]>([]);
  const [globalNews, setGlobalNews] = useState<NewsItem[]>([]);
  const [digest, setDigest] = useState<NewsDigest | null>(null);
  const [showRawSources, setShowRawSources] = useState(false);
  const [activeTab, setActiveTab] = useState<'korea' | 'global'>('korea');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  const fetchNews = async () => {
    try {
      const [krRes, glRes] = await Promise.all([
        fetch(`${API_BASE}/news/korea?limit=50`),
        fetch(`${API_BASE}/news/global?limit=50`),
      ]);
      if (krRes.ok) setKoreaNews(await krRes.json());
      if (glRes.ok) setGlobalNews(await glRes.json());
    } catch (e) {
      console.error('News load failed:', e);
    }
  };

  const fetchDigest = async () => {
    try {
      const res = await fetch(`${API_BASE}/risk-analysis/news-digest`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'ok' || data.status === 'partial') setDigest(data);
      }
    } catch (e) {
      console.error('Digest load failed:', e);
    }
  };

  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await Promise.all([fetchNews(), fetchDigest()]);
      setLoading(false);
    };
    init();
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      // 1. Collect fresh news from all sources
      await Promise.all([
        fetch(`${API_BASE}/ingestion/refresh-korea`, { method: 'POST' }),
        fetch(`${API_BASE}/ingestion/refresh-global`, { method: 'POST' }),
      ]);
      // 2. Fetch updated news
      await fetchNews();
      // 3. Generate AI digest
      const res = await fetch(`${API_BASE}/risk-analysis/news-digest`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setDigest(data);
      }
      setLastUpdated(new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }));
    } catch (e) {
      console.error('Refresh failed:', e);
    } finally {
      setRefreshing(false);
    }
  };

  const severityColor = (s?: string) => {
    if (s === 'critical' || s === 'high') return '#ef4444';
    if (s === 'medium') return '#f97316';
    return '#22c55e';
  };

  // Keywords config modal
  const [showConfig, setShowConfig] = useState(false);
  const [configSection, setConfigSection] = useState<ConfigSection>('korea');
  const [configParams, setConfigParams] = useState({ ...DEFAULT_CONFIG });

  const loadConfig = async () => {
    try {
      const res = await fetch(`${API_BASE}/config/keywords`);
      if (res.ok) {
        const data = await res.json();
        const kn = data.korea_news || {};
        const gn = data.global_news || {};
        const tr = data.trends || {};
        const nv = data.naver_trends || {};
        setConfigParams({
          korea_queries_ko: (kn.queries_ko || kn.queries || []).join('\n'),
          korea_queries_en: (kn.queries_en || []).join('\n'),
          korea_exclude_ko: kn.exclude_ko || kn.exclude || '',
          korea_exclude_en: kn.exclude_en || '',
          global_queries: (gn.queries || []).join('\n'),
          global_exclude: gn.exclude || '',
          trends_queries: (tr.queries || []).join('\n'),
          naver_queries: (nv.queries || []).map((g: any) =>
            typeof g === 'string' ? g : g.groupName
          ).join('\n'),
        });
      }
    } catch (e) {
      console.error(e);
    }
  };

  const saveConfig = async () => {
    try {
      const naverGroups = configParams.naver_queries.split('\n').map(s => s.trim()).filter(Boolean).map(name => ({
        groupName: name,
        keywords: [name, `${name} 증상`],
      }));
      const payload = {
        korea_news: {
          queries_ko: configParams.korea_queries_ko.split('\n').map(s => s.trim()).filter(Boolean),
          queries_en: configParams.korea_queries_en.split('\n').map(s => s.trim()).filter(Boolean),
          exclude_ko: configParams.korea_exclude_ko.trim(),
          exclude_en: configParams.korea_exclude_en.trim(),
        },
        global_news: {
          queries: configParams.global_queries.split('\n').map(s => s.trim()).filter(Boolean),
          exclude: configParams.global_exclude.trim(),
        },
        trends: {
          queries: configParams.trends_queries.split('\n').map(s => s.trim()).filter(Boolean),
        },
        naver_trends: { queries: naverGroups },
      };
      await fetch(`${API_BASE}/config/keywords`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setShowConfig(false);
    } catch (e) {
      console.error(e);
    }
  };

  const resetSection = () => {
    setConfigParams(prev => {
      const next = { ...prev };
      if (configSection === 'korea') {
        next.korea_queries_ko = DEFAULT_CONFIG.korea_queries_ko;
        next.korea_queries_en = DEFAULT_CONFIG.korea_queries_en;
        next.korea_exclude_ko = DEFAULT_CONFIG.korea_exclude_ko;
        next.korea_exclude_en = DEFAULT_CONFIG.korea_exclude_en;
      } else if (configSection === 'global') {
        next.global_queries = DEFAULT_CONFIG.global_queries;
        next.global_exclude = DEFAULT_CONFIG.global_exclude;
      } else if (configSection === 'google_trends') {
        next.trends_queries = DEFAULT_CONFIG.trends_queries;
      } else if (configSection === 'naver_trends') {
        next.naver_queries = DEFAULT_CONFIG.naver_queries;
      }
      return next;
    });
  };

  const items = activeTab === 'korea' ? koreaNews : globalNews;
  const totalSources = (digest?.source_count
    ? Object.values(digest.source_count).reduce((a, b) => a + b, 0)
    : koreaNews.length + globalNews.length);
  const sourceTiles = [
    {
      label: '국내 뉴스',
      count: koreaNews.length,
      desc: 'Naver/국내 기사 기반 OSINT',
      tone: 'blue',
    },
    {
      label: 'WHO/국제 뉴스',
      count: globalNews.length,
      desc: '국제 발생 상황은 별도 보조 레이어',
      tone: 'slate',
    },
    {
      label: 'AI digest',
      count: digest?.status === 'ok' ? 'ready' : 'pending',
      desc: '근거 요약과 risk interpretation',
      tone: 'green',
    },
  ];

  return (
    <div className="sidebar-news-panel" id="news-panel">
      <div className="news-panel-header">
        <div className="news-panel-title">
          NEWS
          {lastUpdated && <span className="news-last-updated">{lastUpdated}</span>}
        </div>
        <div className="news-panel-actions">
          <button
            className="news-refresh-btn"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Collect news and generate AI digest"
          >
            {refreshing ? '갱신 중...' : '소스 갱신'}
          </button>
        </div>
      </div>

      <div className="news-source-overview">
        {sourceTiles.map((tile) => (
          <div className={`news-source-tile tone-${tile.tone}`} key={tile.label}>
            <span>{tile.label}</span>
            <strong>{tile.count}</strong>
            <small>{tile.desc}</small>
          </div>
        ))}
      </div>

      {/* AI Digest View */}
      <div className="news-digest-section">
        {loading ? (
          <div className="news-loading">
            <div className="news-spinner" />
            <span>Loading...</span>
          </div>
        ) : refreshing ? (
          <div className="news-loading">
            <div className="news-spinner" />
            <span>Collecting news and generating AI summary...</span>
          </div>
        ) : digest && digest.status === 'ok' ? (
          <div className="news-digest-content">
            {digest.korea_summary && (
              <div className="digest-block">
                <div className="digest-block-title">국내 신호 요약 / Korea</div>
                <p className="digest-text">{digest.korea_summary}</p>
              </div>
            )}
            {digest.global_summary && (
              <div className="digest-block">
                <div className="digest-block-title">WHO/국제 뉴스 보조 신호</div>
                <p className="digest-text">{digest.global_summary}</p>
              </div>
            )}
            {digest.trends_insight && (
              <div className="digest-block">
                <div className="digest-block-title">검색 트렌드 인사이트</div>
                <p className="digest-text">{digest.trends_insight}</p>
              </div>
            )}
            {digest.risk_assessment && (
              <div className="digest-block digest-risk">
                <div className="digest-block-title">AI 위험 해석</div>
                <p className="digest-text">{digest.risk_assessment}</p>
              </div>
            )}
            {digest.key_alerts && digest.key_alerts.length > 0 && (
              <div className="digest-alerts">
                {digest.key_alerts.map((alert, i) => (
                  <div key={i} className="digest-alert-item">
                    <span className="digest-alert-dot" style={{ background: severityColor(alert.severity) }} />
                    <div>
                      <strong>{alert.title}</strong>
                      <p className="digest-alert-detail">{alert.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {digest.source_count && (
              <div className="digest-source-count">
                Source ledger: Naver {digest.source_count.naver_news || 0} | EN {digest.source_count.english_news || 0} | International news {digest.source_count.global_news || 0} | WHO {digest.source_count.who_don || 0}
              </div>
            )}
          </div>
        ) : digest && digest.status === 'partial' ? (
          <div className="digest-block">
            <p className="digest-text">{digest.raw_summary}</p>
          </div>
        ) : (
          <div className="news-empty">
            <p>AI digest가 아직 없습니다</p>
            <p className="news-empty-hint">소스 갱신을 누르면 뉴스 수집과 AI 요약을 실행합니다.</p>
          </div>
        )}
      </div>

      {/* Raw Sources Toggle */}
      <button
        className="news-sources-toggle"
        onClick={() => setShowRawSources(!showRawSources)}
      >
        {showRawSources ? '원천 기사 숨기기' : `원천 기사 보기 (${totalSources})`}
      </button>

      {showRawSources && (
        <>
          <div className="news-tabs">
            <button
              className={`news-tab${activeTab === 'korea' ? ' news-tab--active' : ''}`}
              onClick={() => setActiveTab('korea')}
            >
              국내 뉴스
              <span className="news-tab-count">{koreaNews.length}</span>
            </button>
            <button
              className={`news-tab${activeTab === 'global' ? ' news-tab--active' : ''}`}
              onClick={() => setActiveTab('global')}
            >
              WHO/국제 뉴스
              <span className="news-tab-count">{globalNews.length}</span>
            </button>
          </div>

          <div className="news-list">
            {items.length === 0 ? (
              <div className="news-empty">
                <p>수집된 뉴스가 없습니다</p>
              </div>
            ) : (
              items.map((item, i) => (
                <div key={i} className="news-item">
                  {item.severity && (
                    <div className="news-severity-bar" style={{ background: severityColor(item.severity) }} />
                  )}
                  <div className="news-item-content">
                    <div className="news-item-meta">
                      <span className="news-date">{item.date}</span>
                      <span className="news-source">{item.publisher || item.source || 'Unknown'}</span>
                      {item.source === 'who_don' && <span className="news-badge-who">WHO</span>}
                      {item.source === 'naver_news' && <span className="news-badge-naver">Naver</span>}
                    </div>
                    {item.url ? (
                      <a className="news-title" href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a>
                    ) : (
                      <p className="news-title">{item.title}</p>
                    )}
                    {item.snippet && <p className="news-snippet">{item.snippet}</p>}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}

      <button
        id="news-panel-keywords-btn"
        className="apply-btn news-panel-keywords-btn-internal"
        style={{ margin: '10px', width: 'calc(100% - 20px)', display: hideKeywordsButton ? 'none' : undefined }}
        onClick={() => { loadConfig(); setShowConfig(true); }}
      >
        키워드 설정
      </button>

      {showConfig && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ width: '600px' }}>
            <div className="modal-header">
              <h3 className="modal-title">키워드 설정</h3>
              <button className="modal-close-btn" onClick={() => setShowConfig(false)}>x</button>
            </div>
            <div className="news-tabs" style={{ padding: '0 16px', background: 'var(--bg-soft)' }}>
              {([
                ['korea', '국내 뉴스'],
                ['global', 'WHO/국제 뉴스'],
                ['google_trends', 'Google Trends'],
                ['naver_trends', 'Naver Trends'],
              ] as [ConfigSection, string][]).map(([key, label]) => (
                <button
                  key={key}
                  className={`news-tab ${configSection === key ? 'news-tab--active' : ''}`}
                  onClick={() => setConfigSection(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="modal-body">
              {configSection === 'korea' && (
                <div>
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <div style={{ flex: 1 }}>
                      <label className="meta-label">Korean Keywords (Naver)</label>
                      <textarea className="keyword-textarea" value={configParams.korea_queries_ko}
                        onChange={e => setConfigParams({ ...configParams, korea_queries_ko: e.target.value })} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label className="meta-label">English Keywords (NewsAPI)</label>
                      <textarea className="keyword-textarea" value={configParams.korea_queries_en}
                        onChange={e => setConfigParams({ ...configParams, korea_queries_en: e.target.value })} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
                    <div style={{ flex: 1 }}>
                      <label className="meta-label">Korean Exclusions</label>
                      <textarea className="keyword-textarea" style={{ height: '36px' }} value={configParams.korea_exclude_ko}
                        onChange={e => setConfigParams({ ...configParams, korea_exclude_ko: e.target.value })} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label className="meta-label">English Exclusions</label>
                      <textarea className="keyword-textarea" style={{ height: '36px' }} value={configParams.korea_exclude_en}
                        onChange={e => setConfigParams({ ...configParams, korea_exclude_en: e.target.value })} />
                    </div>
                  </div>
                </div>
              )}
              {configSection === 'global' && (
                <div>
                  <label className="meta-label">WHO/International Keywords (line-separated)</label>
                  <textarea className="keyword-textarea" value={configParams.global_queries}
                    onChange={e => setConfigParams({ ...configParams, global_queries: e.target.value })} />
                  <label className="meta-label" style={{ marginTop: '8px', display: 'block' }}>Exclusions</label>
                  <textarea className="keyword-textarea" style={{ height: '36px' }} value={configParams.global_exclude}
                    onChange={e => setConfigParams({ ...configParams, global_exclude: e.target.value })} />
                </div>
              )}
              {configSection === 'google_trends' && (
                <div>
                  <label className="meta-label">Google Trends Keywords (English, geo=KR)</label>
                  <textarea className="keyword-textarea" value={configParams.trends_queries}
                    onChange={e => setConfigParams({ ...configParams, trends_queries: e.target.value })} />
                </div>
              )}
              {configSection === 'naver_trends' && (
                <div>
                  <label className="meta-label">Naver Trends Keywords (Korean)</label>
                  <textarea className="keyword-textarea" value={configParams.naver_queries}
                    onChange={e => setConfigParams({ ...configParams, naver_queries: e.target.value })} />
                </div>
              )}
            </div>
            <div className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <button className="modal-btn-cancel" onClick={resetSection} style={{ color: 'var(--text-muted)' }}>
                Reset to Default
              </button>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="modal-btn-cancel" onClick={() => setShowConfig(false)}>Cancel</button>
                <button className="modal-btn-save" onClick={saveConfig}>Save Settings</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
