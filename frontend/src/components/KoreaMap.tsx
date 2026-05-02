import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import type { KoreaAlert } from '../types';

const REGION_LABELS = [
  { code: '11', name_kr: '서울특별시', name_en: 'Seoul', lat: 37.5665, lng: 126.9780 },
  { code: '26', name_kr: '부산광역시', name_en: 'Busan', lat: 35.1796, lng: 129.0756 },
  { code: '27', name_kr: '대구광역시', name_en: 'Daegu', lat: 35.8714, lng: 128.6014 },
  { code: '28', name_kr: '인천광역시', name_en: 'Incheon', lat: 37.4563, lng: 126.7052 },
  { code: '29', name_kr: '광주광역시', name_en: 'Gwangju', lat: 35.1595, lng: 126.8526 },
  { code: '30', name_kr: '대전광역시', name_en: 'Daejeon', lat: 36.3504, lng: 127.3845 },
  { code: '31', name_kr: '울산광역시', name_en: 'Ulsan', lat: 35.5384, lng: 129.3114 },
  { code: '36', name_kr: '세종특별자치시', name_en: 'Sejong', lat: 36.4800, lng: 127.2890 },
  { code: '41', name_kr: '경기도', name_en: 'Gyeonggi', lat: 37.2750, lng: 127.0094 },
  { code: '42', name_kr: '강원특별자치도', name_en: 'Gangwon', lat: 37.8228, lng: 128.1555 },
  { code: '43', name_kr: '충청북도', name_en: 'Chungbuk', lat: 36.6357, lng: 127.4917 },
  { code: '44', name_kr: '충청남도', name_en: 'Chungnam', lat: 36.5184, lng: 126.8000 },
  { code: '45', name_kr: '전북특별자치도', name_en: 'Jeonbuk', lat: 35.7175, lng: 127.1530 },
  { code: '46', name_kr: '전라남도', name_en: 'Jeonnam', lat: 34.8161, lng: 126.4629 },
  { code: '47', name_kr: '경상북도', name_en: 'Gyeongbuk', lat: 36.4919, lng: 128.8889 },
  { code: '48', name_kr: '경상남도', name_en: 'Gyeongnam', lat: 35.4606, lng: 128.2132 },
  { code: '50', name_kr: '제주특별자치도', name_en: 'Jeju', lat: 33.4890, lng: 126.4983 },
];

const SIDO_CODE_TO_REGION_CODE: Record<string, string> = {
  '11': '11', '21': '26', '22': '27', '23': '28', '24': '29', '25': '30', '26': '31', '29': '36',
  '31': '41', '32': '42', '33': '43', '34': '44', '35': '45', '36': '46', '37': '47', '38': '48', '39': '50',
};

function scoreToColor(score: number): string {
  if (score >= 0.75) return '#ff4d4f';
  if (score >= 0.55) return '#ff9f43';
  if (score >= 0.3) return '#f6e05e';
  return '#34d399';
}

type Layer = 'respiratory' | 'wastewater_covid' | 'wastewater_flu' | 'news_trends_risk' | 'total_risk';
type AggregationMode = 'max' | 'weighted';

type Props = {
  koreaAlerts: KoreaAlert[];
  onRegionClick: (alert: KoreaAlert) => void;
  activeLayers: Layer[];
  aggregationMode?: AggregationMode;
};

