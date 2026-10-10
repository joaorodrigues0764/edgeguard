import { describe, expect, it } from "vitest";
import {
	buildEventDataPoint,
	buildRateLimitedDataPoint,
} from "../src/telemetry";

describe("Event telemetry", () => {
	it("maps server-error events to analytics data points", () => {
		const point = buildEventDataPoint({
			method: "GET",
			path: "/api/products",
			status: 500,
			latencyMs: 892,
		});

		expect(point).toEqual({
			blobs: [
				"GET",
				"/api/products",
				"500",
				"observed_event",
			],
			doubles: [1, 892, 1, 0],
			indexes: ["GET"],
		});
	});

	it("records rate-limited responses from monitored services", () => {
		const point = buildEventDataPoint({
			method: "POST",
			path: "/api/login",
			status: 429,
			latencyMs: 120,
		});

		expect(point).toEqual({
			blobs: [
				"POST",
				"/api/login",
				"429",
				"observed_event",
			],
			doubles: [1, 120, 0, 1],
			indexes: ["POST"],
		});
	});

	it("records normal requests without error flags", () => {
		const point = buildEventDataPoint({
			method: "GET",
			path: "/api/health",
			status: 200,
			latencyMs: 50,
		});

		expect(point).toEqual({
			blobs: [
				"GET",
				"/api/health",
				"200",
				"observed_event",
			],
			doubles: [1, 50, 0, 0],
			indexes: ["GET"],
		});
	});

	it("records rate-limited ingestion requests separately", () => {
		const point = buildRateLimitedDataPoint();

		expect(point).toEqual({
			blobs: [
				"POST",
				"/api/events",
				"429",
				"rate_limited_ingestion",
			],
			doubles: [1, 0, 0, 1],
			indexes: ["POST"],
		});
	});
});