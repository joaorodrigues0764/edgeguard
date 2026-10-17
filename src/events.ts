export interface CreateEventInput {
	method: string;
	path: string;
	status: number;
	latencyMs: number;
	clientId?: string;
}

export interface Event {
	id: string;
	occurredAt: number;
	method: string;
	path: string;
	status: number;
	latencyMs: number;
	clientId: string | null;
	createdAt: number;
}

export type EventQueueStatus = "pending" | "sent";

export interface StoredIdempotentEvent {
        event: Event;
        requestHash: string | null;
        queueStatus: EventQueueStatus;
}

interface IdempotentEventRow extends Event {
        requestHash: string | null;
        queueStatus: EventQueueStatus;
}

export interface EventReceivedMessage {
	type: "event.received";
	eventId: string;
}

const ALLOWED_METHODS = new Set([
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"HEAD",
	"OPTIONS",
]);

export function validateEventInput(
	input: unknown,
): CreateEventInput | null {
	if (
		typeof input !== "object" ||
		input === null
	) {
		return null;
	}

	const body = input as Record<string, unknown>;

	if (typeof body.method !== "string") {
		return null;
	}

	if (
		!ALLOWED_METHODS.has(
			body.method.toUpperCase(),
		)
	) {
		return null;
	}

	if (
		typeof body.path !== "string" ||
		!body.path.startsWith("/") ||
		body.path.length > 2048
	) {
		return null;
	}

	if (
		typeof body.status !== "number" ||
		!Number.isInteger(body.status) ||
		body.status < 100 ||
		body.status > 599
	) {
		return null;
	}

	if (
		typeof body.latencyMs !== "number" ||
		!Number.isInteger(body.latencyMs) ||
		body.latencyMs < 0 ||
		body.latencyMs > 600_000
	) {
		return null;
	}

	if (
		body.clientId !== undefined &&
		(typeof body.clientId !== "string" ||
			body.clientId.length > 128)
	) {
		return null;
	}

	return {
		method: body.method.toUpperCase(),
		path: body.path,
		status: body.status,
		latencyMs: body.latencyMs,
		clientId:
			body.clientId as string | undefined,
	};
}

export async function insertEvent(
	db: D1Database,
	input: CreateEventInput,
): Promise<Event> {
	const now = Date.now();

	const event: Event = {
		id: crypto.randomUUID(),
		occurredAt: now,
		method: input.method,
		path: input.path,
		status: input.status,
		latencyMs: input.latencyMs,
		clientId: input.clientId ?? null,
		createdAt: now,
	};

	await db
		.prepare(`
			INSERT INTO events (
				id,
				occurred_at,
				method,
				path,
				status,
				latency_ms,
				client_id,
				created_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`)
		.bind(
			event.id,
			event.occurredAt,
			event.method,
			event.path,
			event.status,
			event.latencyMs,
			event.clientId,
			event.createdAt,
		)
		.run();

	return event;
}

export async function hashEventInput(
        input: CreateEventInput,
): Promise<string> {
        const canonicalPayload = JSON.stringify({
                method: input.method,
                path: input.path,
                status: input.status,
                latencyMs: input.latencyMs,
                clientId: input.clientId ?? null,
        });

        const encodedPayload = new TextEncoder().encode(
                canonicalPayload,
        );

        const digest = await crypto.subtle.digest(
                "SHA-256",
                encodedPayload,
        );

        return Array.from(new Uint8Array(digest))
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("");
}

export async function findEventByIdempotencyKey(
        db: D1Database,
        idempotencyKey: string,
): Promise<StoredIdempotentEvent | null> {
        const row = await db
                .prepare(`
                        SELECT
                                id,
                                occurred_at AS occurredAt,
                                method,
                                path,
                                status,
                                latency_ms AS latencyMs,
                                client_id AS clientId,
                                created_at AS createdAt,
                                request_hash AS requestHash,
                                queue_status AS queueStatus
                        FROM events
                        WHERE idempotency_key = ?
                        LIMIT 1
                `)
                .bind(idempotencyKey)
                .first<IdempotentEventRow>();

        if (!row) {
                return null;
        }

        return {
                event: {
                        id: row.id,
                        occurredAt: row.occurredAt,
                        method: row.method,
                        path: row.path,
                        status: row.status,
                        latencyMs: row.latencyMs,
                        clientId: row.clientId,
                        createdAt: row.createdAt,
                },
                requestHash: row.requestHash,
                queueStatus: row.queueStatus,
        };
}

export async function insertOrGetIdempotentEvent(
        db: D1Database,
        input: CreateEventInput,
        idempotencyKey: string,
        requestHash: string,
): Promise<StoredIdempotentEvent & { created: boolean }> {
        const now = Date.now();

        const event: Event = {
                id: crypto.randomUUID(),
                occurredAt: now,
                method: input.method,
                path: input.path,
                status: input.status,
                latencyMs: input.latencyMs,
                clientId: input.clientId ?? null,
                createdAt: now,
        };

        const result = await db
                .prepare(`
                        INSERT OR IGNORE INTO events (
                                id,
                                occurred_at,
                                method,
                                path,
                                status,
                                latency_ms,
                                client_id,
                                created_at,
                                idempotency_key,
                                request_hash,
                                queue_status
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
                `)
                .bind(
                        event.id,
                        event.occurredAt,
                        event.method,
                        event.path,
                        event.status,
                        event.latencyMs,
                        event.clientId,
                        event.createdAt,
                        idempotencyKey,
                        requestHash,
                )
                .run();

        const stored = await findEventByIdempotencyKey(
                db,
                idempotencyKey,
        );

        if (!stored) {
                throw new Error(
                        "Failed to create or retrieve idempotent event",
                );
        }

        return {
                ...stored,
                created: result.meta.changes > 0,
        };
}

export async function markEventQueued(
        db: D1Database,
        eventId: string,
): Promise<void> {
        const result = await db
                .prepare(`
                        UPDATE events
                        SET queue_status = 'sent'
                        WHERE id = ?
                `)
                .bind(eventId)
                .run();

        if (result.meta.changes === 0) {
                throw new Error(
                        `Failed to mark event ${eventId} as queued`,
                );
        }
}