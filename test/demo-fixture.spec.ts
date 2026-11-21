import { env } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import demo from '../demo/worker';
import { listIncidents } from '../src/incidents';
import { seedTraffic } from './traffic';

describe('Offline fixture presentation', () => {
	it.each([
		{
			healthy: 20,
			failures: 6,
			percentage: '23.08%',
			latency: '192.3 ms',
		},
		{
			healthy: 15,
			failures: 5,
			percentage: '25%',
			latency: '200 ms',
		},
	])('formats $percentage and $latency without changing opening evidence', async ({ healthy, failures, percentage, latency }) => {
		const path = '/fixture/' + crypto.randomUUID();
		await seedTraffic(env.edgeguard_db, healthy, {
			path,
			status: 200,
			latencyMs: 100,
		});
		const ids = await seedTraffic(env.edgeguard_db, failures, {
			path,
			status: 503,
			latencyMs: 500,
		});
		const eventId = ids.at(-1)!;
		const opening = await env.edgeguard_db
			.prepare('SELECT evidence FROM anomaly_episodes WHERE event_id = ?')
			.bind(eventId)
			.first('evidence');
		const batch = createMessageBatch('edgeguard-events', [
			{
				id: crypto.randomUUID(),
				timestamp: new Date(),
				attempts: 1,
				body: { type: 'event.received' as const, eventId },
			},
		]);
		const ctx = createExecutionContext();

		await demo.queue(batch, env, ctx);
		const delivery = await getQueueResult(batch, ctx);
		const incidents = await listIncidents(env.edgeguard_db, { limit: 100 });
		const incident = incidents.find((item) => item.eventId === eventId)!;
		const after = await env.edgeguard_db
			.prepare('SELECT evidence FROM anomaly_episodes WHERE event_id = ?')
			.bind(eventId)
			.first('evidence');

		expect(delivery.explicitAcks).toHaveLength(1);
		expect(incident.analysisState).toBe('complete');
		expect(incident.analysis?.summary).toContain(`(${percentage})`);
		expect(incident.analysis?.summary).toContain(`Mean latency was ${latency}.`);
		expect(incident.evidence?.errorPercent).toBe((100 * failures) / (healthy + failures));
		expect(incident.evidence?.averageLatencyMs).toBe((healthy * 100 + failures * 500) / (healthy + failures));
		expect(after).toBe(opening);
	});
});
