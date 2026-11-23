import type { WindowEvidence } from './anomaly';

const MINUTE_MS = 60_000;
const MAX_REPLAYED_EVENTS = 2000;

export interface TimelinePoint {
	eventId: string;
	createdAt: number;
	status: number;
	windowRequests: number;
	windowErrors: number;
	errorPercent: number;
	eligible: boolean;
	opening: boolean;
}

export interface IncidentTimeline {
	method: string;
	path: string;
	windowMinutes: number;
	openPercent: number;
	minRequests: number;
	minFailures: number;
	truncated: boolean;
	points: TimelinePoint[];
}

interface TimelineSource {
	eventId: string;
	method: string;
	path: string;
	createdAt: number;
	evidence: string | null;
}

interface ReplayedEvent {
	id: string;
	createdAt: number;
	status: number;
}

/**
 * Replays the endpoint's stored reports in insertion order, mirroring the
 * detect_endpoint_spike trigger in migration 0006, so the dashboard can show
 * how the rolling window error rate evolved around the opening report.
 * The thresholds come from the immutable opening evidence, not the live policy.
 * Returns undefined for an unknown incident and null when there is no evidence.
 */
export async function getIncidentTimeline(db: D1Database, incidentId: string): Promise<IncidentTimeline | null | undefined> {
	const source = await db
		.prepare(
			`
				SELECT
				    e.id AS eventId,
				    e.method,
				    e.path,
				    e.created_at AS createdAt,
				    ep.evidence
				FROM incidents AS i
				INNER JOIN events AS e ON e.id = i.event_id
				LEFT JOIN anomaly_episodes AS ep ON ep.event_id = i.event_id
				WHERE i.id = ?
			`,
		)
		.bind(incidentId)
		.first<TimelineSource>();

	if (!source) {
		return undefined;
	}

	if (!source.evidence) {
		return null;
	}

	const evidence: WindowEvidence = JSON.parse(source.evidence);
	const windowMinutes = Math.round((evidence.windowEndExclusiveMs - evidence.windowStartMs) / MINUTE_MS);
	const openingMinute = Math.floor(source.createdAt / MINUTE_MS);

	// Earlier reports only warm up the window; later ones show what followed the opening.
	const warmupStartMs = (openingMinute - 2 * windowMinutes + 1) * MINUTE_MS;
	const displayStartMs = (openingMinute - windowMinutes + 1) * MINUTE_MS;
	const endExclusiveMs = (openingMinute + windowMinutes + 1) * MINUTE_MS;

	const result = await db
		.prepare(
			`
				SELECT id, created_at AS createdAt, status
				FROM events
				WHERE method = ? AND path = ? AND created_at >= ? AND created_at < ?
				ORDER BY rowid ASC
				LIMIT ?
			`,
		)
		.bind(source.method, source.path, warmupStartMs, endExclusiveMs, MAX_REPLAYED_EVENTS + 1)
		.all<ReplayedEvent>();

	const events = result.results.slice(0, MAX_REPLAYED_EVENTS);
	const minutes = new Map<number, { requests: number; failures: number }>();
	const points: TimelinePoint[] = [];
	let newestMinute = -Infinity;

	for (const event of events) {
		const minute = Math.floor(event.createdAt / MINUTE_MS);
		const bucket = minutes.get(minute) ?? { requests: 0, failures: 0 };

		bucket.requests += 1;
		bucket.failures += event.status >= 500 ? 1 : 0;
		minutes.set(minute, bucket);
		newestMinute = Math.max(newestMinute, minute);

		let windowRequests = 0;
		let windowErrors = 0;

		for (const [key, value] of minutes) {
			if (key <= newestMinute - windowMinutes) {
				minutes.delete(key);
			} else {
				windowRequests += value.requests;
				windowErrors += value.failures;
			}
		}

		if (event.createdAt < displayStartMs) {
			continue;
		}

		points.push({
			eventId: event.id,
			createdAt: event.createdAt,
			status: event.status,
			windowRequests,
			windowErrors,
			errorPercent: (100 * windowErrors) / windowRequests,
			eligible: windowRequests >= evidence.minRequests && windowErrors >= evidence.minFailures,
			opening: event.id === source.eventId,
		});
	}

	return {
		method: source.method,
		path: source.path,
		windowMinutes,
		openPercent: evidence.openPercent,
		minRequests: evidence.minRequests,
		minFailures: evidence.minFailures,
		truncated: result.results.length > MAX_REPLAYED_EVENTS,
		points,
	};
}
