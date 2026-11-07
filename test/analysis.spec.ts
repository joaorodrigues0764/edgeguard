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
        release({response: {...sample, summary: 'Stale response.'}});
        await first;
        expect((await incidents())[0].analysis).toEqual(sample);
    });

    it.each(['invalid JSON', 'wrong schema', 'single-letter output', 'gateway error', 'timeout'])('preserves the incident on %s and permits one successful admin retry', async (failure) => {
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
