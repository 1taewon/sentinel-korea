import { useRef, useMemo, useCallback, useEffect, useState } from 'react';
import Globe, { GlobeMethods } from 'react-globe.gl';
import type { KoreaAlert, GlobalSignal } from '../types';

// Map first 2 digits of the code to Province/Metropolitan City name
const SIDO_CODE_TO_REGION: Record<string, string> = {
  '11': '서울', '21': '부산', '22': '대구', '23': '인천',
  '24': '광주', '25': '대전', '26': '울산', '29': '세종',
  '31': '경기', '32': '강원', '33': '충북', '34': '충남',
  '35': '전북', '36': '전남', '37': '경북', '38': '경남',
  '39': '제주'
};

// All Sido (province-level) labels with coordinates
const SIDO_LABELS = [
  { name_kr: '서울', name_en: 'Seoul', lat: 37.5665, lng: 126.9780 },
  { name_kr: '부산', name_en: 'Busan', lat: 35.1796, lng: 129.0756 },
  { name_kr: '대구', name_en: 'Daegu', lat: 35.8714, lng: 128.6014 },
  { name_kr: '인천', name_en: 'Incheon', lat: 37.4563, lng: 126.7052 },
  { name_kr: '광주', name_en: 'Gwangju', lat: 35.1595, lng: 126.8526 },
  { name_kr: '대전', name_en: 'Daejeon', lat: 36.3504, lng: 127.3845 },
  { name_kr: '울산', name_en: 'Ulsan', lat: 35.5384, lng: 129.3114 },
  { name_kr: '세종', name_en: 'Sejong', lat: 36.4800, lng: 127.2890 },
  { name_kr: '경기', name_en: 'Gyeonggi', lat: 37.2750, lng: 127.0094 },
  { name_kr: '강원', name_en: 'Gangwon', lat: 37.8228, lng: 128.1555 },
  { name_kr: '충북', name_en: 'Chungbuk', lat: 36.6357, lng: 127.4917 },
  { name_kr: '충남', name_en: 'Chungnam', lat: 36.5184, lng: 126.8000 },
  { name_kr: '전북', name_en: 'Jeonbuk', lat: 35.7175, lng: 127.1530 },
  { name_kr: '전남', name_en: 'Jeonnam', lat: 34.8161, lng: 126.4629 },
  { name_kr: '경북', name_en: 'Gyeongbuk', lat: 36.4919, lng: 128.8889 },
  { name_kr: '경남', name_en: 'Gyeongnam', lat: 35.4606, lng: 128.2132 },
  { name_kr: '제주', name_en: 'Jeju', lat: 33.4890, lng: 126.4983 },
];

/* ── Color helpers ───────────────────────────────── */
function scoreToColor(score: number): string {
  if (score >= 0.75) return '#ff2a2a'; // Critical — neon red
  if (score >= 0.55) return '#ff8c00'; // Elevated — neon orange
  if (score >= 0.30) return '#ffd700'; // Guarded — neon yellow
  return '#00ffaa';                    // Low — neon green
}

function sourceToColor(source: string): string {
  switch (source) {
    case 'healthmap':     return '#f59e0b'; // amber
    case 'promed':        return '#06b6d4'; // cyan
    case 'google_trends': return '#8b5cf6'; // purple
    default:              return '#6b7280';
  }
}

type Props = {
  koreaAlerts: KoreaAlert[];
  globalSignals: GlobalSignal[];
  onKoreaClick: (alert: KoreaAlert) => void;
  onGlobalClick: (signal: GlobalSignal) => void;
};

