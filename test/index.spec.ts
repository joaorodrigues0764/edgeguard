import { env, exports } from "cloudflare:workers";
import {
	createExecutionContext,
	createMessageBatch,
	getQueueResult,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { detectAnomaly } from "../src/anomaly";
import { insertEvent } from "../src/events";

interface Event {
	id: string;
	occurredAt: number;
	method: string;
	path: string;
	status: number;
	latencyMs: number;
	clientId: string | null;
	createdAt: number;
}

interface EventResponse {
	data: Event;
}

interface EventListResponse {
	data: Event[];
}

interface ErrorResponse {
	error: string;
}

async function readJson<T>(
	response: Response,
): Promise<T> {
	return (await response.json()) as T;
}

describe("EdgeGuard Worker", () => {
	beforeEach(async () => {
		await env.edgeguard_db
			.prepare("DELETE FROM incidents")
			.run();

		await env.edgeguard_db
			.prepare("DELETE FROM events")
			.run();
	});

	it("responds to the health check", async () => {
		const response = await exports.default.fetch(
			"http://example.com/health",
		);

		expect(response.status).toBe(200);

		const body = await readJson<{
			status: string;
			timestamp: string;
		}>(response);

		expect(body.status).toBe("ok");
		expect(typeof body.timestamp).toBe("string");
	});

	it("returns a list of stored events", async () => {
		const response = await exports.default.fetch(
			"http://example.com/api/events",
		);

		expect(response.status).toBe(200);

		const body =
			await readJson<EventListResponse>(response);

		expect(body.data).toEqual([]);
	});

	it("creates and stores an event", async () => {
		const request = new Request(
			"http://example.com/api/events",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					method: "GET",
					path: "/api/products",
					status: 500,
					latencyMs: 892,
					clientId: "test-client",
				}),
			},
		);

		const response =
			await exports.default.fetch(request);

		expect(response.status).toBe(201);

		const body =
			await readJson<EventResponse>(response);

		expect(body.data).toMatchObject({
			method: "GET",
			path: "/api/products",
			status: 500,
			latencyMs: 892,
			clientId: "test-client",
		});

		expect(typeof body.data.id).toBe("string");
		expect(typeof body.data.occurredAt).toBe("number");
		expect(typeof body.data.createdAt).toBe("number");

		const storedEvent = await env.edgeguard_db
			.prepare(
				"SELECT * FROM events WHERE id = ?",
			)
			.bind(body.data.id)
			.first();

		expect(storedEvent).toMatchObject({
			id: body.data.id,
			method: "GET",
			path: "/api/products",
			status: 500,
			client_id: "test-client",
		});

		expect(storedEvent?.latency_ms).toBe(892);
	});

	it("rejects invalid JSON", async () => {
		const request = new Request(
			"http://example.com/api/events",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: "{",
			},
		);

		const response =
			await exports.default.fetch(request);

		expect(response.status).toBe(400);

		const body =
			await readJson<ErrorResponse>(response);

		expect(body).toEqual({
			error: "Invalid JSON body",
		});
	});

	it("rejects an invalid event payload", async () => {
		const request = new Request(
			"http://example.com/api/events",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					method: "INVALID",
					path: "/api/test",
					status: 200,
					latencyMs: 100,
				}),
			},
		);

		const response =
			await exports.default.fetch(request);

		expect(response.status).toBe(400);

		const body =
			await readJson<ErrorResponse>(response);

		expect(body).toEqual({
			error: "Invalid event payload",
		});
	});

	it("lists stored events", async () => {
		const request = new Request(
			"http://example.com/api/events",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					method: "POST",
					path: "/api/login",
					status: 200,
					latencyMs: 120,
				}),
			},
		);

		await exports.default.fetch(request);

		const response = await exports.default.fetch(
			"http://example.com/api/events?limit=10",
		);

		expect(response.status).toBe(200);

		const body =
			await readJson<EventListResponse>(response);

		expect(body.data).toHaveLength(1);

		expect(body.data[0]).toMatchObject({
			method: "POST",
			path: "/api/login",
			status: 200,
			latencyMs: 120,
		});
	});

	it("rejects an invalid limit", async () => {
		const response = await exports.default.fetch(
			"http://example.com/api/events?limit=101",
		);

		expect(response.status).toBe(400);

		const body =
			await readJson<ErrorResponse>(response);

		expect(body).toEqual({
			error:
				"limit must be an integer between 1 and 100",
		});
	});
});

