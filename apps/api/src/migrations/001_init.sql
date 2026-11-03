-- OMOSHINE CX Planner – Healthcare Edition: initial schema (MVP)
-- No PHI is stored anywhere in this schema.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Tenancy and people
-- ---------------------------------------------------------------------------
CREATE TABLE tenant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  license_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('owner','cxa','gc','trade','tab','ahj','design','verifier','other')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid REFERENCES organization(id),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  is_tenant_admin boolean NOT NULL DEFAULT false,
  -- scrypt hash used to re-authenticate before e-signing (dev mode; SSO step-up in production)
  signing_pin_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Asset hierarchy: Building > Phase > Floor > Department > Room > System > Asset
-- ---------------------------------------------------------------------------
CREATE TABLE project (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL,
  facility_name text NOT NULL,
  state_code char(2) NOT NULL,
  accreditor text NOT NULL DEFAULT 'TJC' CHECK (accreditor IN ('TJC','DNV','HFAP','NONE')),
  project_type text NOT NULL DEFAULT 'renovation' CHECK (project_type IN ('new','expansion','renovation')),
  occupied_building boolean NOT NULL DEFAULT true,
  -- Code editions adopted for this project, e.g. [{"code":"NFPA 99","edition":"2012","source":"CMS"}]
  adopted_codes jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_user(id)
);

CREATE TABLE building (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  project_id uuid NOT NULL REFERENCES project(id),
  name text NOT NULL,
  construction_type text
);

CREATE TABLE phase (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  project_id uuid NOT NULL REFERENCES project(id),
  name text NOT NULL,
  sequence int NOT NULL DEFAULT 1,
  target_occupancy_date date,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','ready','occupied'))
);

CREATE TABLE floor (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  building_id uuid NOT NULL REFERENCES building(id),
  name text NOT NULL,
  level int NOT NULL DEFAULT 1
);

CREATE TABLE department (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  floor_id uuid NOT NULL REFERENCES floor(id),
  phase_id uuid REFERENCES phase(id),
  name text NOT NULL,
  clinical_service text
);

CREATE TABLE room (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  department_id uuid NOT NULL REFERENCES department(id),
  phase_id uuid REFERENCES phase(id),
  number text NOT NULL,
  name text NOT NULL,
  space_type_id text NOT NULL,
  area_sqft numeric,
  volume_cuft numeric NOT NULL CHECK (volume_cuft > 0),
  qr_code text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(9), 'hex'),
  design jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE system (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  project_id uuid NOT NULL REFERENCES project(id),
  name text NOT NULL,
  discipline text NOT NULL DEFAULT 'mechanical',
  system_type text NOT NULL
);

CREATE TABLE system_room (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  system_id uuid NOT NULL REFERENCES system(id),
  room_id uuid NOT NULL REFERENCES room(id),
  PRIMARY KEY (system_id, room_id)
);

CREATE TABLE asset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  system_id uuid NOT NULL REFERENCES system(id),
  room_id uuid REFERENCES room(id),
  tag text NOT NULL,
  asset_type text NOT NULL,
  manufacturer text,
  model text,
  serial text,
  -- e.g. {"branch":"life_safety"} for an ATS, {"rating_kw":1500,"mfr_min_exhaust_temp_f":650} for a generator
  attributes jsonb NOT NULL DEFAULT '{}',
  qr_code text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(9), 'hex')
);

CREATE TABLE role_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  project_id uuid NOT NULL REFERENCES project(id),
  role text NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('project','phase','department','system')),
  scope_id uuid NOT NULL,
  UNIQUE (user_id, role, scope_type, scope_id)
);

-- Project / AHJ-specific requirement overlays (state overlays ship in the rules library)
CREATE TABLE project_overlay (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  project_id uuid NOT NULL REFERENCES project(id),
  action text NOT NULL CHECK (action IN ('replace','add','disable')),
  requirement_key text NOT NULL,
  requirement jsonb,
  effective_date date NOT NULL,
  source_note text NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Templates, checklists and functional tests
-- ---------------------------------------------------------------------------
CREATE TABLE template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenant(id), -- NULL = global OMOSHINE library
  family_id uuid NOT NULL,
  version int NOT NULL DEFAULT 1,
  kind text NOT NULL CHECK (kind IN ('pfc','fpt','ees_monthly','ees_annual')),
  name text NOT NULL,
  applies_to_system_type text,
  published boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, version)
);

