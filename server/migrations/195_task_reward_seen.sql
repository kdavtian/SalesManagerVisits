-- The "well done" moment after a task is completed: the app shows it ONCE per finished task. reward_seen_at is when the assignee saw it
-- (or when the task was finished by hand and the person saw the confirmation right away). Existing finished tasks count as seen so the
-- first start after the update does not shower people with old rewards.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reward_seen_at timestamptz;
UPDATE tasks SET reward_seen_at = COALESCE(completed_at, now()) WHERE status <> 'open' AND reward_seen_at IS NULL;
CREATE INDEX IF NOT EXISTS tasks_reward_unseen_idx ON tasks (assignee_id, completed_at) WHERE status = 'done' AND reward_seen_at IS NULL;
