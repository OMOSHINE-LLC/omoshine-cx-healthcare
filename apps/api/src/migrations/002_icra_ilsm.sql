-- Phase 2: Infection Control Risk Assessment (ICRA) and Interim Life Safety Measures (ILSM)

CREATE TABLE icra_zone (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  project_id uuid NOT NULL REFERENCES project(id),
  department_id uuid REFERENCES department(id),
  name text NOT NULL,
  construction_type char(1) NOT NULL CHECK (construction_type IN ('A','B','C','D')),
  risk_group text NOT NULL CHECK (risk_group IN ('low','medium','high','highest')),
  class_override text CHECK (class_override IN ('I','II','III','IV')),
  icra_class text NOT NULL CHECK (icra_class IN ('I','II','III','IV')),
  barrier_type text,
  adjacent_areas text NOT NULL DEFAULT '',
  min_negative_pressure_in_wc numeric CHECK (min_negative_pressure_in_wc IS NULL OR min_negative_pressure_in_wc > 0),
  active boolean NOT NULL DEFAULT true,
  starts_on date,
  ends_on date,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE icra_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  zone_id uuid NOT NULL REFERENCES icra_zone(id),
  logged_at timestamptz NOT NULL,
  icra_class text NOT NULL,
  readings jsonb NOT NULL,
  evaluation jsonb NOT NULL,
  overall text NOT NULL CHECK (overall IN ('pass','fail','incomplete')),
  corrective_action text,
  recorded_by uuid NOT NULL REFERENCES app_user(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX icra_log_zone ON icra_log (zone_id, logged_at DESC);

CREATE TABLE ilsm_assessment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  project_id uuid NOT NULL REFERENCES project(id),
  deficiency_type text NOT NULL,
  description text NOT NULL,
  location text NOT NULL,
  identified_at timestamptz NOT NULL,
  expected_out_of_service_hours numeric NOT NULL CHECK (expected_out_of_service_hours >= 0),
  required_measures jsonb NOT NULL,
  implemented_measures jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_at timestamptz,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fire_watch_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  assessment_id uuid NOT NULL REFERENCES ilsm_assessment(id),
  patrolled_at timestamptz NOT NULL,
  area text NOT NULL,
  all_clear boolean NOT NULL,
  findings text NOT NULL DEFAULT '',
  recorded_by uuid NOT NULL REFERENCES app_user(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fire_watch_assessment ON fire_watch_log (assessment_id, patrolled_at);

CREATE TRIGGER icra_log_append_only BEFORE UPDATE OR DELETE ON icra_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER fire_watch_append_only BEFORE UPDATE OR DELETE ON fire_watch_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Resolved assessments are closed records.
CREATE FUNCTION guard_ilsm() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'resolved' THEN
    RAISE EXCEPTION 'IMMUTABLE: resolved ILSM assessments cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ilsm_guard BEFORE UPDATE OR DELETE ON ilsm_assessment FOR EACH ROW EXECUTE FUNCTION guard_ilsm();

-- Infection Prevention permits are e-signatures on the zone.
ALTER TABLE signature DROP CONSTRAINT signature_record_type_check;
ALTER TABLE signature ADD CONSTRAINT signature_record_type_check
  CHECK (record_type IN ('test_run','room_measurement','ees_test','icra_zone'));
-- A signature is unique per version of the record, so a changed record (e.g. an ICRA zone whose class changed) can be signed again.
ALTER TABLE signature DROP CONSTRAINT signature_record_type_record_id_signer_id_meaning_key;
ALTER TABLE signature ADD CONSTRAINT signature_unique_per_version UNIQUE (record_type, record_id, record_sha256, signer_id, meaning);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['icra_zone','icra_log','ilsm_assessment','fire_watch_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
                   WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON icra_zone, ilsm_assessment TO omoshine_app;
GRANT SELECT, INSERT ON icra_log, fire_watch_log TO omoshine_app;
