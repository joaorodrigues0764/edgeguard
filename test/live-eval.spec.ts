import { describe, expect, it, vi } from 'vitest';
import { runLive } from '../eval/live.mts';
import { analysisModel } from '../src/analysis';

const settings = {
	CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
	CLOUDFLARE_API_TOKEN: 'synthetic-test-credential',
	AI_GATEWAY_ID: 'edgeguard-staging',
};
const args = ['--live', 'historical-502'];
const candidate = {
	summary: 'A single request returned HTTP 502 and took 1300 ms.',
	possibleCauses: ['An upstream dependency may be unavailable.'],
	suggestedNextSteps: ['Check upstream health at the recorded time.'],
};

function response(usage?: unknown, report: unknown = candidate) {
	return Response.json({ success: true, result: { response: report, usage } });
}

async function exercise(transport: typeof fetch, selection = args) {
	const lines: string[] = [];
	const saveReview = vi.fn().mockResolvedValue(undefined);
	const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(142.5);
	const exitCode = await runLive(selection, settings, transport, (line) => lines.push(line), saveReview, now);

	expect(lines).toHaveLength(1);
	expect(lines[0]).not.toContain(settings.CLOUDFLARE_API_TOKEN);
	expect(lines[0]).not.toContain(candidate.summary);
	expect(lines[0]).not.toContain('messages');
	return { exitCode, record: JSON.parse(lines[0]), saveReview };
}

describe('live evaluation with a local transport', () => {
	it('times a complete REST response and preserves independently reported token counts', async () => {
		const transport = vi.fn<typeof fetch>().mockResolvedValue(response({ prompt_tokens: 108, completion_tokens: 0, total_tokens: 108 }));

		const { exitCode, record, saveReview } = await exercise(transport);

		expect(exitCode).toBe(0);
		expect(record).toEqual({
			mode: 'live',
			model: analysisModel,
			scenario: 'historical-502',
			outcome: 'valid',
			httpStatus: 200,
			restEndToEndLatencyMs: 42.5,
			inputTokens: 108,
			outputTokens: 0,
			totalTokens: 108,
			flags: [],
		});
		expect(saveReview).toHaveBeenCalledWith(expect.objectContaining({ report: candidate }));
		expect(transport).toHaveBeenCalledTimes(1);
		expect(transport.mock.calls[0][1]).toMatchObject({
			redirect: 'error',
			headers: {
				'cf-aig-gateway-id': 'edgeguard-staging',
				'cf-aig-max-attempts': '1',
				'cf-aig-collect-log': 'false',
			},
		});
	});

	it('includes response body delivery in REST latency', async () => {
		let clock = 0;
		const emit = vi.fn();
		const payload = await response().text();
		const transport = async () => {
			clock = 10;
			const body = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						clock = 40;
						controller.enqueue(new TextEncoder().encode(payload));
						controller.close();
					},
				},
				{ highWaterMark: 0 },
			);
			return new Response(body);
		};

		await runLive(args, settings, transport, emit, undefined, () => clock);

		expect(JSON.parse(emit.mock.calls[0][0]).restEndToEndLatencyMs).toBe(40);
	});

	it.each([
		{
			usage: undefined,
			inputTokens: null,
			outputTokens: null,
		},
		{
			usage: { prompt_tokens: 0 },
			inputTokens: 0,
			outputTokens: null,
		},
		{
			usage: { prompt_tokens: -1, completion_tokens: 7 },
			inputTokens: null,
			outputTokens: 7,
		},
		{
			usage: { prompt_tokens: '12', completion_tokens: 0.5 },
			inputTokens: null,
			outputTokens: null,
		},
	])('keeps missing or invalid counters distinct from zero', async ({ usage, inputTokens, outputTokens }) => {
		const { record } = await exercise(async () => response(usage));

		expect(record).toMatchObject({ inputTokens, outputTokens, totalTokens: null });
	});

	it.each([
		{
			outcome: 'transport_error',
			reply: () => Promise.reject(new Error(settings.CLOUDFLARE_API_TOKEN)),
		},
		{
			outcome: 'http_error',
			reply: async () => new Response(settings.CLOUDFLARE_API_TOKEN, { status: 429 }),
		},
		{
			outcome: 'invalid_envelope',
			reply: async () => new Response('invalid JSON'),
		},
		{
			outcome: 'invalid_envelope',
			reply: async () => Response.json(null),
		},
		{
			outcome: 'invalid_envelope',
			reply: async () => Response.json({ success: 'true', result: {} }),
		},
		{
			outcome: 'invalid_envelope',
			reply: async () => Response.json({ success: true, result: {} }),
		},
		{
			outcome: 'invalid_envelope',
			reply: async () => new Response(' '.repeat(65536) + '{}'),
		},
		{
			outcome: 'provider_error',
			reply: async () => Response.json({ success: false, errors: [settings.CLOUDFLARE_API_TOKEN] }),
		},
		{
			outcome: 'invalid_report',
			reply: async () => response({ prompt_tokens: 8 }, 'invalid'),
		},
	])('records $outcome and stops a batch after one request', async ({ outcome, reply }) => {
		const transport = vi.fn(reply);

		const { exitCode, record, saveReview } = await exercise(transport, ['--live', 'all']);

		expect(exitCode).toBe(1);
		expect(record).toMatchObject({ outcome, scenario: 'sustained-errors', restEndToEndLatencyMs: 42.5 });
		if (outcome === 'invalid_report') {
			expect(record.inputTokens).toBe(8);
		}
		expect(transport).toHaveBeenCalledTimes(1);
		expect(saveReview).not.toHaveBeenCalled();
	});

	it.each([[], ['all'], ['--live'], ['--live', 'unknown'], ['--live', 'all', 'extra']].map((selection) => ({ selection })))(
		'requires live opt-in and explicit selection ($selection)',
		async ({ selection }) => {
			const transport = vi.fn();

			await expect(runLive(selection, settings, transport, vi.fn())).rejects.toThrow('No request was sent');

			expect(transport).not.toHaveBeenCalled();
		},
	);
});
