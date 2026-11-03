-- Recurring compliance tasks after occupancy, and owner training.

CREATE TABLE compliance_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  project_id uuid NOT NULL REFERENCES project(id),
  kind text NOT NULL,
  label text NOT NULL,
  category text NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('asset','room','medgas_zone','project')),
  target_id uuid,
  every int NOT NULL CHECK (every > 0),
  unit text NOT NULL CHECK (unit IN ('day','week','month')),
  grace_days int NOT NULL DEFAULT 0 CHECK (grace_days >= 0),
  checks jsonb NOT NULL,
  start_on date NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((target_type = 'project') = (target_id IS NULL))
);
CREATE UNIQUE INDEX compliance_task_unique ON compliance_task (project_id, kind, COALESCE(target_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE compliance_completion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  task_id uuid NOT NULL REFERENCES compliance_task(id),
  performed_on date NOT NULL,
  answers jsonb NOT NULL,
  result text NOT NULL CHECK (result IN ('pass','fail')),
  notes text,
  issue_id uuid REFERENCES issue(id),
  recorded_by uuid NOT NULL REFERENCES app_user(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX compliance_completion_task ON compliance_completion (task_id, performed_on DESC);
CREATE TRIGGER compliance_completion_append_only BEFORE UPDATE OR DELETE ON compliance_completion FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE training_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  project_id uuid NOT NULL REFERENCES project(id),
  system_id uuid REFERENCES system(id),
  topic text NOT NULL,
  audiences text[] NOT NULL CHECK (cardinality(audiences) > 0),
  trainer text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  duration_min int NOT NULL CHECK (duration_min BETWEEN 5 AND 1440),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','held','cancelled')),
  -- Where the agenda, sign-in sheet or recording is filed.
  materials_reference text,
  held_at timestamptz,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Staff who attended (names and roles only; no patient information).
CREATE TABLE training_attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  session_id uuid NOT NULL REFERENCES training_session(id),
  attendee_name text NOT NULL,
  audience text NOT NULL,
  department text,
  recorded_by uuid NOT NULL REFERENCES app_user(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, attendee_name)
);
CREATE TRIGGER training_attendance_append_only BEFORE UPDATE OR DELETE ON training_attendance FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A held or cancelled session is a closed record.
CREATE FUNCTION guard_training_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'scheduled' THEN
    RAISE EXCEPTION 'IMMUTABLE: a held or cancelled training session cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER training_session_guard BEFORE UPDATE OR DELETE ON training_session FOR EACH ROW EXECUTE FUNCTION guard_training_session();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['compliance_task','compliance_completion','training_session','training_attendance']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
                   WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON compliance_task, training_session TO omoshine_app;
GRANT SELECT, INSERT ON compliance_completion, training_attendance TO omoshine_app;
