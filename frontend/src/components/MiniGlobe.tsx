import { useRef, useEffect, useMemo } from 'react';
import Globe, { GlobeMethods } from 'react-globe.gl';
import type { KoreaAlert, GlobalSignal } from '../types';

type Layer = 'respiratory' | 'wastewater_covid' | 'wastewater_flu' | 'news_trends_risk' | 'total_risk';

type Props = {
  isExpanded?: boolean;
  signals?: GlobalSignal[];
  koreaAlerts?: KoreaAlert[];
  activeLayers?: Layer[];
  aggregationMode?: 'max' | 'weighted';
};

export default function MiniGlobe({ isExpanded = false, signals = [], koreaAlerts = [], activeLayers = ['respiratory'], aggregationMode = 'max' }: Props) {
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const expandedWidth = typeof window !== 'undefined' ? Math.max(560, window.innerWidth - 440) : 900;
  const expandedHeight = typeof window !== 'undefined' ? Math.max(520, window.innerHeight - 180) : 720;

  useEffect(() => {
    const timer = setTimeout(() => {
      if (globeRef.current) {
        const pov = isExpanded 
          ? { lat: 20, lng: 0, altitude: 2.5 }
          : { lat: 36.0, lng: 127.5, altitude: 1.8 };
        
        globeRef.current.pointOfView(pov, 1000);
        
        const controls = globeRef.current.controls();
        if (controls) {
          controls.autoRotate = true;
          controls.autoRotateSpeed = isExpanded ? 0.2 : 0.8;
          controls.enableZoom = isExpanded;
        }
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [isExpanded]);

  // Source to color mapping
  const sourceColor = (src: string) => {
    if (src === 'healthmap') return '#f59e42'; // Amber
    if (src === 'promed') return '#6b8aff';    // Blue
    if (src === 'google_trends') return '#b794f4'; // Purple
    return '#ffffff';
  };

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
      color: sourceColor(d.source),
      size: isExpanded ? 0.5 : 0.3,
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
    return signals.slice(0, 80).map((signal, index) => {
      const target = koreaTargets[index % koreaTargets.length];
      return {
        ...signal,
        startLat: signal.lat,
        startLng: signal.lng,
        endLat: target.lat,
        endLng: target.lng,
        color: sourceColor(signal.source),
        stroke: signal.severity === 'high' ? 0.8 : signal.severity === 'medium' ? 0.55 : 0.35,
        altitude: 0.18 + (index % 5) * 0.045,
        dashGap: index * 0.12,
        speed: signal.severity === 'high' ? 1800 : 2600,
      };
    });
  }, [isExpanded, signals]);

  const labelsData = useMemo(() => {
    if (!isExpanded) return [];
    const globalLabels = signals.slice(0, 18).map((signal) => ({
      lat: signal.lat,
      lng: signal.lng,
      text: signal.country || sourceLabel(signal.source),
      color: sourceColor(signal.source),
      size: 0.42,
      altitude: 0.045,
    }));
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
        globeImageUrl="//unpkg.com/three-globe/example/img/earth-night.jpg"
        bumpImageUrl="//unpkg.com/three-globe/example/img/earth-topology.png"
        showAtmosphere={true}
        atmosphereColor="#38bdf8"
        atmosphereAltitude={isExpanded ? 0.25 : 0.15}

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
        arcLabel={(d: any) => `
          <div style="background: rgba(4, 12, 8, 0.94); padding: 8px 10px; border: 1px solid ${d.color}; color: #d8f5e1; font-family: monospace">
            <b style="color: ${d.color}">${sourceLabel(d.source)}</b><br/>
            ${d.country || d.disease || 'International support signal'} -> South Korea
          </div>
        `}
        
        pointsData={pointsData}
        pointLat="lat"
        pointLng="lng"
        pointColor="color"
        pointRadius={(d: any) => d.size}
        pointAltitude={(d: any) => (d.type === 'global' && isExpanded ? 0.045 : 0.012)}
        pointResolution={isExpanded ? 18 : 10}
        pointLabel={(d: any) => `
          <div style="background: rgba(4,12,8,0.94); padding: 8px; border-radius: 2px; border: 1px solid ${d.color}; color: #d8f5e1; font-family: monospace">
            <b style="color: ${d.color}">${d.type === 'global' ? sourceLabel(d.source) : 'KOREA REGION'}</b><br/>
            ${d.title || d.region_name_en || d.keyword}
          </div>
        `}

        labelsData={labelsData}
        labelLat="lat"
        labelLng="lng"
        labelText="text"
        labelColor="color"
        labelSize="size"
        labelAltitude="altitude"
        labelDotRadius={0.22}
        labelResolution={2}

        ringsData={isExpanded ? signals : []}
        ringLat="lat"
        ringLng="lng"
        ringColor={(d: any) => sourceColor(d.source)}
        ringMaxRadius={2.5}
        ringPropagationSpeed={1}
        ringRepeatPeriod={800}
      />
      {!isExpanded && <div className="mini-globe-label">KOREA</div>}
    </div>
  );
}
