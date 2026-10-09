import type { Event } from "./events";

export type IncidentSeverity =
	| "medium"
	| "high"
	| "critical";

export interface Anomaly {
	severity: IncidentSeverity;
	reason: string;
}

export function detectAnomaly(
	event: Pick<Event, "status" | "latencyMs">,
): Anomaly | null {
	// A server error combined with very high latency is critical.
	if (event.status >= 500 && event.latencyMs >= 5000) {
		return {
			severity: "critical",
			reason:
				"Server error combined with very high latency",
		};
	}

	// Any 5xx response is considered a high-severity anomaly.
	if (event.status >= 500) {
		return {
			severity: "high",
			reason: "Server returned a 5xx response",
		};
	}

	// HTTP 429 indicates that the request was rate limited.
	if (event.status === 429) {
		return {
			severity: "medium",
			reason: "Request was rate limited",
		};
	}

	// Requests taking at least two seconds are considered slow.
	if (event.latencyMs >= 2000) {
		return {
			severity: "medium",
			reason:
				"Request latency exceeded the anomaly threshold",
		};
	}

	return null;
}