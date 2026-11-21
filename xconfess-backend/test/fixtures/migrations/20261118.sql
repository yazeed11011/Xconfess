CREATE TYPE audit_logs_action_enum AS ENUM ('account_created');

CREATE TABLE anonymous_confessions (
  id uuid PRIMARY KEY,
  message text NOT NULL,
  created_at timestamptz NOT NULL,
  view_count integer NOT NULL DEFAULT 0
);

INSERT INTO anonymous_confessions (id, message, created_at, view_count)
VALUES
  ('a9b5b640-1f12-47ec-8d15-fc35b8161151', 'legacy confession row', '2026-11-18T12:00:00Z', 7),
  ('6f3a9905-d25b-4c9e-a8da-e968f2d13273', 'second legacy row', '2026-11-18T12:01:00Z', 0);
