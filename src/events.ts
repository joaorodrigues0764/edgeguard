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
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const body = input as Record<string, unknown>;

  if (typeof body.method !== "string") {
    return null;
  }

  if (!ALLOWED_METHODS.has(body.method.toUpperCase())) {
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
    (typeof body.clientId !== "string" || body.clientId.length > 128)
  ) {
    return null;
  }

  return {
    method: body.method.toUpperCase(),
    path: body.path,
    status: body.status,
    latencyMs: body.latencyMs,
    clientId: body.clientId as string | undefined,
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