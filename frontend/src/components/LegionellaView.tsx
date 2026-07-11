import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.heat';

// ─── Legionella surveillance (전국) — risk map + investigation hotspots ──────
// (A) 상시 위험지도: 냉각탑(위성 수동 판독) + 목욕장업 + 고위험 병원 + PHWR 위험 히트맵.
// (B) 사건 대응: 비식별 조사서 업로드 → Gemini 파싱 → 공통 노출원 → 조사 우선순위 Hotspot.
// No ML/GPU. 위험 히트맵 = 환경 오염 경향(환자 발생 예측 아님). 합성·비식별 데모.
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const CENTER: [number, number] = [36.4, 127.9]; // 전국
const ZOOM = 7;
// Cooling towers are manual satellite reads (no national registry). Start empty at the
// national view; digitise per area, or the investigation flies to the surveyed region.
const SAMPLE_TOWERS: [number, number][] = [];
const TOWER_WEIGHT = 0.5;

function bathWeight(s: string): number {
  s = s || '';
  if (s.includes('온천')) return 0.394; if (s.includes('찜질')) return 0.375;
  if (s.includes('대형')) return 0.328; return 0.164;
}
function hospWeight(s: string): number {
  s = s || '';
  if (s.includes('상급종합')) return 0.35; if (s.includes('종합병원') || s === '종합') return 0.263;
  if (s.includes('요양')) return 0.20; return 0.164;
}

type LL = [number, number];
type Pt = { ll: LL; w: number; name: string; sub: string };
type Plan = { rank: number; center: [number, number]; radius_m: number; cooling_tower_count: number;
  high_risk_facility_count: number; linked_case_count: number; facilities: string[] };

// muted route colours (지역사회=teal, 의료기관=red, 여행=amber) — kept low-key, not loud.
function routeColor(label: string): string {
  if ((label || '').includes('의료기관')) return '#dc2626';
  if ((label || '').includes('여행')) return '#d97706';
  return '#0891b2';
}

// Analysing loader for the 예시 분석 tab (mirrors the Forecasting "분석 중입니다" loader).
function ExampleAnalyzing() {
  const steps = ['조사서 비식별·파싱 (G-6/Z)', '추정감염지역 지오코딩', '노출 시간창 공통 노출원 매칭', 'KDE 조사 우선순위 산출'];
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStep((s) => (s + 1) % steps.length), 1200);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="whatif-analyzing" style={{ padding: '22px 6px' }}>
      <div className="whatif-analyzing-orbit"><span /><span /><span /></div>
      <div className="whatif-analyzing-title">분석 중입니다</div>
      <div className="whatif-analyzing-step">{steps[step]}…</div>
      <div className="whatif-analyzing-sub">합성 조사서 4건을 파싱해 공통 노출원과 조사 우선순위를 산출하고 있습니다.</div>
    </div>
  );
}

