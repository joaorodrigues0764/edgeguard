import { env } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { listIncidents, updateIncidentStatus } from '../src/incidents';
import { insertEvent, insertOrGetIdempotentEvent } from '../src/events';
import { seedTraffic } from './traffic';

const db = env.edgeguard_db;
const start = 6_000_000;

async function deliver(...ids: string[]) {
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

async function incidents(path: string) {
	const rows = await listIncidents(db, { limit: 100 });
	return rows.filter((row) => row.eventPath === path);
}

describe('Endpoint error windows', () => {
	it.each([
		['isolated error', 0, 1],
		['small sample', 0, 19],
		['healthy', 20, 0],
		['too few failures', 16, 4],
		['exactly 20 percent', 20, 5],
	] as const)('suppresses %s', async (label, successes, failures) => {
		const path = '/' + label;
		const ids: string[] = [];
		if (successes) {
			const successfulIds = await seedTraffic(db, successes, {
				path,
				status: 200,
				at: start,
			});
			ids.push(...successfulIds);
		}
		if (failures) {
			const failedIds = await seedTraffic(db, failures, {
				path,
				status: 500,
				at: start,
			});
			ids.push(...failedIds);
		}

		await deliver(...ids);
		expect(await incidents(path)).toEqual([]);
	});

	it('includes slow and rate-limited requests in the sample without opening a 5xx episode', async () => {
		const path = '/slow-quota';
		const ids = await seedTraffic(db, 20, {
			path,
			status: 429,
			latencyMs: 6000,
			at: start,
		});

		await deliver(...ids);
		expect(await incidents(path)).toEqual([]);
		const window = await db.prepare('SELECT total, errors, latency FROM anomaly_windows WHERE path = ?').bind(path).first();
		expect(window).toEqual({
			total: 20,
			errors: 0,
			latency: 120000,
		});
	});

	it('uses minute-aligned bounds and freezes the sample that crossed the threshold', async () => {
		const path = '/bounds';
		await seedTraffic(db, 10, {
			path,
			status: 200,
			at: start - 1,
		});
		await seedTraffic(db, 15, {
			path,
			status: 200,
			at: start,
		});
		const ids = await seedTraffic(db, 5, {
			path,
			status: 502,
			latencyMs: 500,
			at: start + 299_999,
		});

		// The oldest minute expires. A late committed event outside the window stays in the log.
		await seedTraffic(db, 1, {
			path,
			status: 200,
			at: start + 300_000,
		});
		await seedTraffic(db, 1, {
			path,
			status: 500,
			at: start - 1,
		});

		await deliver(...ids.reverse());

		const rows = await incidents(path);
		expect(rows).toHaveLength(1);
		expect(rows[0].evidence).toEqual({
			rule: 'endpoint_5xx_rate_v2',
			method: 'GET',
			path,
			severity: 'high',
			totalRequests: 20,
			serverErrors: 5,
			errorPercent: 25,
			averageLatencyMs: 200,
			minRequests: 20,
			minFailures: 5,
			openPercent: 20,
			windowStartMs: start,
			windowEndExclusiveMs: start + 300_000,
		});
		const window = await db.prepare('SELECT total, errors FROM anomaly_windows WHERE path = ?').bind(path).first();
		expect(window).toEqual({
			total: 6,
			errors: 5,
		});
	});

	it('counts a late insert in its original minute and keeps the newest minute as the window end', async () => {
		const path = '/out-of-order';
		await seedTraffic(db, 15, {
			path,
			status: 200,
			at: start + 120_000,
		});
		const ids = await seedTraffic(db, 5, {
			path,
			status: 503,
			at: start,
		});

		await deliver(...ids);
		const [row] = await incidents(path);
		expect(row.evidence).toMatchObject({
			totalRequests: 20,
			serverErrors: 5,
			windowStartMs: start - 120_000,
			windowEndExclusiveMs: start + 180_000,
		});
	});

	it('deduplicates concurrent ingest retries and concurrent consumers during sustained failures', async () => {
		const path = '/concurrent';
		const input = {
			method: 'GET',
			path,
			status: 500,
			latencyMs: 100,
		};
		await seedTraffic(db, 19, input);
		const insert = () => insertOrGetIdempotentEvent(db, input, 'concurrent-test', 'same-payload');
		const [firstAttempt, retryAttempt, separateEvent] = await Promise.all([insert(), insert(), insertEvent(db, input)]);
		expect(firstAttempt.event.id).toBe(retryAttempt.event.id);
		expect([firstAttempt.created, retryAttempt.created].sort()).toEqual([false, true]);
		const rest = await seedTraffic(db, 79, input);
		await Promise.all([deliver(firstAttempt.event.id, separateEvent.id), deliver(separateEvent.id, retryAttempt.event.id)]);

		await deliver(...rest);

		const rows = await incidents(path);
		expect(rows).toHaveLength(1);
		expect(rows[0].evidence).toMatchObject({
			severity: 'critical',
			totalRequests: 20,
			serverErrors: 20,
		});
		const windowTotal = await db.prepare('SELECT total FROM anomaly_windows WHERE path = ?').bind(path).first('total');
		expect(windowTotal).toBe(100);
	});

	it('requires measured recovery and survives operator resolution', async () => {
		const path = '/recurrence';
		const first = await seedTraffic(db, 20, {
			path,
			status: 503,
			at: start,
		});

		await deliver(...first);
		const [original] = await incidents(path);
		await updateIncidentStatus(db, original.id, 'resolved');
		const afterIdle = start + 600_000;
		const stillFailing = await seedTraffic(db, 20, {
			path,
			status: 503,
			at: afterIdle,
		});

		// An idle gap and an operator action each leave the episode active.

		await deliver(...stillFailing);
		expect(await incidents(path)).toHaveLength(1);
		const next = afterIdle + 300_000;
		await seedTraffic(db, 20, {
			path,
			status: 200,
			at: next,
		});
		const second = await seedTraffic(db, 6, {
			path,
			status: 503,
			at: next,
		});

		await deliver(...second.reverse(), ...first);

		const rows = await incidents(path);
		expect(rows).toHaveLength(2);
		expect(rows.find((r) => r.id === original.id)?.status).toBe('resolved');
		expect(rows.find((r) => r.id !== original.id)?.evidence).toMatchObject({ totalRequests: 26, serverErrors: 6 });
	});

	it('keeps an episode active between thresholds and rearms at exactly ten percent', async () => {
		const path = '/recovery-threshold';
		await seedTraffic(db, 20, {
			path,
			status: 503,
			at: start,
		});
		const next = start + 300_000;
		await seedTraffic(db, 3, {
			path,
			status: 503,
			at: next,
		});
		await seedTraffic(db, 17, {
			path,
			status: 200,
			at: next,
		});
		const state = db.prepare('SELECT recovered FROM anomaly_episodes WHERE path = ?').bind(path);
		expect(await state.first('recovered')).toBe(0); // 3 / 20
		await seedTraffic(db, 10, {
			path,
			status: 200,
			at: next,
		});
		expect(await state.first('recovered')).toBe(1); // 3 / 30
	});

	it('materialises both opening snapshots when the older one arrives after recovery and recurrence', async () => {
		const path = '/delayed';
		const first = await seedTraffic(db, 20, {
			path,
			status: 502,
			at: start,
		});
		await seedTraffic(db, 20, {
			path,
			status: 200,
			at: start + 300_000,
		});
		const second = await seedTraffic(db, 6, {
			path,
			status: 502,
			at: start + 300_000,
		});

		await deliver(...second);
		expect((await incidents(path)).map((i) => i.evidence?.serverErrors)).toEqual([6]);

		await deliver(...first, ...second);

		const rows = await incidents(path);
		expect(rows).toHaveLength(2);
		expect(rows.map((i) => i.evidence?.serverErrors)).toEqual(expect.arrayContaining([6, 20]));
	});

	it('rolls back ingestion and counters together when the detector cannot record an opening', async () => {
		const path = '/atomic';
		const input = {
			method: 'GET',
			path,
			status: 503,
			latencyMs: 100,
		};
		await seedTraffic(db, 19, input);
		await db
			.prepare(
				`CREATE TRIGGER reject_episode BEFORE INSERT ON anomaly_episodes
            BEGIN SELECT RAISE(ABORT, 'opening failed'); END`,
			)
			.run();
		const submit = () => insertOrGetIdempotentEvent(db, input, 'atomic-event', 'same-payload');
		try {
			await expect(submit()).rejects.toThrow();
			const eventCount = await db.prepare('SELECT COUNT(*) AS n FROM events WHERE path = ?').bind(path).first('n');
			expect(eventCount).toBe(19);
			const windowTotal = await db.prepare('SELECT total FROM anomaly_windows WHERE path = ?').bind(path).first('total');
			expect(windowTotal).toBe(19);
		} finally {
			await db.prepare('DROP TRIGGER reject_episode').run();
		}
		const retry = await submit();
		expect(retry.created).toBe(true);

		await deliver(retry.event.id);
		expect((await incidents(path))[0].evidence?.totalRequests).toBe(20);
	});

	it('isolates methods and paths and honours configured thresholds', async () => {
		const path = '/configured';
		await db
			.prepare('UPDATE anomaly_policy SET window_minutes = 2, min_requests = 4, min_failures = 2, open_percent = 40 WHERE id = 1')
			.run();
		try {
			for (const [method, endpoint] of [
				['GET', path],
				['POST', path],
				['GET', path + '/other'],
			]) {
				await seedTraffic(db, 1, {
					method,
					path: endpoint,
					status: 500,
					at: start - 1,
				});
				const ids = await seedTraffic(db, 4, {
					method,
					path: endpoint,
					status: 500,
					at: start + 119_999,
				});
				await deliver(...ids);
			}
			const rows = [...(await incidents(path)), ...(await incidents(path + '/other'))];
			expect(rows).toHaveLength(3);
			for (const row of rows) {
				expect(row.evidence).toMatchObject({
					totalRequests: 4,
					minRequests: 4,
					minFailures: 2,
					openPercent: 40,
					windowStartMs: start,
					windowEndExclusiveMs: start + 120_000,
				});
			}
		} finally {
			await db
				.prepare('UPDATE anomaly_policy SET window_minutes = 5, min_requests = 20, min_failures = 5, open_percent = 20 WHERE id = 1')
				.run();
		}
	});
});
