import { env } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import { insertEvent } from '../src/events';
import { listIncidents, updateIncidentStatus } from '../src/incidents';

const sample = { summary: 'The response was slow.', possibleCauses: ['An upstream service may be slow.'], suggestedNextSteps: ['Check dependency timings.'] };

async function setup() {
    const run = vi.fn();
    const config: Env = { ...env, AI: { run } as unknown as Ai, AI_GATEWAY_ID: 'test-gateway' };
    const event = await insertEvent(env.edgeguard_db, { method: 'GET', path: '/private/path', clientId: 'private-client', status: 503, latencyMs: 6200 });
    async function deliver() {
        const batch = createMessageBatch('edgeguard-events', [{id: 'msg', timestamp: new Date(), attempts: 1, body: {type: 'event.received' as const, eventId: event.id}}]);
        const ctx = createExecutionContext();
        await worker.queue(batch, config, ctx);
        expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['msg']);
    }
    const incidents = async () => (await listIncidents(env.edgeguard_db, {limit: 100})).filter(i => i.eventId === event.id);
    const retry = (id: string, token = config.ADMIN_API_TOKEN) => worker.fetch(new Request('https://example.test/api/incidents/' + id + '/analysis/retry', {
        method: 'POST', headers: {Authorization: 'Bearer ' + token},
    }), config);
    return {run, deliver, incidents, retry, config};
}

describe('Incident analysis', () => {
    it('persists the incident first, sends minimal evidence through the gateway and skips duplicate delivery', async () => {
        const {run, deliver, incidents} = await setup();
        let visible = false;
        run.mockImplementation(async () => {
            visible = (await incidents())[0]?.analysisState === 'running';
            return {response: sample};
        });
        await deliver();
        await deliver();
        expect(visible).toBe(true);
        expect(run).toHaveBeenCalledTimes(1);
        const [,input,options] = run.mock.calls[0];
        expect(JSON.parse(input.messages[1].content)).toEqual({status: 503, latencyMs: 6200});
        expect(options.gateway.id).toBe('test-gateway');
        expect(await incidents()).toEqual([expect.objectContaining({analysisState:'complete', analysis:sample, status:'open'})]);
    });

    it('requests only the field structure from the model', async () => {
        const {run, deliver} = await setup();
        run.mockResolvedValue({response: sample});
        await deliver();
        const [, input] = run.mock.calls[0];
        expect(input.response_format).toEqual({
            type: 'json_schema',
            json_schema: {
                type: 'object',
                properties: {
                    summary: { type: 'string' },
                    possibleCauses: { type: 'array', items: { type: 'string' } },
                    suggestedNextSteps: { type: 'array', items: { type: 'string' } },
                },
                required: ['summary', 'possibleCauses', 'suggestedNextSteps'],
            },
        });
    });

    it('recovers an expired claim and ignores the late response from its previous owner', async () => {
        const {run, deliver, incidents, retry} = await setup();
        let release!: (value: unknown) => void;
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        run.mockImplementationOnce(() => new Promise(resolve => { release = resolve; entered(); }));
        const first = deliver();
        await started;
        const [row] = await incidents();
        await env.edgeguard_db.prepare('UPDATE incidents SET analysis_expires_at = 0 WHERE id = ?').bind(row.id).run();
        expect((await incidents())[0].analysisState).toBe('failed');
        run.mockResolvedValueOnce({response: sample});
        expect((await retry(row.id)).status).toBe(200);
        release({response: {...sample, summary: 'This valid response belongs to the expired attempt.'}});
        await first;
        expect((await incidents())[0].analysis).toEqual(sample);
    });

    it('cancels a pending inference at the timeout and permits a retry', async () => {
        const {run, deliver, incidents, retry} = await setup();
        const timeout = AbortSignal.timeout.bind(AbortSignal);
        const deadline = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(5));
        try {
            run.mockImplementationOnce((_model, _input, {signal}) => new Promise((_resolve, reject) => {
                signal.throwIfAborted();
                signal.addEventListener('abort', () => reject(signal.reason), {once: true});
            }));
            await deliver();
            expect(deadline).toHaveBeenCalledWith(20_000);
        } finally {
            deadline.mockRestore();
        }
        const [row] = await incidents();
        expect(row).toMatchObject({analysisState: 'failed', analysis: null, status: 'open'});
        run.mockResolvedValueOnce({response: sample});
        expect((await retry(row.id)).status).toBe(200);
        expect((await incidents())[0].analysis).toEqual(sample);
    });

    it('preserves a resolved incident when D1 rejects the retry result', async () => {
        const {run, deliver, incidents, retry} = await setup();
        run.mockRejectedValueOnce(new Error('Gateway unavailable'));
        await deliver();
        const [row] = await incidents();
        await updateIncidentStatus(env.edgeguard_db, row.id, 'resolved');
        await env.edgeguard_db.prepare(`CREATE TRIGGER reject_analysis BEFORE UPDATE ON incidents
            WHEN NEW.analysis_state = 'complete' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`).run();
        run.mockResolvedValue({response: sample});
        try {
            const response = await retry(row.id);
            expect(response.status).toBe(503);
            expect(await response.json()).toEqual({error: 'Could not confirm the analysis state. Refresh the incident before retrying.'});
            expect((await incidents())[0]).toMatchObject({analysisState: 'running', analysis: null, status: 'resolved'});
            expect((await retry(row.id)).status).toBe(409);
        } finally {
            await env.edgeguard_db.prepare('DROP TRIGGER reject_analysis').run();
        }
        await env.edgeguard_db.prepare('UPDATE incidents SET analysis_expires_at = 0 WHERE id = ?').bind(row.id).run();
        expect((await retry(row.id)).status).toBe(200);
        expect((await incidents())[0]).toMatchObject({analysisState: 'complete', analysis: sample, status: 'resolved'});
    });

    it.each(['invalid JSON', 'wrong schema', 'single-letter output', 'gateway error'])('preserves the incident on %s and permits one successful admin retry', async (failure) => {
        const {run, deliver, incidents, retry, config} = await setup();
        if (failure === 'single-letter output') run.mockResolvedValueOnce({response: {summary: 'A', possibleCauses: ['H'], suggestedNextSteps: ['C']}});
        else if (failure === 'invalid JSON') run.mockResolvedValueOnce({response: '{'});
        else if (failure === 'wrong schema') run.mockResolvedValueOnce({response: {...sample, possibleCauses: []}});
        else run.mockRejectedValueOnce(new Error(failure));
        await deliver();
        const [row] = await incidents();
        expect(row).toMatchObject({analysisState:'failed', analysis:null, status:'open'});
        await updateIncidentStatus(env.edgeguard_db, row.id, 'resolved');
        await deliver();
        expect(run).toHaveBeenCalledTimes(1);
        expect((await retry(row.id, config.DASHBOARD_API_TOKEN)).status).toBe(403);
        run.mockResolvedValue({response: JSON.stringify(sample)});
        const responses = await Promise.all([retry(row.id), retry(row.id)]);
        expect(responses.map(r => r.status).sort()).toEqual([200,409]);
        expect(run).toHaveBeenCalledTimes(2);
        expect(await incidents()).toEqual([expect.objectContaining({id:row.id, status:'resolved', analysis:sample})]);
    });
});
