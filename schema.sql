CREATE TABLE IF NOT EXISTS desk_agent_reviews(id uuid PRIMARY KEY, agent text NOT NULL, mode text NOT NULL, findings jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
