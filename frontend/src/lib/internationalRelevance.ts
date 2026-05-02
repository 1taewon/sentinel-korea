import type { GlobalSignal } from '../types';
import { reliabilityFor } from './sourceReliability';

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

/** HealthMap-specific signal volume — many alerts at one place = real cluster.
 *  log scale: 1 alert → 0.25, 5 → 0.55, 10 → 0.7, 20 → 0.85, 30+ → 0.95
 */
function markerVolumeBoost(signal: GlobalSignal): number {
  const count = signal.marker_alert_count ?? 0;
  if (count <= 1) return 0;
  return clamp(0.18 + Math.log10(count + 1) * 0.45);
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

/**
 * Time decay — older news = lower relevance.
 * 0d   → 1.00
 * 30d  → 0.78
 * 90d  → 0.45
 * 180d → 0.18
 * >180d → 0.10 floor
 */
function recencyScore(signal: GlobalSignal): number {
  if (!signal.date) return 0.6;
  const ts = Date.parse(signal.date);
  if (Number.isNaN(ts)) return 0.6;
  const ageDays = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24));
  // Exponential decay with half-life ~60 days
  const decay = Math.exp(-ageDays / 60);
  return clamp(decay, 0.1, 1);
}

export function scoreInternationalRelevance(signal: GlobalSignal) {
  const distanceKm = distanceToKoreaKm(signal);
  const proximityScore = clamp(1 - Math.min(distanceKm, 9000) / 9000);
  const severityScore = signal.severity === 'high' ? 1 : signal.severity === 'medium' ? 0.62 : 0.3;
  // Differential source reliability — official agency feeds outweigh raw news headlines.
  const sourceScore = reliabilityFor(signal.source);
  const riskScore = diseaseRisk(signal);
  const trafficScore = trafficProxy(signal, distanceKm);
  const unexpectedScore = unexpectedness(signal);
  const recency = recencyScore(signal);
  // HealthMap signals: marker volume (clustering) + pin significance (curated tier)
  const markerVolume = markerVolumeBoost(signal);
  const markerSignificance = signal.marker_significance ?? 0;

  // base composite (ignoring recency)
  const baseScore = clamp(
    severityScore * 0.22 +
      riskScore * 0.20 +
      trafficScore * 0.18 +
      proximityScore * 0.14 +
      unexpectedScore * 0.08 +
      sourceScore * 0.06 +
      markerVolume * 0.07 +
      markerSignificance * 0.05,
  );

  // Time decay: recency multiplicatively dampens older signals
  // Floor at baseScore * 0.25 so very old severe events don't disappear entirely
  const score = clamp(Math.max(baseScore * recency, baseScore * 0.25));

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
      recency,
      markerVolume,
      markerSignificance,
    },
  };
}

export function relevanceLabel(score: number) {
  if (score >= 0.75) return '한국 관련성: 매우 높음';
  if (score >= 0.58) return '한국 관련성: 높음';
  if (score >= 0.4) return '한국 관련성: 관찰';
  return '한국 관련성: 참고';
}
