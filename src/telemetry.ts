import type { Event } from "./events";

type EventTelemetryInput = Pick<
	Event,
	"method" | "path" | "status" | "latencyMs"
>;

export interface EventDataPoint {
	blobs: string[];
	doubles: number[];
	indexes: string[];
}

export function buildEventDataPoint(
	event: EventTelemetryInput,
): EventDataPoint {
	return {
		blobs: [
			event.method,
			event.path,
			String(event.status),
		],
		doubles: [
			1,
			event.latencyMs,
			event.status >= 500 ? 1 : 0,
			event.status === 429 ? 1 : 0,
		],
		indexes: [event.method],
	};
}

export function writeEventTelemetry(
	analytics: AnalyticsEngineDataset,
	event: EventTelemetryInput,
): void {
	analytics.writeDataPoint(
		buildEventDataPoint(event),
	);
}