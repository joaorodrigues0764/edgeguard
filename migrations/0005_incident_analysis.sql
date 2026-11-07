-- Existing incidents remain readable and do not trigger retrospective inference.
ALTER TABLE incidents ADD COLUMN analysis_state TEXT NOT NULL DEFAULT 'not_requested'
    CHECK (analysis_state IN ('not_requested', 'pending', 'running', 'complete', 'failed'));
ALTER TABLE incidents ADD COLUMN analysis_attempt TEXT;
ALTER TABLE incidents ADD COLUMN analysis_expires_at INTEGER;
ALTER TABLE incidents ADD COLUMN analysis_json TEXT;
