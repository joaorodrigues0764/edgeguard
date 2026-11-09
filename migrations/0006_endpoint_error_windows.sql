-- Only new event inserts advance the detector. Existing events and incidents stay readable.
CREATE TABLE anomaly_policy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    window_minutes INTEGER NOT NULL CHECK (window_minutes BETWEEN 1 AND 60),
    min_requests INTEGER NOT NULL CHECK (min_requests >= 1),
    min_failures INTEGER NOT NULL CHECK (min_failures >= 1),
    open_percent INTEGER NOT NULL CHECK (open_percent BETWEEN 1 AND 99),
    recover_percent INTEGER NOT NULL CHECK (recover_percent BETWEEN 0 AND open_percent - 1)
) STRICT;

INSERT INTO anomaly_policy (id, window_minutes, min_requests, min_failures, open_percent, recover_percent)
VALUES (1, 5, 20, 5, 20, 10);

CREATE TABLE anomaly_minutes (
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    minute INTEGER NOT NULL,
    requests INTEGER NOT NULL,
    failures INTEGER NOT NULL,
    latency_sum INTEGER NOT NULL,
    PRIMARY KEY (method, path, minute)
) WITHOUT ROWID;

CREATE TABLE anomaly_episodes (
    event_id TEXT PRIMARY KEY NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    recovered INTEGER NOT NULL DEFAULT 0 CHECK (recovered IN (0, 1)),
    evidence TEXT NOT NULL CHECK (json_valid(evidence))
);

-- This table tracks a single rule. Operator incident status is independent.
CREATE UNIQUE INDEX idx_anomaly_active ON anomaly_episodes(method, path) WHERE recovered = 0;

CREATE VIEW anomaly_windows AS
    SELECT
        method,
        path,
        MAX(minute) AS last_minute,
        SUM(requests) AS total,
        SUM(failures) AS errors,
        SUM(latency_sum) AS latency
    FROM anomaly_minutes
    GROUP BY method, path;

CREATE TRIGGER detect_endpoint_spike AFTER INSERT ON events
BEGIN
    INSERT INTO anomaly_minutes (method, path, minute, requests, failures, latency_sum)
    VALUES (NEW.method, NEW.path, NEW.created_at / 60000, 1, NEW.status >= 500, NEW.latency_ms)
    ON CONFLICT(method, path, minute) DO UPDATE SET
        requests = requests + 1,
        failures = failures + excluded.failures,
        latency_sum = latency_sum + excluded.latency_sum;

    -- Use the newest stored minute even if two Workers' inserts reach D1 out of order.
    DELETE FROM anomaly_minutes
    WHERE method = NEW.method AND path = NEW.path AND minute <= (
        SELECT MAX(minute) FROM anomaly_minutes WHERE method = NEW.method AND path = NEW.path
    ) - (SELECT window_minutes FROM anomaly_policy WHERE id = 1);

    UPDATE anomaly_episodes SET recovered = 1
    WHERE method = NEW.method AND path = NEW.path AND recovered = 0 AND EXISTS (
        SELECT 1 FROM anomaly_windows w JOIN anomaly_policy p ON p.id = 1
        WHERE w.method = NEW.method AND w.path = NEW.path AND w.total >= p.min_requests
          AND 100 * w.errors <= p.recover_percent * w.total
    );

    INSERT INTO anomaly_episodes (event_id, method, path, evidence)
    SELECT NEW.id, NEW.method, NEW.path, json_object(
        'rule', 'endpoint_5xx_rate_v2',
        'method', w.method,
        'path', w.path,
        'severity', CASE WHEN 100 * w.errors >= 50 * w.total THEN 'critical' ELSE 'high' END,
        'windowStartMs', (w.last_minute + 1 - p.window_minutes) * 60000,
        'windowEndExclusiveMs', (w.last_minute + 1) * 60000,
        'totalRequests', w.total,
        'serverErrors', w.errors,
        'errorPercent', 100.0 * w.errors / w.total,
        'averageLatencyMs', 1.0 * w.latency / w.total,
        'minRequests', p.min_requests,
        'minFailures', p.min_failures,
        'openPercent', p.open_percent
    )
    FROM anomaly_windows w JOIN anomaly_policy p ON p.id = 1
    WHERE w.method = NEW.method AND w.path = NEW.path AND w.total >= p.min_requests
      AND w.errors >= p.min_failures AND 100 * w.errors > p.open_percent * w.total
      AND NEW.created_at / 60000 > w.last_minute - p.window_minutes
      AND NOT EXISTS (
          SELECT 1 FROM anomaly_episodes WHERE method = NEW.method AND path = NEW.path AND recovered = 0
      );
END;
