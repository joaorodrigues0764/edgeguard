# EdgeGuard

**An edge-native event monitoring and incident detection API built on Cloudflare Workers.**

EdgeGuard ingests application events, detects anomalous behaviour, creates incidents, and exposes operational metrics through an authenticated API. It uses Cloudflare's developer platform to demonstrate event-driven architecture, serverless data processing, observability, and role-based access control.

## Features

- **Event ingestion:** validate and store application events using Cloudflare Workers and D1.
- **Asynchronous processing:** publish events to Cloudflare Queues and analyse them in a queue consumer.
- **Anomaly detection:** identify server errors, rate-limited responses, and high-latency requests.
- **Incident management:** create incidents with severity levels, prevent duplicate incidents for the same event, and update incident status.
- **Operational metrics:** calculate event counts, server-error counts, rate-limited responses, average latency, and incident statistics.
- **Time-series metrics:** aggregate event data into hourly buckets, including intervals with no events.
- **Request rate limiting:** protect event ingestion with Cloudflare's Rate Limiting API.
- **Telemetry:** send event and rate-limited ingestion telemetry to Cloudflare Analytics Engine.
- **API authentication:** use Bearer tokens with separate ingestion, dashboard, and administrator permissions.
- **Automated tests:** validate API behaviour, anomaly detection, queue processing, telemetry mapping, metrics, and access control.

## Architecture

```mermaid
flowchart TD
    Client[API Client] --> Worker[Cloudflare Worker]
    Worker --> Auth[Bearer Token Authorization]
    Auth --> D1[(Cloudflare D1)]
    Worker --> Queue[Cloudflare Queues]
    Queue --> Consumer[Queue Consumer]
    Consumer --> Detect[Anomaly Detection]
    Detect --> D1
    Worker --> Analytics[Cloudflare Analytics Engine]
    Worker --> Metrics[Metrics API]
    Metrics --> D1
```

### Event processing

1. A client submits an event to the ingestion endpoint.
2. The Worker validates the request and stores the event in D1.
3. The Worker records telemetry and publishes a message to a Cloudflare Queue.
4. The queue consumer retrieves the event and runs the anomaly detection rules.
5. If an anomaly is detected, an incident is created in D1.
6. Clients with the appropriate permissions can query events, inspect incidents, and retrieve metrics.

Incident creation is idempotent for each event: the database prevents duplicate incidents for the same event.

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

All protected endpoints require a Bearer token. The public health check is the only endpoint that does not require authentication.

| Method | Endpoint | Permission |
|---|---|---|
| `GET` | `/health` | Public |
| `POST` | `/api/events` | Ingestion |
| `GET` | `/api/events?limit=20` | Dashboard or administrator |
| `GET` | `/api/incidents?limit=20` | Dashboard or administrator |
| `PATCH` | `/api/incidents/:id` | Administrator |
| `GET` | `/api/metrics` | Dashboard or administrator |
| `GET` | `/api/metrics/timeseries?hours=24` | Dashboard or administrator |

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

The response includes incident information and the corresponding event details.

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

The examples above assume the default local Worker address, `http://localhost:8787`.

## Testing

Run the complete test suite:

```bash
npm test -- --run
```

Check TypeScript compilation:

```bash
npx tsc --noEmit
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

A successful local test run does not by itself establish that the production resources have been configured or that the Worker has been deployed.

## Design notes and limitations

- Metrics are calculated from the events and incidents stored in D1.
- `rateLimitedResponses` in the dashboard metrics counts observed application events with HTTP status `429`. Requests rejected by EdgeGuard's own ingestion rate limiter are recorded separately in Analytics Engine and are not included in the D1 event total.
- Time-series timestamps represent the start of each hour in Unix milliseconds.
- The ingestion rate limiter is keyed by the connecting client IP address.
- Bearer tokens use static configured secrets. This project does not currently implement user accounts, per-user identities, or expiring access tokens.
- The current project provides the backend API for a potential dashboard; it does not include a separate frontend dashboard application.

EdgeGuard is a portfolio project demonstrating serverless backend engineering and observability patterns. It has not been independently security-audited and should not be treated as a production security product without further review.

## Cloudflare documentation

- [Workers](https://developers.cloudflare.com/workers/)
- [D1](https://developers.cloudflare.com/d1/)
- [Queues](https://developers.cloudflare.com/queues/)
- [Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)
- [Workers configuration and secrets](https://developers.cloudflare.com/workers/wrangler/configuration/)