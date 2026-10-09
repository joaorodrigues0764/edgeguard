import type { Anomaly } from "./anomaly";

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