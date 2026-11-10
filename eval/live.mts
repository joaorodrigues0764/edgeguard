import { analysisModel, buildAnalysisInput } from '../src/analysis.ts';
import { scenarios } from './scenarios.ts';
import { reviewReport } from './review.ts';

async function main() {
	const [flag, id, ...extra] = process.argv.slice(2);
	const selected = scenarios.filter((scenario) => id === 'all' || scenario.id === id);
	if (flag !== '--live' || !selected.length || extra.length) {
		throw new Error('Select --live and one scenario ID or all. No request was sent.');
	}
	const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token, AI_GATEWAY_ID: gateway } = process.env;
	if (!account || !/^[a-f\d]{32}$/i.test(account) || !token || !gateway) {
		throw new Error('Configure CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and AI_GATEWAY_ID for this opt-in run.');
	}

	for (const scenario of selected) {
		const input = buildAnalysisInput(scenario.evidence);
		const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${analysisModel}`;
		const response = await fetch(url, {
			method: 'POST',
			redirect: 'error',
			signal: AbortSignal.timeout(20_000),
			headers: {
				Authorization: 'Bearer ' + token,
				'Content-Type': 'application/json',
				'cf-aig-gateway-id': gateway,
				'cf-aig-skip-cache': 'true',
				'cf-aig-collect-log': 'false',
				'cf-aig-request-timeout': '18000',
			},
			body: JSON.stringify(input),
		}).catch(() => {
			// Transport and invalid-header errors can include request details.
			throw new Error(`Scenario ${scenario.id}: request failed or timed out. Stopping the run.`);
		});
		if (!response.ok) {
			throw new Error(`Scenario ${scenario.id}: Workers AI returned HTTP ${response.status}. Stopping the run.`);
		}

		const envelope = (await response.json().catch(() => {
			throw new Error(`Scenario ${scenario.id}: invalid provider envelope.`);
		})) as { success: boolean; result?: { response?: unknown } };
		if (!envelope.success) {
			throw new Error(`Scenario ${scenario.id}: Workers AI did not confirm success.`);
		}
		const { report, flags } = reviewReport(scenario, envelope.result?.response);
		console.log(
			JSON.stringify({
				mode: 'live',
				model: analysisModel,
				scenario: scenario.id,
				evidence: JSON.parse(input.messages[1].content),
				report,
				flags,
				review: scenario.review,
			}),
		);
		if (flags.length) {
			process.exitCode = 1;
		}
	}
}

main().catch((error: Error) => {
	console.error(error.message);
	process.exitCode = 1;
});
