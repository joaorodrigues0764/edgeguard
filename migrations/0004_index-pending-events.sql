CREATE INDEX idx_events_pending_delivery
    ON events(created_at, id)
    WHERE queue_status = 'pending';
