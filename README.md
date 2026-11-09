# EdgeGuard

**An edge-native event monitoring and incident detection API built on Cloudflare Workers.**

EdgeGuard ingests application events, detects anomalous behaviour, creates incidents, and exposes operational metrics through an authenticated API. It uses Cloudflare's developer platform to demonstrate event-driven architecture, serverless data processing, observability, and role-based access control.

## Try the synthetic demo

From a clean checkout, install Node.js (verified with 26), npm and Python 3, then run:

```bash
npm ci
npm run demo
```

Open the loopback dashboard URL printed in the terminal and use its temporary password. The demo runs without a Cloudflare account or a project `.dev.vars`. Each run migrates a fresh temporary D1 database, seeds healthy hourly history and 19 recent observations per demo endpoint, then sends the twentieth request for each spike through the actual ingestion and queue paths. Refresh after the queue processes the batch. Select **GET /synthetic/checkout**, inspect its analysis, mark it resolved and use the status filter to find and reopen it. Ctrl+C discards the demo state. The chart is relative to the current hour; IDs, timestamps and the temporary password change each run.

The demo uses a deterministic **fixture** instead of a hosted model. The banner and synthetic paths identify the sample data. For one real inference without deploying, follow the [live smoke test](docs/live-smoke.md).

The screenshots below show the earlier per-event detector. The current detail panel also shows the opening window.

![English operations dashboard displaying synthetic hourly activity and three incidents](docs/images/dashboard-overview.png)

![Selected synthetic checkout incident with its rule, sample hypotheses and suggested checks](docs/images/incident-detail.png)

## Features

- **Event ingestion:** validate and store application events using Cloudflare Workers and D1.
- **Asynchronous processing:** publish events to Cloudflare Queues and analyse them in a queue consumer.
- **Delivery recovery:** a scheduled job republishes pending events. A dead-letter queue retains messages that exhaust consumer retries for operator review.
- **Anomaly detection:** detect sustained endpoint 5xx spikes with configurable sample and recovery thresholds.
- **Incident management:** create incidents with severity levels, group sustained failures into one incident per episode, and update incident status.
- **Operational metrics:** calculate event counts, server-error counts, rate-limited responses, average latency, and incident statistics.
- **Time-series metrics:** aggregate event data into hourly buckets, including intervals with no events.
- **Request rate limiting:** protect event ingestion with Cloudflare's Rate Limiting API.
- **Telemetry:** send event and rate-limited ingestion telemetry to Cloudflare Analytics Engine.
- **Telemetry queries:** retrieve sampled telemetry aggregates through the Analytics SQL binding.
- **API authentication:** use Bearer tokens with separate ingestion, dashboard, and administrator permissions.
- **Automated tests:** validate API behaviour, anomaly detection, queue processing, telemetry mapping, metrics, and access control.

## Architecture

```mermaid
flowchart TD
    Client[Event reporter] -->|Ingest token| Worker[Worker API]
    Worker -->|Persist event and evaluate endpoint window atomically| D1[(D1)]
    Worker -->|Event ID| Queue[Cloudflare Queues]
    Cron[Scheduled recovery] -->|Republish pending events| Queue
    Queue --> Consumer[Event consumer]
    Queue -->|Consumer retries exhausted| DLQ[edgeguard-events-dlq]
    Consumer -->|Materialise recorded opening as incident| D1
    Consumer -->|Claim analysis in D1| Analysis[Analysis worker code]
    Analysis -->|Incident evidence| Gateway[AI Gateway]
    Gateway --> Model[Workers AI]
    Model --> Validate[Server schema validation]
    Validate -->|Store result or mark failed| D1
    Browser[Operator dashboard] -->|Signed session| Worker
    Worker -->|Scoped reads, status updates and retries| D1
    Worker --> Analytics[Analytics Engine]
```

### Event processing

