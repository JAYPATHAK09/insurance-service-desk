CREATE TABLE IF NOT EXISTS desk_agent_reviews(id uuid PRIMARY KEY, agent text NOT NULL, mode text NOT NULL, findings jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS desk_review_actions (
 id uuid PRIMARY KEY, review_id uuid NOT NULL REFERENCES desk_agent_reviews(id),
 decision text NOT NULL, note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
