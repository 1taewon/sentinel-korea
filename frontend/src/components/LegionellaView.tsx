import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.heat';

// ─── Legionella surveillance AI (manual-read PoC) ───────────────────────────
// Three layers on V-World satellite imagery: (1) cooling-tower points a human
// digitised from the imagery (NOT auto-detected), (2) vulnerable facilities from
// LocalData licences, (3) a weighted risk heatmap of the two. No ML / GPU.
// Target: 서울 중구. Data prep for facilities is done by legionella/prepare_data.py.

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const CENTER: [number, number] = [37.5636, 126.9976]; // 서울 중구
const ZOOM = 15;

// 5 seed points inside 중구 to demonstrate — replace with real imagery reads.
const SAMPLE_TOWERS: [number, number][] = [
  [37.5648, 126.9972], [37.5619, 127.0004], [37.5663, 126.9948],
  [37.5602, 126.9931], [37.5677, 127.0016],
];

type LL = [number, number]; // [lat, lng]

export default function LegionellaView() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const satRef = useRef<L.TileLayer | null>(null);
  const hybRef = useRef<L.TileLayer | null>(null);
  const towerLayer = useRef<L.LayerGroup>(L.layerGroup());
  const facilityLayer = useRef<L.LayerGroup>(L.layerGroup());
  const heatRef = useRef<L.Layer | null>(null);
  const towers = useRef<LL[]>([]);
  const facilities = useRef<LL[]>([]);

  const [status, setStatus] = useState('지도를 불러오는 중…');
  const [towerCount, setTowerCount] = useState(0);
  const [facilityCount, setFacilityCount] = useState(0);
  const [addMode, setAddMode] = useState(true);
  const [vis, setVis] = useState({ satellite: true, hybrid: true, towers: true, facilities: true, heat: true });
  const visRef = useRef(vis);
  visRef.current = vis;

  // ── one-time map init ──────────────────────────────────────────────────
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    const map = L.map(mapEl.current, { center: CENTER, zoom: ZOOM, minZoom: 7, maxZoom: 19, zoomControl: true });
    mapRef.current = map;

    (async () => {
      let key = '';
      try {
        const r = await fetch(`${API_BASE}/config/vworld-key`);
        key = (await r.json()).vworld_key || '';
      } catch { /* fall through */ }
      if (!key) {
        setStatus('VWORLD_KEY가 설정되지 않았습니다. 백엔드 환경변수 VWORLD_KEY를 확인하세요.');
        return;
      }
      const sat = L.tileLayer(
        `https://api.vworld.kr/req/wmts/1.0.0/${key}/Satellite/{z}/{y}/{x}.jpeg`,
        { maxZoom: 19, attribution: 'Imagery © V-World (국토교통부)' });
      const hyb = L.tileLayer(
        `https://api.vworld.kr/req/wmts/1.0.0/${key}/Hybrid/{z}/{y}/{x}.png`,
        { maxZoom: 19 });
      satRef.current = sat; hybRef.current = hyb;
      sat.addTo(map); hyb.addTo(map);
      towerLayer.current.addTo(map);
      facilityLayer.current.addTo(map);
      setStatus('');
      await loadTowers();
      await loadFacilities();
      rebuildHeat();
      renderTowers();
    })();

    map.on('click', (e: L.LeafletMouseEvent) => {
      if (!visRef.current.towers || !addModeRef.current) return;
      towers.current.push([e.latlng.lat, e.latlng.lng]);
      renderTowers(); rebuildHeat();
    });

    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addModeRef = useRef(addMode);
  addModeRef.current = addMode;

  // ── data loading ───────────────────────────────────────────────────────
  const featuresToLL = (gj: any): LL[] =>
    (gj?.features ?? [])
      .filter((f: any) => f?.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates))
      .map((f: any) => [f.geometry.coordinates[1], f.geometry.coordinates[0]] as LL); // geojson [lng,lat] → [lat,lng]

  async function loadTowers() {
    try {
      const r = await fetch('/data/cooling_towers.geojson', { cache: 'no-store' });
      if (r.ok) {
        const ll = featuresToLL(await r.json());
        towers.current = ll.length ? ll : [...SAMPLE_TOWERS];
        return;
      }
    } catch { /* ignore */ }
    towers.current = [...SAMPLE_TOWERS];
  }

  async function loadFacilities() {
    try {
      const r = await fetch('/data/facilities.geojson', { cache: 'no-store' });
      if (r.ok) facilities.current = featuresToLL(await r.json());
    } catch { /* ignore */ }
    setFacilityCount(facilities.current.length);
    renderFacilities();
  }

  // ── rendering ──────────────────────────────────────────────────────────
  function renderTowers() {
    const layer = towerLayer.current;
    layer.clearLayers();
    towers.current.forEach((ll, i) => {
      const m = L.circleMarker(ll, { radius: 7, color: '#fff', weight: 1.5, fillColor: '#ef4444', fillOpacity: 0.9 });
      m.bindTooltip('냉각탑 (클릭 시 삭제)', { direction: 'top' });
      m.on('click', (ev) => {
        L.DomEvent.stopPropagation(ev as any);
        towers.current.splice(i, 1);
        renderTowers(); rebuildHeat();
      });
      m.addTo(layer);
    });
    setTowerCount(towers.current.length);
  }

  function renderFacilities() {
    const layer = facilityLayer.current;
    layer.clearLayers();
    facilities.current.forEach((ll) => {
      L.circleMarker(ll, { radius: 4, color: '#fff', weight: 1, fillColor: '#38bdf8', fillOpacity: 0.85 })
        .bindTooltip('취약시설', { direction: 'top' }).addTo(layer);
    });
  }

  function rebuildHeat() {
    const map = mapRef.current;
    if (!map) return;
    if (heatRef.current) { map.removeLayer(heatRef.current); heatRef.current = null; }
    // cooling towers weigh more than facilities.
    const pts: [number, number, number][] = [
      ...towers.current.map((ll) => [ll[0], ll[1], 1.0] as [number, number, number]),
      ...facilities.current.map((ll) => [ll[0], ll[1], 0.45] as [number, number, number]),
    ];
    const heat = (L as any).heatLayer(pts, {
      radius: 34, blur: 22, maxZoom: 17, minOpacity: 0.25,
      gradient: { 0.2: '#22d3ee', 0.4: '#84cc16', 0.6: '#facc15', 0.8: '#f97316', 1.0: '#dc2626' },
    });
    heatRef.current = heat;
    if (visRef.current.heat) heat.addTo(map);
  }

  // ── layer toggles ──────────────────────────────────────────────────────
  const toggle = (k: keyof typeof vis) => {
    const next = { ...vis, [k]: !vis[k] };
    setVis(next);
    const map = mapRef.current; if (!map) return;
    const pairs: [keyof typeof vis, L.Layer | null][] = [
      ['satellite', satRef.current], ['hybrid', hybRef.current],
      ['towers', towerLayer.current], ['facilities', facilityLayer.current], ['heat', heatRef.current],
    ];
    for (const [key, lyr] of pairs) {
      if (key !== k || !lyr) continue;
      if (next[k]) map.addLayer(lyr); else map.removeLayer(lyr);
    }
  };

  // ── save cooling towers as GeoJSON ─────────────────────────────────────
  const saveGeoJSON = () => {
    const fc = {
      type: 'FeatureCollection',
      features: towers.current.map((ll, i) => ({
        type: 'Feature',
        properties: { id: i + 1, source: 'manual_satellite_read', layer: 'cooling_tower' },
        geometry: { type: 'Point', coordinates: [ll[1], ll[0]] }, // WGS84 [lng,lat]
      })),
    };
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cooling_towers.geojson';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="legionella-view">
      <div className="legionella-map" ref={mapEl} />
      <div className="legionella-panel">
        <div className="legionella-title">Legionella surveillance AI</div>
        <div className="legionella-sub">서울 중구 · V-World 위성영상 기반 수동 판독 PoC</div>

        <div className="legionella-group">
          <div className="legionella-group-title">레이어</div>
          {([
            ['satellite', '위성영상'], ['hybrid', '라벨(하이브리드)'],
            ['towers', `냉각탑 (${towerCount})`], ['facilities', `취약시설 (${facilityCount})`], ['heat', '위험 히트맵'],
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
          <button type="button" className="legionella-btn" onClick={saveGeoJSON}>GeoJSON 저장 ({towerCount})</button>
        </div>

        <div className="legionella-legend">
          <span><i style={{ background: '#ef4444' }} /> 냉각탑(수동 판독)</span>
          <span><i style={{ background: '#38bdf8' }} /> 취약시설</span>
          <span><i className="legionella-grad" /> 위험도 낮음→높음</span>
        </div>

        <div className="legionella-note">
          냉각탑 계층은 사람이 위성영상을 판독해 표시한 결과이며 <strong>자동 탐지가 아닙니다</strong>. 환자·개인정보는 사용하지 않으며, 환경/시설 공개데이터(V-World, LocalData)만 사용합니다.
        </div>
        {status && <div className="legionella-status">{status}</div>}
      </div>
    </div>
  );
}