CREATE TABLE template_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES template(id),
  seq int NOT NULL,
  prompt text NOT NULL,
  response_type text NOT NULL CHECK (response_type IN ('pass_fail','number','text')),
  unit text,
  required boolean NOT NULL DEFAULT true,
  requirement_key text,
  UNIQUE (template_id, seq)
);

CREATE TABLE test_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  project_id uuid NOT NULL REFERENCES project(id),
  template_id uuid NOT NULL REFERENCES template(id),
  target_type text NOT NULL CHECK (target_type IN ('system','asset','room')),
  target_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted','signed','superseded')),
  result text CHECK (result IN ('pass','fail')),
  supersedes uuid REFERENCES test_run(id),
  superseded_by uuid REFERENCES test_run(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  created_by uuid NOT NULL REFERENCES app_user(id)
);

CREATE TABLE test_response (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  test_run_id uuid NOT NULL REFERENCES test_run(id),
  template_item_id uuid NOT NULL REFERENCES template_item(id),
  value text,
  status text NOT NULL CHECK (status IN ('pass','fail','not_evaluated')),
  evaluation jsonb,
  note text,
  updated_by uuid NOT NULL REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (test_run_id, template_item_id)
);

-- ---------------------------------------------------------------------------
-- Issues with ball-in-court
-- ---------------------------------------------------------------------------
CREATE TABLE issue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  project_id uuid NOT NULL REFERENCES project(id),
  number int NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  room_id uuid REFERENCES room(id),
  system_id uuid REFERENCES system(id),
  asset_id uuid REFERENCES asset(id),
  test_run_id uuid REFERENCES test_run(id),
  requirement_key text,
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  life_safety boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','ready_for_review','closed')),
  ball_in_court_org_id uuid REFERENCES organization(id),
  due_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES app_user(id),
  closed_at timestamptz,
  UNIQUE (project_id, number)
);

CREATE TABLE issue_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  issue_id uuid NOT NULL REFERENCES issue(id),
  kind text NOT NULL CHECK (kind IN ('created','comment','status_change','reassigned')),
  payload jsonb NOT NULL DEFAULT '{}',
  actor_id uuid NOT NULL REFERENCES app_user(id),
  at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Room measurements (ASHRAE 170) and EES tests: append-only
