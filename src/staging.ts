import worker, { type Env } from './index';

// Staging has its own entry point so a missing/replaced variable cannot select production defaults.
function configured(env: Env): boolean {
	const secrets = [env.INGEST_API_TOKEN, env.DASHBOARD_API_TOKEN, env.ADMIN_API_TOKEN, env.DASHBOARD_PASSWORD];
	return (
		env.TELEMETRY_DATASET === 'edgeguard_staging_telemetry' &&
		env.AI_GATEWAY_ID === 'edgeguard-staging' &&
		typeof env.ANALYTICS_SQL?.query === 'function' &&
		typeof env.EDGEGUARD_ANALYTICS?.writeDataPoint === 'function' &&
		typeof env.edgeguard_db?.prepare === 'function' &&
		typeof env.EVENTS_QUEUE?.send === 'function' &&
		typeof env.EVENT_INGEST_RATE_LIMITER?.limit === 'function' &&
		typeof env.AI?.run === 'function' &&
		secrets.every((secret) => typeof secret === 'string' && secret.trim().length > 0) &&
		new Set(secrets).size === secrets.length &&
		(env.DASHBOARD_PASSWORD?.length ?? 0) >= 32
	);
}

export default {
	async fetch(request: Request, env) {
		if (!configured(env)) {
			return Response.json({ error: 'Staging configuration incomplete.' }, { status: 503 });
		}
		return worker.fetch(request, env);
	},

	async queue(batch, env, ctx) {
		if (!configured(env) || batch.queue !== 'edgeguard-staging-events') {
			throw new Error('Invalid staging queue configuration.');
		}
		return worker.queue(batch, env, ctx);
	},
} satisfies ExportedHandler<Env>;
