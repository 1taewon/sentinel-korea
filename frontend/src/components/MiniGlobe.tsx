import { useRef, useEffect, useMemo, useState } from 'react';
import Globe, { GlobeMethods } from 'react-globe.gl';
import type { KoreaAlert, GlobalSignal } from '../types';
import { relevanceLabel, scoreInternationalRelevance } from '../lib/internationalRelevance';

// Read app theme from <html data-theme="..."> so the globe texture and tooltip
// background can adapt to the current light/dark mode.
function useTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light') ? 'light' : 'dark'
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const observer = new MutationObserver(() => {
      const next = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
      setTheme((prev) => (prev === next ? prev : next));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

type Layer = 'respiratory' | 'wastewater_covid' | 'wastewater_flu' | 'news_trends_risk' | 'total_risk';

type Props = {
  isExpanded?: boolean;
  signals?: GlobalSignal[];
  koreaAlerts?: KoreaAlert[];
  activeLayers?: Layer[];
  aggregationMode?: 'max' | 'weighted';
  onGlobalSignalClick?: (signal: GlobalSignal) => void;
  selectedGlobalId?: string | null;
};

export default function MiniGlobe({
  isExpanded = false,
  signals = [],
  koreaAlerts = [],
  activeLayers = ['respiratory'],
  aggregationMode = 'max',
  onGlobalSignalClick,
  selectedGlobalId = null,
}: Props) {
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const theme = useTheme();
  const expandedWidth = typeof window !== 'undefined' ? Math.max(560, window.innerWidth - 440) : 900;
  const expandedHeight = typeof window !== 'undefined' ? Math.max(520, window.innerHeight - 180) : 720;
  // 1x1 white pixel — produces a clean white globe surface; country borders are
  // overlaid as polygons below for a minimal/clinical look in light theme.
  const WHITE_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const globeTexture = theme === 'light'
    ? WHITE_PIXEL
    : '//unpkg.com/three-globe/example/img/earth-night.jpg';

  // Fetch country geojson once (cheap, ~270KB) so light mode can show borders
  // on the white globe.
  const [countries, setCountries] = useState<{ features: any[] }>({ features: [] });
  useEffect(() => {
    if (theme !== 'light' || countries.features.length > 0) return;
    fetch('https://raw.githubusercontent.com/vasturiano/react-globe.gl/master/example/datasets/ne_110m_admin_0_countries.geojson')
      .then((r) => r.ok ? r.json() : { features: [] })
      .then((d) => setCountries(d))
      .catch(() => setCountries({ features: [] }));
  }, [theme, countries.features.length]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (globeRef.current) {
        const pov = isExpanded 
          ? { lat: 20, lng: 0, altitude: 2.5 }
          : { lat: 36.0, lng: 127.5, altitude: 1.8 };
        
        globeRef.current.pointOfView(pov, 1000);
        
        const controls = globeRef.current.controls();
        if (controls) {
          controls.autoRotate = !isExpanded;
          controls.autoRotateSpeed = isExpanded ? 0 : 0.8;
          controls.enableZoom = isExpanded;
        }
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [isExpanded]);

  const sourceLabel = (src: string) => {
    if (src === 'healthmap') return 'HealthMap';
    if (src === 'promed') return 'ProMED';
    if (src === 'google_trends') return 'Google Trends';
    return src;
  };

  const koreaColor = (score: number) => {
    if (score >= 0.75) return '#ff5258';
    if (score >= 0.55) return '#f59e42';
    if (score >= 0.30) return '#e6c040';
    return '#34d399';
  };

  const getLayerScore = (alert: KoreaAlert) => {
    const getScoreForLayer = (layer: Layer): number => {
      if (layer === 'wastewater_covid') return alert.regional_wastewater?.covid19.score ?? alert.score;
      if (layer === 'wastewater_flu') return alert.regional_wastewater?.influenza.score ?? alert.score;
      if (layer === 'news_trends_risk') return alert.news_trends_risk?.score ?? 0;
      if (layer === 'total_risk') return alert.total_risk?.score ?? 0;
    return alert.national_respiratory?.score ?? alert.score;
    };
    const scores = activeLayers.map(getScoreForLayer);
    if (scores.length === 0) return 0;
    if (scores.length === 1 || aggregationMode === 'max') return Math.max(...scores);
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  };

  const factorSummary = (signal: GlobalSignal) => {
    const relevance = scoreInternationalRelevance(signal);
    const strongest = Object.entries(relevance.factors)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([key, value]) => `${key} ${(value * 100).toFixed(0)}%`)
      .join(' / ');
    return {
      relevance,
      label: relevanceLabel(relevance.score),
      strongest,
    };
  };

  // Combine Korea alerts and Global signals for visualization
  const pointsData = [
    ...koreaAlerts.map(d => ({
      ...d,
      color: koreaColor(getLayerScore(d)),
      size: isExpanded ? 0.8 : 0.5,
      type: 'korea'
    })),
    ...signals.map(d => ({
      ...d,
      color: scoreInternationalRelevance(d).color,
      size: isExpanded
        ? 0.74 + scoreInternationalRelevance(d).score * 0.82 + (selectedGlobalId === d.id ? 0.3 : 0)
        : 0.3,
      type: 'global'
    }))
  ];

  const arcsData = useMemo(() => {
    if (!isExpanded) return [];
    const koreaTargets = [
      { lat: 37.5665, lng: 126.9780 },
      { lat: 35.1796, lng: 129.0756 },
      { lat: 35.1595, lng: 126.8526 },
      { lat: 36.3504, lng: 127.3845 },
      { lat: 33.4996, lng: 126.5312 },
    ];

    // Sort by combined relevance + marker_volume so HealthMap clusters
    // (e.g. Chile H5N1 with 24 alerts) get arcs even if their per-signal
    // relevance score isn't critical.
    const sortedByImportance = [...signals].sort((a, b) => {
      const ra = scoreInternationalRelevance(a).score;
      const rb = scoreInternationalRelevance(b).score;
      const ma = (a.marker_alert_count ?? 0) > 5 ? 0.15 : 0; // cluster bonus
      const mb = (b.marker_alert_count ?? 0) > 5 ? 0.15 : 0;
      return (rb + mb) - (ra + ma);
    });

    return sortedByImportance
      .slice(0, 150)   // raised from 60 — show more signals (HealthMap, ECDC, etc.)
      .flatMap((signal, index) => {
        const relevance = scoreInternationalRelevance(signal);
        return Array.from({ length: relevance.pulseCount }, (_, routeIndex) => {
          const target = koreaTargets[(index + routeIndex) % koreaTargets.length];
          return {
            ...signal,
            startLat: signal.lat,
            startLng: signal.lng,
            endLat: target.lat,
            endLng: target.lng,
            color: relevance.color,
            stroke: relevance.stroke + routeIndex * 0.04,
            altitude: 0.16 + relevance.score * 0.32 + (routeIndex % 3) * 0.055,
            dashGap: index * 0.18 + routeIndex * 0.72,
            speed: relevance.speed + routeIndex * 150,
            routeIndex,
            koreaRelevance: relevance,
          };
        });
      });
  }, [isExpanded, signals]);

  const labelsData = useMemo(() => {
    if (!isExpanded) return [];
    const globalLabels = [...signals]
      .sort((a, b) => scoreInternationalRelevance(b).score - scoreInternationalRelevance(a).score)
      .slice(0, 18)
      .map((signal) => {
        const relevance = scoreInternationalRelevance(signal);
        return {
          lat: signal.lat,
          lng: signal.lng,
          text: signal.country || sourceLabel(signal.source),
          color: relevance.color,
          size: 0.36 + relevance.score * 0.18,
          altitude: 0.045 + relevance.score * 0.035,
        };
      });
    return [
      { lat: 37.5665, lng: 126.9780, text: 'SOUTH KOREA', color: '#c9f4d6', size: 0.75, altitude: 0.06 },
      ...globalLabels,
    ];
  }, [isExpanded, signals]);

  return (
    <div className={isExpanded ? "expanded-globe-inner" : "mini-globe-container"}>
      <Globe
        ref={globeRef}
        width={isExpanded ? expandedWidth : 180}
        height={isExpanded ? expandedHeight : 180}
        backgroundColor="rgba(0,0,0,0)"
        globeImageUrl={globeTexture}
        bumpImageUrl={theme === 'dark' ? '//unpkg.com/three-globe/example/img/earth-topology.png' : ''}
        showAtmosphere={true}
        atmosphereColor={theme === 'light' ? '#94a3b8' : '#38bdf8'}
        atmosphereAltitude={isExpanded ? 0.25 : 0.15}

        // Light-theme country borders for a minimal "white globe" look
        polygonsData={theme === 'light' ? countries.features : []}
        polygonAltitude={0.005}
        polygonCapColor={() => 'rgba(248, 250, 252, 1)'}
        polygonSideColor={() => 'rgba(148, 163, 184, 0.15)'}
        polygonStrokeColor={() => 'rgba(100, 116, 139, 0.55)'}

        arcsData={arcsData}
        arcStartLat="startLat"
        arcStartLng="startLng"
        arcEndLat="endLat"
        arcEndLng="endLng"
        arcColor={(d: any) => [`${d.color}22`, d.color]}
        arcAltitude={(d: any) => d.altitude}
        arcStroke={(d: any) => d.stroke}
        arcDashLength={0.38}
        arcDashGap={1.6}
        arcDashInitialGap={(d: any) => d.dashGap}
        arcDashAnimateTime={(d: any) => d.speed}
        onArcClick={(d: any) => onGlobalSignalClick?.(d as GlobalSignal)}
        arcLabel={(d: any) => `
          <div style="background: rgba(4, 12, 8, 0.94); padding: 8px 10px; border: 1px solid ${d.color}; color: #d8f5e1; font-family: monospace">
            <b style="color: ${d.color}">${sourceLabel(d.source)}</b><br/>
            ${d.country || d.disease || 'International support signal'} -> South Korea<br/>
            ${relevanceLabel(d.koreaRelevance?.score ?? 0)} ${(Number(d.koreaRelevance?.score ?? 0) * 100).toFixed(0)}%
          </div>
        `}
        
        pointsData={pointsData}
        pointLat="lat"
        pointLng="lng"
        pointColor="color"
        pointRadius={(d: any) => d.size}
        pointAltitude={(d: any) => (d.type === 'global' && isExpanded ? 0.045 : 0.012)}
        pointResolution={isExpanded ? 28 : 10}
        onPointClick={(d: any) => {
          if (d.type === 'global') onGlobalSignalClick?.(d as GlobalSignal);
        }}
        pointLabel={(d: any) => `
          <div style="background: rgba(4,12,8,0.94); padding: 8px; border-radius: 2px; border: 1px solid ${d.color}; color: #d8f5e1; font-family: monospace">
            <b style="color: ${d.color}">${d.type === 'global' ? sourceLabel(d.source) : 'KOREA REGION'}</b><br/>
            ${d.title || d.region_name_en || d.keyword}<br/>
            ${d.type === 'global' ? `${factorSummary(d).label} ${(factorSummary(d).relevance.score * 100).toFixed(0)}%<br/>${factorSummary(d).strongest}` : ''}
          </div>
        `}

        labelsData={labelsData}
        labelLat="lat"
        labelLng="lng"
        labelText="text"
        labelColor="color"
        labelSize="size"
        labelAltitude="altitude"
        labelDotRadius={isExpanded ? 0.34 : 0.22}
        labelResolution={2}

        ringsData={isExpanded ? signals.map((signal) => ({
          ...signal,
          color: scoreInternationalRelevance(signal).color,
          koreaRelevance: scoreInternationalRelevance(signal),
        })) : []}
        ringLat="lat"
        ringLng="lng"
        ringColor={(d: any) => d.color}
        ringMaxRadius={(d: any) => 1.9 + (d.koreaRelevance?.score ?? 0.35) * 2.5}
        ringPropagationSpeed={(d: any) => 0.6 + (d.koreaRelevance?.score ?? 0.35)}
        ringRepeatPeriod={(d: any) => Math.max(420, 1200 - (d.koreaRelevance?.score ?? 0.35) * 620)}
      />
      {!isExpanded && <div className="mini-globe-label">KOREA</div>}
    </div>
  );
}
