import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { insertEvent, type EventReceivedMessage } from '../src/events';
import { seedTraffic } from './traffic';
import staging from '../src/staging';
import worker, { type Env } from '../src/index';

const productionDataset = 'edgeguard_telemetry';
const stagingDataset = 'edgeguard_staging_telemetry';

function setup() {
	const query = vi.fn().mockResolvedValue({ data: [] });
	const writeDataPoint = vi.fn();
	const config: Env = {
		...env,
		TELEMETRY_DATASET: stagingDataset,
		ANALYTICS_SQL: { query } as unknown as AnalyticsSQLBinding,
		EDGEGUARD_ANALYTICS: { writeDataPoint },
		DASHBOARD_PASSWORD: 'synthetic-staging-dashboard-password',
	};
	const request = new Request('https://example.test/api/metrics/telemetry?dataset=' + productionDataset, {
		headers: { Authorization: 'Bearer ' + env.DASHBOARD_API_TOKEN },
	});
	return { config, request, query, writeDataPoint };
}

function eventBatch(body: EventReceivedMessage) {
	return createMessageBatch('edgeguard-staging-events', [
		{
			id: 'synthetic-message',
			timestamp: new Date(),
			attempts: 1,
			body,
		},
	]);
}

describe('staging without inference', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('persists a healthy event, emits telemetry and acknowledges its queue message', async () => {
		const { config, writeDataPoint } = setup();
		const send = vi.fn<Queue<EventReceivedMessage>['send']>().mockResolvedValue({
			metadata: { metrics: { backlogCount: 1, backlogBytes: 100 } },
		});
		config.EVENTS_QUEUE = { send, sendBatch: vi.fn(), metrics: vi.fn() };
		const path = '/synthetic/healthy';
		const request = new Request('https://example.test/api/events', {
			method: 'POST',
			headers: { Authorization: 'Bearer ' + config.INGEST_API_TOKEN, 'Content-Type': 'application/json' },
			body: JSON.stringify({ method: 'GET', path, status: 200, latencyMs: 10 }),
		});

		const response = await staging.fetch(request, config);
		expect(response.status).toBe(201);
		const { data } = await response.json<{ data: { id: string } }>();
		expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'event.received', eventId: data.id });
		const batch = eventBatch(send.mock.calls[0][0]);
		const ctx = createExecutionContext();
		await staging.queue(batch, config, ctx);

		const delivery = await getQueueResult(batch, ctx);
		const saved = await config.edgeguard_db.prepare('SELECT path, queue_status FROM events WHERE id = ?').bind(data.id).first();
		expect(saved).toEqual({ path, queue_status: 'sent' });
		expect(writeDataPoint).toHaveBeenCalledOnce();
		expect(delivery.explicitAcks).toEqual(['synthetic-message']);
	});

	it('creates an anomalous incident without requesting analysis and rejects admin retry', async () => {
		const { config } = setup();
		const spike = {
			path: '/synthetic/' + crypto.randomUUID(),
			method: 'GET',
			status: 503,
			latencyMs: 200,
		};
		await seedTraffic(config.edgeguard_db, 19, spike);
		const { id: eventId } = await insertEvent(config.edgeguard_db, spike);
		const batch = eventBatch({ type: 'event.received', eventId });
		const ctx = createExecutionContext();

		await staging.queue(batch, config, ctx);
		const delivery = await getQueueResult(batch, ctx);
		const incident = await config.edgeguard_db
			.prepare('SELECT id, analysis_state FROM incidents WHERE event_id = ?')
			.bind(eventId)
			.first<{ id: string; analysis_state: string }>();
		expect(delivery.explicitAcks).toEqual(['synthetic-message']);
		expect(incident?.analysis_state).toBe('not_requested');

		const retry = await staging.fetch(
			new Request('https://example.test/api/incidents/' + incident!.id + '/analysis/retry', {
				method: 'POST',
				headers: { Authorization: 'Bearer ' + config.ADMIN_API_TOKEN },
			}),
			config,
		);

		expect(retry.status).toBe(503);
		expect(await retry.json()).toEqual({ error: 'Analysis is not configured.' });
	});

	it.each([
		{
			binding: true,
			gateway: false,
		},
		{
			binding: false,
			gateway: true,
		},
		{
			binding: true,
			gateway: true,
		},
	])('rejects AI binding=$binding and gateway=$gateway before dispatch', async ({ binding, gateway }) => {
		const { config, request } = setup();
		const run = vi.fn();
		if (binding) {
			config.AI = { run } as unknown as Ai;
		}
		if (gateway) {
			config.AI_GATEWAY_ID = 'edgeguard-staging';
		}
		const fetchHandler = vi.spyOn(worker, 'fetch');
		const queueHandler = vi.spyOn(worker, 'queue');
		const batch = eventBatch({ type: 'event.received', eventId: 'synthetic' });

		const response = await staging.fetch(request, config);
		await expect(staging.queue(batch, config, createExecutionContext())).rejects.toThrow('Invalid staging queue configuration');

		expect(response.status).toBe(503);
		expect(fetchHandler).not.toHaveBeenCalled();
		expect(queueHandler).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});
});

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
			value: 'edgeguard-staging',
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
