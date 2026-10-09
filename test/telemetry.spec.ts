import { describe, expect, it } from "vitest";
import { buildEventDataPoint } from "../src/telemetry";

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
			],
			doubles: [1, 892, 1, 0],
			indexes: ["GET"],
		});
	});

	it("records rate-limited requests", () => {
		const point = buildEventDataPoint({
			method: "POST",
			path: "/api/login",
			status: 429,
			latencyMs: 120,
		});

		expect(point.doubles).toEqual([
			1,
			120,
			0,
			1,
		]);

		expect(point.indexes).toEqual(["POST"]);
	});

	it("records normal requests without error flags", () => {
		const point = buildEventDataPoint({
			method: "GET",
			path: "/api/health",
			status: 200,
			latencyMs: 50,
		});

		expect(point.doubles).toEqual([
			1,
			50,
			0,
			0,
		]);
	});
});