// Local demo entry point only. The production entry point cannot load this fixture.
import worker, { type Env } from '../src/index';

const fixture = {
	async run(_model: string, input: { messages: { content: string }[] }) {
		const evidence = JSON.parse(input.messages[1].content);
		let summary: string;
		if ('serverErrors' in evidence) {
			const { serverErrors, totalRequests, errorPercent, averageLatencyMs } = evidence;
			summary =
				`The endpoint returned HTTP 5xx for ${serverErrors} of ${totalRequests} requests (${errorPercent}%). ` +
				`Mean latency was ${averageLatencyMs} ms.`;
		} else {
			summary = `The request returned HTTP ${evidence.status} in ${evidence.latencyMs} ms.`;
		}

		return {
			response: {
				summary: `Synthetic fixture: ${summary}`,
				possibleCauses: [evidence.status === 429 ? 'A request quota may have been reached.' : 'A dependency may be slow or unavailable.'],
				suggestedNextSteps: [
					evidence.status === 429
						? 'Compare the request rate with the configured quota.'
						: 'Inspect upstream timings for the affected endpoint.',
				],
			},
		};
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