1. A client submits an event to the ingestion endpoint.
2. The Worker validates the request and stores the event in D1. An insert trigger updates the endpoint window and saves evidence when a new episode opens.
3. The Worker records telemetry and publishes a message to a Cloudflare Queue.
4. The queue consumer looks up the event and its opening snapshot by ID.
5. An opening creates one incident linked to that event. Other events in the same episode still contribute to metrics.
6. When AI is configured, the consumer claims an analysis attempt, calls Workers AI through AI Gateway and validates the result against a strict schema before storing it. Provider and validation failures mark only the analysis as failed.
7. Clients with the appropriate permissions can query events, inspect incidents, and retrieve metrics.

### Endpoint error detection

Migration `0006_endpoint_error_windows.sql` installs one deterministic rule, `endpoint_5xx_rate_v2`. Its defaults are:

| Decision         | Condition                                                                               |
| ---------------- | --------------------------------------------------------------------------------------- |
| Open an episode  | At least 20 requests, at least 5 HTTP 5xx, and strictly more than 20% 5xx in the window |
| Opening severity | Critical at 50% 5xx or above, high otherwise                                            |
| Rearm the rule   | At least 20 requests with a 5xx rate at or below 10%                                    |
| Window           | Current UTC minute and four preceding minutes                                           |

For example, 5 errors in 20 requests open a high-severity incident. Five in 25 sit exactly on the threshold. The lower recovery threshold prevents a rate oscillating around 20% from splitting one incident. An idle endpoint stays in its last state until sufficient traffic demonstrates recovery. Operators can resolve or reopen an incident independently.

**Window calculation.** On every successful event insert, D1 increments the count, 5xx count and latency sum for the exact HTTP method, reported path and server-assigned ingestion minute. It drops expired buckets for that endpoint, then sums the retained counts. Average latency is the sum of all latencies divided by the total request count. Thresholds use integer cross-multiplication. The composite primary key `(method, path, minute)` bounds the aggregate to five rows at the defaults. The window advances by whole minutes and the current minute is partial. At 12:04:30 UTC, the snapshot covers requests ingested so far in the interval [12:00, 12:05). Overlapping windows are evaluated on each insert.

