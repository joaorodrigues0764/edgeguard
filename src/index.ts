import {
    hashEventInput,
    insertEvent,
    insertOrGetIdempotentEvent,
    markEventQueued,
    validateEventInput,
    type Event,
    type EventReceivedMessage,
} from "./events";
import { detectAnomaly } from "./anomaly";
import {
    createIncident,
    getEventForAnalysis,
    listIncidents,
    updateIncidentStatus,
    type IncidentSeverity,
    type IncidentStatus,
} from "./incidents";
import {
    writeEventTelemetry,
    writeRateLimitedTelemetry,
} from "./telemetry";
import {
    getDashboardMetrics,
    getDashboardTimeSeries,
} from "./metrics";
import { authorizeRequest, type ApiRole } from "./auth";

export interface Env {
    edgeguard_db: D1Database;
    EVENTS_QUEUE: Queue<EventReceivedMessage>;
    EDGEGUARD_ANALYTICS: AnalyticsEngineDataset;
    EVENT_INGEST_RATE_LIMITER: RateLimit;
    INGEST_API_TOKEN: string;
    DASHBOARD_API_TOKEN: string;
    ADMIN_API_TOKEN: string;
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

function isIncidentSeverity(
        value: string,
): value is IncidentSeverity {
        return (
        value === "medium" ||
        value === "high" ||
        value === "critical"
        );
}

function isIncidentStatus(
    value: string,
): value is IncidentStatus {
    return value === "open" || value === "resolved";
}

export default {
    async queue(batch, env, ctx): Promise<void> {
        for (const message of batch.messages) {
            const body: unknown = message.body;

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

                if (!event) {
                    console.warn(
                        `Event ${body.eventId} was not found`,
                    );

                    message.ack();
                    continue;
                }

                const anomaly = detectAnomaly(event);

                if (anomaly) {
                    const created = await createIncident(
                        env.edgeguard_db,
                        event.id,
                        anomaly,
                    );

                    if (created) {
                        console.log(
                            `Created ${anomaly.severity} incident for event ${event.id}`,
                        );
                    }
                }

                message.ack();
            } catch (error) {
                console.error(
                    `Failed to process event ${body.eventId}:`,
                    error,
                );

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

        // Protect API routes according to their required role.
        let allowedRoles: readonly ApiRole[] | null = null;

        if (
            method === "POST" &&
            path === "/api/events"
        ) {
            allowedRoles = ["ingest"];
        } else if (
            method === "GET" &&
            [
                "/api/events",
                "/api/incidents",
                "/api/metrics",
                "/api/metrics/timeseries",
            ].includes(path)
        ) {
            allowedRoles = ["dashboard", "admin"];
        } else if (
            method === "PATCH" &&
            /^\/api\/incidents\/[^/]+$/.test(path)
        ) {
            allowedRoles = ["admin"];
        }

        if (allowedRoles !== null) {
            const authResponse = authorizeRequest(
                request,
                env,
                allowedRoles,
            );

            if (authResponse !== null) {
                return authResponse;
            }
        }

        // Dashboard time-series metrics
        if (
            method === "GET" &&
            path === "/api/metrics/timeseries"
        ) {
            const hoursParam =
                url.searchParams.get("hours") ?? "24";
            const hours = Number(hoursParam);

            if (
                !Number.isInteger(hours) ||
                hours < 1 ||
                hours > 168
            ) {
                return Response.json(
                    {
                        error:
                            "hours must be an integer between 1 and 168",
                    },
                    { status: 400 },
                );
            }

            try {
                const metrics =
                    await getDashboardTimeSeries(
                        env.edgeguard_db,
                        hours,
                    );

                return Response.json({
                    data: metrics,
                });
            } catch (error) {
                console.error(
                    "Failed to fetch time-series metrics:",
                    error,
                );

                return Response.json(
                    {
                        error:
                            "Failed to fetch time-series metrics",
                    },
                    { status: 500 },
                );
            }
        }

        // Dashboard metrics
        if (method === "GET" && path === "/api/metrics") {
            try {
                const metrics = await getDashboardMetrics(
                    env.edgeguard_db,
                );

                return Response.json({
                    data: metrics,
                });
            } catch (error) {
                    console.error(
                        "Failed to fetch dashboard metrics:",
                        error,
                    );

                    return Response.json(
                        {
                            error:
                                "Failed to fetch dashboard metrics",
                        },
                        { status: 500 },
                    );
            }
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

        // List incidents with optional filters
        if (method === "GET" && path === "/api/incidents") {
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

            const severityParam =
                        url.searchParams.get("severity");

            if (
                severityParam !== null &&
                !isIncidentSeverity(severityParam)
            ) {
                return Response.json(
                    {
                        error:
                            "severity must be medium, high, or critical",
                    },
                    { status: 400 },
                );
            }

            const statusParam =
                    url.searchParams.get("status");

            if (
                statusParam !== null &&
                !isIncidentStatus(statusParam)
            ) {
                return Response.json(
                    {
                        error:
                            "status must be open or resolved",
                    },
                    { status: 400 },
                );
            }

            try {
                const incidents = await listIncidents(
                    env.edgeguard_db,
                    {
                        limit,
                        severity:
                            severityParam ?? undefined,
                        status:
                            statusParam ?? undefined,
                    },
                );

                return Response.json({
                    data: incidents,
                });
            } catch (error) {
                console.error(
                    "Failed to fetch incidents:",
                    error,
                );

                return Response.json(
                    {
                        error: "Failed to fetch incidents",
                    },
                    { status: 500 },
                );
            }
        }

        // Update an incident's status
        const incidentPathMatch = path.match(
                /^\/api\/incidents\/([^/]+)$/,
        );

        if (
            method === "PATCH" &&
            incidentPathMatch !== null
        ) {
            const incidentId = incidentPathMatch[1];

            let body: unknown;

            try {
                    body = await request.json();
            } catch {
                return Response.json(
                    { error: "Invalid JSON body" },
                    { status: 400 },
                );
            }

            if (
                typeof body !== "object" ||
                body === null ||
                Array.isArray(body)
            ) {
                return Response.json(
                    { error: "Invalid incident payload" },
                    { status: 400 },
                );
            }

            const statusParam = (
                body as Record<string, unknown>
            ).status;

            if (
                typeof statusParam !== "string" ||
                !isIncidentStatus(statusParam)
            ) {
                return Response.json(
                        {
                            error:
                                "status must be open or resolved",
                        },
                        { status: 400 },
                );
            }

            try {
                const incident =
                        await updateIncidentStatus(
                            env.edgeguard_db,
                            incidentId,
                            statusParam,
                        );

                    if (!incident) {
                        return Response.json(
                            { error: "Incident not found" },
                            { status: 404 },
                        );
                    }

                    return Response.json({
                        data: incident,
                    });
            } catch (error) {
                    console.error(
                        "Failed to update incident:",
                        error,
                    );

                    return Response.json(
                        {
                            error: "Failed to update incident",
                        },
                        { status: 500 },
                    );
            }
        }

        // Ingest a new event
        if (method === "POST" && path === "/api/events") {
            const clientAddress =
                request.headers.get("cf-connecting-ip") ??
                "local-development";

            const { success } =
                await env.EVENT_INGEST_RATE_LIMITER.limit({
                    key: `POST:/api/events:${clientAddress}`,
                });

            if (!success) {
                try {
                    writeRateLimitedTelemetry(
                        env.EDGEGUARD_ANALYTICS,
                    );
                } catch (error) {
                    console.error(
                        "Failed to record rate-limited request:",
                        error,
                    );
                }

                return Response.json(
                    {
                        error: "Rate limit exceeded",
                        message:
                            "Too many event ingestion requests. Try again shortly.",
                    },
                    {
                        status: 429,
                        headers: {
                            "Retry-After": "10",
                        },
                    },
                );
            }

            const idempotencyKey =
                request.headers.get("Idempotency-Key");

            if (
                idempotencyKey !== null &&
                !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)
            ) {
                return Response.json(
                    {
                        error:
                            "Idempotency-Key must contain 1 to 128 letters, numbers, dots, underscores, colons, or hyphens",
                    },
                    { status: 400 },
                );
            }

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

            let event: Event;
            let created = true;
            let queueStatus: "pending" | "sent" = "pending";

            try {
                if (idempotencyKey === null) {
                    event = await insertEvent(
                        env.edgeguard_db,
                        input,
                    );
                } else {
                    const requestHash =
                        await hashEventInput(input);

                    const stored =
                        await insertOrGetIdempotentEvent(
                            env.edgeguard_db,
                            input,
                            idempotencyKey,
                            requestHash,
                        );

                    if (stored.requestHash !== requestHash) {
                        return Response.json(
                            {
                                error:
                                    "Idempotency key reused with a different payload",
                            },
                            { status: 409 },
                        );
                    }

                    event = stored.event;
                    created = stored.created;
                    queueStatus = stored.queueStatus;
                }
            } catch (error) {
                console.error(
                    "Failed to store event:",
                    error,
                );

                return Response.json(
                    { error: "Failed to store event" },
                    { status: 500 },
                );
            }

            // Only record telemetry when the event is first created.
            if (created) {
                try {
                    writeEventTelemetry(
                        env.EDGEGUARD_ANALYTICS,
                        event,
                    );
                } catch (error) {
                    console.error(
                        "Failed to write event telemetry:",
                        error,
                    );
                }
            }

            const shouldSendToQueue =
                idempotencyKey === null ||
                created ||
                queueStatus === "pending";

            if (shouldSendToQueue) {
                try {
                    await env.EVENTS_QUEUE.send({
                        type: "event.received",
                        eventId: event.id,
                    });

                    await markEventQueued(
                        env.edgeguard_db,
                        event.id,
                    );
                } catch (error) {
                    console.error(
                        `Failed to enqueue event ${event.id}:`,
                        error,
                    );

                    return Response.json(
                        {
                            error: "Failed to enqueue event",
                            message:
                                idempotencyKey !== null
                                    ? "Retry the request with the same Idempotency-Key to resume delivery."
                                    : "The event may already be stored. Retrying without an Idempotency-Key can create a duplicate.",
                        },
                        { status: 500 },
                    );
                }
            }

            const headers =
                !created && idempotencyKey !== null
                    ? { "Idempotency-Replayed": "true" }
                    : undefined;

            return Response.json(
                { data: event },
                {
                    status: created ? 201 : 200,
                    headers,
                },
            );
        }

        // Fallback: 404 Not Found
        return Response.json(
            { error: "Not Found" },
            { status: 404 },
        );
    },
} satisfies ExportedHandler<Env>;