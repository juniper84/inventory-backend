import fs from 'fs';
import path from 'path';

export type RequestMetric = {
  key: string;
  method: string;
  route: string;
  ms: number;
  ok: boolean;
  status: number;
  retryCount: number;
  requestBytes: number;
  responseBytes: number;
};

export type StepMetric = {
  label: string;
  startedAt: string;
  endedAt: string;
  ms: number;
};

const percentile = (values: number[], p: number) => {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * (sorted.length - 1))),
  );
  return sorted[index];
};

export const buildRequestSummary = (metrics: RequestMetric[]) => {
  const byKey = new Map<string, RequestMetric[]>();
  for (const item of metrics) {
    const arr = byKey.get(item.key) ?? [];
    arr.push(item);
    byKey.set(item.key, arr);
  }

  const endpointStats = Array.from(byKey.entries()).map(([key, rows]) => {
    const latencies = rows.map((row) => row.ms);
    const failures = rows.filter((row) => !row.ok).length;
    const retries = rows.reduce((sum, row) => sum + row.retryCount, 0);
    const reqBytes = rows.reduce((sum, row) => sum + row.requestBytes, 0);
    const resBytes = rows.reduce((sum, row) => sum + row.responseBytes, 0);
    return {
      key,
      count: rows.length,
      failures,
      failureRate: rows.length ? failures / rows.length : 0,
      retries,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      avgMs: rows.length
        ? latencies.reduce((sum, value) => sum + value, 0) / rows.length
        : 0,
      requestBytes: reqBytes,
      responseBytes: resBytes,
    };
  });

  const all = metrics.map((item) => item.ms);
  const failures = metrics.filter((item) => !item.ok).length;
  return {
    totals: {
      requests: metrics.length,
      failures,
      failureRate: metrics.length ? failures / metrics.length : 0,
      retries: metrics.reduce((sum, row) => sum + row.retryCount, 0),
      p50: percentile(all, 50),
      p95: percentile(all, 95),
      p99: percentile(all, 99),
      requestBytes: metrics.reduce((sum, row) => sum + row.requestBytes, 0),
      responseBytes: metrics.reduce((sum, row) => sum + row.responseBytes, 0),
    },
    slowestEndpoints: [...endpointStats]
      .sort((a, b) => b.p95 - a.p95)
      .slice(0, 20),
    endpointStats,
  };
};

export const writeSimulationReport = (input: {
  runId: string;
  profile: unknown;
  metrics: Record<string, unknown>;
  warnings: string[];
  entityCounts: Record<string, number>;
  requestMetrics: RequestMetric[];
  stepMetrics: StepMetric[];
  assertions: Array<{ name: string; passed: boolean; detail?: string }>;
}) => {
  const reportDir = path.join(process.cwd(), 'tmp');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }
  const summary = buildRequestSummary(input.requestMetrics);
  const reportPath = path.join(reportDir, `system-sim-report-${input.runId}.json`);
  const payload = {
    runId: input.runId,
    finishedAt: new Date().toISOString(),
    profile: input.profile,
    metrics: input.metrics,
    warnings: input.warnings,
    entityCounts: input.entityCounts,
    requestSummary: summary,
    stepMetrics: input.stepMetrics,
    assertions: input.assertions,
  };
  fs.writeFileSync(reportPath, JSON.stringify(payload, null, 2));
  return reportPath;
};
