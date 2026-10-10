import type { Anomaly } from "./anomaly";

export type IncidentSeverity = "medium" | "high" | "critical";
export type IncidentStatus = "open" | "resolved";

export interface IncidentFilters {
    limit: number;
    severity?: IncidentSeverity;
    status?: IncidentStatus;
}

export interface IncidentRecord {
    id: string;
    eventId: string;
    severity: IncidentSeverity;
    reason: string;
    status: IncidentStatus;
    createdAt: number;
    eventMethod: string;
    eventPath: string;
    eventStatus: number;
    eventLatencyMs: number;
    eventOccurredAt: number;
}

export interface EventForAnalysis {
    id: string;
    status: number;
    latencyMs: number;
}

export async function getEventForAnalysis(
    db: D1Database,
    eventId: string,
): Promise<EventForAnalysis | null> {
    const event = await db
        .prepare(`
            SELECT
                id,
                status,
                latency_ms AS latencyMs
            FROM events
            WHERE id = ?
        `)
        .bind(eventId)
        .first<EventForAnalysis>();

    return event ?? null;
}

export async function createIncident(
    db: D1Database,
    eventId: string,
    anomaly: Anomaly,
): Promise<boolean> {
    const result = await db
        .prepare(`
            INSERT OR IGNORE INTO incidents (
                id,
                event_id,
                severity,
                reason,
                status,
                created_at
            )
            VALUES (?, ?, ?, ?, 'open', ?)
        `)
        .bind(
            crypto.randomUUID(),
            eventId,
            anomaly.severity,
            anomaly.reason,
            Date.now(),
        )
        .run();

    return result.meta.changes > 0;
}

export async function listIncidents(
    db: D1Database,
    filters: IncidentFilters,
): Promise<IncidentRecord[]> {
    const conditions: string[] = [];
    const bindings: Array<string | number> = [];

    if (filters.severity !== undefined) {
        conditions.push("i.severity = ?");
        bindings.push(filters.severity);
    }

    if (filters.status !== undefined) {
        conditions.push("i.status = ?");
        bindings.push(filters.status);
    }

    let query = `
        SELECT
            i.id,
            i.event_id AS eventId,
            i.severity,
            i.reason,
            i.status,
            i.created_at AS createdAt,
            e.method AS eventMethod,
            e.path AS eventPath,
            e.status AS eventStatus,
            e.latency_ms AS eventLatencyMs,
            e.occurred_at AS eventOccurredAt
        FROM incidents AS i
        INNER JOIN events AS e ON e.id = i.event_id
    `;

    if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
    }

    query += " ORDER BY i.created_at DESC LIMIT ?";
    bindings.push(filters.limit);

    const result = await db
        .prepare(query)
        .bind(...bindings)
        .all<IncidentRecord>();

    return result.results;
}