import { validated, type Analysis } from './analysis';
import type { WindowEvidence } from "./anomaly";

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
    analysisState: 'not_requested' | 'pending' | 'running' | 'complete' | 'failed';
    analysis: Analysis | null;
    evidence: WindowEvidence | null;
}

export function getDetectionResult(db: D1Database, eventId: string) {
	return db
		.prepare(
			`
				SELECT ep.evidence, i.id AS incidentId
				FROM events e
				LEFT JOIN anomaly_episodes ep ON ep.event_id = e.id
				LEFT JOIN incidents i ON i.event_id = e.id
				WHERE e.id = ?
			`,
		)
		.bind(eventId)
		.first<{ evidence: string | null; incidentId: string | null }>();
}

export async function createIncident(
    db: D1Database,
    eventId: string,
    anomaly: { severity: IncidentSeverity; reason: string },
    requestAnalysis = false,
): Promise<boolean> {
    const result = await db
        .prepare(`
            INSERT INTO incidents (
                id,
                event_id,
                severity,
                reason,
                status,
                created_at, analysis_state
            )
            VALUES (?, ?, ?, ?, 'open', ?, ?)
            ON CONFLICT(event_id) DO NOTHING
        `)
        .bind(
            crypto.randomUUID(),
            eventId,
            anomaly.severity,
            anomaly.reason,
            Date.now(),
            requestAnalysis ? 'pending' : 'not_requested',
        )
        .run();

    return result.meta.changes > 0;
}

const incidentSelect = `
        SELECT
            CASE WHEN i.analysis_state = 'running' AND i.analysis_expires_at <= unixepoch('now') * 1000
                 THEN 'failed' ELSE i.analysis_state END AS analysisState,
            i.analysis_json AS analysisJson,
            ep.evidence AS evidenceJson,
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
        LEFT JOIN anomaly_episodes ep ON ep.event_id = i.event_id
    `;

type StoredIncident = Omit<IncidentRecord, 'analysis' | 'evidence'> & { analysisJson: string | null; evidenceJson: string | null };

function present({ analysisJson, evidenceJson, ...row }: StoredIncident): IncidentRecord {
	const analysis = row.analysisState === 'complete' ? validated(analysisJson) : null;
	return {
		...row,
		analysis,
		evidence: evidenceJson ? JSON.parse(evidenceJson) : null,
	};
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

    let query = incidentSelect;
    if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
    }

    query += " ORDER BY i.created_at DESC LIMIT ?";
    bindings.push(filters.limit);

    const result = await db
        .prepare(query)
        .bind(...bindings)
        .all<StoredIncident>();

    return result.results.map(present);
}

export async function updateIncidentStatus(
    db: D1Database,
    incidentId: string,
    status: IncidentStatus,
): Promise<IncidentRecord | null> {
    const result = await db
        .prepare(`
            UPDATE incidents
            SET status = ?
            WHERE id = ?
        `)
        .bind(status, incidentId)
        .run();

    if (result.meta.changes === 0) {
        return null;
    }

    const incident = await db
        .prepare(incidentSelect + ' WHERE i.id = ?')
        .bind(incidentId)
        .first<StoredIncident>();

    return incident ? present(incident) : null;
}
