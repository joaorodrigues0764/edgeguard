import { insertEvent, validateEventInput } from "./events";

export interface Env {
  edgeguard_db: D1Database; 
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Route: GET /health
    if (method === 'GET' && path === '/health') {
      return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // Route: GET /api/events (Substituído com a consulta à base de dados real)
    if (method === 'GET' && path === '/api/events') {
      const limitParam = url.searchParams.get("limit") ?? "20";
      const limit = Number(limitParam);

      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return Response.json({ error: "limit must be an integer between 1 and 100" }, { status: 400 });
      }

      try {
        const result = await env.edgeguard_db
          .prepare(`
            SELECT
              id,
              timestamp,
              method,
              path,
              status,
              latency,
              client_id AS clientId
            FROM events
            ORDER BY timestamp DESC
            LIMIT ?
          `)
          .bind(limit)
          .all();

        return Response.json({ data: result.results });
      } catch (error) {
        return Response.json({ error: "Failed to fetch events" }, { status: 500 });
      }
    }

    // Route: POST /api/events (Lógica de ingestão do Dia 4)
    if (method === 'POST' && path === '/api/events') {
      let body: unknown;

      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }

      const input = validateEventInput(body);
      if (!input) {
        return Response.json({ error: "Invalid event payload" }, { status: 400 });
      }

      try {
        const event = await insertEvent(env.edgeguard_db, input);
        return Response.json({ data: event }, { status: 201 });
      } catch (error) {
        return Response.json({ error: "Failed to store event" }, { status: 500 });
      }
    }

    // Fallback: 404 Not Found
    return Response.json({ error: 'Not Found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;