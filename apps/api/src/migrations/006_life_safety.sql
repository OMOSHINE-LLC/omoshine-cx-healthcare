-- Life safety module: dampers, fire and smoke doors, fire alarm devices, and the
-- Statement of Conditions plan-for-improvement (PFI) list.

CREATE TABLE ls_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  project_id uuid NOT NULL REFERENCES project(id),
  kind text NOT NULL,
  tag text NOT NULL,
  room_id uuid REFERENCES room(id),
  location text NOT NULL DEFAULT '',
  rating_minutes int CHECK (rating_minutes IS NULL OR rating_minutes IN (20, 45, 60, 90, 180)),
  installed_on date,
  attributes jsonb NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, tag)
);

CREATE TABLE ls_inspection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  item_id uuid NOT NULL REFERENCES ls_item(id),
  performed_on date NOT NULL,
  answers jsonb NOT NULL,
  results jsonb NOT NULL,
  overall text NOT NULL CHECK (overall IN ('pass','fail','incomplete')),
  inspector_credential text,
  notes text,
  issue_id uuid REFERENCES issue(id),
  recorded_by uuid NOT NULL REFERENCES app_user(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ls_inspection_item ON ls_inspection (item_id, performed_on DESC);
CREATE TRIGGER ls_inspection_append_only BEFORE UPDATE OR DELETE ON ls_inspection FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE pfi_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  project_id uuid NOT NULL REFERENCES project(id),
  number int NOT NULL,
  deficiency text NOT NULL,
  code_reference text NOT NULL DEFAULT '',
  location text NOT NULL,
  planned_completion date NOT NULL,
  estimated_cost numeric,
  ilsm_assessment_id uuid REFERENCES ilsm_assessment(id),
  ls_item_id uuid REFERENCES ls_item(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution text,
  resolved_at timestamptz,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);

-- Resolved PFI items are closed records.
CREATE FUNCTION guard_pfi() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'resolved' THEN
    RAISE EXCEPTION 'IMMUTABLE: resolved plan-for-improvement items cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pfi_guard BEFORE UPDATE OR DELETE ON pfi_item FOR EACH ROW EXECUTE FUNCTION guard_pfi();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ls_item','ls_inspection','pfi_item']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
                   WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON ls_item, pfi_item TO omoshine_app;
GRANT SELECT, INSERT ON ls_inspection TO omoshine_app;
