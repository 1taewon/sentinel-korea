import type { GlobalSignal } from '../types';

const KOREA_CENTER = { lat: 37.5665, lng: 126.9780 };

const HIGH_TRAFFIC_COUNTRY_PROXY: Record<string, number> = {
  china: 0.95,
  japan: 0.95,
  taiwan: 0.82,
  vietnam: 0.78,
  thailand: 0.76,
  philippines: 0.72,
  singapore: 0.72,
  indonesia: 0.66,
  malaysia: 0.65,
  usa: 0.64,
  'united states': 0.64,
  australia: 0.56,
  canada: 0.52,
  india: 0.5,
};

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

export function distanceToKoreaKm(signal: GlobalSignal) {
  const earthKm = 6371;
  const dLat = toRadians(KOREA_CENTER.lat - signal.lat);
  const dLng = toRadians(KOREA_CENTER.lng - signal.lng);
  const lat1 = toRadians(signal.lat);
  const lat2 = toRadians(KOREA_CENTER.lat);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return earthKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function textFor(signal: GlobalSignal) {
  return [signal.title, signal.keyword, signal.disease, signal.country, signal.source]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function diseaseRisk(signal: GlobalSignal) {
  const text = textFor(signal);
  if (/(h5n1|avian|mers|sars|novel|unknown|hemorrhagic|fatal|severe pneumonia)/.test(text)) return 1;
  if (/(covid|coronavirus|influenza|flu|pneumonia|respiratory outbreak|cluster)/.test(text)) return 0.78;
  if (/(rsv|mycoplasma|fever|cough|respiratory)/.test(text)) return 0.58;
  return 0.3;
}

function unexpectedness(signal: GlobalSignal) {
  const text = textFor(signal);
  let score = 0;
  if (/(unknown|novel|unexplained|cluster|new variant|first case|fatal)/.test(text)) score += 0.55;
  if (signal.source === 'promed') score += 0.22;
  if (signal.severity === 'high') score += 0.18;
  return clamp(score);
}

function trafficProxy(signal: GlobalSignal, distanceKm: number) {
  const country = (signal.country || '').toLowerCase();
  const matched = Object.entries(HIGH_TRAFFIC_COUNTRY_PROXY).find(([key]) => country.includes(key));
  if (matched) return matched[1];
  if (distanceKm < 900) return 0.82;
  if (distanceKm < 2500) return 0.68;
  if (distanceKm < 5500) return 0.48;
  return 0.28;
}

export function scoreInternationalRelevance(signal: GlobalSignal) {
  const distanceKm = distanceToKoreaKm(signal);
  const proximityScore = clamp(1 - Math.min(distanceKm, 9000) / 9000);
  const severityScore = signal.severity === 'high' ? 1 : signal.severity === 'medium' ? 0.62 : 0.3;
  const sourceScore = signal.source === 'promed' ? 0.86 : signal.source === 'healthmap' ? 0.72 : 0.55;
  const riskScore = diseaseRisk(signal);
  const trafficScore = trafficProxy(signal, distanceKm);
  const unexpectedScore = unexpectedness(signal);

  const score = clamp(
    severityScore * 0.25 +
      riskScore * 0.22 +
      trafficScore * 0.2 +
      proximityScore * 0.15 +
      unexpectedScore * 0.12 +
      sourceScore * 0.06,
  );

  const level = score >= 0.75 ? 'critical' : score >= 0.58 ? 'high' : score >= 0.4 ? 'watch' : 'context';
  const color = level === 'critical' ? '#ff4d4f' : level === 'high' ? '#f59e42' : level === 'watch' ? '#38d8ff' : '#8b8cff';

  return {
    score,
    level,
    color,
    distanceKm,
    pulseCount: Math.max(1, Math.min(5, Math.round(score * 5))),
    stroke: 0.28 + score * 1.25,
    speed: 3300 - score * 1700,
    factors: {
      severity: severityScore,
      diseaseRisk: riskScore,
      trafficProxy: trafficScore,
      proximity: proximityScore,
      unexpectedness: unexpectedScore,
      sourceReliability: sourceScore,
    },
  };
}

export function relevanceLabel(score: number) {
  if (score >= 0.75) return '한국 관련성: 매우 높음';
  if (score >= 0.58) return '한국 관련성: 높음';
  if (score >= 0.4) return '한국 관련성: 관찰';
  return '한국 관련성: 참고';
}
