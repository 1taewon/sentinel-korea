export type AlertLevel = 'G3' | 'G2' | 'G1' | 'G0';

export type SignalDetail = {
  source_type: string;
  label: string;
  raw_value: number | null;
  unit: string;
  updated_at: string;
  coverage: number;
  freshness_days: number;
  qc_flag: string;
  baseline_mean: number;
  baseline_sd: number;
  z_score: number;
  normalized_score: number;
  algorithm_version: string;
};

export type DataQuality = {
  score: number;
  label: string;
};

export type KoreaAlert = {
  region_code: string;
  region_id: string;
  region_name_en: string;
  region_name_kr: string;
  lat: number;
  lng: number;
  epiweek: string;
  pathogen: string;
  score: number;
  level: AlertLevel;
  source_type: string;
  signals: Record<string, number | null>;
  signal_details: Record<string, SignalDetail>;
  active_sources: number;
  independent_sources: number;
  confidence: string;
  alert_explanation: string[];
  explanation: string[];
  snapshot_date: string;
  algorithm_version: string;
  data_quality: DataQuality;
  date: string;
  national_respiratory?: {
    level: string;
    score: number;
    details: {
      influenza_rate: number;
      ari_cases: number;
      sari_cases: number;
    };
  };
  regional_wastewater?: {
    covid19: { level: string; score: number };
    influenza: { level: string; score: number };
  };
  news_trends_risk?: { score: number; level: string; reason: string };
  total_risk?: { score: number; level: string; reason: string };
};

export type GlobalSignal = {
  id: string;
  source: 'healthmap' | 'promed' | 'google_trends' | 'kdca_global_report' | string;
  title?: string;
  keyword?: string;
  lat: number;
  lng: number;
  date: string;
  disease?: string;
  country?: string;
  trend_score?: number;
  baseline?: number;
  severity: 'low' | 'medium' | 'high';
  url?: string;
  publisher?: string;
  snippet?: string;
  // HealthMap-specific signals
  marker_alert_count?: number;       // # alerts at this place
  marker_pin?: string;               // raw HealthMap pin code (e.g. "l3", "s2")
  marker_pin_tier?: string;          // "location_cluster" | "single_alert" | "unknown"
  marker_significance?: number;      // 0..1, derived from pin
};

export type SignalConfig = {
  label: string;
  description: string;
  source: string;
  enabled: boolean;
};

export type ScoringConfig = {
  signals: Record<string, SignalConfig>;
  weights: Record<string, number>;
  active_threshold: number;
  level_thresholds: Record<AlertLevel, number>;
  formula: string;
  convergence_note: string;
};

export type IngestionSourceStatus = {
  source: string;
  status: string;
  latest_snapshot: string;
  cadence: string;
  notes: string;
};

export type IngestionStatus = {
  latest_snapshot: string;
  available_snapshots: string[];
  sources: IngestionSourceStatus[];
};

export type TimelinePoint = {
  snapshot_date: string;
  epiweek: string;
  score: number;
  level: AlertLevel;
  confidence: string;
};

export type CombinedData = {
  korea: KoreaAlert[];
  global: GlobalSignal[];
  meta?: {
    generated_at: string;
    snapshot_date: string;
    algorithm_version: string;
    korea_regions: number;
    global_signals: number;
  };
};
