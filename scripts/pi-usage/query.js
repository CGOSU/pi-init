import { summarizeCostSource } from "./core.js";
import { readUsageState } from "./database.js";
import { numberValue, averageTps } from "./numbers.js";

export async function readSummary(connection, range) {
  const rowsReader = await connection.runAndReadAll(
    `
      WITH unique_events AS (
        SELECT model, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, total_tokens, cost, cost_from_provider, entry_key, event_date,
          ROW_NUMBER() OVER (PARTITION BY entry_key ORDER BY source_file) AS occurrence
        FROM usage_events
      )
      SELECT model, COUNT(*) AS calls,
        COALESCE(SUM(input_tokens), 0) AS input,
        COALESCE(SUM(output_tokens), 0) AS output,
        COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
        COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COALESCE(SUM(cost), 0) AS cost,
        CASE WHEN BOOL_AND(COALESCE(cost_from_provider, FALSE)) THEN 'provider'
          WHEN BOOL_OR(COALESCE(cost_from_provider, FALSE)) THEN 'mixed'
          ELSE 'estimated' END AS cost_source
      FROM unique_events
      WHERE occurrence = 1 AND event_date >= $start_date AND event_date <= $end_date
      GROUP BY model
      ORDER BY cost DESC
    `,
    { start_date: range.startDate, end_date: range.endDate },
  );
  const speedReader = await connection.runAndReadAll(
    `
      WITH unique_events AS (
        SELECT model, output_tokens, generation_seconds, event_date, entry_key,
          ROW_NUMBER() OVER (PARTITION BY entry_key ORDER BY source_file) AS occurrence
        FROM speed_events
      )
      SELECT model,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(generation_seconds), 0) AS generation_seconds
      FROM unique_events
      WHERE occurrence = 1 AND event_date >= $start_date AND event_date <= $end_date
      GROUP BY model
    `,
    { start_date: range.startDate, end_date: range.endDate },
  );
  const sessionsReader = await connection.runAndReadAll(
    `
      WITH unique_events AS (
        SELECT source_file, event_date, entry_key,
          ROW_NUMBER() OVER (PARTITION BY entry_key ORDER BY source_file) AS occurrence
        FROM usage_events
      )
      SELECT COUNT(DISTINCT source_file) AS sessions
      FROM unique_events
      WHERE occurrence = 1 AND event_date >= $start_date AND event_date <= $end_date
    `,
    { start_date: range.startDate, end_date: range.endDate },
  );
  const durationReader = await connection.runAndReadAll(
    `
      SELECT
        COALESCE(SUM(active_seconds), 0) AS active_seconds,
        COALESCE(SUM(model_wait_seconds), 0) AS model_wait_seconds,
        COALESCE(SUM(session_span_seconds), 0) AS session_span_seconds
      FROM duration_summaries
      WHERE report_date >= $start_date AND report_date <= $end_date AND scope = 'overall'
    `,
    { start_date: range.startDate, end_date: range.endDate },
  );
  const speedByModel = new Map(
    speedReader.getRowObjects().map((row) => [
      row.model,
      {
        outputTokens: numberValue(row.output_tokens),
        generationSeconds: numberValue(row.generation_seconds),
      },
    ]),
  );
  const rows = rowsReader.getRowObjects().map((row) => ({
    model: row.model,
    calls: numberValue(row.calls),
    input: numberValue(row.input),
    output: numberValue(row.output),
    cacheRead: numberValue(row.cacheRead),
    cacheWrite: numberValue(row.cacheWrite),
    tokens: numberValue(row.tokens),
    cost: numberValue(row.cost),
    costSource: row.cost_source,
    avgTps: averageTps(speedByModel.get(row.model)),
  }));
  const speed = [...speedByModel.values()].reduce(
    (total, value) => ({
      outputTokens: total.outputTokens + value.outputTokens,
      generationSeconds: total.generationSeconds + value.generationSeconds,
    }),
    { outputTokens: 0, generationSeconds: 0 },
  );
  const durationRow = durationReader.getRowObjects()[0];
  const duration = {
    sessions: numberValue(sessionsReader.getRowObjects()[0]?.sessions),
    activeSeconds: numberValue(durationRow?.active_seconds),
    modelWaitSeconds: numberValue(durationRow?.model_wait_seconds),
    sessionSpanSeconds: numberValue(durationRow?.session_span_seconds),
  };
  const usageState = await readUsageState(connection);
  return {
    date: range.date,
    sessions: numberValue(sessionsReader.getRowObjects()[0]?.sessions),
    rows,
    costSource: summarizeCostSource(rows),
    speed: { ...speed, avgTps: averageTps(speed) },
    duration,
    updatedAt: Number.isFinite(usageState?.checkedMs)
      ? new Date(usageState.checkedMs).toISOString()
      : undefined,
  };
}
