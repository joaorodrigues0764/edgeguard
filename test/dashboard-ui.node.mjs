import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';
import { dashboardScript } from '../src/dashboard-ui.ts';

// A small DOM/timer harness runs the shipped script without a browser dependency.
async function flush() {
	await setImmediate();
}

function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function response(data, status = 200) {
	const body = structuredClone(status === 200 ? { data } : { error: 'Sign in to continue.' });
	return { ok: status === 200, status, json: async () => body };
}

async function dashboard() {
	const elements = new Map();
	const timers = new Map();
	const listeners = new Map();
	const requests = [];
	let nextTimer = 0;
	class Element {
		children = [];
		listeners = new Map();
		value = '';
		textContent = '';
		hidden = false;
		disabled = false;
		append(...children) {
			this.children.push(...children);
		}
		replaceChildren(...children) {
			this.children = children;
		}
		setAttribute() {}
		addEventListener(name, handler) {
			this.listeners.set(name, handler);
		}
		contains(node) {
			return this === node || this.children.some((child) => child.contains(node));
		}
		focus() {
			document.activeElement = this;
		}
	}
	const document = {
		hidden: false,
		activeElement: null,
		getElementById(id) {
			if (!elements.has(id)) {
				elements.set(id, new Element());
			}
			return elements.get(id);
		},
		createElement: () => new Element(),
		createElementNS: () => new Element(),
		addEventListener: (name, handler) => listeners.set(name, handler),
	};
	const item = {
		id: 'incident-1',
		eventMethod: 'GET',
		eventPath: '/checkout',
		eventStatus: 503,
		eventLatencyMs: 100,
		eventOccurredAt: 0,
		createdAt: 0,
		severity: 'high',
		status: 'open',
		analysisState: 'pending',
	};
	const state = { total: 26, items: [item], intercept: () => null };
	const context = vm.createContext({
		document,
		window: {
			getSelection: () => null,
			addEventListener: (name, handler) => listeners.set(name, handler),
		},
		AbortController,
		DOMException,
		URLSearchParams,
		setTimeout(handler, delay) {
			timers.set(++nextTimer, { handler, delay });
			return nextTimer;
		},
		clearTimeout: (id) => timers.delete(id),
		fetch(path, options) {
			requests.push({ path, options });
			const intercepted = state.intercept(path, options);
			if (intercepted) {
				return intercepted;
			}
			if (path.includes('timeseries')) {
				return response({ points: [{ timestamp: 0, total: state.total, serverErrors: 6 }] });
			}
			if (path.endsWith('/metrics')) {
				return response({
					events: { total: state.total, serverErrors: 6, rateLimitedResponses: 0, averageLatencyMs: 192.3 },
					incidents: { open: 1, resolved: 0, total: 1, bySeverity: { critical: 0 } },
				});
			}
			if (path.includes('/incidents?')) {
				return response(state.items);
			}
			return response({ ok: true });
		},
	});
	vm.runInContext(dashboardScript, context);
	await flush();
	return {
		state, document, requests, timers,
		$: (id) => document.getElementById(id),
		emit: (name) => listeners.get(name)(),
		tick() {
			assert.equal(timers.size, 1);
			const [id, timer] = [...timers.entries()][0];
			assert.equal(timer.delay, 3000);
			timers.delete(id);
			return timer.handler();
		},
	};
}

function text(node) {
	return [node.textContent, ...node.children.map(text)].join(' ');
}

function selectFirst(ui) {
	ui.$('rows').children[0].children.at(-1).children[0].onclick();
}

test('polls on one timer and serializes manual refresh behind an unfinished cycle', async () => {
	const ui = await dashboard();
	const pending = deferred();
	let blocked = false;
	ui.state.intercept = (path) => {
		if (path.includes('/incidents?') && !blocked) {
			blocked = true;
			return pending.promise;
		}
		return null;
	};
	const initial = ui.requests.length;

	const polling = ui.tick();
	ui.$('refresh').onclick();
	await flush();

	assert.equal(ui.requests.length, initial + 3);
	assert.equal(ui.timers.size, 0);
	pending.resolve(response(ui.state.items));
	await polling;
	assert.equal(ui.requests.length, initial + 6);
	assert.equal(ui.timers.size, 1);
	assert.equal(ui.$('refresh').disabled, false);
});

test('hiding or leaving cancels reads and polling; resuming creates only one timer', async () => {
	const ui = await dashboard();
	const pending = deferred();
	ui.state.intercept = (path) => path.endsWith('/metrics') ? pending.promise : null;
	const oldMetric = ui.$('metrics').children[0];

	const polling = ui.tick();
	ui.document.hidden = true;
	ui.emit('visibilitychange');
	pending.resolve(response({ events: { total: 999 } }));
	await polling;

	assert.equal(ui.$('metrics').children[0], oldMetric);
	assert.equal(ui.timers.size, 0);
	ui.state.intercept = () => null;
	ui.document.hidden = false;
	ui.emit('visibilitychange');
	await flush();
	assert.equal(ui.timers.size, 1);
	ui.emit('pagehide');
	assert.equal(ui.timers.size, 0);
	ui.emit('pageshow');
	await flush();
	assert.equal(ui.timers.size, 1);
});

