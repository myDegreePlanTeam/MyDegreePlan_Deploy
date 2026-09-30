-- ═══════════════════════════════════════════════════════════════════════════════
-- MyDegreePlan — consolidated baseline schema for the local (Docker) install.
--
-- This is the FINAL state after rls_migration.sql and migration_tier6..20, as a
-- single re-runnable script. The base tables (courses, prerequisite_entries,
-- corequisite_entries, concentrations, requirement_slots, student_profiles,
-- student_plan_slots, student_semester_notes) were originally created by hand in
-- the Supabase dashboard and never checked in, so they are RECONSTRUCTED here
-- from seed.js and the columns the frontend reads/writes. Verify against a real
-- `pg_dump --schema-only` of the hosted project before relying on it (README).
--
-- When you add migration_tier21+.sql to the project, add its final-state changes
-- here too (or drop the file in setup/sql/ with a higher number prefix).
-- Every statement is idempotent; the setup container runs this on every start.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Catalog tables (public read, written only by the seed script) ──────────────

CREATE TABLE IF NOT EXISTS courses (
  code         TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  credits      INTEGER NOT NULL,
  subject_code TEXT,
  description  TEXT,
  standing_req TEXT              -- 'junior' | 'senior' | NULL
);

CREATE TABLE IF NOT EXISTS prerequisite_entries (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_code   TEXT    NOT NULL,
  required_code TEXT    NOT NULL,
  group_index   INTEGER NOT NULL DEFAULT 0,
  logic         TEXT    NOT NULL DEFAULT 'AND' CHECK (logic IN ('AND', 'OR'))
);

CREATE TABLE IF NOT EXISTS corequisite_entries (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_code   TEXT    NOT NULL,
  required_code TEXT    NOT NULL,
  group_index   INTEGER NOT NULL DEFAULT 0,
  logic         TEXT    NOT NULL DEFAULT 'AND' CHECK (logic IN ('AND', 'OR'))
);

CREATE TABLE IF NOT EXISTS concentrations (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  total_hours INTEGER
);

-- Tier 17: semester_number / slot_order are nullable hints, no unique constraint.
CREATE TABLE IF NOT EXISTS requirement_slots (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  concentration_id INTEGER NOT NULL REFERENCES concentrations(id) ON DELETE CASCADE,
  semester_number  INTEGER,
  slot_order       INTEGER,
  class_code       TEXT    NOT NULL,
  is_pool          BOOLEAN NOT NULL DEFAULT false,
  flex_credits     INTEGER,
  gened_program    TEXT    NOT NULL DEFAULT 'legacy'                -- tier 21
);

