import {
	insertEvent,
	validateEventInput,
	type EventReceivedMessage,
} from "./events";
import { detectAnomaly } from "./anomaly";
import {
	createIncident,
	getEventForAnalysis,
} from "./incidents";

export interface Env {
	edgeguard_db: D1Database;
	EVENTS_QUEUE: Queue<EventReceivedMessage>;
}

function isEventReceivedMessage(
	body: unknown,
): body is EventReceivedMessage {
	if (typeof body !== "object" || body === null) {
		return false;
	}

	const candidate = body as Record<string, unknown>;

	return (
		candidate.type === "event.received" &&
		typeof candidate.eventId === "string" &&
		candidate.eventId.length > 0
	);
}

export default {
	async queue(batch, env, ctx): Promise<void> {
		for (const message of batch.messages) {
			const body: unknown = message.body;

			// Invalid messages will not become valid through retrying.
			if (!isEventReceivedMessage(body)) {
				console.warn(
					"Discarding invalid queue message:",
					JSON.stringify(body),
				);

				message.ack();
				continue;
			}

			try {
				const event = await getEventForAnalysis(
					env.edgeguard_db,
					body.eventId,
				);

				// The event may have been removed before processing.
				if (!event) {
					console.warn(
						`Event ${body.eventId} was not found`,
					);

					message.ack();
					continue;
				}

				const anomaly = detectAnomaly(event);

				if (anomaly) {
					await createIncident(
						env.edgeguard_db,
						event.id,
						anomaly,
					);

					console.log(
						`Created ${anomaly.severity} incident for event ${event.id}`,
					);
				}

				// A normal event is also successfully processed.
				message.ack();
			} catch (error) {
				console.error(
					`Failed to process event ${body.eventId}:`,
					error,
				);

				// Ask Cloudflare Queues to retry this message.
				message.retry();
			}
		}
	},

	async fetch(
		request: Request,
		env: Env,
	): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;

		// Health check endpoint
		if (method === "GET" && path === "/health") {
			return Response.json({
				status: "ok",
				timestamp: new Date().toISOString(),
			});
		}

		// List stored events
		if (method === "GET" && path === "/api/events") {
			const limitParam =
				url.searchParams.get("limit") ?? "20";
			const limit = Number(limitParam);

			if (
				!Number.isInteger(limit) ||
				limit < 1 ||
				limit > 100
			) {
				return Response.json(
					{
						error:
							"limit must be an integer between 1 and 100",
					},
					{ status: 400 },
				);
			}

			try {
				const result = await env.edgeguard_db
					.prepare(`
						SELECT
							id,
							occurred_at AS occurredAt,
							method,
							path,
							status,
							latency_ms AS latencyMs,
							client_id AS clientId,
							created_at AS createdAt
						FROM events
						ORDER BY occurred_at DESC
						LIMIT ?
					`)
					.bind(limit)
					.all();

				return Response.json({
					data: result.results,
				});
			} catch {
				return Response.json(
					{ error: "Failed to fetch events" },
					{ status: 500 },
				);
			}
		}

		// Ingest a new event
		if (method === "POST" && path === "/api/events") {
			let body: unknown;

			try {
				body = await request.json();
			} catch {
				return Response.json(
					{ error: "Invalid JSON body" },
					{ status: 400 },
				);
			}

			const input = validateEventInput(body);

			if (!input) {
				return Response.json(
					{ error: "Invalid event payload" },
					{ status: 400 },
				);
			}

			try {
				const event = await insertEvent(
					env.edgeguard_db,
					input,
				);

				await env.EVENTS_QUEUE.send({
					type: "event.received",
					eventId: event.id,
				});

				return Response.json(
					{ data: event },
					{ status: 201 },
				);
			} catch {
				return Response.json(
					{ error: "Failed to store event" },
					{ status: 500 },
				);
			}
		}

		// Fallback: 404 Not Found
		return Response.json(
			{ error: "Not Found" },
			{ status: 404 },
		);
	},
} satisfies ExportedHandler<Env>;