**Concurrency and recovery.** In the same SQLite statement as the event insert, the trigger records the opening event ID and an immutable JSON snapshot. A partial unique index permits one active episode per method and path for this rule. Replaying an ingestion idempotency key inserts no row and fires no trigger. The consumer can materialise openings in any order. The existing unique constraint on `incidents.event_id` protects concurrent deliveries of the opening event, including after a later episode has opened. Detection storage errors roll back ingestion. A failed queue-side D1 operation follows the existing per-message retry and DLQ path. [D1 concurrency](https://developers.cloudflare.com/d1/platform/limits/#concurrency-and-throughput) · [SQLite trigger semantics](https://www.sqlite.org/lang_createtrigger.html) · [Queue ordering](https://developers.cloudflare.com/queues/reference/how-queues-works/)

**Timestamps.** Reporters supply status and latency. The service assigns `created_at` before insertion. The newest committed minute for an endpoint anchors its window. An out-of-order insert inside that window contributes at its original minute. An older insert remains in the raw event log and metrics but falls outside detection. Late queue delivery can delay incident creation and AI analysis. Its evidence still describes the original opening.

**Configuration and cost.** The single row in `anomaly_policy` configures window length (1–60 minutes), minimum requests, minimum failures, opening percentage and recovery percentage. For example:

```sql
UPDATE anomaly_policy
SET window_minutes = 10, min_requests = 40, min_failures = 8,
    open_percent = 20, recover_percent = 10
WHERE id = 1;
```

Changes take effect on the next insert for each endpoint. Increasing the window requires fresh traffic to fill previously expired minutes. The trigger adds synchronous writes to ingestion. Dormant endpoints retain their last buckets, and raw paths with IDs or query strings create distinct groups. For this MVP, HTTP 429 and slow requests contribute to metrics and the latency summary. Standalone latency alerts, p95 and historical baselines are deferred. Exact p95 needs information beyond counts and sums, and baseline comparisons need representative endpoint history.

**Migration boundary.** Detection starts with inserts after migration 0006. Historical events are available to existing APIs and metrics, and historical incidents retain their analysis and operator status. Their window evidence is null. A previously queued event without an opening or an existing incident is acknowledged. For a coordinated upgrade, drain the legacy consumer and pause ingestion across the migration and Worker cutover to avoid applying the previous per-event rules to new traffic.

### Queue delivery

A Cron Trigger runs every minute and republishes up to 50 pending events that are at least one minute old, including events submitted without an idempotency key. Events are marked as sent only after the queue confirms publication. A crash between publication and the database update may cause duplicate delivery; the consumer's unique event constraint prevents duplicate incidents.

`queue_status = 'sent'` records successful publication. Once the message is in the queue, the consumer decides the outcome for each message in the batch.

| Consumer outcome | What happens |
|---|---|
| Malformed message or event ID absent from D1 after a successful lookup | Log a warning and acknowledge. The producer persists the event before publishing its ID. |
| Healthy event or successfully handled anomaly | Acknowledge. Redelivery reuses the incident for that event and skips a completed analysis. |
| AI provider error, timeout or invalid response | Store the failed analysis and acknowledge. An administrator can retry the analysis on the same incident. |
| D1 read or write throws, including while saving an analysis result | Retry the affected message. The 60-second retry delay gives an interrupted analysis claim time to expire. A new attempt may repeat the inference. |
| Processing still fails after the initial delivery and three retries | Cloudflare routes the message to `edgeguard-events-dlq` for inspection and manual recovery. |

## Technology stack

| Technology | Purpose |
|---|---|
| TypeScript | Application and API implementation |
| Cloudflare Workers | Serverless API and queue consumer |
| Cloudflare D1 | Event and incident persistence |
| Cloudflare Queues | Asynchronous event processing |
| Cloudflare Analytics Engine | Event and rate-limited ingestion telemetry |
| Cloudflare Rate Limiting | Protect event ingestion |
| Wrangler | Local development and Cloudflare configuration |
| Vitest | Automated tests |

## API reference

All protected endpoints require a Bearer token. Health and dashboard sign-in assets are public; dashboard data requires a session.

| Method | Endpoint | Permission |
|---|---|---|
| `GET` | `/health` | Public |
| `POST` | `/api/events` | Ingestion |
| `GET` | `/api/events?limit=20` | Dashboard or administrator |
| `GET` | `/api/incidents?limit=20` | Dashboard or administrator |
| `PATCH` | `/api/incidents/:id` | Administrator |
| `POST` | `/api/incidents/:id/analysis/retry` | Administrator; failed or expired attempt only |
| `GET` | `/api/metrics` | Dashboard or administrator |
| `GET` | `/api/metrics/timeseries?hours=24` | Dashboard or administrator |
| `GET` | `/api/metrics/telemetry?hours=24` | Dashboard or administrator |

### Authentication

Send the token in the `Authorization` header:

```http
Authorization: Bearer YOUR_API_TOKEN
```

The API uses three independently configured tokens:

| Secret | Access |
|---|---|
| `INGEST_API_TOKEN` | Submit events |
| `DASHBOARD_API_TOKEN` | Read events, incidents, and metrics |
| `ADMIN_API_TOKEN` | Read operational data and update incident status |

A request without valid credentials returns `401 Unauthorized`. A valid token without permission for the requested endpoint returns `403 Forbidden`.

### Health check

```bash
curl http://localhost:8787/health
```

Returns the service status and a timestamp.

### Submit an event

```bash
curl -X POST http://localhost:8787/api/events \
  -H "Authorization: Bearer YOUR_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "method": "GET",
    "path": "/api/products",
    "status": 500,
    "latencyMs": 892,
    "clientId": "example-client"
  }'
```

The event payload contains:

| Field | Description |
|---|---|
| `method` | HTTP method |
| `path` | Application request path |
| `status` | HTTP status code, from 100 to 599 |
| `latencyMs` | Request latency in milliseconds |
| `clientId` | Optional client identifier |

Successful ingestion returns `201 Created`. Invalid JSON or an invalid payload returns `400 Bad Request`.

Both JSON write endpoints (`POST /api/events` and `PATCH /api/incidents/:id`) accept bodies up to 64 KiB (65,536 bytes). Larger bodies return `413 Content Too Large`, including streamed requests without a `Content-Length` header.

For safe retries, send an optional `Idempotency-Key` header containing 1 to 128 letters, numbers, dots, underscores, colons, or hyphens. Repeating a key with the same normalized payload returns the original event with `200 OK` and `Idempotency-Replayed: true`; reusing it with a different payload returns `409 Conflict`. If queue publication fails, the API returns `500` while retaining the event for a client retry or scheduled recovery. A retry without a key can create a second event.

### List events

```bash
curl "http://localhost:8787/api/events?limit=20" \
  -H "Authorization: Bearer YOUR_DASHBOARD_TOKEN"
```

The optional `limit` parameter accepts integers from 1 to 100 and defaults to 20.

### List incidents

```bash
curl "http://localhost:8787/api/incidents?severity=critical&status=open&limit=10" \
  -H "Authorization: Bearer YOUR_DASHBOARD_TOKEN"
```

Supported severity values are `medium`, `high`, and `critical`. Supported status values are `open` and `resolved`. Both filters are optional.

The response includes incident information, the triggering event details and an additive `evidence` field. For v2 openings it contains the rule, endpoint, severity, UTC window bounds in Unix milliseconds, sample and failure counts, error percentage, mean latency and configured opening thresholds. Earlier incidents return `evidence: null`.

### Update incident status

```bash
curl -X PATCH http://localhost:8787/api/incidents/YOUR_INCIDENT_ID \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"resolved"}'
```

The supported status values are `open` and `resolved`. Successful updates return the updated incident. An unknown incident ID returns `404 Not Found`.

### Dashboard metrics

```bash
curl http://localhost:8787/api/metrics \
  -H "Authorization: Bearer YOUR_DASHBOARD_TOKEN"
```

The response includes event totals, server-error counts, rate-limited responses, average latency, incident counts, and counts grouped by severity and status.

### Hourly time-series metrics

```bash
curl "http://localhost:8787/api/metrics/timeseries?hours=24" \
  -H "Authorization: Bearer YOUR_DASHBOARD_TOKEN"
```

The `hours` parameter accepts integers from 1 to 168 and defaults to 24. The response contains hourly buckets ordered by timestamp, including buckets with no events.

### Analytics Engine telemetry metrics

```bash
curl "http://localhost:8787/api/metrics/telemetry?hours=24" \
  -H "Authorization: Bearer YOUR_DASHBOARD_TOKEN"
```

The `hours` parameter accepts integers from 1 to 168 and defaults to 24. The response separates observed application events from requests rejected by the ingestion rate limiter, and includes the queried UTC time range. Analytics SQL applies sampling weights automatically, so these aggregates are estimates and may differ from the D1 totals. A failed upstream query returns `502 Bad Gateway`.

The Analytics SQL binding queries Cloudflare-hosted data and requires the account's Analytics Engine entitlement. The automated tests use a stub for this binding and do not validate a live query. The dedicated `wrangler.test.jsonc` omits the SQL binding to keep tests offline; the production configuration includes it.

## Local development

### Prerequisites

- Node.js and npm
- A local checkout of the project

### 1. Install dependencies

```bash
npm ci
```

### 2. Configure local secrets

Copy the example file:

```bash
cp .dev.vars.example .dev.vars
```

Replace all placeholder values in `.dev.vars` with independent, randomly generated tokens. You can generate each token with:

```bash
openssl rand -hex 32
```

Do not commit `.dev.vars` or share its contents.

### 3. Apply local D1 migrations

```bash
npx wrangler d1 migrations apply edgeguard-db --local
```

### 4. Start the development server

```bash
npm run dev
```

The main Wrangler configuration includes a remote Workers AI binding and requires Cloudflare authentication. For an account-free local run, use `npm run demo`.

The examples above assume the default local Worker address, `http://localhost:8787`.

## Testing

Run the complete test suite:

```bash
npm test -- --run
```

Check TypeScript compilation:

```bash
npx tsc --noEmit
npm run typecheck:test
```

The tests cover API endpoints, event validation, anomaly detection, queue processing, incident lifecycle operations, telemetry data-point mapping, rate limiting, dashboard metrics, time-series aggregation, and authorization.

The test environment uses dedicated test tokens rather than real development or production credentials.

## Configuration and deployment

The `wrangler.jsonc` file defines the Worker's resource bindings and required secret names. The generated `worker-configuration.d.ts` provides TypeScript types for the configured environment.

For Cloudflare deployment, configure the required resources and set each production token as a Cloudflare Worker secret. For example:

```bash
npx wrangler secret put INGEST_API_TOKEN
npx wrangler secret put DASHBOARD_API_TOKEN
npx wrangler secret put ADMIN_API_TOKEN
```

Provide each secret value interactively. Production secrets must be generated and managed separately from local development tokens.

Apply D1 migrations before deploying the Worker, including the index used by pending delivery recovery:

```bash
npx wrangler d1 migrations apply edgeguard-db --remote
npm run deploy
```

Deployment also installs the configured Cron Trigger. Scheduled recovery can be exercised locally with `npx wrangler dev --test-scheduled` and `curl 'http://localhost:8787/cdn-cgi/handler/scheduled'`.

A successful local test run does not by itself establish that the production resources have been configured or that the Worker has been deployed.

### Dead-letter queue operations

The consumer configuration names `edgeguard-events-dlq` as the destination for exhausted messages. At deployment, Cloudflare can create it in the same jurisdiction as `edgeguard-events`. If provisioning it separately, create a queue with that exact name in the source queue's jurisdiction. Leave it without an automatic consumer. After deployment, verify the DLQ destination and retry settings on the source consumer and check the retention period on the DLQ. Messages expire at the end of that period. [Cloudflare DLQ configuration](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/) · [Queue limits and retention](https://developers.cloudflare.com/queues/platform/limits/)

1. In the Cloudflare dashboard, select **Queues → edgeguard-events-dlq → Messages → List**. Correlate the event ID with the Worker error logs and the D1 event and incident. Inspect messages before retention expires. [Preview messages](https://developers.cloudflare.com/queues/examples/list-messages-from-dash/)
2. Correct the processing failure. For a valid event that still needs processing, send `{"type":"event.received","eventId":"<original D1 event ID>"}` as **JSON** to `edgeguard-events`. This replays the existing event through the consumer. [Send a queue message](https://developers.cloudflare.com/queues/examples/send-messages-from-dash/)
3. Confirm processing succeeded before acknowledging the selected DLQ copy. For an event with an opening in `anomaly_episodes`, verify the incident for its original event ID and its analysis state. A persisted `failed` analysis can be retried through the administrator endpoint.

To verify hosted routing in isolated staging, install the following temporary trigger in its D1 database on a fresh endpoint. Submit 20 HTTP 503 events within one window, all with method GET and path `/synthetic/dlq-check`. Pace ingestion within its rate limit.

```sql
CREATE TRIGGER fail_dlq_check BEFORE INSERT ON incidents
WHEN EXISTS (SELECT 1 FROM events WHERE id = NEW.event_id AND path = '/synthetic/dlq-check')
BEGIN
    SELECT RAISE(ABORT, 'injected staging failure');
END;
```

Find the opening event in `anomaly_episodes`, confirm it is marked `sent` in `events`, and look for attempts 1–4 in the Worker logs. Once the message appears in the DLQ, run `DROP TRIGGER fail_dlq_check` in staging and follow the replay steps above. Expect one incident for the original event ID. Remove the trigger even if the check is interrupted.

## Design notes and limitations

- Metrics are calculated from the events and incidents stored in D1.
- `/api/metrics/telemetry` separately queries Analytics Engine through Analytics SQL; its rolling time window differs from the calendar-hour buckets used by `/api/metrics/timeseries`.
- `rateLimitedResponses` in the dashboard metrics counts observed application events with HTTP status `429`. Requests rejected by EdgeGuard's own ingestion rate limiter are recorded separately in Analytics Engine and are not included in the D1 event total.
- Time-series timestamps represent the start of each hour in Unix milliseconds.
- The ingestion rate limiter is keyed by the connecting client IP address.
- Bearer tokens use static configured secrets. This project does not currently implement user accounts, per-user identities, or expiring access tokens.
- For a window incident, the model receives the immutable opening snapshot, including the reported method and path, window bounds, 5xx count, sample size, error percentage and mean latency. Historical incidents without a snapshot supply the event’s HTTP status and latency. The prompt treats telemetry as untrusted data and asks for an observed summary, explicitly hypothetical causes and suggested checks. Analysis never updates incident status.
- Incidents predating AI support show “Not requested”. There is no automatic analysis backfill. Provider errors, invalid output and timeouts need an operator retry; an interrupted running claim becomes retryable after one minute. The attempt ID prevents late completions from overwriting a newer result. Retries can consume inference even if a previous provider request completed without saving its response.
- The offline demo does not verify provider credentials, billing, model behaviour, remote analytics or production configuration.

EdgeGuard is a portfolio project demonstrating serverless backend engineering and observability patterns. It has not been independently security-audited and should not be treated as a production security product without further review.

## Cloudflare documentation

- [Workers](https://developers.cloudflare.com/workers/)
- [D1](https://developers.cloudflare.com/d1/)
- [Queues](https://developers.cloudflare.com/queues/)
- [Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)
- [Analytics SQL sampling and aggregates](https://developers.cloudflare.com/analytics/sql-api/sql-reference/functions/)
- [Analytics SQL Workers binding](https://developers.cloudflare.com/analytics/sql-api/workers-binding/)
- [Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Workers configuration and secrets](https://developers.cloudflare.com/workers/wrangler/configuration/)

## Dashboard

Open `/dashboard` or `/` to view all-time D1 metrics, hourly activity for the last 24 hours and up to 100 recent incidents per filter. Select an incident to inspect its rule and event details, resolve it or reopen it. Data refreshes on sign-in, on request and after status changes. The detail panel shows analysis state, validated results and a retry action for failed analysis.

Configure the three distinct API tokens described above and a separate `DASHBOARD_PASSWORD` of at least 32 characters. Generate a password with `openssl rand -hex 32` and set it in the ignored local `.dev.vars` file. For production, use `npx wrangler secret put DASHBOARD_PASSWORD`.

Apply local migrations with `npx wrangler d1 migrations apply edgeguard-db --local`, then run `npm run dev -- --local-protocol https` and open the printed HTTPS address followed by `/dashboard`. Wrangler uses a self-signed certificate locally.

This dashboard is intended for one operator. API tokens stay on the server. The signed session cookie uses HttpOnly, Secure and SameSite=Strict and expires after eight hours. Writes require a matching origin and sign-in attempts are rate limited by IP. Signing out clears the browser cookie. Rotating the dashboard password invalidates all sessions. Individual accounts and per-user auditing are not implemented.
