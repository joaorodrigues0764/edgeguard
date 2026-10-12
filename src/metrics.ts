export interface DashboardMetrics {
    events: {
        total: number;
        serverErrors: number;
        rateLimitedResponses: number;
        averageLatencyMs: number;
    };
    incidents: {
        total: number;
        open: number;
        resolved: number;
        bySeverity: {
            medium: number;
            high: number;
            critical: number;
        };
    };
}

interface EventMetricsRow {
    total: number;
    serverErrors: number;
    rateLimitedResponses: number;
    averageLatencyMs: number;
}

interface IncidentMetricsRow {
    total: number;
    open: number;
    resolved: number;
    medium: number;
    high: number;
    critical: number;
}

export async function getDashboardMetrics(
    db: D1Database,
): Promise<DashboardMetrics> {
    const [eventMetrics, incidentMetrics] = await Promise.all([
        db
            .prepare(`
                SELECT
                    COUNT(*) AS total,
                    COALESCE(
                        SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END),
                        0
                    ) AS serverErrors,
                    COALESCE(
                        SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END),
                        0
                    ) AS rateLimitedResponses,
                    COALESCE(AVG(latency_ms), 0) AS averageLatencyMs
                FROM events
            `)
            .first<EventMetricsRow>(),

        db
            .prepare(`
                SELECT
                    COUNT(*) AS total,
                    COALESCE(
                        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END),
                        0
                    ) AS open,
                    COALESCE(
                        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END),
                        0
                    ) AS resolved,
                    COALESCE(
                        SUM(CASE WHEN severity = 'medium' THEN 1 ELSE 0 END),
                        0
                    ) AS medium,
                    COALESCE(
                        SUM(CASE WHEN severity = 'high' THEN 1 ELSE 0 END),
                        0
                    ) AS high,
                    COALESCE(
                        SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END),
                        0
                    ) AS critical
                FROM incidents
            `)
            .first<IncidentMetricsRow>(),
    ]);

    return {
        events: {
            total: eventMetrics?.total ?? 0,
            serverErrors: eventMetrics?.serverErrors ?? 0,
            rateLimitedResponses:
                eventMetrics?.rateLimitedResponses ?? 0,
            averageLatencyMs: eventMetrics?.averageLatencyMs ?? 0,
        },
        incidents: {
            total: incidentMetrics?.total ?? 0,
            open: incidentMetrics?.open ?? 0,
            resolved: incidentMetrics?.resolved ?? 0,
            bySeverity: {
                medium: incidentMetrics?.medium ?? 0,
                high: incidentMetrics?.high ?? 0,
                critical: incidentMetrics?.critical ?? 0,
            },
        },
    };
}
