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

interface Incident {
    id: string;
    eventId: string;
    severity: "medium" | "high" | "critical";
    reason: string;
    status: "open" | "resolved";
	createdAt: number;
    eventMethod: string;
    eventPath: string;
    eventStatus: number;
    eventLatencyMs: number;
    eventOccurredAt: number;
}

interface IncidentListResponse {
        data: Incident[];
}

interface IncidentResponse {
        data: Incident;
}

interface ErrorResponse {
	error: string;
}

async function readJson<T>(
	response: Response,
): Promise<T> {
	return (await response.json()) as T;
}

interface TestIncidentInput {
    severity: "medium" | "high" | "critical";
    status: "open" | "resolved";
    path: string;
    eventStatus: number;
    latencyMs: number;
    createdAt: number;
}

async function seedIncident(
    input: TestIncidentInput,
): Promise<string> {
    const event = await insertEvent(env.edgeguard_db, {
        method: "GET",
        path: input.path,
        status: input.eventStatus,
        latencyMs: input.latencyMs,
    });

    const incidentId = crypto.randomUUID();

    await env.edgeguard_db
        .prepare(`
            INSERT INTO incidents (
                id,
                event_id,
                severity,
                reason,
                status,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
        `)
        .bind(
            incidentId,
            event.id,
            input.severity,
            `Test ${input.severity} incident`,
            input.status,
            input.createdAt,
        )
        .run();

    return incidentId;
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


    it("lists incidents with their related event data", async () => {
            await seedIncident({
                    severity: "high",
                    status: "open",
                    path: "/api/products",
                    eventStatus: 500,
                    latencyMs: 892,
                    createdAt: 1000,
            });

            const response = await exports.default.fetch(
                    "http://example.com/api/incidents",
            );

            expect(response.status).toBe(200);

            const body =
                    await readJson<IncidentListResponse>(response);

            expect(body.data).toHaveLength(1);
            expect(body.data[0]).toMatchObject({
                    severity: "high",
                    reason: "Test high incident",
                    status: "open",
                    createdAt: 1000,
                    eventMethod: "GET",
                    eventPath: "/api/products",
                    eventStatus: 500,
                    eventLatencyMs: 892,
            });

            expect(typeof body.data[0].id).toBe("string");
            expect(typeof body.data[0].eventId).toBe("string");
    });

    it("filters incidents by severity and status", async () => {
	        await seedIncident({
                    severity: "high",
                    status: "open",
                    path: "/api/high",
                    eventStatus: 500,
                    latencyMs: 100,
                    createdAt: 1000,
            });

            await seedIncident({
                    severity: "critical",
                    status: "open",
                    path: "/api/critical",
                    eventStatus: 500,
                    latencyMs: 6000,
                    createdAt: 2000,
            });

            await seedIncident({
                    severity: "medium",
                    status: "resolved",
                    path: "/api/slow",
                    eventStatus: 200,
                    latencyMs: 2500,
                    createdAt: 3000,
            });

            const severityResponse = await exports.default.fetch(
                    "http://example.com/api/incidents?severity=critical",
            );

            const severityBody =
                    await readJson<IncidentListResponse>(severityResponse);

            expect(severityResponse.status).toBe(200);
            expect(severityBody.data).toHaveLength(1);
            expect(severityBody.data[0].severity).toBe("critical");

            const statusResponse = await exports.default.fetch(
                    "http://example.com/api/incidents?status=resolved",
            );

            const statusBody =
                    await readJson<IncidentListResponse>(statusResponse);

            expect(statusResponse.status).toBe(200);
            expect(statusBody.data).toHaveLength(1);
            expect(statusBody.data[0].status).toBe("resolved");

            const combinedResponse = await exports.default.fetch(
                    "http://example.com/api/incidents?severity=high&status=open",
            );

            const combinedBody =
                    await readJson<IncidentListResponse>(combinedResponse);

            expect(combinedResponse.status).toBe(200);
            expect(combinedBody.data).toHaveLength(1);
            expect(combinedBody.data[0]).toMatchObject({
                    severity: "high",
                    status: "open",
            });
    });

    it("orders incidents by creation time and respects the limit", async () => {
            await seedIncident({
                    severity: "high",
                    status: "open",
                    path: "/api/oldest",
                    eventStatus: 500,
                    latencyMs: 100,
                    createdAt: 100,
            });

            await seedIncident({
                    severity: "critical",
                    status: "open",
                    path: "/api/newest",
                    eventStatus: 500,
                    latencyMs: 6000,
                    createdAt: 300,
            });

            await seedIncident({
                    severity: "medium",
                    status: "open",
                    path: "/api/middle",
                    eventStatus: 200,
                    latencyMs: 2500,
                    createdAt: 200,
            });

            const response = await exports.default.fetch(
                    "http://example.com/api/incidents?limit=2",
            );

            const body =
                    await readJson<IncidentListResponse>(response);

            expect(response.status).toBe(200);
            expect(body.data).toHaveLength(2);
            expect(body.data.map((incident) => incident.eventPath)).toEqual([
                    "/api/newest",
                    "/api/middle",
            ]);
    });

    it("rejects an invalid incident severity", async () => {
            const response = await exports.default.fetch(
                    "http://example.com/api/incidents?severity=urgent",
            );

            expect(response.status).toBe(400);

            const body = await readJson<ErrorResponse>(response);

            expect(body.error).toBe(
                    "severity must be medium, high, or critical",
            );
    });

    it("rejects an invalid incident status", async () => {
            const response = await exports.default.fetch(
                    "http://example.com/api/incidents?status=pending",
            );

            expect(response.status).toBe(400);

            const body = await readJson<ErrorResponse>(response);

            expect(body.error).toBe(
                    "status must be open or resolved",
            );
    });

    it("rejects an invalid incident limit", async () => {
            const response = await exports.default.fetch(
 	               "http://example.com/api/incidents?limit=101",
            );

            expect(response.status).toBe(400);

            const body = await readJson<ErrorResponse>(response);

            expect(body.error).toBe(
                    "limit must be an integer between 1 and 100",
            );
    });
    
	it("resolves an open incident", async () => {
        const incidentId = await seedIncident({
            severity: "high",
            status: "open",
            path: "/api/products",
            eventStatus: 500,
            latencyMs: 892,
            createdAt: 1000,
        });

        const response = await exports.default.fetch(
            `http://example.com/api/incidents/${incidentId}`,
            {
                method: "PATCH",
                headers: {
                        "Content-Type": "application/json",
                },
                body: JSON.stringify({
                        status: "resolved",
                }),
            },
        );

        expect(response.status).toBe(200);

        const body =
            await readJson<IncidentResponse>(response);

        expect(body.data).toMatchObject({
            id: incidentId,
            severity: "high",
            status: "resolved",
        });

        const storedIncident = await env.edgeguard_db
            .prepare(
                "SELECT status FROM incidents WHERE id = ?",
            )
            .bind(incidentId)
            .first<{ status: string }>();

        expect(storedIncident?.status).toBe("resolved");
    });
    
	it("reopens a resolved incident", async () => {
        const incidentId = await seedIncident({
            severity: "critical",
            status: "resolved",
            path: "/api/checkout",
            eventStatus: 500,
            latencyMs: 6000,
            createdAt: 2000,
        });

        const response = await exports.default.fetch(
            `http://example.com/api/incidents/${incidentId}`,
            {
                method: "PATCH",
                headers: {
                        "Content-Type": "application/json",
                },
                body: JSON.stringify({
                        status: "open",
                }),
            },
        );

        expect(response.status).toBe(200);

        const body =
            await readJson<IncidentResponse>(response);

        expect(body.data).toMatchObject({
                id: incidentId,
                status: "open",
        });
    });
    
	it("rejects an invalid incident status update", async () => {
        const response = await exports.default.fetch(
            "http://example.com/api/incidents/test-id",
            {
                method: "PATCH",
                headers: {
                        "Content-Type": "application/json",
                },
                body: JSON.stringify({
                        status: "pending",
                }),
        	},
        );

        expect(response.status).toBe(400);

        const body = await readJson<ErrorResponse>(response);

        expect(body.error).toBe(
            "status must be open or resolved",
        );
    });
    
	it("rejects an incident update without a status", async () => {
        const response = await exports.default.fetch(
            "http://example.com/api/incidents/test-id",
            {
                method: "PATCH",
                headers: {
                        "Content-Type": "application/json",
                },
                body: JSON.stringify({}),
            },
        );

        expect(response.status).toBe(400);

        const body = await readJson<ErrorResponse>(response);

        expect(body.error).toBe(
            "status must be open or resolved",
        );
    });
    
	it("rejects invalid JSON in an incident update", async () => {
        const response = await exports.default.fetch(
            "http://example.com/api/incidents/test-id",
            {
                method: "PATCH",
                headers: {
                        "Content-Type": "application/json",
                },
                body: "{",
            },
        );

        expect(response.status).toBe(400);

        const body = await readJson<ErrorResponse>(response);

        expect(body.error).toBe("Invalid JSON body");
    });
    
	it("returns 404 when the incident does not exist", async () => {
        const response = await exports.default.fetch(
            "http://example.com/api/incidents/non-existent-id",
            {
                method: "PATCH",
                headers: {
                        "Content-Type": "application/json",
                },
                body: JSON.stringify({
                        status: "resolved",
                }),
            },
        );

        expect(response.status).toBe(404);

        const body = await readJson<ErrorResponse>(response);

        expect(body.error).toBe("Incident not found");
    });
	
	it("rate limits repeated event-ingestion requests", async () => {
		const responses: Array<{
			clientId: string;
			response: Response;
		}> = [];

		for (let i = 0; i < 20; i++) {
			const clientId = `rate-test-${i}`;

			const request = new Request(
				"http://example.com/api/events",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"cf-connecting-ip": "192.0.2.42",
					},
					body: JSON.stringify({
						method: "GET",
						path: "/api/products",
						status: 200,
						latencyMs: 25,
						clientId,
					}),
				},
			);

			const response = await exports.default.fetch(request);

			responses.push({ clientId, response });
		}

		const rejectedRequests = responses.filter(
			({ response }) => response.status === 429,
		);

		expect(rejectedRequests.length).toBeGreaterThan(0);

		for (const { clientId, response } of rejectedRequests) {
			expect(await response.json()).toMatchObject({
				error: "Rate limit exceeded",
			});

			expect(response.headers.get("Retry-After")).toBe("10");

			const storedEvent = await env.edgeguard_db
				.prepare(
					"SELECT id FROM events WHERE client_id = ?",
				)
				.bind(clientId)
				.first();

			expect(storedEvent).toBeNull();
		}

		expect(
			responses.every(({ response }) =>
				response.status === 201 || response.status === 429
			),
		).toBe(true);
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