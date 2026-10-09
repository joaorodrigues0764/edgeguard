CREATE TABLE incidents (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    severity TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,

    CHECK (severity IN ('medium', 'high', 'critical')),
    CHECK (status IN ('open', 'resolved')),

    FOREIGN KEY (event_id)
        REFERENCES events(id)
        ON DELETE CASCADE
);

CREATE INDEX idx_incidents_created_at
    ON incidents(created_at);

CREATE INDEX idx_incidents_severity
    ON incidents(severity);