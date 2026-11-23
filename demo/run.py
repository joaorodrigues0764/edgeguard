"""Start an isolated, disposable portfolio demo from the project root."""

import http.client
import json
import math
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'node_modules/.bin/wrangler'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# Loopback requests must not inherit a proxy or follow redirects elsewhere.
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def ensure_port_free(port):
    """Exit with a clear message if another process is listening on the demo port."""
    with socket.socket() as probe:
        # Sockets left in TIME_WAIT by a previous run must not block a new demo.
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(('127.0.0.1', port))
        except OSError as error:
            sys.exit(
                f'Port {port} on 127.0.0.1 is unavailable ({error.strerror}). '
                f'Stop the process using it (for example, check `ss -ltnp | grep {port}`) '
                'and run the demo again.'
            )


def run_stream(url, credentials):
    path = '/synthetic/stream/' + secrets.token_hex(8)
    observations = []

    def request(route, payload=None, key=None, until=None):
        token = credentials['INGEST_API_TOKEN' if payload is not None else 'DASHBOARD_API_TOKEN']
        headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
        if key is not None:
            headers['Idempotency-Key'] = key
        req = urllib.request.Request(
            url + route,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers=headers,
        )
        for attempt in range(4):
            remaining = until - time.monotonic() if until is not None else 5
            if remaining <= 0:
                raise RuntimeError(f'{req.get_method()} {route}: verification/scenario deadline exceeded.')
            delay = 2 * (attempt + 1)
            try:
                with HTTP.open(req, timeout=min(5, remaining)) as response:
                    if response.status not in ((200, 201) if payload is not None else (200,)):
                        raise RuntimeError(f'{req.get_method()} {route}: unexpected HTTP {response.status}.')
                    if payload is not None and response.status == 200 and response.headers.get('Idempotency-Replayed') != 'true':
                        raise RuntimeError('Ingestion returned HTTP 200 without confirming an idempotent replay.')
                    return json.load(response)['data']
            except urllib.error.HTTPError as error:
                status = error.code
                retry_after = error.headers.get('Retry-After', '10')
                error.close()
                if status not in (408, 429) and not 500 <= status <= 599:
                    raise RuntimeError(f'{req.get_method()} {route}: HTTP {status}; not retrying.') from None
                reason = f'HTTP {status}'
                if status == 429:
                    try:
                        delay = max(10, float(retry_after))
                    except ValueError:
                        delay = 10
                    if not math.isfinite(delay) or delay > 30:
                        raise RuntimeError('Rate-limit retry delay exceeds the demo retry budget.') from None
            except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException):
                reason = 'local connection failure'
            if attempt == 3 or (until is not None and time.monotonic() + delay >= until):
                raise RuntimeError(f'{req.get_method()} {route}: {reason}; retry budget exhausted.')
            print(f'  {reason}; retrying the same observation/request in {delay:g}s ({attempt + 2}/4).', flush=True)
            time.sleep(delay)

    def state(total, errors, until=None):
        metrics = request('/api/metrics', until=until)
        incidents = request('/api/incidents?limit=100', until=until)
        actual = metrics['events']
        if actual['total'] != total or actual['serverErrors'] != errors:
            raise RuntimeError(
                f'Persisted counts mismatch: expected {total} events/{errors} errors; '
                f'observed {actual["total"]}/{actual["serverErrors"]}.'
            )
        print(
            f'  Observed API: {actual["total"]} events, {actual["serverErrors"]} HTTP 5xx '
            f'({100 * errors / total if total else 0:.2f}%), {len(incidents)} incidents.',
            flush=True,
        )
        if total < 26 and (incidents or metrics['incidents']['total'] != 0):
            raise RuntimeError('An incident exists before the threshold-crossing observation.')
        return incidents

    print(f'\nStreaming GET {path}. All observations use POST /api/events.', flush=True)
    state(0, 0)
    print('Open the dashboard now; streaming starts in 10s. Use Refresh data at each pause.', flush=True)
    time.sleep(10)
    # The detector uses minute buckets: a span below four minutes guarantees all
    # samples fit in five buckets, even when the first arrives at a minute end.
    deadline = time.monotonic() + 210
    for phase, count, status, expected_errors in [(1, 20, 200, 0), (2, 5, 503, 5), (3, 1, 503, 6)]:
        print(f'Phase {phase}/3: sending {count} HTTP {status} observations.', flush=True)
        for _ in range(count):
            if observations:
                time.sleep(1.2)
            payload = {
                'method': 'GET',
                'path': path,
                'status': status,
                'latencyMs': 100 if status == 200 else 500,
                'clientId': 'synthetic-stream',
            }
            key = f'stream-{path.rsplit("/", 1)[1]}-{len(observations) + 1}'
            event = request('/api/events', payload, key, deadline)
            if any(event.get(field) != value for field, value in payload.items()):
                raise RuntimeError('The ingestion response does not match the submitted observation.')
            if not event.get('id') or any(old['id'] == event['id'] for old in observations):
                raise RuntimeError('Ingestion returned a missing or duplicate observation ID.')
            observations.append(event)
            if event['createdAt'] // 60000 - observations[0]['createdAt'] // 60000 >= 5:
                raise RuntimeError('The observations no longer fit in the five-minute detection window; restart the demo.')
            errors = sum(item['status'] >= 500 for item in observations)
            print(
                f'  Ingested {len(observations)}/26; expected HTTP 5xx rate {errors}/{len(observations)} '
                f'= {100 * errors / len(observations):.2f}%.',
                flush=True,
            )
        incidents = state(len(observations), expected_errors, deadline)
        if phase < 3:
            print('Phase verified. Refresh the dashboard; continuing in 8s.', flush=True)
            time.sleep(8)
            # Recheck after allowing the queue to consume the preceding phase.
            state(len(observations), expected_errors, deadline)

    print('Waiting up to 30s for the queue-created incident…', flush=True)
    until = time.monotonic() + 30
    while not incidents:
        time.sleep(1)
        incidents = request('/api/incidents?limit=100', until=until)
    if len(incidents) != 1:
        raise RuntimeError(f'Expected exactly one incident; observed {len(incidents)}.')
    incident = incidents[0]
    expected = {
        'rule': 'endpoint_5xx_rate_v2',
        'severity': 'high',
        'method': 'GET',
        'path': path,
        'totalRequests': 26,
        'serverErrors': 6,
        'minRequests': 20,
        'minFailures': 5,
        'openPercent': 20,
        'windowStartMs': (observations[-1]['createdAt'] // 60000 - 4) * 60000,
        'windowEndExclusiveMs': (observations[-1]['createdAt'] // 60000 + 1) * 60000,
    }
    evidence = incident.get('evidence') or {}
    for field, value in expected.items():
        if evidence.get(field) != value:
            raise RuntimeError(f'Opening evidence {field}: expected {value!r}, observed {evidence.get(field)!r}.')
    for field, value in [('errorPercent', 100 * 6 / 26), ('averageLatencyMs', (20 * 100 + 6 * 500) / 26)]:
        if not isinstance(evidence.get(field), (int, float)) or not math.isclose(evidence[field], value):
            raise RuntimeError(f'Opening evidence {field}: expected {value}, observed {evidence.get(field)!r}.')
    if (
        incident['severity'] != 'high'
        or incident['eventId'] != observations[-1]['id']
        or incident['eventMethod'] != 'GET'
        or incident['eventPath'] != path
    ):
        raise RuntimeError('The incident does not match the HIGH threshold-crossing observation.')
    state(26, 6, until)
    print(
        f'Verified incident {incident["id"]}: HIGH, opening evidence 6/26 HTTP 5xx '
        f'({evidence["errorPercent"]:.2f}%).\n'
        'Demo complete. Refresh, inspect the evidence, resolve/filter/reopen the incident.\n'
        'The dashboard stays available until Ctrl+C.',
        flush=True,
    )


def main():
    LIVE = sys.argv[1:] == ['--live']
    STREAM = sys.argv[1:] == ['--stream']
    if sys.argv[1:] and not (LIVE or STREAM):
        sys.exit('Usage: python3 demo/run.py [--live | --stream]')
    PORT = 8793 if LIVE else 8792
    URL = f'http://127.0.0.1:{PORT}'
    # Fail before applying migrations or seeding data.
    ensure_port_free(PORT)
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='edgeguard-demo-') as directory:
        base = Path(directory)
        config = json.loads((ROOT / 'wrangler.test.jsonc').read_text())
        config.pop('$schema')
        config['main'] = str(ROOT / ('src/index.ts' if LIVE else 'demo/worker.ts'))
        config['d1_databases'][0]['migrations_dir'] = str(ROOT / 'migrations')
        config['secrets']['required'].append('DASHBOARD_PASSWORD')
        if LIVE:
            config.update(
                ai={'binding': 'AI', 'remote': True},
                vars={**config['vars'], 'AI_GATEWAY_ID': os.getenv('AI_GATEWAY_ID', 'default')},
            )
        credentials = {key: secrets.token_hex(24) for key in config['secrets']['required']}
        (base / '.dev.vars').write_text(''.join(f'{k}={v}\n' for k, v in credentials.items()))
        settings = base / 'wrangler.json'
        settings.write_text(json.dumps(config))
        common = ['--config', str(settings), '--persist-to', str(base / 'state')]
        child_env = os.environ.copy()
        if STREAM:
            # Keep the offline run independent of account credentials and CLI telemetry.
            child_env = {
                key: value for key, value in child_env.items()
                if not key.startswith(('CLOUDFLARE_', 'CF_', 'WRANGLER_'))
            }
            child_env.update(
                WRANGLER_SEND_METRICS='false',
                WRANGLER_HIDE_BANNER='true',
                XDG_CONFIG_HOME=str(base / 'config'),
                WRANGLER_LOG_PATH=str(base / 'wrangler.log'),
                CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV='false',
            )

        def wrangler(*args):
            subprocess.run([CLI, *args, *common], cwd=base, env=child_env, check=True)

        wrangler('d1', 'migrations', 'apply', 'edgeguard-db', '--local')
        examples = []
        if not STREAM:
            # A deterministic shape relative to the current hour, including empty buckets.
            counts = [2, 0, 1, 3, 0, 5, 3, 2, 0, 4, 7, 2, 1, 0, 3, 4, 6, 2, 1, 0, 2, 4, 3, 1]
            hour = int(time.time() // 3600) * 3600000
            rows = []
            for i, count in enumerate(counts):
                for j in range(count):
                    ts = hour - (23 - i) * 3600000
                    rows.append(f"('synthetic-{i}-{j}',{ts},'GET','/synthetic/health',200,{65+i},'synthetic-demo',{ts},'sent')")
            # Nineteen samples per endpoint keep the detector below its minimum sample.
            # The final request goes through the authenticated API and the real queue.
            if LIVE:
                examples = [('checkout', 503, 6100, 12)]
            else:
                examples = [
                    ('catalog', 500, 90, 4),
                    ('search', 502, 400, 6),
                    ('checkout', 503, 6100, 12),
                ]
            now = int(time.time() * 1000)
            for path, status, latency, failures in examples:
                for i in range(19):
                    sample_status = status if i < failures else 200
                    rows.append(
                        f"('warmup-{path}-{i}',{now},'GET','/synthetic/{path}',"
                        f"{sample_status},{latency},'synthetic-demo',{now},'sent')"
                    )
            seed = base / 'seed.sql'
            seed.write_text(
                'INSERT INTO events (id,occurred_at,method,path,status,latency_ms,'
                'client_id,created_at,queue_status) VALUES ' + ','.join(rows) + ';'
            )
            wrangler('d1', 'execute', 'edgeguard-db', '--local', '--file', str(seed))
        # Recheck in case the port was taken while migrations were running.
        ensure_port_free(PORT)
        local = ['--local'] if STREAM else []
        proc = subprocess.Popen(
            [CLI, 'dev', *local, '--ip', '127.0.0.1', '--port', str(PORT), *common],
            cwd=base,
            env=child_env,
            start_new_session=True,
        )

        def interrupted(signum, frame):
            raise KeyboardInterrupt

        signal.signal(signal.SIGTERM, interrupted)
        try:
            for _ in range(120):
                if proc.poll() is not None:
                    sys.exit('Wrangler exited before startup.')
                try:
                    with HTTP.open(URL + '/health', timeout=1) as res:
                        if json.load(res)['status'] == 'ok':
                            break
                except OSError:
                    time.sleep(0.5)
            else:
                sys.exit('Local Worker did not become ready.')
            for path, status, latency, _ in examples:
                payload = {
                    'method': 'GET',
                    'path': '/synthetic/' + path,
                    'status': status,
                    'latencyMs': latency,
                    'clientId': 'synthetic-demo',
                }
                data = json.dumps(payload).encode()
                headers = {
                    'Authorization': 'Bearer ' + credentials['INGEST_API_TOKEN'],
                    'Content-Type': 'application/json',
                }
                with HTTP.open(urllib.request.Request(URL + '/api/events', data, headers)) as res:
                    assert res.status == 201
            print(
                f'\nDashboard: {URL}/dashboard\n'
                f'Temporary dashboard password: {credentials["DASHBOARD_PASSWORD"]}\n'
                'Press Ctrl+C to discard the demo.',
                flush=True,
            )
            if STREAM:
                run_stream(URL, credentials)
            proc.wait()
        except KeyboardInterrupt:
            pass
        except (RuntimeError, ValueError, KeyError, TypeError, OSError) as error:
            sys.exit(f'Demo failed: {error}')
        finally:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()


if __name__ == '__main__':
    main()