export default function GlobeScene({ koreaAlerts, globalSignals, onKoreaClick, onGlobalClick }: Props) {
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const [koreaPolygons, setKoreaPolygons] = useState([]);

  // Fetch High-Res Korea GeoJSON
  useEffect(() => {
    fetch('/korea-sig.geojson')
      .then(res => res.json())
      .then(data => setKoreaPolygons(data.features))
      .catch(err => console.error('Failed to load geojson', err));
  }, []);

  /* ── Auto-zoom to Korea on mount ──────────────── */
  useEffect(() => {
    const timer = setTimeout(() => {
      if (globeRef.current) {
        globeRef.current.pointOfView(
          { lat: 36.0, lng: 127.5, altitude: 0.6 },
          2000 // smooth 2s transition
        );
      }
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  const [hoverD, setHoverD] = useState<any | null>(null);
  const clickTimeoutRef = useRef<number | null>(null);
  const lastClickedPolygonRef = useRef<any>(null);

  /* ── Global Rings data ────────────────────────── */
  const globalRings = useMemo(() =>
    globalSignals.map(s => ({
      ...s,
      color: sourceToColor(s.source),
    })),
    [globalSignals]
  );

  /* ── Polygon Mapping ──────────────────────────── */
  const polygonsWithScore = useMemo(() => {
    return koreaPolygons.map((feature: any) => {
      // Map SIG_CD to Province Name
      const code = feature.properties.code;
      const provinceCode = code ? code.substring(0, 2) : '';
      const regionKr = SIDO_CODE_TO_REGION[provinceCode];
      const alert = koreaAlerts.find(a => a.region_name_kr === regionKr);
      return { ...feature, alert, regionKr };
    });
  }, [koreaPolygons, koreaAlerts]);

  /* ── Sido-Level Labels ─────────────────────────────── */
  const koreaLabels = useMemo(() => {
    return SIDO_LABELS.map(sido => {
      const alert = koreaAlerts.find(a => a.region_name_kr === sido.name_kr);
      return {
        lat: sido.lat,
        lng: sido.lng,
        text: sido.name_en,
        labelSize: 0.25,
        labelDot: true,
        score: alert ? alert.score : 0,
        alert: alert
      };
    });
  }, [koreaAlerts]);

  /* ── Handlers ─────────────────────────────────── */
  const handlePolygonClick = useCallback((polygon: any) => {
    if (!polygon.alert) return;
    
    if (clickTimeoutRef.current && lastClickedPolygonRef.current === polygon) {
      window.clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
      lastClickedPolygonRef.current = null;
      
      if (globeRef.current) {
        // Calculate center for SiGunGu or go to Alert lat/lng
        globeRef.current.pointOfView(
          { lat: polygon.alert.lat, lng: polygon.alert.lng, altitude: 0.15 },
          800
        );
      }
    } else {
      if (clickTimeoutRef.current) window.clearTimeout(clickTimeoutRef.current);
      lastClickedPolygonRef.current = polygon;
      onKoreaClick(polygon.alert); 
      
      clickTimeoutRef.current = window.setTimeout(() => {
        clickTimeoutRef.current = null;
        lastClickedPolygonRef.current = null;
      }, 300);
    }
  }, [onKoreaClick]);

  const handleRingClick = useCallback((ring: object) => {
    onGlobalClick(ring as GlobalSignal);
  }, [onGlobalClick]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const extraGlobeProps: Record<string, any> = {
    ringsData: globalRings,
    ringLat: 'lat',
    ringLng: 'lng',
    ringColor: 'color',
    ringMaxRadius: 3,
    ringPropagationSpeed: 1.5,
    ringRepeatPeriod: 1200,
    onRingClick: handleRingClick,
  };

  return (
    <div className="globe-container">
      <Globe
        ref={globeRef}
        backgroundColor="#050816"
        globeImageUrl="//unpkg.com/three-globe/example/img/earth-blue-marble.jpg"
        bumpImageUrl="//unpkg.com/three-globe/example/img/earth-topology.png"
        
        // ── High-Res Province Polygons ──
        polygonsData={polygonsWithScore}
        polygonCapColor={(d: any) => 
          d === hoverD 
            ? 'rgba(255, 255, 255, 0.6)' 
            : (d.alert ? `${scoreToColor(d.alert.score)}88` : 'rgba(255, 255, 255, 0.05)')
        }
        polygonSideColor={(d: any) => 
          d.alert ? `${scoreToColor(d.alert.score)}44` : 'rgba(100, 149, 237, 0.05)'
        }
        polygonStrokeColor={() => 'rgba(200, 230, 255, 0.4)'} // Crisp glowing borders
        polygonAltitude={(d: any) => d === hoverD ? 0.015 : 0.005} // Subdued 3D effect
        onPolygonHover={setHoverD}
        onPolygonClick={handlePolygonClick}
        polygonLabel={(d: any) => {
          const sigName = d.properties.name || d.properties.NAME || '';
          const sigNameEn = d.properties.name_eng || d.properties.NAME_ENG || '';
          const sidoName = d.regionKr || '';

          if (!d.alert) {
            // SiGunGu without alert data — just show district name
            if (!sigName) return '';
            return `
              <div style="
                background: rgba(15, 23, 42, 0.9);
                border: 1px solid rgba(148, 163, 184, 0.2);
                border-radius: 6px;
                padding: 8px 12px;
                backdrop-filter: blur(8px);
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.4);
              ">
                <div style="font-weight:600;font-size:13px;color:#f8fafc;">
                  ${sigNameEn || sigName}
                </div>
                <div style="font-size:11px;color:#94a3b8;margin-top:2px;">
                  ${sidoName} ${sigName}
                </div>
              </div>
            `;
          }

          const a = d.alert as KoreaAlert;
          return `
            <div style="
              background: rgba(15, 23, 42, 0.95);
              border: 1px solid rgba(148, 163, 184, 0.2);
              border-radius: 8px;
              padding: 12px 16px;
              backdrop-filter: blur(8px);
              min-width: 180px;
              box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.6), 0 2px 4px -2px rgba(0, 0, 0, 0.6);
            ">
              <div style="font-weight:700;font-size:15px;color:#f8fafc;letter-spacing:1px;text-transform:uppercase;">
                ${sigNameEn || a.region_name_en}
              </div>
              <div style="font-size:12px;color:#94a3b8;margin-top:2px;">
                ${a.region_name_kr} ${sigName}
              </div>
              <div style="margin-top:8px;display:flex;align-items:center;gap:10px;">
                <span style="
                  color:${scoreToColor(a.score)};
                  font-weight:800;
                  font-size:20px;
                  font-family:'JetBrains Mono',monospace;
                  text-shadow: 0 0 5px ${scoreToColor(a.score)}44;
                ">${a.score.toFixed(2)}</span>
                <span style="
                  font-size:11px;
                  padding:3px 8px;
                  border-radius:4px;
                  font-weight: 600;
                  border: 1px solid ${scoreToColor(a.score)}55;
                  background:${scoreToColor(a.score)}15;
                  color:${scoreToColor(a.score)};
                ">${a.level}</span>
              </div>
            </div>
          `;
        }}
        
        // ── Metro City Labels ──
        labelsData={koreaLabels}
        labelLat="lat"
        labelLng="lng"
        labelText="text"
        labelSize="labelSize"
        labelDotRadius={0.08}
        labelColor={(d: any) => d.score >= 0.55 ? '#ffffff' : 'rgba(200, 215, 240, 0.7)'}
        labelResolution={3}
        labelAltitude={0.015}
        labelDotOrientation={() => 'bottom'}
        
        // ── Atmosphere ──
        atmosphereColor="#38bdf8"
        atmosphereAltitude={0.2}
        
        // ── Ring layer ──
        {...extraGlobeProps}
      />
    </div>
  );
}

