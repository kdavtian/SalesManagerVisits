-- Payments redesign, release 4 (owner, 2026-11-02): the daily money board's evening summary goes to the accounting Telegram group (the CEO
-- bot posts it, like the cash sheets): one row per day once it is posted, so it goes out once; a failed post is offered again (10 times).
CREATE TABLE money_board_posts (
  day          DATE PRIMARY KEY,
  posted_at    TIMESTAMPTZ,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT
);
