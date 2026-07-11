import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.heat';

// ─── Legionella surveillance (부산) ─────────────────────────────────────────
// V-World satellite imagery + three layers, no ML/GPU:
//  (1) cooling towers — points a human digitised from imagery (NOT auto-detected),
//  (2) high-risk facilities — 목욕장업(공개데이터 좌표) + 고위험 병원(심평원 좌표),
//  (3) PHWR-weighted risk heatmap (environmental-contamination tendency, NOT a
//      patient-incidence forecast — 2021 PHWR: 지역 검출률과 환자 발생률 상관 없음).
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const CENTER: [number, number] = [35.1796, 129.0756]; // 부산
const ZOOM = 12;

// Cooling-tower seed points in 부산 도심 — replace with real satellite reads.
const SAMPLE_TOWERS: [number, number][] = [
  [35.1580, 129.0595], [35.1846, 129.0836], [35.2129, 129.0839],
  [35.1533, 129.1183], [35.1042, 129.0227],
];
const TOWER_WEIGHT = 0.5;

// 2021 PHWR 레지오넬라 환경검사 검출률 → 시설유형 위험 가중치.
function bathWeight(subtype: string): number {
  const s = subtype || '';
  if (s.includes('온천')) return 0.394;
  if (s.includes('찜질')) return 0.375;
  if (s.includes('대형')) return 0.328;
  return 0.164; // 대중목욕탕/기타 목욕장업
}
function hospWeight(cl: string): number {
  const s = cl || '';
  if (s.includes('상급종합')) return 0.35;
  if (s.includes('종합병원') || s === '종합') return 0.263;
  if (s.includes('요양')) return 0.20;
  return 0.164;
}

type LL = [number, number]; // [lat, lng]
type Pt = { ll: LL; w: number; name: string; sub: string };

