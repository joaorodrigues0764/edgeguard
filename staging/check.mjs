import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import template from './wrangler.json' with { type: 'json' };

function readConfig(filename) {
	const text = readFileSync(new URL(filename, import.meta.url), 'utf8');
	try {
		return JSON.parse(text);
	} catch {
		throw new Error('Use valid JSON in the Wrangler configuration files.');
	}
}

export function localTemplate() {
	const config = structuredClone(template);
	config.build.command = 'node check.mjs';
	return config;
}

export function checkStaging(config, production) {
	const expected = localTemplate();
	const account = config.account_id;
	const database = config.d1_databases?.[0]?.database_id;
	const namespace = config.ratelimits?.[0]?.namespace_id;
	if (typeof account !== 'string' || !/^[a-f0-9]{32}$/i.test(account)) {
		throw new Error('Set the verified staging account ID.');
	}
	if (
		typeof database !== 'string' ||
		!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(database) ||
		production.d1_databases.some((db) => db.database_id.toLowerCase() === database.toLowerCase())
	) {
		throw new Error('Set a staging D1 UUID distinct from production.');
	}
	if (
		typeof namespace !== 'string' ||
		!/^[1-9][0-9]*$/.test(namespace) ||
		production.ratelimits.some((limit) => BigInt(limit.namespace_id) === BigInt(namespace))
	) {
		throw new Error('Select a separate positive integer rate limit namespace.');
	}

	expected.account_id = account;
	expected.d1_databases[0].database_id = database;
	expected.ratelimits[0].namespace_id = namespace;
	if (!isDeepStrictEqual(config, expected)) {
		throw new Error('Only the three staging identifiers may differ from the reviewed template.');
	}
}

if (import.meta.main) {
	try {
		const args = process.argv.slice(2);
		if (args.length === 1 && args[0] === '--init') {
			writeFileSync(new URL('./wrangler.local.json', import.meta.url), JSON.stringify(localTemplate(), null, '\t') + '\n', { flag: 'wx' });
			console.log('Set the three staging identifiers in staging/wrangler.local.json.');
		} else if (args.length === 0) {
			checkStaging(readConfig('./wrangler.local.json'), readConfig('../wrangler.jsonc'));
			console.log('Staging configuration passed local isolation checks.');
		} else {
			throw new Error('The checked-in staging template cannot be deployed. Prepare the local copy with node staging/check.mjs --init.');
		}
	} catch (error) {
		console.error(error.code === 'ENOENT' ? 'Prepare the staging configuration with node staging/check.mjs --init.' : error.message);
		process.exitCode = 1;
	}
}
