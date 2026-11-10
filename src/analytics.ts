export interface TelemetryMetrics {
	hours: number;
	from: string;
	to: string;
	observedEvents: {
		total: number;
		serverErrors: number;
		rateLimitedResponses: number;
		averageLatencyMs: number;
	};
	rejectedIngestion: {
		total: number;
	};
}

type TelemetryAggregateRow = Record<string, unknown> & {
	blob4: string;
	total: number;
	server_errors: number;
	rate_limited_responses: number;
	total_latency_ms: number;
};

export async function getTelemetryMetrics(
	analytics: AnalyticsSQLBinding,
	dataset: string,
	hours: number,
	now: number = Date.now(),
): Promise<TelemetryMetrics> {
	if (dataset !== 'edgeguard_telemetry' && dataset !== 'edgeguard_staging_telemetry') {
		throw new Error('Unknown EdgeGuard telemetry dataset.');
	}

	const end = new Date(now);
	const start = new Date(now - hours * 60 * 60 * 1000);

	// The Analytics SQL API applies adaptive sample weights automatically.
	// Multiplying by sampleInterval here would apply those weights twice.
	const result = await analytics.query<TelemetryAggregateRow>({
		query: `
            SELECT
                blob4,
                SUM(double1) AS total,
                SUM(double3) AS server_errors,
                SUM(double4) AS rate_limited_responses,
                SUM(double2) AS total_latency_ms
            FROM events.analyticsEngine."${dataset}"
            WHERE timestamp >= $start
              AND timestamp <= $end
            GROUP BY blob4
            ORDER BY blob4 ASC
            LIMIT 10
        `,
		params: {
			start: start.toISOString(),
			end: end.toISOString(),
		},
	});

	const observed = result.data.find((row) => row.blob4 === 'observed_event');

	const rejected = result.data.find((row) => row.blob4 === 'rate_limited_ingestion');

	const observedTotal = Number(observed?.total ?? 0);
	const totalLatencyMs = Number(observed?.total_latency_ms ?? 0);

	return {
		hours,
		from: start.toISOString(),
		to: end.toISOString(),
		observedEvents: {
			total: observedTotal,
			serverErrors: Number(observed?.server_errors ?? 0),
			rateLimitedResponses: Number(observed?.rate_limited_responses ?? 0),
			averageLatencyMs: observedTotal > 0 ? totalLatencyMs / observedTotal : 0,
		},
		rejectedIngestion: {
			total: Number(rejected?.total ?? 0),
		},
	};
}
