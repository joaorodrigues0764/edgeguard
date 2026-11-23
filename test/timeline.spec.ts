import { env } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { listIncidents } from '../src/incidents';
import type { IncidentTimeline } from '../src/timeline';
import { seedTraffic } from './traffic';

const db = env.edgeguard_db;
const start = 9_000_000;

async function deliver(ids: string[]) {
	const messages = ids.map((eventId) => ({
		id: crypto.randomUUID(),
		timestamp: new Date(),
		attempts: 1,
		body: { type: 'event.received' as const, eventId },
	}));
	const batch = createMessageBatch('edgeguard-events', messages);
	const ctx = createExecutionContext();

	await worker.queue(batch, env, ctx);

	const result = await getQueueResult(batch, ctx);
	expect(result.explicitAcks).toHaveLength(ids.length);
}

function timeline(incidentId: string, token: string | null = env.DASHBOARD_API_TOKEN) {
	const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

	return worker.fetch(new Request(`https://edgeguard.test/api/incidents/${incidentId}/timeline`, { headers }), env);
}

async function openStreamScenario(path: string) {
	const ids = [
		...(await seedTraffic(db, 20, { path, status: 200, at: start })),
		...(await seedTraffic(db, 5, { path, status: 503, at: start + 1000 })),
		...(await seedTraffic(db, 1, { path, status: 503, at: start + 2000 })),
	];

	await deliver(ids);

	const incidents = await listIncidents(db, { limit: 100 });
	const incident = incidents.find((row) => row.eventPath === path);
	expect(incident).toBeDefined();

	return incident!;
}

describe('Incident detection timeline', () => {
	it('replays the window rate up to the opening report and matches its evidence', async () => {
		const incident = await openStreamScenario('/timeline/stream');

		const response = await timeline(incident.id);
		expect(response.status).toBe(200);

		const { data } = await response.json<{ data: IncidentTimeline }>();
		expect(data).toMatchObject({
			method: 'GET',
			path: '/timeline/stream',
			windowMinutes: 5,
			openPercent: 20,
			minRequests: 20,
			minFailures: 5,
			truncated: false,
		});
		expect(data.points).toHaveLength(26);

		const boundary = data.points[24];
		expect(boundary).toMatchObject({
			windowRequests: 25,
			windowErrors: 5,
			errorPercent: 20,
			eligible: true,
			opening: false,
		});

		const opening = data.points[25];
		expect(opening).toMatchObject({
			eventId: incident.eventId,
			windowRequests: incident.evidence!.totalRequests,
			windowErrors: incident.evidence!.serverErrors,
			opening: true,
		});
		expect(opening.errorPercent).toBeCloseTo(incident.evidence!.errorPercent, 10);
		expect(data.points.filter((point) => point.opening)).toHaveLength(1);
		expect(data.points.slice(0, 20).every((point) => point.errorPercent === 0 && !point.eligible)).toBe(true);
	});

	it('keeps replaying reports that arrive after the opening', async () => {
		const path = '/timeline/after';
		const incident = await openStreamScenario(path);
		const laterIds = await seedTraffic(db, 4, { path, status: 200, at: start + 3000 });

		await deliver(laterIds);

		const { data } = await (await timeline(incident.id)).json<{ data: IncidentTimeline }>();

		expect(data.points).toHaveLength(30);
		expect(data.points.at(-1)).toMatchObject({
			windowRequests: 30,
			windowErrors: 6,
			errorPercent: 20,
			opening: false,
		});
	});

	it('drops minutes that leave the rolling window', async () => {
		const path = '/timeline/rolling';
		const oldIds = await seedTraffic(db, 10, { path, status: 503, at: start - 5 * 60_000 });
		const incident = await openStreamScenario(path);

		await deliver(oldIds);

		const { data } = await (await timeline(incident.id)).json<{ data: IncidentTimeline }>();

		// The old failures are older than the window that ends at the opening minute.
		expect(data.points).toHaveLength(26);
		expect(data.points[0]).toMatchObject({ windowRequests: 1, windowErrors: 0 });
	});

	it('returns 404 for an unknown incident and requires authentication', async () => {
		const missing = await timeline('missing-incident');
		expect(missing.status).toBe(404);

		const anonymous = await timeline('missing-incident', null);
		expect(anonymous.status).toBe(401);

		const ingest = await timeline('missing-incident', env.INGEST_API_TOKEN);
		expect(ingest.status).toBe(403);
	});
});
