import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import { insertEvent } from '../src/events';
import { createIncident } from '../src/incidents';

const password = 'test-dashboard-password-32-characters-minimum';
const origin = 'https://edgeguard.test';

function environment(): Env {
    return {
        ...env,
        DASHBOARD_PASSWORD: password,
        EVENT_INGEST_RATE_LIMITER: {
            limit: vi.fn().mockResolvedValue({ success: true })
        }
    } as unknown as Env;
}

function request(path: string, init: RequestInit = {}) {
    return new Request(origin + path, init);
}

async function login(config: Env) {
    const response = await worker.fetch(
        request('/dashboard/login', {
            method: 'POST',
            headers: { Origin: origin },
            body: JSON.stringify({ password })
        }),
        config
    );

    expect(response.status).toBe(200);
    return response.headers.get('Set-Cookie')!;
}

describe('Dashboard', () => {

    it('serves protected static assets without API secrets', async () => {
        const config = environment();
        const paths = ['/dashboard', '/dashboard/app.js', '/dashboard/style.css'];

        for (const path of paths) {
            const response = await worker.fetch(request(path), config);

            expect(response.status).toBe(200);
            expect(response.headers.get('Cache-Control')).toBe('no-store');
            expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");

            const body = await response.text();
            const secrets = [
                password,
                config.ADMIN_API_TOKEN,
                config.DASHBOARD_API_TOKEN,
                config.INGEST_API_TOKEN
            ];

            for (const secret of secrets) {
                expect(body).not.toContain(secret);
            }
        }
    });

    it('fails closed without configuration or a session', async () => {
        const noSessionResponse = await worker.fetch(request('/dashboard/api/metrics'), environment());
        expect(noSessionResponse.status).toBe(401);

        const noConfigResponse = await worker.fetch(request('/dashboard/session'), {
            ...environment(),
            DASHBOARD_PASSWORD: undefined
        });
        expect(noConfigResponse.status).toBe(503);
    });

    it('rejects incorrect passwords, cross-origin login and rate-limited login', async () => {
        const config = environment();
        const init = {
            method: 'POST',
            headers: { Origin: origin },
            body: JSON.stringify({ password: 'wrong' })
        };

        const wrongPasswordResponse = await worker.fetch(request('/dashboard/login', init), config);
        expect(wrongPasswordResponse.status).toBe(401);

        const crossOriginResponse = await worker.fetch(request('/dashboard/login', {
            ...init,
            headers: { Origin: 'https://evil.test' }
        }), config);
        expect(crossOriginResponse.status).toBe(403);

        vi.mocked(config.EVENT_INGEST_RATE_LIMITER.limit).mockResolvedValue({ success: false });

        const rateLimitedResponse = await worker.fetch(request('/dashboard/login', init), config);
        expect(rateLimitedResponse.status).toBe(429);
    });

    it('issues secure cookies and rejects tampered, expired or rotated sessions', async () => {
        const config = environment();
        const cookie = await login(config);

        expect(cookie).toContain('HttpOnly; Secure; SameSite=Strict');

        const headers = { Cookie: cookie.split(';')[0] };

        const validSessionResponse = await worker.fetch(request('/dashboard/session', { headers }), config);
        expect(validSessionResponse.status).toBe(200);

        const tamperedSessionResponse = await worker.fetch(request('/dashboard/session', {
            headers: { Cookie: headers.Cookie.replace(/.$/, 'z') }
        }), config);
        expect(tamperedSessionResponse.status).toBe(401);

        const rotatedSessionResponse = await worker.fetch(request('/dashboard/session', { headers }), {
            ...config,
            DASHBOARD_PASSWORD: password + 'rotated'
        });
        expect(rotatedSessionResponse.status).toBe(401);

        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 9 * 60 * 60 * 1000);

        try {
            const expiredSessionResponse = await worker.fetch(request('/dashboard/session', { headers }), config);
            expect(expiredSessionResponse.status).toBe(401);
        } finally {
            clock.mockRestore();
        }
    });

    it('reads real metrics and incidents, updates state, blocks CSRF and arbitrary proxy routes', async () => {
        const config = environment();
        const cookie = (await login(config)).split(';')[0];

        const event = await insertEvent(config.edgeguard_db, {
            method: 'GET',
            path: '/dashboard-test',
            status: 503,
            latencyMs: 2000
        });

        await createIncident(config.edgeguard_db, event.id, {
            severity: 'high',
            reason: 'Server error'
        });

        const headers = { Cookie: cookie, Origin: origin };

        const response = await worker.fetch(request('/dashboard/api/incidents?status=open', { headers }), config);
        const { data } = await response.json<{ data: Array<{ id: string; eventId: string }> }>();

        const incident = data.find(i => i.eventId === event.id)!;
        expect(incident).toBeDefined();

        const metricsResponse = await worker.fetch(request('/dashboard/api/metrics', { headers }), config);
        expect(metricsResponse.status).toBe(200);

        const timeseriesResponse = await worker.fetch(request('/dashboard/api/metrics/timeseries', { headers }), config);
        expect(timeseriesResponse.status).toBe(200);

        const path = '/dashboard/api/incidents/' + incident.id;

        // Test CSRF failure (missing Origin header)
        const csrfResponse = await worker.fetch(request(path, {
            method: 'PATCH',
            headers: { Cookie: cookie },
            body: '{"status":"resolved"}'
        }), config);
        expect(csrfResponse.status).toBe(403);

        // Successfully update status
        const changed = await worker.fetch(request(path, {
            method: 'PATCH',
            headers,
            body: '{"status":"resolved"}'
        }), config);
        expect(changed.status).toBe(200);
        expect(await changed.json()).toMatchObject({ data: { status: 'resolved' } });

        // Invalid update
        const invalidUpdate = await worker.fetch(request(path, {
            method: 'PATCH',
            headers,
            body: '{"status":"invalid"}'
        }), config);
        expect(invalidUpdate.status).toBe(400);

        // Protected / non-existent route
        const notFoundResponse = await worker.fetch(request('/dashboard/api/events', { headers }), config);
        expect(notFoundResponse.status).toBe(404);

        const arbitraryProxyResponse = await worker.fetch(request('/api/metrics', { headers }), config);
        expect(arbitraryProxyResponse.status).toBe(401);

        // Logout
        const logout = await worker.fetch(request('/dashboard/logout', {
            method: 'POST',
            headers
        }), config);
        expect(logout.headers.get('Set-Cookie')).toContain('Max-Age=0');
    });
});
