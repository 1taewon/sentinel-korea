import { useRef, useEffect } from 'react';
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

  return (
    <div className={isExpanded ? "expanded-globe-inner" : "mini-globe-container"}>
      <Globe
        ref={globeRef}
        width={isExpanded ? window.innerWidth : 180}
        height={isExpanded ? window.innerHeight - 160 : 180}
        backgroundColor="rgba(0,0,0,0)"
        globeImageUrl="//unpkg.com/three-globe/example/img/earth-night.jpg"
        bumpImageUrl="//unpkg.com/three-globe/example/img/earth-topology.png"
        showAtmosphere={true}
        atmosphereColor="#38bdf8"
        atmosphereAltitude={isExpanded ? 0.25 : 0.15}
        
        pointsData={pointsData}
        pointLat="lat"
        pointLng="lng"
        pointColor="color"
        pointRadius="size"
        pointAltitude={0.01}
        pointLabel={(d: any) => `
          <div style="background: rgba(15,23,42,0.9); padding: 8px; border-radius: 4px; border: 1px solid ${d.color}">
            <b style="color: ${d.color}">${d.type.toUpperCase()}</b><br/>
            ${d.title || d.region_name_en || d.keyword}
          </div>
        `}

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
