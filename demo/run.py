"""Start an isolated, disposable portfolio demo from the project root."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'node_modules/.bin/wrangler'
LIVE = sys.argv[1:] == ['--live']
if sys.argv[1:] and not LIVE:
    sys.exit('Usage: python3 demo/run.py [--live]')
PORT = 8793 if LIVE else 8792
URL = f'http://127.0.0.1:{PORT}'
os.umask(0o077)
with tempfile.TemporaryDirectory(prefix='edgeguard-demo-') as directory:
    base = Path(directory)
    config = json.loads((ROOT / 'wrangler.test.jsonc').read_text())
    config.pop('$schema')
    config['main'] = str(ROOT / ('src/index.ts' if LIVE else 'demo/worker.ts'))
    config['d1_databases'][0]['migrations_dir'] = str(ROOT / 'migrations')
    config['secrets']['required'].append('DASHBOARD_PASSWORD')
    if LIVE:
        config.update(ai={'binding': 'AI', 'remote': True}, vars={'AI_GATEWAY_ID': os.getenv('AI_GATEWAY_ID', 'default')})
    credentials = {key: secrets.token_hex(24) for key in config['secrets']['required']}
    (base / '.dev.vars').write_text(''.join(f'{k}={v}\n' for k, v in credentials.items()))
    settings = base / 'wrangler.json'
    settings.write_text(json.dumps(config))
    common = ['--config', str(settings), '--persist-to', str(base / 'state')]
    def wrangler(*args):
        subprocess.run([CLI, *args, *common], cwd=base, check=True)
    wrangler('d1', 'migrations', 'apply', 'edgeguard-db', '--local')
    # A deterministic shape relative to the current hour, including empty buckets.
    counts = [2, 0, 1, 3, 0, 5, 3, 2, 0, 4, 7, 2, 1, 0, 3, 4, 6, 2, 1, 0, 2, 4, 3, 1]
    hour = int(time.time() // 3600) * 3600000
    rows = []
    for i, count in enumerate(counts):
        for j in range(count):
            ts = hour - (23 - i) * 3600000
            rows.append(f"('synthetic-{i}-{j}',{ts},'GET','/synthetic/health',200,{65+i},'synthetic-demo',{ts},'sent')")
    seed = base / 'seed.sql'
    seed.write_text('INSERT INTO events (id,occurred_at,method,path,status,latency_ms,client_id,created_at,queue_status) VALUES ' + ','.join(rows) + ';')
    wrangler('d1', 'execute', 'edgeguard-db', '--local', '--file', str(seed))
    # Check the port before sending any requests to it.
    import socket
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', PORT))
    proc = subprocess.Popen([CLI, 'dev', '--ip', '127.0.0.1', '--port', str(PORT), *common], cwd=base)
    try:
        for _ in range(120):
            if proc.poll() is not None:
                sys.exit('Wrangler exited before startup.')
            try:
                with urllib.request.urlopen(URL + '/health', timeout=1) as res:
                    if json.load(res)['status'] == 'ok':
                        break
            except OSError:
                time.sleep(0.5)
        else:
            sys.exit('Local Worker did not become ready.')
        examples = [('checkout', 503, 6100)] if LIVE else [('quota', 429, 90), ('search', 502, 400), ('checkout', 503, 6100)]
        for path, status, latency in examples:
            data = json.dumps(dict(method='GET', path='/synthetic/' + path, status=status, latencyMs=latency, clientId='synthetic-demo')).encode()
            headers = {'Authorization': 'Bearer ' + credentials['INGEST_API_TOKEN'], 'Content-Type': 'application/json'}
            with urllib.request.urlopen(urllib.request.Request(URL + '/api/events', data, headers)) as res:
                assert res.status == 201
        print(f'\nDashboard: {URL}/dashboard\nTemporary dashboard password: {credentials["DASHBOARD_PASSWORD"]}\nPress Ctrl+C to discard the demo.', flush=True)
        proc.wait()
    except KeyboardInterrupt:
        pass
    finally:
        if proc.poll() is None:
            proc.terminate()
        proc.wait()