export default function LegionellaView() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const satRef = useRef<L.TileLayer | null>(null);
  const hybRef = useRef<L.TileLayer | null>(null);
  const towerLayer = useRef<L.LayerGroup>(L.layerGroup());
  const bathLayer = useRef<L.LayerGroup>(L.layerGroup());
  const hospLayer = useRef<L.LayerGroup>(L.layerGroup());
  const heatRef = useRef<L.Layer | null>(null);
  const towers = useRef<LL[]>([]);
  const baths = useRef<Pt[]>([]);
  const hospitals = useRef<Pt[]>([]);

  const [status, setStatus] = useState('지도를 불러오는 중…');
  const [counts, setCounts] = useState({ towers: 0, baths: 0, hospitals: 0 });
  const [addMode, setAddMode] = useState(true);
  const [vis, setVis] = useState({ satellite: true, hybrid: true, towers: true, baths: true, hospitals: true, heat: true });
  const visRef = useRef(vis); visRef.current = vis;
  const addModeRef = useRef(addMode); addModeRef.current = addMode;

  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    const map = L.map(mapEl.current, { center: CENTER, zoom: ZOOM, minZoom: 7, maxZoom: 19 });
    mapRef.current = map;

    (async () => {
      let key = '';
      try { key = (await (await fetch(`${API_BASE}/config/vworld-key`)).json()).vworld_key || ''; } catch { /* */ }
      if (!key) { setStatus('VWORLD_KEY 미설정 — 백엔드 환경변수 VWORLD_KEY를 확인하세요.'); return; }
      const sat = L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${key}/Satellite/{z}/{y}/{x}.jpeg`,
        { maxZoom: 19, attribution: 'Imagery © V-World (국토교통부)' });
      const hyb = L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${key}/Hybrid/{z}/{y}/{x}.png`, { maxZoom: 19 });
      satRef.current = sat; hybRef.current = hyb;
      sat.addTo(map); hyb.addTo(map);
      towerLayer.current.addTo(map); bathLayer.current.addTo(map); hospLayer.current.addTo(map);
      setStatus('');
      await loadTowers();
      await loadFacilities();
      renderAll();
      rebuildHeat();
    })();

    map.on('click', (e: L.LeafletMouseEvent) => {
      if (!visRef.current.towers || !addModeRef.current) return;
      towers.current.push([e.latlng.lat, e.latlng.lng]);
      renderTowers(); rebuildHeat();
    });

    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toLL = (gj: any): any[] =>
    (gj?.features ?? []).filter((f: any) => f?.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates))
      .map((f: any) => ({ ll: [f.geometry.coordinates[1], f.geometry.coordinates[0]] as LL, props: f.properties || {} }));

  async function loadTowers() {
    try {
      const r = await fetch('/data/cooling_towers.geojson', { cache: 'no-store' });
      if (r.ok) { const arr = toLL(await r.json()).map((x) => x.ll); towers.current = arr.length ? arr : [...SAMPLE_TOWERS]; return; }
    } catch { /* */ }
    towers.current = [...SAMPLE_TOWERS];
  }

  async function loadFacilities() {
    try {
      const rb = await fetch('/data/facilities_bath.geojson', { cache: 'no-store' });
      if (rb.ok) baths.current = toLL(await rb.json()).map((x) => ({
        ll: x.ll, name: x.props.name || '목욕장업', sub: x.props.subtype || '목욕장업', w: bathWeight(x.props.subtype || ''),
      }));
    } catch { /* */ }
    try {
      const rh = await fetch('/data/facilities_hospital.geojson', { cache: 'no-store' });
      if (rh.ok) hospitals.current = toLL(await rh.json()).map((x) => ({
        ll: x.ll, name: x.props.name || '병원', sub: x.props.clCdNm || '병원', w: hospWeight(x.props.clCdNm || ''),
      }));
    } catch { /* */ }
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
    baths.current.forEach((p) => {
      L.circleMarker(p.ll, { radius: 5, color: '#fff', weight: 1, fillColor: '#22d3ee', fillOpacity: 0.85 })
        .bindTooltip(`${p.name} · ${p.sub}`, { direction: 'top' }).addTo(bl);
    });
    const hl = hospLayer.current; hl.clearLayers();
    hospitals.current.forEach((p) => {
      L.circleMarker(p.ll, { radius: 8, color: '#fff', weight: 1.5, fillColor: '#f59e0b', fillOpacity: 0.9 })
        .bindTooltip(`고위험: ${p.name} · ${p.sub}`, { direction: 'top' }).addTo(hl);
    });
    setCounts({ towers: towers.current.length, baths: baths.current.length, hospitals: hospitals.current.length });
  }

  function rebuildHeat() {
    const map = mapRef.current; if (!map) return;
    if (heatRef.current) { map.removeLayer(heatRef.current); heatRef.current = null; }
    const pts: [number, number, number][] = [
      ...towers.current.map((ll) => [ll[0], ll[1], TOWER_WEIGHT] as [number, number, number]),
      ...baths.current.map((p) => [p.ll[0], p.ll[1], p.w] as [number, number, number]),
      ...hospitals.current.map((p) => [p.ll[0], p.ll[1], p.w] as [number, number, number]),
    ];
    const heat = (L as any).heatLayer(pts, {
      radius: 30, blur: 20, maxZoom: 16, max: 0.5, minOpacity: 0.22,
      gradient: { 0.2: '#22d3ee', 0.4: '#84cc16', 0.6: '#facc15', 0.8: '#f97316', 1.0: '#dc2626' },
    });
    heatRef.current = heat;
    if (visRef.current.heat) heat.addTo(map);
  }

  const toggle = (k: keyof typeof vis) => {
    const next = { ...vis, [k]: !vis[k] }; setVis(next);
    const map = mapRef.current; if (!map) return;
    const lyr: L.Layer | null = k === 'satellite' ? satRef.current : k === 'hybrid' ? hybRef.current
      : k === 'towers' ? towerLayer.current : k === 'baths' ? bathLayer.current
      : k === 'hospitals' ? hospLayer.current : heatRef.current;
    if (!lyr) return;
    if (next[k]) map.addLayer(lyr); else map.removeLayer(lyr);
  };

  const saveGeoJSON = () => {
    const fc = {
      type: 'FeatureCollection',
      features: towers.current.map((ll, i) => ({
        type: 'Feature', properties: { id: i + 1, source: 'manual_satellite_read', layer: 'cooling_tower' },
        geometry: { type: 'Point', coordinates: [ll[1], ll[0]] },
      })),
    };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(fc, null, 2)], { type: 'application/json' }));
    a.download = 'cooling_towers.geojson'; a.click(); URL.revokeObjectURL(a.href);
  };

  return (
    <div className="legionella-view">
      <div className="legionella-map" ref={mapEl} />
      <div className="legionella-panel">
        <div className="legionella-title">Legionella surveillance · 부산</div>
        <div className="legionella-sub">V-World 위성 · 냉각탑(수동 판독) + 고위험 시설 + PHWR 위험 히트맵</div>

        <div className="legionella-group">
          <div className="legionella-group-title">레이어</div>
          {([
            ['satellite', '위성영상'], ['hybrid', '라벨(하이브리드)'],
            ['towers', `냉각탑 (${counts.towers})`], ['baths', `목욕장업 (${counts.baths})`],
            ['hospitals', `고위험 병원 (${counts.hospitals})`], ['heat', '위험 히트맵'],
          ] as [keyof typeof vis, string][]).map(([k, label]) => (
            <label key={k} className="legionella-check">
              <input type="checkbox" checked={vis[k]} onChange={() => toggle(k)} /> {label}
            </label>
          ))}
        </div>

        <div className="legionella-group">
          <div className="legionella-group-title">냉각탑 디지타이징</div>
          <label className="legionella-check">
            <input type="checkbox" checked={addMode} onChange={(e) => setAddMode(e.target.checked)} /> 지도 클릭으로 추가
          </label>
          <div className="legionella-hint">마커 클릭 = 삭제. 지도 클릭 = 추가(위 체크 시).</div>
          <button type="button" className="legionella-btn" onClick={saveGeoJSON}>GeoJSON 저장 ({counts.towers})</button>
        </div>

        <div className="legionella-legend">
          <span><i style={{ background: '#ef4444' }} /> 냉각탑(수동 판독)</span>
          <span><i style={{ background: '#22d3ee' }} /> 목욕장업</span>
          <span><i style={{ background: '#f59e0b' }} /> 고위험 병원(상급종합/종합/요양)</span>
          <span><i className="legionella-grad" /> 위험도 낮음→높음</span>
        </div>

        <div className="legionella-note">
          냉각탑 계층은 사람이 위성영상을 판독한 좌표이며 <strong>자동 탐지가 아닙니다</strong>. 위험 히트맵은
          PHWR 검출률 가중 <strong>환경 오염 경향</strong>이며 <strong>환자 발생 예측이 아닙니다</strong>(2021 PHWR:
          지역 검출률과 환자 발생률 상관 없음). 환자·개인정보 미사용, 환경/시설 공개데이터만 사용.
        </div>
        {status && <div className="legionella-status">{status}</div>}
      </div>
    </div>
  );
}
