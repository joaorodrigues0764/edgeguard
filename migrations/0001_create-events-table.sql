CREATE TABLE events (
    id TEXT PRIMARY KEY,
    occurred_at INTEGER NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    client_id TEXT,
    created_at INTEGER NOT NULL,

    CHECK (status BETWEEN 100 AND 599),
    CHECK (latency_ms >= 0)
);

CREATE INDEX idx_events_occurred_at
    ON events(occurred_at);

CREATE INDEX idx_events_path
    ON events(path);

CREATE INDEX idx_events_status
    ON events(status);