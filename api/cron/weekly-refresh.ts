/**
 * Vercel Cron Job — Weekly Pipeline Refresh
 * Schedule: Every Sunday 22:00 UTC (= Monday 07:00 KST)
 *
 * Calls the Railway backend API endpoints sequentially to:
 * 1. Refresh all data sources (news, trends, global outbreak, KDCA API)
 * 2. Run AI analysis (KDCA digest, OSINT, Sentinel integrated)
 * 3. Generate FINAL report
 *
 * Required Vercel Environment Variables:
 *   CRON_SECRET           — Vercel cron auth secret
 *   RAILWAY_BACKEND_URL   — e.g. https://sentinel-korea-production.up.railway.app
 *   SENTINEL_ADMIN_TOKEN  — Admin bearer token for backend auth
 */

interface PipelineStep {
  name: string;
  url: string;
  method: string;
  body?: Record<string, unknown>;
  timeoutMs?: number;
}

interface StepResult {
  step: string;
  status?: number;
  ok?: boolean;
  error?: string;
  durationMs?: number;
}

export default async function handler(
  req: any,
  res: any
) {
  // Verify cron secret
  const authHeader = req.headers["authorization"];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const BACKEND = process.env.RAILWAY_BACKEND_URL;
  const TOKEN = process.env.SENTINEL_ADMIN_TOKEN;

  if (!BACKEND || !TOKEN) {
    return res.status(500).json({
      error: "Missing env: RAILWAY_BACKEND_URL or SENTINEL_ADMIN_TOKEN",
    });
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  };

  const steps: PipelineStep[] = [
    // Phase 1: Data ingestion
    {
      name: "korea_news",
      url: `${BACKEND}/ingestion/refresh-korea`,
      method: "POST",
      timeoutMs: 120_000,
    },
    {
      name: "trends",
      url: `${BACKEND}/ingestion/refresh-trends`,
      method: "POST",
      timeoutMs: 180_000,
    },
    {
      name: "global_outbreak",
      url: `${BACKEND}/ingestion/refresh-global`,
      method: "POST",
      timeoutMs: 300_000,
    },
    {
      name: "kdca_api",
      url: `${BACKEND}/ingestion/refresh-kdca-notifiable`,
      method: "POST",
      timeoutMs: 120_000,
    },
    // Phase 2: AI analysis
    {
      name: "kdca_digest",
      url: `${BACKEND}/risk-analysis/kdca-digest`,
      method: "POST",
      timeoutMs: 120_000,
    },
    {
      name: "osint_analysis",
      url: `${BACKEND}/risk-analysis/analyze-news-trends`,
      method: "POST",
      timeoutMs: 180_000,
    },
    {
      name: "sentinel_integrated",
      url: `${BACKEND}/risk-analysis/analyze`,
      method: "POST",
      body: { include_kdca: true },
      timeoutMs: 180_000,
    },
    // Phase 3: Report generation
    {
      name: "final_report",
      url: `${BACKEND}/reports/generate-final`,
      method: "POST",
      timeoutMs: 180_000,
    },
  ];

  const results: StepResult[] = [];
  const startTime = Date.now();

  for (const step of steps) {
    const stepStart = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        step.timeoutMs || 120_000
      );

      const response = await fetch(step.url, {
        method: step.method,
        headers,
        body: step.body ? JSON.stringify(step.body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      results.push({
        step: step.name,
        status: response.status,
        ok: response.ok,
        durationMs: Date.now() - stepStart,
      });

      // If a critical step fails, continue anyway (best-effort pipeline)
      // The FINAL report will still be generated with whatever data is available
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      results.push({
        step: step.name,
        error: message,
        durationMs: Date.now() - stepStart,
      });
    }
  }

  const totalDurationMs = Date.now() - startTime;
  const allOk = results.every((r) => r.ok);

  return res.status(200).json({
    ran_at: new Date().toISOString(),
    total_duration_ms: totalDurationMs,
    all_ok: allOk,
    steps_completed: results.filter((r) => r.ok).length,
    steps_total: results.length,
    results,
  });
}
