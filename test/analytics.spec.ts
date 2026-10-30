import { describe, expect, it, vi } from "vitest";
import { getTelemetryMetrics } from "../src/analytics";

describe("Analytics SQL sampling contract", () => {
    it("uses automatic sample weights and binds the requested time window", async () => {
        const query = vi.fn(async (_request: AnalyticsSQLQuery) => ({
            // These aggregates are already weighted by the SQL API.
            data: [{
                blob4: "observed_event", total: 100,
                server_errors: 10, rate_limited_responses: 5, total_latency_ms: 25000,
            }],
            rows: 1, statistics: { elapsed_ms: 1, rows_read: 10, bytes_read: 100 },
        }));
        const now = Date.parse("2026-10-28T12:00:00Z");
        const result = await getTelemetryMetrics(
            { query } as unknown as AnalyticsSQLBinding, 6, now,
        );
        const request = query.mock.calls[0]![0];
        expect(request.query).not.toMatch(/sampleInterval/i);
        expect(request.query).toMatch(/SELECT\s+blob4\s*,/);
        expect(request.query).toContain("SUM(double1)");
        expect(request.query).toContain("SUM(double2)");
        expect(request.params).toEqual({
            start: "2026-10-28T06:00:00.000Z", end: "2026-10-28T12:00:00.000Z",
        });
        expect(result.observedEvents).toEqual({
            total: 100, serverErrors: 10, rateLimitedResponses: 5, averageLatencyMs: 250,
        });
    });
});
