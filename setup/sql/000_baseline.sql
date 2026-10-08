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
-- The full Coursedog catalog. credits is the hours the planner counts (the minimum of a variable-credit
-- range); credits_max is the top of that range, NULL for a fixed-credit course. requisite_text keeps a
-- prerequisite statement the planner could not turn into rules, so it can be shown without being enforced.
-- Their own statements so a database whose table already exists gains the columns too.
ALTER TABLE courses ADD COLUMN IF NOT EXISTS credits_max    INTEGER;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS requisite_text TEXT;

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
-- A row here is a degree PROGRAM: a major (a degree on its own) or a concentration of one. The table kept its
-- original name so student_profiles.concentration_id and every stored plan stay valid; the app says "program".
-- Their own statements so a database whose table already exists gains the columns too.
--   kind               'major' | 'concentration'
--   degree             e.g. 'B.S.'
--   major_name         what the picker groups programs under (a concentration shares its major's name)
--   department         owning department code
--   supersedes         code of the program this one replaces
--   last_catalog_year  the last catalog year that may choose this program (NULL = still open)
--   description        shown to students choosing a program
--   college            a college code (degree-specs/colleges.json in the prototype repo); the picker's first level
--   major_code         groups a major with its concentrations (the picker's second level)
--   is_base            true for the program that is the major itself, with no concentration
--   aliases            extra words the picker's search matches, comma separated ("CS, comp sci")
ALTER TABLE concentrations ADD COLUMN IF NOT EXISTS kind              TEXT NOT NULL DEFAULT 'concentration';
ALTER TABLE concentrations ADD COLUMN IF NOT EXISTS degree            TEXT;
ALTER TABLE concentrations ADD COLUMN IF NOT EXISTS major_name        TEXT;
ALTER TABLE concentrations ADD COLUMN IF NOT EXISTS department        TEXT;
ALTER TABLE concentrations ADD COLUMN IF NOT EXISTS supersedes        TEXT;
ALTER TABLE concentrations ADD COLUMN IF NOT EXISTS last_catalog_year TEXT;
ALTER TABLE concentrations ADD COLUMN IF NOT EXISTS description       TEXT;
ALTER TABLE concentrations ADD COLUMN IF NOT EXISTS college           TEXT;
ALTER TABLE concentrations ADD COLUMN IF NOT EXISTS major_code        TEXT;
ALTER TABLE concentrations ADD COLUMN IF NOT EXISTS is_base           BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE concentrations ADD COLUMN IF NOT EXISTS aliases           TEXT;
ALTER TABLE concentrations DROP CONSTRAINT IF EXISTS concentrations_kind_check;
ALTER TABLE concentrations ADD CONSTRAINT concentrations_kind_check CHECK (kind IN ('major','concentration'));

-- One row per program per catalog year: the index of which degree plan exists. A student's plan is the one for
-- their catalog year (or the latest earlier one); covers_earlier marks a program's first plan as also serving
-- every older catalog year. The slots themselves are requirement_slots rows with the same catalog_year.
CREATE TABLE IF NOT EXISTS degree_plans (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  concentration_id INTEGER NOT NULL REFERENCES concentrations(id) ON DELETE CASCADE,
  catalog_year     TEXT    NOT NULL,                      -- '2026-2027'
  gened_program    TEXT    NOT NULL DEFAULT 'legacy',     -- 'legacy' | 'flight_foundations'
  total_hours      INTEGER,
  covers_earlier   BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (concentration_id, catalog_year)                 -- target of the seed's upsert onConflict
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
-- catalog_year: the degree plan a slot belongs to (see degree_plans). slot_key: the slot's stable identity
-- within its plan, which is how the seed keeps a slot's id (and every student's saved pick) across spec edits.
-- map_semester: the semester the department's degree map recommends for the slot, when one is published.
ALTER TABLE requirement_slots ADD COLUMN IF NOT EXISTS catalog_year TEXT;
ALTER TABLE requirement_slots ADD COLUMN IF NOT EXISTS slot_key     TEXT;
ALTER TABLE requirement_slots ADD COLUMN IF NOT EXISTS map_semester INTEGER;

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
-- option_key: an exam whose credit is one of several courses ("PHYS 2010 or 2110") marks each alternative's rows with a
-- key; the rows of one exam sharing a key are one choice (test_equivalencies.sql, "AP: credit that is one of several courses").
ALTER TABLE test_equivalencies ADD COLUMN IF NOT EXISTS option_key TEXT;
-- superseded_at: a row that a higher score replaces (Calculus AB: a 3 earns MATH 1830, a 4 earns MATH 1910 instead) applies
-- when min_score <= score < superseded_at; NULL means it applies from min_score upward.
ALTER TABLE test_equivalencies ADD COLUMN IF NOT EXISTS superseded_at INTEGER;
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
-- sat_math: an SAT Math score places a student the way an ACT Math score does (see mathPlacement.js in the
-- frontend). Its own statement so a database whose table already exists gains the column too.
ALTER TABLE student_profiles ADD COLUMN IF NOT EXISTS sat_math INTEGER;
-- catalog_year: the catalog year of the degree plan the student's slots belong to, stored at onboarding
-- (never recomputed, so a plan keeps its slots when a newer year is added). Students who onboarded before
-- catalog years existed follow the plan their gen-ed program implied.
ALTER TABLE student_profiles ADD COLUMN IF NOT EXISTS catalog_year TEXT;
UPDATE student_profiles
   SET catalog_year = CASE gened_program WHEN 'flight_foundations' THEN '2026-2027' ELSE '2025-2026' END
 WHERE catalog_year IS NULL AND concentration_id IS NOT NULL;

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
-- selected_credits: the credit hours a student chose for a pool pick whose course carries a range
-- (courses.credits .. courses.credits_max). NULL for a fixed-credit course.
ALTER TABLE student_plan_slots ADD COLUMN IF NOT EXISTS selected_credits INTEGER;
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
-- fills_slot_id: a Free Elective slot filled by several courses. A follow-up pick points at
-- the slot whose hours it fills; NULL for ordinary "+ Add course" rows. Its own statement
-- (not inline above) so a database whose table already exists gains the column too.
ALTER TABLE student_free_add_slots
  ADD COLUMN IF NOT EXISTS fills_slot_id INTEGER REFERENCES requirement_slots(id) ON DELETE CASCADE;
-- credits: the credit hours a student chose for an added course whose catalog entry carries a range
-- (courses.credits .. courses.credits_max). NULL for a fixed-credit course.
ALTER TABLE student_free_add_slots ADD COLUMN IF NOT EXISTS credits INTEGER;

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
  FOREACH t IN ARRAY ARRAY['courses','concentrations','degree_plans','requirement_slots',
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

GRANT SELECT ON courses, concentrations, degree_plans, requirement_slots, prerequisite_entries,
                corequisite_entries, test_equivalencies             TO anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON student_profiles, student_plan_slots, student_semester_notes,
     student_free_add_slots, prior_credits                          TO authenticated;

GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

-- Tell PostgREST to reload its schema cache.
NOTIFY pgrst, 'reload schema';
