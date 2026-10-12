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

const HOUR_MS = 60 * 60 * 1000;

export interface TimeSeriesPoint {
    timestamp: number;
    total: number;
    serverErrors: number;
    rateLimitedResponses: number;
    averageLatencyMs: number;
}

export interface DashboardTimeSeries {
    interval: "hour";
    hours: number;
    points: TimeSeriesPoint[];
}

export async function getDashboardTimeSeries(
    db: D1Database,
    hours: number,
    now: number = Date.now(),
): Promise<DashboardTimeSeries> {
    const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
    const firstHour = currentHour - (hours - 1) * HOUR_MS;
    const endExclusive = currentHour + HOUR_MS;

    const result = await db
        .prepare(`
            SELECT
                CAST(occurred_at / 3600000 AS INTEGER) * 3600000
                    AS timestamp,
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
            WHERE occurred_at >= ? AND occurred_at < ?
            GROUP BY CAST(occurred_at / 3600000 AS INTEGER)
            ORDER BY timestamp ASC
        `)
        .bind(firstHour, endExclusive)
        .all<TimeSeriesPoint>();

    const eventsByHour = new Map<number, TimeSeriesPoint>();

    for (const row of result.results) {
        eventsByHour.set(row.timestamp, row);
    }

    const points: TimeSeriesPoint[] = [];

    for (let i = 0; i < hours; i++) {
        const timestamp = firstHour + i * HOUR_MS;
        const metrics = eventsByHour.get(timestamp);

        points.push({
            timestamp,
            total: metrics?.total ?? 0,
            serverErrors: metrics?.serverErrors ?? 0,
            rateLimitedResponses:
                metrics?.rateLimitedResponses ?? 0,
            averageLatencyMs: metrics?.averageLatencyMs ?? 0,
        });
    }

    return {
        interval: "hour",
        hours,
        points,
    };
}