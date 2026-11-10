import { open } from 'node:fs/promises';
import { analysisModel, buildAnalysisInput, type Analysis } from '../src/analysis.ts';
import { readJsonBody } from '../src/body.ts';
import { scenarios, type Scenario } from './scenarios.ts';
import { reviewReport } from './review.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tokenCount(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

type Review = { scenario: string; report: Analysis; flags: string[]; review: string };

export async function runLive(
	args: string[],
	env: Record<string, string | undefined>,
	transport: typeof fetch,
	emit: (line: string) => void,
	saveReview?: (record: Review) => Promise<void>,
	now = () => performance.now(),
) {
	const [flag, id, ...extra] = args;
	const selected = scenarios.filter((scenario) => id === 'all' || scenario.id === id);
	if (flag !== '--live' || !selected.length || extra.length) {
		throw new Error('Select --live and one scenario ID or all. No request was sent.');
	}
	const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token, AI_GATEWAY_ID: gateway } = env;
	if (!account || !/^[a-f\d]{32}$/i.test(account) || !token || !gateway) {
		throw new Error('Configure CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and AI_GATEWAY_ID for this opt-in run.');
	}

	let exitCode = 0;
	for (const scenario of selected) {
		const { record, report } = await evaluate(scenario, account, token, gateway, transport, now);
		emit(JSON.stringify(record));
		if (report && saveReview) {
			await saveReview({ scenario: scenario.id, report, flags: record.flags, review: scenario.review });
		}
		if (record.outcome === 'review_flagged') {
			exitCode = 1;
		} else if (record.outcome !== 'valid') {
			return 1;
		}
	}
	return exitCode;
}

async function evaluate(scenario: Scenario, account: string, token: string, gateway: string, transport: typeof fetch, now: () => number) {
	const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${analysisModel}`;
	const body = JSON.stringify(buildAnalysisInput(scenario.evidence));
	const signal = AbortSignal.timeout(20_000);
	const record = {
		mode: 'live',
		model: analysisModel,
		scenario: scenario.id,
		outcome: 'transport_error',
		httpStatus: null as number | null,
		restEndToEndLatencyMs: 0,
		inputTokens: null as number | null,
		outputTokens: null as number | null,
		totalTokens: null as number | null,
		flags: [] as string[],
	};
	let envelope: unknown;
	const started = now();
	try {
		const response = await transport(url, {
			method: 'POST',
			redirect: 'error',
			signal,
			headers: {
				Authorization: 'Bearer ' + token,
				'Content-Type': 'application/json',
				'cf-aig-gateway-id': gateway,
				'cf-aig-skip-cache': 'true',
				'cf-aig-collect-log': 'false',
				'cf-aig-max-attempts': '1',
				'cf-aig-request-timeout': '18000',
			},
			body,
		});
		record.httpStatus = response.status;
		const parsed = await readJsonBody(response);
		if (parsed.ok) {
			envelope = parsed.value;
		}
	} catch {
		// Transport exceptions can include credentials or request details.
	} finally {
		record.restEndToEndLatencyMs = now() - started;
	}

	const result = isRecord(envelope) && isRecord(envelope.result) ? envelope.result : null;
	if (isRecord(result?.usage)) {
		record.inputTokens = tokenCount(result.usage.prompt_tokens);
		record.outputTokens = tokenCount(result.usage.completion_tokens);
		record.totalTokens = tokenCount(result.usage.total_tokens);
	}

	let report: Analysis | null = null;
	if (record.httpStatus !== null && (record.httpStatus < 200 || record.httpStatus >= 300)) {
		record.outcome = 'http_error';
	} else if (signal.aborted) {
		record.outcome = 'timeout';
	} else if (record.httpStatus !== null) {
		if (isRecord(envelope) && envelope.success === false) {
			record.outcome = 'provider_error';
		} else if (!isRecord(envelope) || envelope.success !== true || !result || !Object.hasOwn(result, 'response')) {
			record.outcome = 'invalid_envelope';
		} else {
			const review = reviewReport(scenario, result.response);
			report = review.report;
			record.flags = review.flags;
			record.outcome = !report ? 'invalid_report' : review.flags.length ? 'review_flagged' : 'valid';
		}
	}
	return { record, report };
}

async function main() {
	// Free-form model text is only retained for an explicitly requested private review.
	const path = process.env.EDGEGUARD_REVIEW_FILE;
	const file = path ? await open(path, 'wx', 0o600) : undefined;
	try {
		process.exitCode = await runLive(
			process.argv.slice(2),
			process.env,
			fetch,
			(line) => console.log(line),
			file
				? async (record) => {
						await file.writeFile(JSON.stringify(record) + '\n');
					}
				: undefined,
		);
	} finally {
		await file?.close();
	}
}

if (import.meta.main) {
	main().catch(() => {
		console.error('Evaluation stopped. Check --live, scenario selection, account settings and review file permissions.');
		process.exitCode = 1;
	});
}
