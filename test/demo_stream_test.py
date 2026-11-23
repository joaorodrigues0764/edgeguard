"""Offline launcher contract checks; real detection is verified by the local demo."""

import contextlib
import io
import json
import socket
import unittest
import urllib.error
from unittest.mock import patch

from demo.run import ensure_port_free, run_stream


class Response(io.BytesIO):
    def __init__(self, data, status=200, replay=False):
        super().__init__(json.dumps({'data': data}).encode())
        self.status = status
        self.headers = {'Idempotency-Replayed': 'true'} if replay else {}


class LocalAPI:
    def __init__(self, fault=None):
        self.fault = fault
        self.elapsed = 0
        self.events = {}
        self.keys = []

    def sleep(self, seconds):
        self.elapsed += seconds

    def open(self, request, timeout):
        if request.get_method() == 'POST':
            key = request.get_header('Idempotency-key')
            self.keys.append(key)
            if self.fault == 'unavailable' or (self.fault == 'rate_limit' and len(self.keys) == 1):
                status = 429 if self.fault == 'rate_limit' else 503
                raise urllib.error.HTTPError(request.full_url, status, 'test response', {'Retry-After': '10'}, None)
            payload = json.loads(request.data)
            replay = key in self.events
            if not replay:
                self.events[key] = {
                    **payload,
                    'id': str(len(self.events) + 1),
                    'createdAt': 6_000_000 + int(self.elapsed * 1000),
                }
            if self.fault == 'lost_response' and len(self.keys) == 1:
                raise urllib.error.URLError('response lost after persistence')
            return Response(self.events[key], 200 if replay else 201, replay)

        count = len(self.events)
        incidents = []
        if count == 26:
            last = list(self.events.values())[-1]
            incidents = [{
                'id': 'test-incident',
                'eventId': last['id'],
                'eventMethod': 'GET',
                'eventPath': last['path'],
                'severity': 'high',
                'evidence': {
                    'rule': 'endpoint_5xx_rate_v2',
                    'severity': 'high',
                    'method': 'GET',
                    'path': last['path'],
                    'totalRequests': 26,
                    'serverErrors': 6,
                    'minRequests': 20,
                    'minFailures': 5,
                    'openPercent': 20,
                    'windowStartMs': (last['createdAt'] // 60000 - 4) * 60000,
                    'windowEndExclusiveMs': (last['createdAt'] // 60000 + 1) * 60000,
                    'errorPercent': 100 * 6 / 26,
                    'averageLatencyMs': 5000 / 26,
                },
            }]
            if self.fault == 'wrong_evidence':
                incidents[0]['evidence']['serverErrors'] = 5
            if self.fault == 'queue_timeout':
                incidents = []
            if self.fault == 'duplicate_incident':
                incidents *= 2
        if count == 25 and self.fault == 'early_incident':
            incidents = [{'id': 'unexpected'}]
        if '/api/metrics' in request.full_url:
            return Response({
                'events': {'total': count, 'serverErrors': max(0, count - 20)},
                'incidents': {'total': len(incidents)},
            })
        return Response(incidents)


class StreamTests(unittest.TestCase):
    def run_scenario(self, api):
        with (
            patch('demo.run.HTTP.open', side_effect=api.open),
            patch('demo.run.time.sleep', side_effect=api.sleep),
            patch('demo.run.time.monotonic', side_effect=lambda: api.elapsed),
            contextlib.redirect_stdout(io.StringIO()) as output,
        ):
            run_stream('http://127.0.0.1:8792', {
                'INGEST_API_TOKEN': 'test-ingest',
                'DASHBOARD_API_TOKEN': 'test-dashboard',
            })
        return output.getvalue()

    def test_phases_and_pacing(self):
        api = LocalAPI()

        output = self.run_scenario(api)

        self.assertEqual([event['status'] for event in api.events.values()], [200] * 20 + [503] * 6)
        self.assertEqual(len(set(api.keys)), 26)
        self.assertIn('25 events, 5 HTTP 5xx (20.00%), 0 incidents', output)
        self.assertIn('Verified incident', output)
        self.assertGreaterEqual(api.elapsed, 10 + 25 * 1.2 + 16)

    def test_retry_after_lost_response_reuses_key_without_duplicate(self):
        api = LocalAPI('lost_response')

        self.run_scenario(api)

        self.assertEqual(api.keys[0], api.keys[1])
        self.assertEqual(len(api.keys), 27)
        self.assertEqual(len(api.events), 26)

    def test_rate_limit_retries_same_observation_after_waiting(self):
        api = LocalAPI('rate_limit')

        self.run_scenario(api)

        self.assertEqual(api.keys[0], api.keys[1])
        self.assertEqual(len(api.events), 26)
        self.assertGreaterEqual(api.elapsed, 66)

    def test_transient_retry_budget_is_bounded(self):
        api = LocalAPI('unavailable')

        with self.assertRaisesRegex(RuntimeError, 'retry budget exhausted'):
            self.run_scenario(api)

        self.assertEqual(len(api.keys), 4)
        self.assertEqual(len(set(api.keys)), 1)
        self.assertEqual(len(api.events), 0)

    def test_rejects_early_incident(self):
        api = LocalAPI('early_incident')

        with self.assertRaisesRegex(RuntimeError, 'before the threshold'):
            self.run_scenario(api)

        self.assertEqual(len(api.events), 25)

    def test_rejects_wrong_opening_evidence(self):
        with self.assertRaisesRegex(RuntimeError, 'Opening evidence serverErrors'):
            self.run_scenario(LocalAPI('wrong_evidence'))

    def test_rejects_multiple_incidents(self):
        with self.assertRaisesRegex(RuntimeError, 'exactly one incident'):
            self.run_scenario(LocalAPI('duplicate_incident'))

    def test_queue_polling_times_out(self):
        api = LocalAPI('queue_timeout')

        with self.assertRaisesRegex(RuntimeError, 'deadline exceeded'):
            self.run_scenario(api)

        self.assertLess(api.elapsed, 90)


class PortCheckTest(unittest.TestCase):
    def test_accepts_free_port(self):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]

        ensure_port_free(port)

    def test_exits_with_message_when_port_is_in_use(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            port = listener.getsockname()[1]

            with self.assertRaises(SystemExit) as raised:
                ensure_port_free(port)

        self.assertIn(f'Port {port} on 127.0.0.1 is unavailable', str(raised.exception.code))


if __name__ == '__main__':
    unittest.main()
