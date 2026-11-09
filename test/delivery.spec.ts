import { env } from 'cloudflare:workers';
import { createScheduledController } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { retryPendingEvents } from '../src/delivery';
import { insertEvent } from '../src/events';

describe('Pending queue delivery recovery', () => {
	beforeEach(async () => {
		await env.edgeguard_db.prepare('DELETE FROM incidents').run();
		await env.edgeguard_db.prepare('DELETE FROM events').run();
	});

	async function seedEvent(ageMs: number, status = 'pending') {
		const event = await insertEvent(env.edgeguard_db, {
			method: 'GET',
			path: '/api/recovery',
			status: 500,
			latencyMs: 100,
		});

		await env.edgeguard_db
			.prepare(
				`
					UPDATE events SET created_at = ?, queue_status = ? WHERE id = ?
				`,
			)
			.bind(Date.now() - ageMs, status, event.id)
			.run();

		return event;
	}

	it('recovers old pending events without another client request', async () => {
		const event = await seedEvent(120_000);

		const sendBatch = vi.fn(async (_messages: MessageSendRequest[]) => {
			return {};
		});

		const queue = {
			sendBatch,
		} as unknown as Queue;

		await worker.scheduled(
			createScheduledController({
				scheduledTime: Date.now(),
			}),
			{
				...env,
				EVENTS_QUEUE: queue,
			},
		);

		expect(sendBatch).toHaveBeenCalledWith([
			{
				body: {
					type: 'event.received',
					eventId: event.id,
				},
			},
		]);

		expect(await env.edgeguard_db.prepare('SELECT queue_status FROM events WHERE id = ?').bind(event.id).first()).toEqual({
			queue_status: 'sent',
		});

		// A later recovery run must not publish the same event again.
		await retryPendingEvents(env.edgeguard_db, queue, Date.now());

		expect(sendBatch).toHaveBeenCalledOnce();
	});

	it('leaves recent and already sent events alone', async () => {
		await seedEvent(0);
		await seedEvent(120_000, 'sent');

		const sendBatch = vi.fn();

		await retryPendingEvents(
			env.edgeguard_db,
			{
				sendBatch,
			} as unknown as Queue,
			Date.now(),
		);

		expect(sendBatch).not.toHaveBeenCalled();
	});

	it('keeps events pending when sending fails so the next run can retry', async () => {
		const event = await seedEvent(120_000);

		const sendBatch = vi.fn().mockRejectedValueOnce(new Error('Queue unavailable')).mockResolvedValueOnce({});

		const queue = {
			sendBatch,
		} as unknown as Queue;

		await expect(retryPendingEvents(env.edgeguard_db, queue, Date.now())).rejects.toThrow('Queue unavailable');

		expect(await env.edgeguard_db.prepare('SELECT queue_status FROM events WHERE id = ?').bind(event.id).first()).toEqual({
			queue_status: 'pending',
		});

		await retryPendingEvents(env.edgeguard_db, queue, Date.now());

		expect(sendBatch).toHaveBeenCalledTimes(2);
	});

	it('bounds each run and drains the remaining events on the next run', async () => {
		for (let i = 0; i < 51; i++) {
			await seedEvent(120_000 + i * 1000);
		}

		const sendBatch = vi.fn(async (_messages: MessageSendRequest[]) => {
			return {};
		});

		const queue = {
			sendBatch,
		} as unknown as Queue;

		await retryPendingEvents(env.edgeguard_db, queue, Date.now());

		expect(sendBatch.mock.calls[0]?.[0]).toHaveLength(50);

		expect(await env.edgeguard_db.prepare("SELECT COUNT(*) AS total FROM events WHERE queue_status = 'pending'").first()).toEqual({
			total: 1,
		});

		await retryPendingEvents(env.edgeguard_db, queue, Date.now());

		expect(sendBatch.mock.calls[1]?.[0]).toHaveLength(1);
	});
});
