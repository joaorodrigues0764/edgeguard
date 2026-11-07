// Local demo entry point only. The production entry point cannot load this fixture.
import worker, { type Env } from '../src/index';

const fixture = {
    async run(_model: string, input: { messages: { content: string }[] }) {
        const {status, latencyMs} = JSON.parse(input.messages[1].content);
        return {response: {
            summary: `Synthetic fixture: the request returned HTTP ${status} in ${latencyMs} ms.`,
            possibleCauses: [status === 429 ? 'A request quota may have been reached.' : 'A dependency may be slow or unavailable.'],
            suggestedNextSteps: [status === 429 ? 'Compare the request rate with the configured quota.' : 'Inspect upstream timings for this request.'],
        }};
    },
};
export default {
    ...worker,
    queue(batch, env, ctx) {
        return worker.queue(batch, { ...env, AI: fixture as unknown as Ai, AI_GATEWAY_ID: 'offline-fixture' }, ctx);
    },
    async fetch(request, env) {
        const response = await worker.fetch(request, { ...env, AI: fixture as unknown as Ai, AI_GATEWAY_ID: 'offline-fixture' });
        if (!response.headers.get('Content-Type')?.startsWith('text/html')) return response;
        return new Response((await response.text()).replace('EDGE MONITORING', 'SYNTHETIC DEMO · FIXTURE ANALYSIS'), response);
    },
} satisfies ExportedHandler<Env, import('../src/events').EventReceivedMessage>;