export default function KoreaMap({ koreaAlerts, onRegionClick, activeLayers, aggregationMode = 'max' }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [geoData, setGeoData] = useState<any>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; title: string; subtitle: string; score: number; level: string } | null>(null);
  const [dimensions, setDimensions] = useState({ width: 1200, height: 840 });

  useEffect(() => {
    // Use province-level (시도) geojson so clicks/fills align with the 17
    // administrative regions rather than individual 시군구 polygons.
    fetch('/korea.geojson')
      .then((response) => response.json())
      .then((data) => setGeoData(data))
      .catch(() => setGeoData(null));
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setDimensions({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const alertByRegionCode = useMemo(() => {
    const map: Record<string, KoreaAlert> = {};
    for (const alert of koreaAlerts) {
      map[alert.region_code] = alert;
    }
    return map;
  }, [koreaAlerts]);

  const projection = useMemo(() => {
    if (!geoData) return null;
    return d3.geoMercator().fitSize([dimensions.width, dimensions.height], geoData);
  }, [dimensions, geoData]);

  const pathGenerator = useMemo(() => {
    if (!projection) return null;
    return d3.geoPath().projection(projection);
  }, [projection]);

  const getLayerScore = useCallback((alert?: KoreaAlert) => {
    if (!alert) return { score: 0, level: 'G0' };

    // When the user has only the default "respiratory" layer selected, use the
    // composite alert.score / alert.level that the backend already computed —
    // that's what the sidebar legend counts. Recomputing from a single signal
    // (e.g. national_respiratory) caused the map to show G0 (green) while the
    // sidebar said G1, because composite signals can be elevated even when a
    // single sub-signal is low.
    if (activeLayers.length === 1 && activeLayers[0] === 'respiratory') {
      return { score: alert.score, level: alert.level || 'G0' };
    }

    const getScoreForLayer = (layer: Layer): number => {
      if (layer === 'wastewater_covid') return alert.regional_wastewater?.covid19.score ?? alert.score;
      if (layer === 'wastewater_flu') return alert.regional_wastewater?.influenza.score ?? alert.score;
      if (layer === 'news_trends_risk') return (alert as any).news_trends_risk?.score ?? 0;
      if (layer === 'total_risk') return (alert as any).total_risk?.score ?? 0;
      return alert.score;
    };

    const scores = activeLayers.map(getScoreForLayer);
    if (scores.length === 0) return { score: 0, level: 'G0' };

    let aggregated: number;
    if (scores.length === 1 || aggregationMode === 'max') {
      aggregated = Math.max(...scores);
    } else {
      aggregated = scores.reduce((a, b) => a + b, 0) / scores.length;
    }

    const level = aggregated >= 0.75 ? 'G3' : aggregated >= 0.55 ? 'G2' : aggregated >= 0.3 ? 'G1' : 'G0';
    return { score: aggregated, level };
  }, [activeLayers, aggregationMode]);

  const resolveAlertFromFeature = useCallback((feature: any): KoreaAlert | null => {
    const provinceCode = String(feature.properties.code || '').slice(0, 2);
    const regionCode = SIDO_CODE_TO_REGION_CODE[provinceCode];
    const alert = alertByRegionCode[regionCode];
    if (alert) return alert;
    // Fallback: if no alert snapshot exists for this province, synthesise a
    // minimal KoreaAlert so clicks still open the region panel with the name.
    const label = REGION_LABELS.find((r) => r.code === regionCode);
    if (!label) return null;
    return {
      region_code: label.code,
      region_name_kr: label.name_kr,
      region_name_en: label.name_en,
      epiweek: '',
      score: 0,
      level: 'G0',
      signals: {},
      active_sources: 0,
    } as unknown as KoreaAlert;
  }, [alertByRegionCode]);

  const handleMouseMove = useCallback((event: React.MouseEvent, feature: any) => {
    const alert = resolveAlertFromFeature(feature);
    if (!alert) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const layer = getLayerScore(alertByRegionCode[alert.region_code]);
    setTooltip({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      title: alert.region_name_en,
      subtitle: alert.region_name_kr,
      score: layer.score,
      level: layer.level,
    });
  }, [alertByRegionCode, getLayerScore, resolveAlertFromFeature]);

  const handleClick = useCallback((feature: any) => {
    const alert = resolveAlertFromFeature(feature);
    if (alert) onRegionClick(alert);
  }, [onRegionClick, resolveAlertFromFeature]);

  if (!geoData || !projection || !pathGenerator) {
    return (
      <div ref={containerRef} className="korea-map-container">
        <div className="loading-spinner" />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="korea-map-container">
      <svg ref={svgRef} width={dimensions.width} height={dimensions.height} viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}>
        <g>
          {geoData.features.map((feature: any, index: number) => {
            const provinceCode = String(feature.properties.code || '').slice(0, 2);
            const regionCode = SIDO_CODE_TO_REGION_CODE[provinceCode];
            const alert = alertByRegionCode[regionCode];
            const layer = getLayerScore(alert);
            // Semi-transparent fill so the underlying map labels stay legible
            // while the whole 시도 polygon still reads as a single risk zone.
            const fillColor = alert
              ? `${scoreToColor(layer.score)}4d` // ~30% alpha when data exists
              : 'rgba(148, 163, 184, 0.10)';
            return (
              <path
                key={`feature-${index}`}
                d={pathGenerator(feature) || ''}
                fill={fillColor}
                stroke="var(--map-polygon-stroke)"
                strokeWidth={0.9}
                className="korea-map-polygon"
                onMouseMove={(event) => handleMouseMove(event, feature)}
                onMouseLeave={() => setTooltip(null)}
                onClick={() => handleClick(feature)}
              />
            );
          })}
        </g>
        <g>
          {REGION_LABELS.map((region) => {
            const coords = projection([region.lng, region.lat]);
            if (!coords) return null;
            return (
              <g key={region.code} style={{ pointerEvents: 'none' }}>
                <text x={coords[0]} y={coords[1]} textAnchor="middle" fill="var(--map-label-color)" fontSize={11} fontWeight={600}>
                  {region.name_en}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {tooltip && (
        <div className="korea-map-tooltip" style={{ left: tooltip.x + 12, top: tooltip.y - 10 }}>
          <div className="korea-map-tooltip-name">{tooltip.title}</div>
          <div className="korea-map-tooltip-sub">{tooltip.subtitle}</div>
          <div className="korea-map-tooltip-score">
            <span style={{ color: scoreToColor(tooltip.score) }}>{tooltip.score.toFixed(2)}</span>
            <span className="korea-map-tooltip-level" style={{ color: scoreToColor(tooltip.score), borderColor: `${scoreToColor(tooltip.score)}55` }}>
              {tooltip.level}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
