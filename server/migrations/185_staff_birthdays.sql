-- Staff birthdays (owner, 2026-11-03): a day and month on the staff card (the year is deliberately NOT stored: nobody's age is ever shown). Vaghinak
-- congratulates on the day, the whole team sees "Birthday today" on Home and can congratulate with one tap, and the gift is one paid day off
-- that does not use the person's paid-day-off allowance ('birthday_off' mark; the person picks the day in Vaghinak's message or management marks it).
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS birth_day SMALLINT CHECK (birth_day BETWEEN 1 AND 31);
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS birth_month SMALLINT CHECK (birth_month BETWEEN 1 AND 12);
ALTER TABLE staff_members DROP CONSTRAINT IF EXISTS staff_members_birthday_both;
ALTER TABLE staff_members ADD CONSTRAINT staff_members_birthday_both CHECK ((birth_day IS NULL) = (birth_month IS NULL));

ALTER TABLE staff_days DROP CONSTRAINT IF EXISTS staff_days_status_check;
ALTER TABLE staff_days ADD CONSTRAINT staff_days_status_check CHECK (status IN ('completed', 'dayoff', 'unpaid', 'birthday_off'));

-- a colleague's wish (one tap on Home); one per colleague and birthday year
CREATE TABLE IF NOT EXISTS staff_birthday_wishes (
  staff_id INTEGER NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  year SMALLINT NOT NULL,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, year, from_user_id)
);

-- the CEO / admin announcement goes out once per person and year
CREATE TABLE IF NOT EXISTS staff_birthday_log (
  staff_id INTEGER NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  year SMALLINT NOT NULL,
  announced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, year)
);
