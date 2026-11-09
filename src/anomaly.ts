// Immutable opening snapshot written by the event INSERT trigger in migration 0006.
export interface WindowEvidence {
	rule: 'endpoint_5xx_rate_v2';
	severity: 'high' | 'critical';
	method: string;
	path: string;
	windowStartMs: number;
	windowEndExclusiveMs: number;
	totalRequests: number;
	serverErrors: number;
	errorPercent: number;
	averageLatencyMs: number;
	minRequests: number;
	minFailures: number;
	openPercent: number;
}

export function describeSpike(evidence: WindowEvidence): string {
	return `HTTP 5xx rate exceeded ${evidence.openPercent}% (${evidence.serverErrors} of ${evidence.totalRequests} requests)`;
}
