/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { checkStaging, localTemplate } from '../staging/check.mjs';
import template from '../staging/wrangler.json';
import productionText from '../wrangler.jsonc?raw';

const production = JSON.parse(productionText);

function filledConfig() {
	// Shape-valid ephemeral values for the in-memory check only.
	const config = localTemplate();
	config.account_id = crypto.randomUUID().replaceAll('-', '');
	config.d1_databases[0].database_id = crypto.randomUUID();
	config.ratelimits[0].namespace_id = '17';
	return config;
}

describe('staging preflight', () => {
	it('rejects the shipped placeholders and accepts only a completed local copy', () => {
		expect(() => checkStaging(template, production)).toThrow('account ID');
		expect(() => checkStaging(filledConfig(), production)).not.toThrow();
	});

	it('pairs the read and write datasets and pins staging resources', () => {
		expect(template.name).toBe('edgeguard-staging');
		expect(template.main).toBe('../src/staging.ts');
		expect(template).not.toHaveProperty('ai');
		expect(template.vars).toEqual({ TELEMETRY_DATASET: 'edgeguard_staging_telemetry' });
		expect(template.analytics_engine_datasets).toEqual([{ binding: 'EDGEGUARD_ANALYTICS', dataset: template.vars.TELEMETRY_DATASET }]);
		expect(template.analytics.binding).toBe('ANALYTICS_SQL');
		expect(template.d1_databases[0].database_name).toBe('edgeguard-staging-db');
		expect(template.queues.producers).toEqual([{ binding: 'EVENTS_QUEUE', queue: 'edgeguard-staging-events' }]);
		expect(template.queues.consumers).toHaveLength(1);
		expect(template.queues.consumers[0]).toMatchObject({
			queue: 'edgeguard-staging-events',
			dead_letter_queue: 'edgeguard-staging-events-dlq',
		});
	});

	it('refuses the production database or rate limiting namespace', () => {
		const config = filledConfig();
		config.d1_databases[0].database_id = production.d1_databases[0].database_id.toUpperCase();

		expect(() => checkStaging(config, production)).toThrow('D1 UUID');

		const sharedNamespace = filledConfig();
		sharedNamespace.ratelimits[0].namespace_id = production.ratelimits[0].namespace_id;

		expect(() => checkStaging(sharedNamespace, production)).toThrow('namespace');
	});

	it.each(['ai', 'queues', 'analytics_engine_datasets', 'vars', 'name'] as const)('rejects production %s in the deployable copy', (key) => {
		const config = { ...filledConfig(), [key]: production[key] };

		expect(() => checkStaging(config, production)).toThrow('reviewed template');
	});

	it('rejects extra binding targets, alternate environments and missing IDs', () => {
		const config = filledConfig();
		config.queues.producers.push(production.queues.producers[0]);

		expect(() => checkStaging(config, production)).toThrow('reviewed template');
		expect(() => checkStaging({ ...filledConfig(), env: { staging: production } }, production)).toThrow('reviewed template');
		expect(() => checkStaging({ ...filledConfig(), d1_databases: [] }, production)).toThrow('D1 UUID');
	});
});
