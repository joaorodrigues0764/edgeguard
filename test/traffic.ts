interface Traffic {
	path: string;
	method?: string;
	status: number;
	latencyMs?: number;
	at?: number;
}

// Each row goes through the same D1 INSERT trigger as the HTTP ingestion path.
export async function seedTraffic(db: D1Database, count: number, traffic: Traffic) {
	const at = traffic.at ?? Date.now();
	const result = await db
		.prepare(
			`
				WITH RECURSIVE requests(n) AS (
				    SELECT 1 UNION ALL SELECT n + 1 FROM requests WHERE n < ?
				)
				INSERT INTO events (id, method, path, status, latency_ms, occurred_at, created_at)
				SELECT lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ? FROM requests
				RETURNING id
			`,
		)
		.bind(count, traffic.method ?? 'GET', traffic.path, traffic.status, traffic.latencyMs ?? 100, at, at)
		.all<{ id: string }>();
	return result.results.map((row) => row.id);
}