-- ---------------------------------------------------------------------------
CREATE TABLE room_measurement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  room_id uuid NOT NULL REFERENCES room(id),
  source text NOT NULL CHECK (source IN ('tab','bas','manual')),
  measured_at timestamptz NOT NULL,
  readings jsonb NOT NULL,
  evaluation jsonb NOT NULL,
  overall text NOT NULL CHECK (overall IN ('pass','fail','incomplete')),
  life_safety_failure boolean NOT NULL,
  engine_version text NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app_user(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ees_test (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  asset_id uuid NOT NULL REFERENCES asset(id),
  test_type text NOT NULL CHECK (test_type IN ('ats_transfer','generator_monthly','generator_triennial')),
  performed_at timestamptz NOT NULL,
  readings jsonb NOT NULL,
  evaluation jsonb NOT NULL,
  overall text NOT NULL CHECK (overall IN ('pass','fail','incomplete')),
  life_safety_failure boolean NOT NULL DEFAULT false,
  engine_version text NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app_user(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- E-signatures and audit trail: append-only
-- ---------------------------------------------------------------------------
CREATE TABLE signature (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  record_type text NOT NULL CHECK (record_type IN ('test_run','room_measurement','ees_test')),
  record_id uuid NOT NULL,
  record_sha256 text NOT NULL,
  signer_id uuid NOT NULL REFERENCES app_user(id),
  signer_name text NOT NULL,
  signer_role text NOT NULL,
  meaning text NOT NULL CHECK (meaning IN ('performed','witnessed','reviewed','approved','ahj_accepted')),
  reauth_method text NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (record_type, record_id, signer_id, meaning)
);

CREATE TABLE audit_log (
  seq bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  actor_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  data jsonb NOT NULL,
  at timestamptz NOT NULL,
  prev_hash text NOT NULL,
  hash text NOT NULL UNIQUE
);
CREATE INDEX audit_log_entity ON audit_log (tenant_id, entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Immutability guards
-- ---------------------------------------------------------------------------
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE: % rows cannot be updated or deleted', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER room_measurement_append_only BEFORE UPDATE OR DELETE ON room_measurement FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ees_test_append_only BEFORE UPDATE OR DELETE ON ees_test FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER signature_append_only BEFORE UPDATE OR DELETE ON signature FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER issue_event_append_only BEFORE UPDATE OR DELETE ON issue_event FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A signed test run is frozen. The only permitted change is signed -> superseded,
-- which links the new run and changes nothing else.
CREATE FUNCTION guard_test_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE: test runs cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('signed','superseded') THEN
    IF OLD.status = 'signed' AND NEW.status = 'superseded' AND OLD.superseded_by IS NULL AND NEW.superseded_by IS NOT NULL
       AND (to_jsonb(NEW) - 'status' - 'superseded_by') = (to_jsonb(OLD) - 'status' - 'superseded_by') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'IMMUTABLE: signed test run % cannot be changed; create a superseding run', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER test_run_guard BEFORE UPDATE OR DELETE ON test_run FOR EACH ROW EXECUTE FUNCTION guard_test_run();

CREATE FUNCTION guard_test_response() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_status text;
BEGIN
  SELECT status INTO run_status FROM test_run WHERE id = COALESCE(NEW.test_run_id, OLD.test_run_id);
  IF run_status <> 'in_progress' THEN
    RAISE EXCEPTION 'IMMUTABLE: responses are locked once a test run is submitted' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER test_response_guard BEFORE INSERT OR UPDATE OR DELETE ON test_response FOR EACH ROW EXECUTE FUNCTION guard_test_response();

CREATE FUNCTION guard_template() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published THEN
    RAISE EXCEPTION 'IMMUTABLE: published template versions cannot change; create a new version' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER template_guard BEFORE UPDATE OR DELETE ON template FOR EACH ROW EXECUTE FUNCTION guard_template();

CREATE FUNCTION guard_template_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE is_pub boolean;
BEGIN
  SELECT published INTO is_pub FROM template WHERE id = COALESCE(NEW.template_id, OLD.template_id);
  IF is_pub THEN
    RAISE EXCEPTION 'IMMUTABLE: items of a published template cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER template_item_guard BEFORE INSERT OR UPDATE OR DELETE ON template_item FOR EACH ROW EXECUTE FUNCTION guard_template_item();

-- ---------------------------------------------------------------------------
-- Tenant isolation (row-level security). The application connects as the
-- non-owner role omoshine_app and sets app.tenant_id per transaction.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organization','app_user','project','building','phase','floor','department','room','system',
    'system_room','asset','role_assignment','project_overlay','test_run','test_response','issue','issue_event',
    'room_measurement','ees_test','signature','audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
                   WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Templates: global (tenant_id NULL) rows are readable by all tenants.
ALTER TABLE template ENABLE ROW LEVEL SECURITY;
CREATE POLICY template_read ON template FOR SELECT USING (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY template_write ON template FOR ALL USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Login lookup runs before a tenant is known.
CREATE FUNCTION auth_lookup_user(p_email text)
RETURNS TABLE (id uuid, tenant_id uuid, name text, signing_pin_hash text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id, tenant_id, name, signing_pin_hash FROM app_user WHERE lower(email) = lower(p_email)
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'omoshine_app') THEN
    CREATE ROLE omoshine_app LOGIN PASSWORD 'omoshine_app';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO omoshine_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO omoshine_app;
-- Append-only tables: no UPDATE/DELETE privilege at all (triggers are a second layer).
REVOKE UPDATE, DELETE ON room_measurement, ees_test, signature, audit_log, issue_event FROM omoshine_app;
REVOKE INSERT, UPDATE, DELETE ON tenant FROM omoshine_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO omoshine_app;
GRANT EXECUTE ON FUNCTION auth_lookup_user(text) TO omoshine_app;
