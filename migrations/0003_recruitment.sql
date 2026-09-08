-- CORPUS 0003 — recruitment: jobs, requirements, candidates, applications.

PRAGMA foreign_keys = ON;

CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_code        TEXT NOT NULL,
  title           TEXT NOT NULL,
  department_id   TEXT REFERENCES departments(id) ON DELETE SET NULL,
  location        TEXT,
  employment_type TEXT NOT NULL
                    CHECK (employment_type IN ('FULL_TIME','PART_TIME','CONTRACT','INTERN','TEMPORARY')),
  description     TEXT NOT NULL,
  salary_min      REAL,
  salary_max      REAL,
  currency        TEXT,
  remote_allowed  INTEGER NOT NULL DEFAULT 0 CHECK (remote_allowed IN (0,1)),
  experience_min  INTEGER,
  status          TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','PUBLISHED','CLOSED','ARCHIVED')),
  -- Whether the salary range may be shown to public/external callers.
  salary_public   INTEGER NOT NULL DEFAULT 0 CHECK (salary_public IN (0,1)),
  published_at    TEXT,
  closing_date    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max)
);

CREATE UNIQUE INDEX idx_jobs_tenant_code ON jobs (tenant_id, job_code);
CREATE INDEX idx_jobs_status ON jobs (tenant_id, status, published_at);

CREATE TABLE job_requirements (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id           TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  requirement_type TEXT NOT NULL
                     CHECK (requirement_type IN ('SKILL','EDUCATION','EXPERIENCE','CERTIFICATION','LANGUAGE','OTHER')),
  description      TEXT NOT NULL,
  mandatory        INTEGER NOT NULL DEFAULT 1 CHECK (mandatory IN (0,1)),
  priority         INTEGER NOT NULL DEFAULT 100,
  created_at       TEXT NOT NULL
);

CREATE INDEX idx_job_requirements_job ON job_requirements (tenant_id, job_id, priority);

CREATE TABLE candidates (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL,
  phone            TEXT,
  telegram_user_id TEXT,
  cv_file_id       TEXT,
  source           TEXT NOT NULL DEFAULT 'DIRECT',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_candidates_tenant_email ON candidates (tenant_id, email);
CREATE INDEX idx_candidates_telegram ON candidates (tenant_id, telegram_user_id);

CREATE TABLE applications (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stage        TEXT NOT NULL DEFAULT 'APPLIED'
                 CHECK (stage IN ('APPLIED','SCREENING','SHORTLISTED','INTERVIEW','TECHNICAL','FINAL','OFFER','HIRED','REJECTED','WITHDRAWN')),
  status       TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  -- Opaque reference a candidate can quote. Not guessable, not sequential.
  reference    TEXT NOT NULL,
  cover_note   TEXT,
  applied_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- One live application per candidate per job.
CREATE UNIQUE INDEX idx_applications_unique ON applications (tenant_id, candidate_id, job_id);
CREATE UNIQUE INDEX idx_applications_reference ON applications (reference);
CREATE INDEX idx_applications_job_stage ON applications (tenant_id, job_id, stage);
CREATE INDEX idx_applications_candidate ON applications (tenant_id, candidate_id);

CREATE TABLE application_events (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_stage     TEXT,
  to_stage       TEXT NOT NULL,
  note           TEXT,
  actor_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_application_events_app ON application_events (tenant_id, application_id, created_at);

CREATE TABLE interviews (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  application_id          TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  scheduled_at            TEXT NOT NULL,
  duration_minutes        INTEGER NOT NULL DEFAULT 60,
  mode                    TEXT NOT NULL DEFAULT 'REMOTE' CHECK (mode IN ('ONSITE','REMOTE','PHONE')),
  interviewer_employee_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
  status                  TEXT NOT NULL DEFAULT 'SCHEDULED'
                            CHECK (status IN ('SCHEDULED','COMPLETED','CANCELLED','NO_SHOW')),
  -- CONFIDENTIAL: never surfaced to the EXTERNAL zone.
  evaluation              TEXT,
  score                   INTEGER CHECK (score IS NULL OR (score BETWEEN 1 AND 5)),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE INDEX idx_interviews_app ON interviews (tenant_id, application_id, scheduled_at);
CREATE INDEX idx_interviews_interviewer ON interviews (tenant_id, interviewer_employee_id, scheduled_at);

CREATE TABLE offers (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  base_salary    REAL NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'USD',
  start_date     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT','SENT','ACCEPTED','DECLINED','WITHDRAWN','EXPIRED')),
  expires_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX idx_offers_app ON offers (tenant_id, application_id);
