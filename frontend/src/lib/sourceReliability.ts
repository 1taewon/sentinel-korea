/**
 * Source reliability score per outbreak data source.
 *
 * Higher = more authoritative / curated. Used as the `sourceReliability` factor
 * in scoreInternationalRelevance, and as a label/tooltip data source in the
 * World outbreak panel.
 *
 * Tier reasoning:
 *  - 0.92+ : Official IHR / public-health agencies (WHO, ECDC, US CDC) — primary truth.
 *  - 0.78-0.90 : Curated outbreak surveillance services (ProMED, HealthMap) — moderated by epidemiologists.
 *  - 0.55-0.70 : AI-assisted or general-news aggregations (Gemini, NewsAPI) — useful but unverified.
 *  - 0.40-0.55 : Raw Google News / unfiltered headlines.
 */
export const SOURCE_RELIABILITY: Record<string, number> = {
  who_don: 0.95,
  ecdc: 0.92,
  cdc: 0.90,
  promed: 0.88,
  healthmap: 0.78,
  kdca_global_report: 0.85,
  gemini_outbreak: 0.65,
  news_global: 0.55,
  google_news_outbreak: 0.50,
  google_news: 0.45,
};

export const DEFAULT_SOURCE_RELIABILITY = 0.55;

export function reliabilityFor(source: string | undefined | null): number {
  if (!source) return DEFAULT_SOURCE_RELIABILITY;
  return SOURCE_RELIABILITY[source] ?? DEFAULT_SOURCE_RELIABILITY;
}

/** Tier label for UI badges. */
export function reliabilityTier(score: number): 'official' | 'curated' | 'ai' | 'raw' {
  if (score >= 0.88) return 'official';
  if (score >= 0.75) return 'curated';
  if (score >= 0.6) return 'ai';
  return 'raw';
}