test('keeps selected details and filters, defers focused controls, and ignores stale filter results', async () => {
	const ui = await dashboard();
	selectFirst(ui);
	const original = ui.$('detail').children[0];

	await ui.tick();

	assert.equal(ui.$('detail').children[0], original);
	ui.document.activeElement = ui.$('detail').children.at(-1);
	ui.state.items[0].analysisState = 'complete';
	await ui.tick();
	assert.equal(ui.$('detail').children[0], original);
	ui.document.activeElement = null;
	await ui.tick();
	assert.match(text(ui.$('detail')), /Complete/);

	const pending = deferred();
	ui.state.intercept = (path) => path.includes('/incidents?') && !path.includes('status=resolved') ? pending.promise : null;
	const polling = ui.tick();
	ui.$('status').value = 'resolved';
	ui.state.items = [];
	ui.$('status').onchange();
	pending.resolve(response([{ ...ui.state.items[0], id: 'stale' }]));
	await polling;

	assert.equal(ui.$('status').value, 'resolved');
	assert.equal(ui.$('rows').children.length, 0);
	assert.match(text(ui.$('detail')), /GET \/checkout/);
	assert.ok(ui.requests.some(({ path }) => path.includes('status=resolved')));
});

test('a polling 401 clears the session and late reads cannot repopulate it', async () => {
	const ui = await dashboard();
	const pending = deferred();
	ui.state.intercept = (path) => {
		if (path.endsWith('/metrics')) {
			return pending.promise;
		}
		if (path.includes('/incidents?')) {
			return response(null, 401);
		}
		return null;
	};

	const polling = ui.tick();
	await flush();
	pending.resolve(response({ events: { total: 999 } }));
	await polling;

	assert.equal(ui.$('app').hidden, true);
	assert.equal(ui.$('login').hidden, false);
	assert.equal(ui.$('metrics').children.length, 0);
	assert.equal(ui.$('message').textContent, 'Sign in to continue.');
	assert.equal(ui.timers.size, 0);
});

test('an explicit analysis retry refreshes the focused investigation immediately', async () => {
	const ui = await dashboard();
	ui.state.items[0].analysisState = 'failed';
	await ui.tick();
	selectFirst(ui);
	const retry = ui.$('detail').children.find((child) => child.textContent === 'Retry analysis');
	ui.document.activeElement = retry;
	ui.state.intercept = (path) => {
		if (path.endsWith('/analysis/retry')) {
			ui.state.items[0].analysisState = 'complete';
			return response({ ok: true });
		}
		return null;
	};

	await retry.onclick();

	assert.match(text(ui.$('detail')), /Complete/);
	assert.equal(ui.timers.size, 1);
});

test('an incident write invalidates old reads and preserves the investigation after filtering it out', async () => {
	const ui = await dashboard();
	selectFirst(ui);
	const pending = deferred();
	const write = deferred();
	ui.state.intercept = (path, options) => {
		if (options.method === 'PATCH') {
			return write.promise;
		}
		return path.endsWith('/metrics') ? pending.promise : null;
	};

	const polling = ui.tick();
	const action = ui.$('detail').children.at(-1).listeners.get('click')();
	pending.resolve(response({ events: { total: 999 } }));
	await polling;
	assert.equal(ui.timers.size, 0);
	ui.state.intercept = () => null;
	const updated = { ...ui.state.items[0], status: 'resolved' };
	ui.state.items = [];
	ui.$('status').value = 'open';
	write.resolve(response(updated));
	await action;

	assert.match(text(ui.$('detail')), /Resolved/);
	assert.equal(ui.$('status').value, 'open');
	assert.equal(ui.$('rows').children.length, 0);
	assert.equal(ui.$('message').textContent, 'Status updated.');
	assert.equal(ui.timers.size, 1);
});

test('finishing a write does not replace a different incident selected meanwhile', async () => {
	const ui = await dashboard();
	ui.state.items.push({ ...ui.state.items[0], id: 'incident-2', eventPath: '/search' });
	await ui.tick();
	selectFirst(ui);
	const write = deferred();
	ui.state.intercept = (path, options) => options.method === 'PATCH' ? write.promise : null;

	const action = ui.$('detail').children.at(-1).listeners.get('click')();
	ui.$('rows').children[1].children.at(-1).children[0].onclick();
	ui.state.items[0].status = 'resolved';
	write.resolve(response(ui.state.items[0]));
	await action;

	assert.match(text(ui.$('detail')), /GET \/search/);
	assert.equal(ui.timers.size, 1);
});
