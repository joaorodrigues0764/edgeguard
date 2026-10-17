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

interface DashboardMetricsResponse {
    data: {
        events: {
            total: number;
            serverErrors: number;
            rateLimitedResponses: number;
            averageLatencyMs: number;
        };
        incidents: {
            total: number;
            open: number;
            resolved: number;
            bySeverity: {
                medium: number;
                high: number;
                critical: number;
            };
        };
    };
}

interface DashboardTimeSeriesResponse {
    data: {
        interval: "hour";
        hours: number;
        points: Array<{
            timestamp: number;
            total: number;
            serverErrors: number;
            rateLimitedResponses: number;
            averageLatencyMs: number;
        }>;
    };
}

interface ErrorResponse {
    error: string;
}

async function readJson<T>(
    response: Response,
): Promise<T> {
    return (await response.json()) as T;
}

const rawWorkerFetch = exports.default.fetch.bind(exports.default);

async function fetchTestRequest(
    input: RequestInfo | URL,
    init?: RequestInit,
): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);

    let token: string | undefined;

    if (
        request.method === "POST" &&
        url.pathname === "/api/events"
    ) {
        token = env.INGEST_API_TOKEN;
    } else if (
        request.method === "PATCH" &&
        /^\/api\/incidents\/[^/]+$/.test(url.pathname)
    ) {
        token = env.ADMIN_API_TOKEN;
    } else if (
        request.method === "GET" &&
        [
            "/api/events",
            "/api/incidents",
            "/api/metrics",
            "/api/metrics/timeseries",
        ].includes(url.pathname)
    ) {
        token = env.DASHBOARD_API_TOKEN;
    }

    if (!token || request.headers.has("Authorization")) {
        return rawWorkerFetch(request);
    }

    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${token}`);

    return rawWorkerFetch(
        new Request(request, { headers }),
    );
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
        const response = await fetchTestRequest(
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
        const response = await fetchTestRequest(
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
            await fetchTestRequest(request);

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
            await fetchTestRequest(request);

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
            await fetchTestRequest(request);

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

        await fetchTestRequest(request);

        const response = await fetchTestRequest(
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
        const response = await fetchTestRequest(
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

            const response = await fetchTestRequest(
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

            const severityResponse = await fetchTestRequest(
                    "http://example.com/api/incidents?severity=critical",
            );

            const severityBody =
                    await readJson<IncidentListResponse>(severityResponse);

            expect(severityResponse.status).toBe(200);
            expect(severityBody.data).toHaveLength(1);
            expect(severityBody.data[0].severity).toBe("critical");

            const statusResponse = await fetchTestRequest(
                    "http://example.com/api/incidents?status=resolved",
            );

            const statusBody =
                    await readJson<IncidentListResponse>(statusResponse);

            expect(statusResponse.status).toBe(200);
            expect(statusBody.data).toHaveLength(1);
            expect(statusBody.data[0].status).toBe("resolved");

            const combinedResponse = await fetchTestRequest(
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

            const response = await fetchTestRequest(
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
            const response = await fetchTestRequest(
                    "http://example.com/api/incidents?severity=urgent",
            );

            expect(response.status).toBe(400);

            const body = await readJson<ErrorResponse>(response);

            expect(body.error).toBe(
                    "severity must be medium, high, or critical",
            );
    });

    it("rejects an invalid incident status", async () => {
            const response = await fetchTestRequest(
                    "http://example.com/api/incidents?status=pending",
            );

            expect(response.status).toBe(400);

            const body = await readJson<ErrorResponse>(response);

            expect(body.error).toBe(
                    "status must be open or resolved",
            );
    });

    it("rejects an invalid incident limit", async () => {
            const response = await fetchTestRequest(
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

        const response = await fetchTestRequest(
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

        const response = await fetchTestRequest(
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
        const response = await fetchTestRequest(
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
        const response = await fetchTestRequest(
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
        const response = await fetchTestRequest(
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
        const response = await fetchTestRequest(
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

    it("returns zeroed dashboard metrics when the database is empty", async () => {
        const response = await fetchTestRequest(
            "http://example.com/api/metrics",
        );

        expect(response.status).toBe(200);

        const body =
            await readJson<DashboardMetricsResponse>(response);

        expect(body.data).toEqual({
            events: {
                total: 0,
                serverErrors: 0,
                rateLimitedResponses: 0,
                averageLatencyMs: 0,
            },
            incidents: {
                total: 0,
                open: 0,
                resolved: 0,
                bySeverity: {
                    medium: 0,
                    high: 0,
                    critical: 0,
                },
            },
        });
    });

    it("calculates dashboard metrics from events and incidents", async () => {
        await seedIncident({
            severity: "medium",
            status: "resolved",
            path: "/api/slow",
            eventStatus: 429,
            latencyMs: 100,
            createdAt: 1000,
        });

        await seedIncident({
            severity: "high",
            status: "open",
            path: "/api/products",
            eventStatus: 500,
            latencyMs: 300,
            createdAt: 2000,
        });

        await seedIncident({
            severity: "critical",
            status: "open",
            path: "/api/checkout",
            eventStatus: 503,
            latencyMs: 500,
            createdAt: 3000,
        });

        const response = await fetchTestRequest(
            "http://example.com/api/metrics",
        );

        expect(response.status).toBe(200);

        const body =
            await readJson<DashboardMetricsResponse>(response);

        expect(body.data).toEqual({
            events: {
                total: 3,
                serverErrors: 2,
                rateLimitedResponses: 1,
                averageLatencyMs: 300,
            },
            incidents: {
                total: 3,
                open: 2,
                resolved: 1,
                bySeverity: {
                    medium: 1,
                    high: 1,
                    critical: 1,
                },
            },
        });
    });

    it("returns empty hourly buckets when there are no events", async () => {
        const response = await fetchTestRequest(
            "http://example.com/api/metrics/timeseries?hours=3",
        );

        expect(response.status).toBe(200);

        const body =
            await readJson<DashboardTimeSeriesResponse>(response);

        expect(body.data.interval).toBe("hour");
        expect(body.data.hours).toBe(3);
        expect(body.data.points).toHaveLength(3);

        for (const point of body.data.points) {
            expect(point.timestamp % 3_600_000).toBe(0);
            expect(point.total).toBe(0);
            expect(point.serverErrors).toBe(0);
            expect(point.rateLimitedResponses).toBe(0);
            expect(point.averageLatencyMs).toBe(0);
        }

        for (let i = 1; i < body.data.points.length; i++) {
            expect(
                body.data.points[i].timestamp -
                body.data.points[i - 1].timestamp,
            ).toBe(3_600_000);
        }
    });

    it("aggregates event metrics into hourly buckets", async () => {
        const hourMs = 3_600_000;
        const oldOccurredAt = Date.now() - 2 * hourMs;

        const oldEvent = await insertEvent(env.edgeguard_db, {
            method: "GET",
            path: "/api/products",
            status: 500,
            latencyMs: 300,
        });

        await env.edgeguard_db
            .prepare(
                "UPDATE events SET occurred_at = ? WHERE id = ?",
            )
            .bind(oldOccurredAt, oldEvent.id)
            .run();

        const recentEvent = await insertEvent(env.edgeguard_db, {
            method: "POST",
            path: "/api/login",
            status: 429,
            latencyMs: 100,
        });

        const response = await fetchTestRequest(
            "http://example.com/api/metrics/timeseries?hours=4",
        );

        expect(response.status).toBe(200);

        const body =
            await readJson<DashboardTimeSeriesResponse>(response);

        expect(body.data.points).toHaveLength(4);

        const oldBucketTimestamp =
            Math.floor(oldOccurredAt / hourMs) * hourMs;

        const recentBucketTimestamp =
            Math.floor(recentEvent.occurredAt / hourMs) * hourMs;

        const oldBucket = body.data.points.find(
            (point) => point.timestamp === oldBucketTimestamp,
        );

        const recentBucket = body.data.points.find(
            (point) => point.timestamp === recentBucketTimestamp,
        );

        expect(oldBucket).toMatchObject({
            total: 1,
            serverErrors: 1,
            rateLimitedResponses: 0,
            averageLatencyMs: 300,
        });

        expect(recentBucket).toMatchObject({
            total: 1,
            serverErrors: 0,
            rateLimitedResponses: 1,
            averageLatencyMs: 100,
        });
    });

    it("rejects invalid time-series hour ranges", async () => {
        for (const hours of ["0", "169", "abc", "1.5"]) {
            const response = await fetchTestRequest(
                `http://example.com/api/metrics/timeseries?hours=${hours}`,
            );

            expect(response.status).toBe(400);

            const body =
                await readJson<ErrorResponse>(response);

            expect(body.error).toBe(
                "hours must be an integer between 1 and 168",
            );
        }
    });

    it("rejects protected API requests without a token", async () => {
        const requests: Request[] = [
            new Request(
                "http://example.com/api/events",
            ),
            new Request(
                "http://example.com/api/incidents",
            ),
            new Request(
                "http://example.com/api/metrics",
            ),
            new Request(
                "http://example.com/api/metrics/timeseries",
            ),
            new Request(
                "http://example.com/api/events",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        method: "GET",
                        path: "/api/test",
                        status: 200,
                        latencyMs: 25,
                    }),
                },
            ),
            new Request(
                "http://example.com/api/incidents/test-id",
                {
                    method: "PATCH",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        status: "resolved",
                    }),
                },
            ),
        ];

        for (const request of requests) {
            const response = await rawWorkerFetch(request);

            expect(response.status).toBe(401);
            expect(
                response.headers.get("WWW-Authenticate"),
            ).toBe("Bearer");
        }

        const eventCount = await env.edgeguard_db
            .prepare("SELECT COUNT(*) AS total FROM events")
            .first<{ total: number }>();

        expect(eventCount?.total).toBe(0);
    });

    it("rejects invalid tokens and non-Bearer authentication", async () => {
        const authorizationHeaders = [
            "Bearer invalid-test-token",
            "Basic test-token",
        ];

        for (const authorization of authorizationHeaders) {
            const request = new Request(
                "http://example.com/api/metrics",
                {
                    headers: {
                        Authorization: authorization,
                    },
                },
            );

            const response = await rawWorkerFetch(request);

            expect(response.status).toBe(401);
            expect(
                response.headers.get("WWW-Authenticate"),
            ).toBe("Bearer");
        }
    });

    it("forbids API access when the token has insufficient permissions", async () => {
        const requests = [
            new Request(
                "http://example.com/api/events",
                {
                    method: "POST",
                    headers: {
                            Authorization:
                                `Bearer ${env.DASHBOARD_API_TOKEN}`,
                            "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                            method: "GET",
                            path: "/api/test",
                            status: 200,
                            latencyMs: 25,
                    }),
                },
            ),
            new Request(
                "http://example.com/api/metrics",
                {
                    headers: {
                            Authorization:
                                `Bearer ${env.INGEST_API_TOKEN}`,
                    },
                },
            ),
            new Request(
                "http://example.com/api/incidents/test-id",
                {
                    method: "PATCH",
                    headers: {
                            Authorization:
                                `Bearer ${env.DASHBOARD_API_TOKEN}`,
                            "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                            status: "resolved",
                    }),
                },
            ),
        ];

        for (const request of requests) {
            const response = await rawWorkerFetch(request);

            expect(response.status).toBe(403);
            expect(await response.json()).toEqual({
                error: "Forbidden",
            });
        }

        const eventCount = await env.edgeguard_db
            .prepare("SELECT COUNT(*) AS total FROM events")
            .first<{ total: number }>();

        expect(eventCount?.total).toBe(0);
    });

    it("replays an event for the same idempotency key and payload", async () => {
        const idempotencyKey = "idempotency-replay-test";
        const payload = {
            method: "GET",
            path: "/api/products",
            status: 200,
            latencyMs: 100,
            clientId: "idempotency-client",
        };

        const createRequest = () => new Request(
            "http://example.com/api/events",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Idempotency-Key": idempotencyKey,
                    "cf-connecting-ip": "198.51.100.41",
                },
                body: JSON.stringify(payload),
            },
        );

        const firstResponse = await fetchTestRequest(createRequest());

        expect(firstResponse.status).toBe(201);

        const firstBody =
            await readJson<EventResponse>(firstResponse);

        const secondResponse = await fetchTestRequest(createRequest());

        expect(secondResponse.status).toBe(200);
        expect(
            secondResponse.headers.get("Idempotency-Replayed"),
        ).toBe("true");

        const secondBody =
            await readJson<EventResponse>(secondResponse);

        expect(secondBody.data.id).toBe(firstBody.data.id);

        const storedEvents = await env.edgeguard_db
            .prepare(`
                SELECT COUNT(*) AS total
                FROM events
                WHERE idempotency_key = ?
            `)
            .bind(idempotencyKey)
            .first<{ total: number }>();

        expect(storedEvents?.total).toBe(1);
    });

    it("rejects an idempotency key reused with a different payload", async () => {
        const idempotencyKey = "idempotency-conflict-test";

        const createRequest = (path: string) =>
            new Request("http://example.com/api/events", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Idempotency-Key": idempotencyKey,
                    "cf-connecting-ip": "198.51.100.42",
                },
                body: JSON.stringify({
                    method: "GET",
                    path,
                    status: 200,
                    latencyMs: 100,
                }),
            });

        const firstResponse = await fetchTestRequest(
            createRequest("/api/products"),
        );

        expect(firstResponse.status).toBe(201);

        const conflictResponse = await fetchTestRequest(
            createRequest("/api/orders"),
        );

        expect(conflictResponse.status).toBe(409);

        expect(await conflictResponse.json()).toEqual({
            error: "Idempotency key reused with a different payload",
        });

        const storedEvents = await env.edgeguard_db
            .prepare(`
                SELECT COUNT(*) AS total
                FROM events
                WHERE idempotency_key = ?
            `)
            .bind(idempotencyKey)
            .first<{ total: number }>();

        expect(storedEvents?.total).toBe(1);
    });

    it("rejects an invalid idempotency key", async () => {
        const response = await fetchTestRequest(
            new Request("http://example.com/api/events", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Idempotency-Key": "invalid key with spaces",
                    "cf-connecting-ip": "198.51.100.43",
                },
                body: JSON.stringify({
                    method: "GET",
                    path: "/api/products",
                    status: 200,
                    latencyMs: 100,
                }),
            }),
        );

        expect(response.status).toBe(400);

        const body = await readJson<ErrorResponse>(response);

        expect(body.error).toBe(
            "Idempotency-Key must contain 1 to 128 letters, numbers, dots, underscores, colons, or hyphens",
        );

        const storedEvents = await env.edgeguard_db
            .prepare("SELECT COUNT(*) AS total FROM events")
            .first<{ total: number }>();

        expect(storedEvents?.total).toBe(0);
    });

    it("retries queue delivery for an existing pending event", async () => {
        const idempotencyKey = "idempotency-queue-retry-test";

        const createRequest = () =>
            new Request("http://example.com/api/events", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Idempotency-Key": idempotencyKey,
                    "cf-connecting-ip": "198.51.100.44",
                },
                body: JSON.stringify({
                    method: "GET",
                    path: "/api/health",
                    status: 200,
                    latencyMs: 25,
                }),
            });

        const firstResponse = await fetchTestRequest(createRequest());

        expect(firstResponse.status).toBe(201);

        const firstBody =
            await readJson<EventResponse>(firstResponse);

        await env.edgeguard_db
            .prepare(`
                UPDATE events
                SET queue_status = 'pending'
                WHERE idempotency_key = ?
            `)
            .bind(idempotencyKey)
            .run();

        const retryResponse = await fetchTestRequest(createRequest());

        expect(retryResponse.status).toBe(200);
        expect(
            retryResponse.headers.get("Idempotency-Replayed"),
        ).toBe("true");

        const retryBody =
            await readJson<EventResponse>(retryResponse);

        expect(retryBody.data.id).toBe(firstBody.data.id);

        const storedEvent = await env.edgeguard_db
            .prepare(`
                SELECT queue_status
                FROM events
                WHERE idempotency_key = ?
            `)
            .bind(idempotencyKey)
            .first<{ queue_status: string }>();

        expect(storedEvent?.queue_status).toBe("sent");

        const storedEvents = await env.edgeguard_db
            .prepare(`
                SELECT COUNT(*) AS total
                FROM events
                WHERE idempotency_key = ?
            `)
            .bind(idempotencyKey)
            .first<{ total: number }>();

        expect(storedEvents?.total).toBe(1);
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

            const response = await fetchTestRequest(request);

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