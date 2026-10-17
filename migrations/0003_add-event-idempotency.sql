ALTER TABLE events
    ADD COLUMN idempotency_key TEXT;

ALTER TABLE events
    ADD COLUMN request_hash TEXT;

ALTER TABLE events
    ADD COLUMN queue_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (queue_status IN ('pending', 'sent'));

CREATE UNIQUE INDEX idx_events_idempotency_key
    ON events(idempotency_key);