CREATE TABLE IF NOT EXISTS test_equivalencies (
  id                  BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  test_type           TEXT        NOT NULL,
  test_name           TEXT        NOT NULL,
  min_score           INTEGER,
  awarded_course_code TEXT        NOT NULL,
  credits_awarded     INTEGER     NOT NULL DEFAULT 0,
  satisfies_pool      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Final list after tiers 9, 10, 13.
ALTER TABLE test_equivalencies DROP CONSTRAINT IF EXISTS test_equivalencies_test_type_check;
ALTER TABLE test_equivalencies ADD CONSTRAINT test_equivalencies_test_type_check
  CHECK (test_type IN ('ap_credit','test_out','ib_credit','cambridge','act_credit','act_placement'));

-- ─── Student tables (each row owned by exactly one auth user) ───────────────────

CREATE TABLE IF NOT EXISTS student_profiles (
  id               INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          UUID        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  concentration_id INTEGER     REFERENCES concentrations(id),
  start_season     TEXT,
  start_year       INTEGER,
  student_type     TEXT        CHECK (student_type IN ('incoming_freshman','transfer','returning')),
  act_math         INTEGER,
  act_english      INTEGER,
  act_science      INTEGER,
  act_reading      INTEGER,
  act_composite    INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  gened_program    TEXT        NOT NULL DEFAULT 'legacy'   -- tier 21
);

CREATE TABLE IF NOT EXISTS student_plan_slots (
  id                   INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id           INTEGER     NOT NULL REFERENCES student_profiles(id)  ON DELETE CASCADE,
  requirement_slot_id  INTEGER     NOT NULL REFERENCES requirement_slots(id) ON DELETE CASCADE,
  selected_course_code TEXT,                                   -- tier 19: nullable (unfilled pool slots)
  status               TEXT        NOT NULL DEFAULT 'planned',
  semester_number      INTEGER,                                -- tier 6: drag / algorithm placement
  credits_remaining    INTEGER     NOT NULL DEFAULT 0,         -- tier 6
  locked               BOOLEAN     NOT NULL DEFAULT false,     -- tier 8
  archived             BOOLEAN     NOT NULL DEFAULT false,     -- tier 9
  archive_reason       TEXT,                                   -- tier 9 / 18 (constraint below)
  position_source      TEXT        CHECK (position_source IN ('algorithm','student')),  -- tier 18
  UNIQUE (student_id, requirement_slot_id)                     -- target of every upsert onConflict
);
ALTER TABLE student_plan_slots DROP CONSTRAINT IF EXISTS student_plan_slots_archive_reason_check;
ALTER TABLE student_plan_slots ADD CONSTRAINT student_plan_slots_archive_reason_check
  CHECK (archive_reason IN ('prior_credit','banner_import','not_applicable'));

CREATE TABLE IF NOT EXISTS student_semester_notes (
  id                   INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id           INTEGER     NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  concentration_id     INTEGER     NOT NULL REFERENCES concentrations(id),
  semester_number      INTEGER     NOT NULL,
  note_text            TEXT        NOT NULL DEFAULT '',
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_by_student BOOLEAN     NOT NULL DEFAULT false,     -- tier 9
  term_season          TEXT        CHECK (term_season IN ('Fall','Spring','Summer')),   -- tier 14
  term_year            INTEGER,                                                        -- tier 14
  UNIQUE (student_id, concentration_id, semester_number)
);

CREATE TABLE IF NOT EXISTS student_free_add_slots (           -- tier 6
  id              BIGINT      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  student_id      INTEGER     NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  course_code     TEXT        NOT NULL,
  semester_number INTEGER     NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'planned'
                              CHECK (status IN ('planned','in_progress','completed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prior_credits (                    -- tier 7
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id               INTEGER     NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  credit_type           TEXT        NOT NULL,
  satisfies_course_code TEXT,
  note                  TEXT,
  credits_awarded       INTEGER     NOT NULL DEFAULT 0,
  satisfies_pool        TEXT,                                 -- tier 9
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Final list after tiers 10 and 11 (dual_enrollment removed).
ALTER TABLE prior_credits DROP CONSTRAINT IF EXISTS prior_credits_credit_type_check;
ALTER TABLE prior_credits ADD CONSTRAINT prior_credits_credit_type_check
  CHECK (credit_type IN ('act_placement','ap_credit','transfer_credit','test_out',
                         'ib_credit','act_credit','cambridge'));

-- Foreign-key columns the RLS policies and the app filter on constantly.
CREATE INDEX IF NOT EXISTS idx_plan_slots_student   ON student_plan_slots(student_id);
CREATE INDEX IF NOT EXISTS idx_notes_student        ON student_semester_notes(student_id);
CREATE INDEX IF NOT EXISTS idx_free_add_student     ON student_free_add_slots(student_id);
CREATE INDEX IF NOT EXISTS idx_prior_credits_plan   ON prior_credits(plan_id);
CREATE INDEX IF NOT EXISTS idx_req_slots_conc       ON requirement_slots(concentration_id);
CREATE INDEX IF NOT EXISTS idx_prereq_course        ON prerequisite_entries(course_code);
CREATE INDEX IF NOT EXISTS idx_coreq_course         ON corequisite_entries(course_code);

-- ─── Row-level security ─────────────────────────────────────────────────────────
-- Same policy set as rls_migration.sql / tier6 / tier7 (owner via auth.uid()).
-- Rebuilt in a loop instead of 20 near-identical CREATE POLICY statements.

DO $$
DECLARE
  t   TEXT;
  own TEXT;
BEGIN
  -- Catalog tables: anyone may read, nobody but service_role (seed) may write.
  FOREACH t IN ARRAY ARRAY['courses','concentrations','requirement_slots',
                           'prerequisite_entries','corequisite_entries','test_equivalencies']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Public read access" ON %I', t);
    EXECUTE format('CREATE POLICY "Public read access" ON %I FOR SELECT USING (true)', t);
  END LOOP;

  -- Student tables: full CRUD on your own rows only.
  FOR t, own IN
    SELECT * FROM (VALUES
      ('student_profiles',       'user_id = auth.uid()'),
      ('student_plan_slots',     'student_id IN (SELECT id FROM student_profiles WHERE user_id = auth.uid())'),
      ('student_semester_notes', 'student_id IN (SELECT id FROM student_profiles WHERE user_id = auth.uid())'),
      ('student_free_add_slots', 'student_id IN (SELECT id FROM student_profiles WHERE user_id = auth.uid())'),
      ('prior_credits',          'plan_id    IN (SELECT id FROM student_profiles WHERE user_id = auth.uid())')
    ) AS v(t, own)
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Students can view own rows"   ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS "Students can insert own rows" ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS "Students can update own rows" ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS "Students can delete own rows" ON %I', t);
    EXECUTE format('CREATE POLICY "Students can view own rows"   ON %I FOR SELECT USING (%s)', t, own);
    EXECUTE format('CREATE POLICY "Students can insert own rows" ON %I FOR INSERT WITH CHECK (%s)', t, own);
    EXECUTE format('CREATE POLICY "Students can update own rows" ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', t, own, own);
    EXECUTE format('CREATE POLICY "Students can delete own rows" ON %I FOR DELETE USING (%s)', t, own);
  END LOOP;
END $$;

-- ─── Grants ─────────────────────────────────────────────────────────────────────
-- PostgREST switches to anon / authenticated / service_role per request; RLS above
-- decides which rows. Least privilege: anon can only read the catalog.

-- The supabase/postgres image auto-grants ALL (including TRUNCATE, which ignores
-- RLS) on every new public table to anon and authenticated. Strip that, and stop it
-- for future tables this role creates; then grant only what the app needs. A future
-- migration that adds a table must therefore GRANT it explicitly (fails loudly with
-- 42501 if forgotten, rather than silently over-granting).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT SELECT ON courses, concentrations, requirement_slots, prerequisite_entries,
                corequisite_entries, test_equivalencies             TO anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON student_profiles, student_plan_slots, student_semester_notes,
     student_free_add_slots, prior_credits                          TO authenticated;

GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

-- Tell PostgREST to reload its schema cache.
NOTIFY pgrst, 'reload schema';
