-- Operations turnover documents and the signed final commissioning report.

CREATE TABLE turnover_document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  project_id uuid NOT NULL REFERENCES project(id),
  system_id uuid NOT NULL REFERENCES system(id),
  asset_id uuid REFERENCES asset(id),
  kind text NOT NULL CHECK (kind IN ('om_manual','warranty','as_built','training_record','spare_parts','tab_report','acceptance_test_report','sequence_of_operations','certificate')),
  title text NOT NULL,
  -- Where the document lives (document management system path or link). Files themselves are not stored here.
  reference text NOT NULL,
  warranty_start date,
  warranty_months int CHECK (warranty_months IS NULL OR warranty_months BETWEEN 1 AND 600),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','accepted','rejected')),
  review_note text,
  reviewed_by uuid REFERENCES app_user(id),
  reviewed_at timestamptz,
  submitted_by uuid NOT NULL REFERENCES app_user(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'warranty' OR (warranty_start IS NOT NULL AND warranty_months IS NOT NULL)),
  CHECK (status <> 'rejected' OR (review_note IS NOT NULL AND length(review_note) >= 3))
);
CREATE INDEX turnover_document_system ON turnover_document (system_id, kind, submitted_at DESC);

-- Reviewed documents are closed; a correction is a new submission.
CREATE FUNCTION guard_turnover_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'submitted' THEN
    RAISE EXCEPTION 'IMMUTABLE: a reviewed turnover document cannot be changed; submit a new version' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER turnover_document_guard BEFORE UPDATE OR DELETE ON turnover_document FOR EACH ROW EXECUTE FUNCTION guard_turnover_document();

CREATE TABLE final_report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  project_id uuid NOT NULL REFERENCES project(id),
  version int NOT NULL,
  html text NOT NULL,
  html_sha256 text NOT NULL,
  summary jsonb NOT NULL,
  signature_id uuid NOT NULL REFERENCES signature(id),
  issued_by uuid NOT NULL REFERENCES app_user(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);
CREATE TRIGGER final_report_append_only BEFORE UPDATE OR DELETE ON final_report FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE signature DROP CONSTRAINT signature_record_type_check;
ALTER TABLE signature ADD CONSTRAINT signature_record_type_check
  CHECK (record_type IN ('test_run','room_measurement','ees_test','icra_zone','medgas_zone','phase','final_report'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['turnover_document','final_report']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
                   WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON turnover_document TO omoshine_app;
GRANT SELECT, INSERT ON final_report TO omoshine_app;