export default function LegionellaView() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const satRef = useRef<L.TileLayer | null>(null);
  const hybRef = useRef<L.TileLayer | null>(null);
  const towerLayer = useRef<L.LayerGroup>(L.layerGroup());
  const bathLayer = useRef<L.LayerGroup>(L.layerGroup());
  const hospLayer = useRef<L.LayerGroup>(L.layerGroup());
  const caseLayer = useRef<L.LayerGroup>(L.layerGroup());
  const hotspotLayer = useRef<L.LayerGroup>(L.layerGroup());
  const heatRef = useRef<L.Layer | null>(null);
  const towers = useRef<LL[]>([]);
  const baths = useRef<Pt[]>([]);
  const hospitals = useRef<Pt[]>([]);

  const [status, setStatus] = useState('지도를 불러오는 중…');
  const [counts, setCounts] = useState({ towers: 0, baths: 0, hospitals: 0, cases: 0 });
  const [addMode, setAddMode] = useState(true);
  const [plan, setPlan] = useState<Plan[]>([]);
  const [uploadMsg, setUploadMsg] = useState('');
  const [uploading, setUploading] = useState(false);
  const [mode, setMode] = useState<'map' | 'example'>('map');
  const [exLoading, setExLoading] = useState(false);
  const [exResult, setExResult] = useState<any>(null);
  const [vis, setVis] = useState({ satellite: true, hybrid: true, towers: true, baths: true, hospitals: true, heat: true, cases: true, hotspot: true });
  const visRef = useRef(vis); visRef.current = vis;
  const addModeRef = useRef(addMode); addModeRef.current = addMode;

  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    const map = L.map(mapEl.current, { center: CENTER, zoom: ZOOM, minZoom: 6, maxZoom: 19, preferCanvas: true });
    mapRef.current = map;
    (async () => {
      let key = '';
      try { key = (await (await fetch(`${API_BASE}/config/vworld-key`)).json()).vworld_key || ''; } catch { /* */ }
      if (!key) { setStatus('VWORLD_KEY 미설정 — 백엔드 환경변수 VWORLD_KEY를 확인하세요.'); return; }
      satRef.current = L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${key}/Satellite/{z}/{y}/{x}.jpeg`,
        { maxZoom: 19, attribution: 'Imagery © V-World (국토교통부)' }).addTo(map);
      hybRef.current = L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${key}/Hybrid/{z}/{y}/{x}.png`, { maxZoom: 19 }).addTo(map);
      [towerLayer, bathLayer, hospLayer, caseLayer, hotspotLayer].forEach((l) => l.current.addTo(map));
      setStatus('');
      await loadTowers(); await loadFacilities(); renderAll(); rebuildHeat();
      loadState(); // existing cases (if any)
    })();
    map.on('click', (e: L.LeafletMouseEvent) => {
      if (!visRef.current.towers || !addModeRef.current) return;
      towers.current.push([e.latlng.lat, e.latlng.lng]); renderTowers(); rebuildHeat();
    });
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toLL = (gj: any): any[] =>
    (gj?.features ?? []).filter((f: any) => f?.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates))
      .map((f: any) => ({ ll: [f.geometry.coordinates[1], f.geometry.coordinates[0]] as LL, props: f.properties || {} }));

  async function loadTowers() {
    try { const r = await fetch('/data/cooling_towers.geojson', { cache: 'no-store' });
      if (r.ok) { const a = toLL(await r.json()).map((x) => x.ll); towers.current = a.length ? a : [...SAMPLE_TOWERS]; return; } } catch { /* */ }
    towers.current = [...SAMPLE_TOWERS];
  }
  async function loadFacilities() {
    try { const r = await fetch('/data/facilities_bath.geojson', { cache: 'no-store' });
      if (r.ok) baths.current = toLL(await r.json()).map((x) => ({ ll: x.ll, name: x.props.name || '목욕장업', sub: x.props.subtype || '목욕장업', w: bathWeight(x.props.subtype || '') })); } catch { /* */ }
    try { const r = await fetch('/data/facilities_hospital.geojson', { cache: 'no-store' });
      if (r.ok) hospitals.current = toLL(await r.json()).map((x) => ({ ll: x.ll, name: x.props.name || '병원', sub: x.props.clCdNm || '병원', w: hospWeight(x.props.clCdNm || '') })); } catch { /* */ }
  }

  function renderTowers() {
    const layer = towerLayer.current; layer.clearLayers();
    towers.current.forEach((ll, i) => {
      const m = L.circleMarker(ll, { radius: 7, color: '#fff', weight: 1.5, fillColor: '#ef4444', fillOpacity: 0.9 });
      m.bindTooltip('냉각탑 (위성 판독 · 클릭 시 삭제)', { direction: 'top' });
      m.on('click', (ev) => { L.DomEvent.stopPropagation(ev as any); towers.current.splice(i, 1); renderTowers(); rebuildHeat(); });
      m.addTo(layer);
    });
    setCounts((c) => ({ ...c, towers: towers.current.length }));
  }
  function renderAll() {
    renderTowers();
    const bl = bathLayer.current; bl.clearLayers();
    baths.current.forEach((p) => L.circleMarker(p.ll, { radius: 5, color: '#fff', weight: 1, fillColor: '#22d3ee', fillOpacity: 0.85 })
      .bindTooltip(`${p.name} · ${p.sub}`, { direction: 'top' }).addTo(bl));
    const hl = hospLayer.current; hl.clearLayers();
    hospitals.current.forEach((p) => L.circleMarker(p.ll, { radius: 8, color: '#fff', weight: 1.5, fillColor: '#f59e0b', fillOpacity: 0.9 })
      .bindTooltip(`고위험: ${p.name} · ${p.sub}`, { direction: 'top' }).addTo(hl));
    setCounts((c) => ({ ...c, towers: towers.current.length, baths: baths.current.length, hospitals: hospitals.current.length }));
  }
  function rebuildHeat() {
    const map = mapRef.current; if (!map) return;
    if (heatRef.current) { map.removeLayer(heatRef.current); heatRef.current = null; }
    const pts: [number, number, number][] = [
      ...towers.current.map((ll) => [ll[0], ll[1], TOWER_WEIGHT] as [number, number, number]),
      ...baths.current.map((p) => [p.ll[0], p.ll[1], p.w] as [number, number, number]),
      ...hospitals.current.map((p) => [p.ll[0], p.ll[1], p.w] as [number, number, number]),
    ];
    heatRef.current = (L as any).heatLayer(pts, { radius: 30, blur: 20, maxZoom: 16, max: 0.5, minOpacity: 0.22,
      gradient: { 0.2: '#22d3ee', 0.4: '#84cc16', 0.6: '#facc15', 0.8: '#f97316', 1.0: '#dc2626' } });
    if (visRef.current.heat) heatRef.current!.addTo(map);
  }

  // ── investigation (cases + hotspots) ─────────────────────────────────────
  function applyInvestigation(d: any, focus = true) {
    // Results must always be visible when produced — re-attach the case/hotspot layers even
    // if the user had toggled them off (otherwise upload/example render into detached groups).
    [caseLayer, hotspotLayer].forEach((l) => {
      if (mapRef.current && !mapRef.current.hasLayer(l.current)) mapRef.current.addLayer(l.current);
    });
    setVis((v) => (v.cases && v.hotspot ? v : { ...v, cases: true, hotspot: true }));
    const pts: [number, number][] = [];
    const cl = caseLayer.current; cl.clearLayers();
    (d.case_results || []).forEach((cr: any) => {
      if (cr.location) pts.push([cr.location[1], cr.location[0]]);
      if (!cr.location) return;
      const ll: LL = [cr.location[1], cr.location[0]];
      const cands = (cr.exposure_candidates || []).slice(0, 4).map((x: any) => `${x.name}(${x.dist_m}m)`).join(', ') || '반경 내 없음';
      L.circleMarker(ll, { radius: 6, color: '#fff', weight: 1.5, fillColor: '#a855f7', fillOpacity: 0.95 })
        .bindPopup(`<b>케이스 ${cr.id}</b> · 발병 ${cr.onset_date || '?'}<br/>추정감염경로(초안): <b>${cr.route?.label || '-'}</b><br/><small>${cr.route?.reason || ''}</small><br/>노출후보: ${cands}`)
        .addTo(cl);
    });
    const hl = hotspotLayer.current; hl.clearLayers();
    (d.hotspots?.features || []).forEach((f: any) => {
      const pr = f.properties; const c: [number, number] = [f.geometry.coordinates[1], f.geometry.coordinates[0]];
      pts.push(c);
      const color = pr.rank === 1 ? '#dc2626' : pr.rank === 2 ? '#f97316' : '#f59e0b';
      L.circle(c, { radius: pr.radius_m, color, weight: 2, fillColor: color, fillOpacity: 0.14, dashArray: '4 4' })
        .bindPopup(`<b>조사 우선순위 ${pr.rank}위</b> (점수 ${pr.score})<br/>권장 조사 반경 ${pr.radius_m}m<br/>냉각탑 ${pr.cooling_towers.length} · 고위험시설 ${pr.facilities.length} · 관련 케이스 ${pr.linked_case_count}<br/><small>환경검사 우선순위 제안이며 확정 감염원 아님. 채수·배양 일치로 확정.</small>`)
        .addTo(hl);
      L.marker(c, { icon: L.divIcon({ className: '', html: `<div class="hotspot-badge" style="background:${color}">${pr.rank}</div>`, iconSize: [22, 22] }) }).addTo(hl);
    });
    setPlan(d.hotspots?.plan || []);
    setCounts((c) => ({ ...c, cases: (d.cases || []).length }));
    if (focus && pts.length && mapRef.current) {  // fly to the surveyed region
      mapRef.current.fitBounds(L.latLngBounds(pts).pad(0.5), { maxZoom: 14 });
    }
  }

  async function loadState() {
    try {
      const q = `?cooling_towers=${encodeURIComponent(JSON.stringify(towers.current))}`;
      const d = await (await fetch(`${API_BASE}/surveillance/state${q}`)).json();
      if ((d.cases || []).length) applyInvestigation(d, false);
    } catch { /* */ }
  }

  async function uploadFiles(fileList: File[]) {
    if (!fileList.length) return;
    setUploading(true); setUploadMsg('업로드·분석 중… (Gemini 파싱)');
    const fd = new FormData();
    fileList.forEach((f) => fd.append('files', f));
    fd.append('cooling_towers', JSON.stringify(towers.current));
    try {
      const d = await (await fetch(`${API_BASE}/surveillance/parse-survey`, { method: 'POST', body: fd })).json();
      applyInvestigation(d);
      setUploadMsg(`분석 완료 — 케이스 ${(d.cases || []).length}건, 조사 우선순위 ${(d.hotspots?.features || []).length}개`);
    } catch { setUploadMsg('업로드·분석 실패'); }
    setUploading(false);
  }
  // 예시 분석: pre-warmed, stateless synthetic demo (non-admin judges see it instantly).
  async function runExample() {
    setMode('example');
    if (exResult) { applyInvestigation(exResult, true); return; }  // cached (also re-shows layers)
    if (exLoading) return;
    setExLoading(true);
    try {
      const d = await (await fetch(`${API_BASE}/surveillance/example`)).json();
      setExResult(d);
      applyInvestigation(d, true);
    } catch { /* leave loader off; note stays visible */ }
    setExLoading(false);
  }
  async function resetCases() {
    try { await fetch(`${API_BASE}/surveillance/reset`, { method: 'POST' }); } catch { /* */ }
    caseLayer.current.clearLayers(); hotspotLayer.current.clearLayers();
    setPlan([]); setCounts((c) => ({ ...c, cases: 0 })); setUploadMsg('초기화됨');
  }

  const toggle = (k: keyof typeof vis) => {
    const next = { ...vis, [k]: !vis[k] }; setVis(next);
    const map = mapRef.current; if (!map) return;
    const lyr: L.Layer | null = k === 'satellite' ? satRef.current : k === 'hybrid' ? hybRef.current
      : k === 'towers' ? towerLayer.current : k === 'baths' ? bathLayer.current : k === 'hospitals' ? hospLayer.current
      : k === 'heat' ? heatRef.current : k === 'cases' ? caseLayer.current : hotspotLayer.current;
    if (!lyr) return; if (next[k]) map.addLayer(lyr); else map.removeLayer(lyr);
  };
  const flyTo = (p: Plan) => mapRef.current?.flyTo([p.center[1], p.center[0]], 15);
  const saveGeoJSON = () => {
    const fc = { type: 'FeatureCollection', features: towers.current.map((ll, i) => ({
      type: 'Feature', properties: { id: i + 1, source: 'manual_satellite_read', layer: 'cooling_tower' },
      geometry: { type: 'Point', coordinates: [ll[1], ll[0]] } })) };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(fc, null, 2)], { type: 'application/json' }));
    a.download = 'cooling_towers.geojson'; a.click(); URL.revokeObjectURL(a.href);
  };

  const onDrop = (e: React.DragEvent) => { e.preventDefault(); uploadFiles(Array.from(e.dataTransfer.files)); };

  return (
    <div className="legionella-view">
      <div className="legionella-map" ref={mapEl} />
      <div className="legionella-panel">
        <div className="legionella-title">Legionella surveillance · 전국</div>
        <div className="legionella-sub">전국 위성 위험지도 + 비식별 조사서 → 지역 조사 우선순위</div>

        <div className="legionella-modes">
          <button type="button" className={mode === 'map' ? 'is-active' : ''} onClick={() => setMode('map')}>위험지도</button>
          <button type="button" className={mode === 'example' ? 'is-active' : ''} onClick={runExample}>예시 분석</button>
        </div>

        {mode === 'map' && (<>
          <div className="legionella-group">
            <div className="legionella-group-title">레이어</div>
            {([
              ['satellite', '위성영상'], ['hybrid', '라벨'], ['towers', `냉각탑 (${counts.towers})`],
              ['baths', `목욕장업 (${counts.baths})`], ['hospitals', `고위험 병원 (${counts.hospitals})`],
              ['heat', '위험 히트맵'], ['cases', `역학조사 케이스 (${counts.cases})`], ['hotspot', '조사 우선순위(Hotspot)'],
            ] as [keyof typeof vis, string][]).map(([k, label]) => (
              <label key={k} className="legionella-check"><input type="checkbox" checked={vis[k]} onChange={() => toggle(k)} /> {label}</label>
            ))}
          </div>

          <div className="legionella-group">
            <div className="legionella-group-title">냉각탑 디지타이징</div>
            <label className="legionella-check"><input type="checkbox" checked={addMode} onChange={(e) => setAddMode(e.target.checked)} /> 지도 클릭으로 추가</label>
            <div className="legionella-hint">마커 클릭=삭제. 지도 클릭=추가.</div>
            <button type="button" className="legionella-btn" onClick={saveGeoJSON}>GeoJSON 저장 ({counts.towers})</button>
          </div>

          <div className="legionella-group" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
            <div className="legionella-group-title">역학조사서 업로드 (비식별)</div>
            <div className="legionella-dropzone">
              <input type="file" multiple accept=".txt,.md,.csv,.docx,.pdf" disabled={uploading}
                onChange={(e) => uploadFiles(Array.from(e.target.files || []))} />
              <span>파일 선택 · 드래그앤드롭 (.txt/.csv/.docx/.pdf)</span>
            </div>
            <div className="legionella-row2">
              <button type="button" className="legionella-btn ghost" onClick={resetCases} disabled={uploading}>케이스 초기화</button>
            </div>
            {uploadMsg && <div className="legionella-upmsg">{uploadMsg}</div>}
            <div className="legionella-hint warn">개인정보(성명·주민번호·주소·연락처)가 제거된 비식별 조사서만 업로드. 합성·비식별 데모.</div>
          </div>
        </>)}

        {mode === 'example' && (
          <div className="legionella-group">
            <div className="legionella-group-title">예시 분석 · 합성 조사서 4건</div>
            {exLoading && <ExampleAnalyzing />}
            {!exLoading && exResult && (<>
              {exResult.narrative?.convergence && (
                <div className="leg-ex-finding">
                  <div className="leg-ex-finding-title">핵심 발견 · 공통 노출후보 수렴</div>
                  <div className="leg-ex-finding-body">
                    케이스 {exResult.narrative.convergence.linked_case_count}건의 노출후보가 조사 1순위 지점(반경 {exResult.narrative.convergence.radius_m}m · 고위험시설 {exResult.narrative.convergence.high_risk_facility_count}곳)에 수렴 — {(exResult.narrative.convergence.facilities || []).slice(0, 3).join(', ')} 등 동일 목욕장 밀집지. <em>확정 감염원 아님(채수·배양 일치로 확정).</em>
                  </div>
                </div>
              )}
              <div className="leg-ex-caption">추정 감염경로(초안) · 규칙 기반</div>
              <div className="leg-ex-routes">
                {Object.entries(exResult.narrative?.route_summary || {}).map(([label, cnt]) => (
                  <span className="leg-ex-route-chip" key={label}><i style={{ background: routeColor(label) }} />{label} {cnt as number}</span>
                ))}
              </div>
              <div className="leg-ex-cases">
                {(exResult.case_results || []).map((cr: any) => (
                  <button type="button" key={cr.id} className="leg-ex-case"
                    onClick={() => cr.location && mapRef.current?.flyTo([cr.location[1], cr.location[0]], 14)}>
                    <span className="leg-ex-case-top">
                      <span className="leg-ex-case-id">케이스 {cr.id}</span>
                      <span className="leg-ex-route" style={{ color: routeColor(cr.route?.label || '') }}>{cr.route?.label || '-'}</span>
                    </span>
                    <span className="leg-ex-case-meta">발병 {cr.onset_date || '?'} · 노출후보 {(cr.exposure_candidates || []).length}개</span>
                  </button>
                ))}
              </div>
              <button type="button" className="legionella-btn ghost" onClick={() => applyInvestigation(exResult, true)}>지도에 다시 표시</button>
            </>)}
            {!exLoading && !exResult && (
              <div className="legionella-hint">예시 분석을 불러오지 못했습니다.
                <button type="button" className="legionella-btn" style={{ marginTop: 6 }} onClick={() => { setExResult(null); runExample(); }}>다시 실행</button>
              </div>
            )}
            <div className="legionella-hint warn">개인정보가 제거된 합성 조사서 기반의 재현 가능한 데모입니다(실제 환자정보 미사용).</div>
          </div>
        )}

        {plan.length > 0 && (
          <div className="legionella-group">
            <div className="legionella-group-title">조사 우선순위</div>
            {plan.map((p) => (
              <button key={p.rank} type="button" className="legionella-plan" onClick={() => flyTo(p)}>
                <span className="legionella-plan-rank">{p.rank}</span>
                <span className="legionella-plan-body">
                  반경 {p.radius_m}m · 냉각탑 {p.cooling_tower_count} · 고위험 {p.high_risk_facility_count} · 케이스 {p.linked_case_count}
                  {p.facilities.length ? <em> · {p.facilities.slice(0, 2).join(', ')}</em> : null}
                </span>
              </button>
            ))}
          </div>
        )}

        {mode === 'map' && (
        <div className="legionella-legend">
          <span><i style={{ background: '#ef4444' }} /> 냉각탑</span>
          <span><i style={{ background: '#22d3ee' }} /> 목욕장업</span>
          <span><i style={{ background: '#f59e0b' }} /> 고위험 병원</span>
          <span><i style={{ background: '#a855f7' }} /> 조사 케이스</span>
          <span><i className="legionella-grad" /> 위험도 낮음→높음</span>
        </div>
        )}

        <div className="legionella-note">
          냉각탑=위성 판독 좌표(<strong>자동 탐지 아님</strong>). 위험 히트맵=PHWR 가중 <strong>환경 오염 경향</strong>(환자
          발생 예측 아님). Hotspot=<strong>환경검사 우선순위 제안</strong>이며 채수·배양 병원체 일치로 확정, 최종 판단은
          조사관. LLM은 초안만 생성. 조사 모듈은 <strong>합성·비식별 데모</strong>(실제 환자정보 미사용).
        </div>
        {status && <div className="legionella-status">{status}</div>}
      </div>
    </div>
  );
}
