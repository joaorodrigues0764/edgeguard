import type { Env } from './index';
import { readJsonBody } from './body';
import { dashboardHtml, dashboardScript, dashboardStyle } from './dashboard-ui';

const COOKIE = '__Host-edgeguard';
const TTL = 8 * 60 * 60;
const encoder = new TextEncoder();

const json = (error: string, status: number) => {
	return Response.json(
		{
			error,
		},
		{
			status,
		},
	);
};

async function key(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{
			name: 'HMAC',
			hash: 'SHA-256',
		},
		false,
		['sign', 'verify'],
	);
}

async function signature(value: string, secret: string): Promise<string> {
	const bytes = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(value));

	return Array.from(new Uint8Array(bytes), (b) => {
		return b.toString(16).padStart(2, '0');
	}).join('');
}

async function validSession(request: Request, secret: string): Promise<boolean> {
	const cookie = request.headers
		.get('Cookie')
		?.split(';')
		.map((v) => {
			return v.trim();
		})
		.find((v) => {
			return v.startsWith(COOKIE + '=');
		})
		?.slice(COOKIE.length + 1);

	if (!cookie || !/^\d{13}\.[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(cookie)) {
		return false;
	}

	const [expires, nonce, mac] = cookie.split('.');

	if (Number(expires) <= Date.now() || Number(expires) > Date.now() + TTL * 1000) {
		return false;
	}

	return crypto.subtle.verify(
		'HMAC',
		await key(secret),
		Uint8Array.from(mac.match(/../g)!, (b) => {
			return parseInt(b, 16);
		}),
		encoder.encode(`${expires}.${nonce}`),
	);
}

function sessionCookie(value: string, age: number): string {
	return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
}

// The only bridge to bearer-authenticated routes. No user-controlled destination or headers.
export async function handleDashboard(request: Request, env: Env, api: (request: Request) => Promise<Response>): Promise<Response | null> {
	const url = new URL(request.url);

	if (url.pathname !== '/' && url.pathname !== '/dashboard' && !url.pathname.startsWith('/dashboard/')) {
		return null;
	}

	const response = await route(request, env, api, url);

	response.headers.set('Cache-Control', 'no-store');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'no-referrer');
	response.headers.set(
		'Content-Security-Policy',
		"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
	);

	return response;
}

async function route(request: Request, env: Env, api: (request: Request) => Promise<Response>, url: URL): Promise<Response> {
	const path = url.pathname;

	if (request.method === 'GET') {
		if (path === '/' || path === '/dashboard' || path === '/dashboard/') {
			return new Response(dashboardHtml, {
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
				},
			});
		}

		if (path === '/dashboard/app.js') {
			return new Response(dashboardScript, {
				headers: {
					'Content-Type': 'text/javascript; charset=utf-8',
				},
			});
		}

		if (path === '/dashboard/style.css') {
			return new Response(dashboardStyle, {
				headers: {
					'Content-Type': 'text/css; charset=utf-8',
				},
			});
		}
	}

	const secret = env.DASHBOARD_PASSWORD;

	if (!secret || secret.length < 32 || [env.ADMIN_API_TOKEN, env.DASHBOARD_API_TOKEN, env.INGEST_API_TOKEN].includes(secret)) {
		return json('Dashboard unavailable. Configure a separate dashboard password of at least 32 characters.', 503);
	}

	if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
		return json('HTTPS required.', 403);
	}

	if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) {
		return json('Invalid origin.', 403);
	}

	if (path === '/dashboard/login' && request.method === 'POST') {
		const limited = await env.EVENT_INGEST_RATE_LIMITER.limit({
			key: `dashboard-login:${request.headers.get('cf-connecting-ip') ?? 'local'}`,
		});

		if (!limited.success) {
			return json('Too many attempts. Try again later.', 429);
		}

		const parsed = await readJsonBody(request);

		if (!parsed.ok) {
			return parsed.response;
		}

		const password = (
			parsed.value as {
				password?: unknown;
			} | null
		)?.password;

		if (
			typeof password !== 'string' ||
			!crypto.subtle.timingSafeEqual(encoder.encode(await signature(password, secret)), encoder.encode(await signature(secret, secret)))
		) {
			return json('Invalid credentials.', 401);
		}

		const value = `${Date.now() + TTL * 1000}.${crypto.randomUUID()}`;

		return Response.json(
			{
				ok: true,
			},
			{
				headers: {
					'Set-Cookie': sessionCookie(`${value}.${await signature(value, secret)}`, TTL),
				},
			},
		);
	}

	if (path === '/dashboard/logout' && request.method === 'POST') {
		return Response.json(
			{
				ok: true,
			},
			{
				headers: {
					'Set-Cookie': sessionCookie('', 0),
				},
			},
		);
	}

	if (!(await validSession(request, secret))) {
		return json('Sign in to continue.', 401);
	}

	if (path === '/dashboard/session' && request.method === 'GET') {
		return Response.json({
			ok: true,
		});
	}

	const read =
		request.method === 'GET' && ['/dashboard/api/metrics', '/dashboard/api/metrics/timeseries', '/dashboard/api/incidents'].includes(path);
	const retry = request.method === 'POST' && /^\/dashboard\/api\/incidents\/[a-zA-Z0-9-]+\/analysis\/retry$/.test(path);
	const write = retry || (request.method === 'PATCH' && /^\/dashboard\/api\/incidents\/[a-zA-Z0-9-]+$/.test(path));

	if (!read && !write) {
		return json('Not Found', 404);
	}

	const token = write ? env.ADMIN_API_TOKEN : env.DASHBOARD_API_TOKEN;

	if (!token) {
		return json('Server token is not configured.', 503);
	}

	const target = new URL(path.slice('/dashboard'.length) + url.search, url.origin);

	return api(
		new Request(target, {
			method: request.method,
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: write ? request.body : undefined,
		}),
	);
}