describe("Anomaly detection", () => {
	it("does not flag a normal event", () => {
		expect(
			detectAnomaly({
				status: 200,
				latencyMs: 100,
			}),
		).toBeNull();
	});

	it("detects server errors", () => {
		expect(
			detectAnomaly({
				status: 500,
				latencyMs: 892,
			}),
		).toEqual({
			severity: "high",
			reason: "Server returned a 5xx response",
		});
	});

	it("detects rate-limited requests", () => {
		expect(
			detectAnomaly({
				status: 429,
				latencyMs: 100,
			}),
		).toEqual({
			severity: "medium",
			reason: "Request was rate limited",
		});
	});

	it("detects high latency", () => {
		expect(
			detectAnomaly({
				status: 200,
				latencyMs: 2500,
			}),
		).toEqual({
			severity: "medium",
			reason:
				"Request latency exceeded the anomaly threshold",
		});
	});

	it("classifies slow server errors as critical", () => {
		expect(
			detectAnomaly({
				status: 500,
				latencyMs: 7000,
			}),
		).toEqual({
			severity: "critical",
			reason:
				"Server error combined with very high latency",
		});
	});
});

async function processQueueMessage(
	eventId: string,
	messageId: string,
	attempts = 1,
) {
	const batch = createMessageBatch("edgeguard-events", [
		{
			id: messageId,
			timestamp: new Date(1000),
			attempts,
			body: {
				type: "event.received",
				eventId,
			},
		},
	]);

	const context = createExecutionContext();
	await worker.queue(batch, env, context);

	return getQueueResult(batch, context);
}

describe("Queue consumer", () => {
	beforeEach(async () => {
		await env.edgeguard_db
			.prepare("DELETE FROM incidents")
			.run();

		await env.edgeguard_db
			.prepare("DELETE FROM events")
			.run();
	});

	it("creates a high-severity incident for a server error", async () => {
		const event = await insertEvent(env.edgeguard_db, {
			method: "GET",
			path: "/api/products",
			status: 500,
			latencyMs: 892,
			clientId: "test-client",
		});

		const result = await processQueueMessage(
			event.id,
			"high-incident-message",
		);

		expect(result.explicitAcks).toStrictEqual([
			"high-incident-message",
		]);

		const incident = await env.edgeguard_db
			.prepare(`
				SELECT event_id, severity, reason, status
				FROM incidents
				WHERE event_id = ?
			`)
			.bind(event.id)
			.first();

		expect(incident).toMatchObject({
			event_id: event.id,
			severity: "high",
			reason: "Server returned a 5xx response",
			status: "open",
		});
	});

	it("does not create an incident for a normal event", async () => {
		const event = await insertEvent(env.edgeguard_db, {
			method: "GET",
			path: "/api/products",
			status: 200,
			latencyMs: 100,
		});

		const result = await processQueueMessage(
			event.id,
			"normal-event-message",
		);

		expect(result.explicitAcks).toStrictEqual([
			"normal-event-message",
		]);

		const incident = await env.edgeguard_db
			.prepare(
				"SELECT id FROM incidents WHERE event_id = ?",
			)
			.bind(event.id)
			.first();

		expect(incident).toBeNull();
	});

	it("does not create duplicate incidents for a redelivered message", async () => {
		const event = await insertEvent(env.edgeguard_db, {
			method: "GET",
			path: "/api/database",
			status: 500,
			latencyMs: 7000,
		});

		await processQueueMessage(
			event.id,
			"critical-message-first-delivery",
		);

		await processQueueMessage(
			event.id,
			"critical-message-redelivery",
		);

		const result = await env.edgeguard_db
			.prepare(`
				SELECT COUNT(*) AS count
				FROM incidents
				WHERE event_id = ?
			`)
			.bind(event.id)
			.first<{ count: number }>();

		expect(result?.count).toBe(1);
	});
});