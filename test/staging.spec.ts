import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import staging from '../src/staging';
import type { Env } from '../src/index';

const productionDataset = 'edgeguard_telemetry';
const stagingDataset = 'edgeguard_staging_telemetry';

function setup() {
	const query = vi.fn().mockResolvedValue({ data: [] });
	const writeDataPoint = vi.fn();
	const config: Env = {
		...env,
		TELEMETRY_DATASET: stagingDataset,
		AI_GATEWAY_ID: 'edgeguard-staging',
		AI: { run: vi.fn() } as unknown as Ai,
		ANALYTICS_SQL: { query } as unknown as AnalyticsSQLBinding,
		EDGEGUARD_ANALYTICS: { writeDataPoint },
		DASHBOARD_PASSWORD: 'synthetic-staging-dashboard-password',
	};
	const request = new Request('https://example.test/api/metrics/telemetry?dataset=' + productionDataset, {
		headers: { Authorization: 'Bearer ' + env.DASHBOARD_API_TOKEN },
	});
	return { config, request, query, writeDataPoint };
}

describe('staging telemetry isolation', () => {
	it('queries only the staging table even if a URL names production', async () => {
		const { config, request, query } = setup();

		const response = await staging.fetch(request, config);

		expect(response.status).toBe(200);
		expect(query).toHaveBeenCalledTimes(1);
		expect(query.mock.calls[0][0].query).toContain('FROM events.analyticsEngine."edgeguard_staging_telemetry"');
		expect(query.mock.calls[0][0].query).not.toContain(productionDataset);
	});

	it.each([
		{
			field: 'TELEMETRY_DATASET',
			value: productionDataset,
		},
		{
			field: 'TELEMETRY_DATASET',
			value: undefined,
		},
		{
			field: 'TELEMETRY_DATASET',
			value: 'x" UNION SELECT 1 --',
		},
		{
			field: 'EDGEGUARD_ANALYTICS',
			value: undefined,
		},
		{
			field: 'ANALYTICS_SQL',
			value: undefined,
		},
		{
			field: 'AI_GATEWAY_ID',
			value: 'default',
		},
		{
			field: 'INGEST_API_TOKEN',
			value: undefined,
		},
	])('refuses $field=$value before dispatch', async ({ field, value }) => {
		const { config, request, query, writeDataPoint } = setup();

		const response = await staging.fetch(request, { ...config, [field]: value });

		expect(response.status).toBe(503);
		expect(query).not.toHaveBeenCalled();
		expect(writeDataPoint).not.toHaveBeenCalled();
	});
});
