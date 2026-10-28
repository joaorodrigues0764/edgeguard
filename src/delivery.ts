import type { EventReceivedMessage } from "./events";

// Leave recent events to the request handler. Duplicate deliveries after a
// crash or concurrent retry are safe because incident creation is idempotent.
const RECOVERY_GRACE_MS = 60_000;
const RECOVERY_BATCH_SIZE = 50;

export async function retryPendingEvents(
    db: D1Database,
    queue: Queue<EventReceivedMessage>,
    now: number,
): Promise<void> {
    const pending = await db.prepare(`
        SELECT id FROM events
        WHERE queue_status = 'pending' AND created_at <= ?
        ORDER BY created_at ASC, id ASC
        LIMIT ?
    `)
        .bind(now - RECOVERY_GRACE_MS, RECOVERY_BATCH_SIZE)
        .all<{ id: string }>();

    if (pending.results.length === 0) {
        return;
    }

    await queue.sendBatch(pending.results.map(({ id }) => ({
        body: { type: "event.received" as const, eventId: id },
    })));

    // A failed send leaves all rows pending. A crash after a successful send
    // may cause redelivery, but never marks an unsent event as delivered.
    const placeholders = pending.results.map(() => "?").join(", ");
    await db.prepare(`
        UPDATE events SET queue_status = 'sent'
        WHERE id IN (${placeholders})
    `)
        .bind(...pending.results.map(({ id }) => id))
        .run();
}
