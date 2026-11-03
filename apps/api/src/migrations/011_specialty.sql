-- Specialty systems (nurse call, pneumatic tube, RTLS, imaging): interface test results.
-- Append-only; a retest is a new row and the latest row per interface counts.
CREATE TABLE interface_test (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  project_id uuid NOT NULL REFERENCES project(id),
  system_id uuid NOT NULL REFERENCES system(id),
  interface_key text NOT NULL,
  result text NOT NULL CHECK (result IN ('pass','fail')),
  tested_on date NOT NULL,
  evidence_reference text,
  notes text,
  issue_id uuid REFERENCES issue(id),
  recorded_by uuid NOT NULL REFERENCES app_user(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (result = 'pass' OR (notes IS NOT NULL AND length(trim(notes)) > 0))
);
CREATE INDEX interface_test_system ON interface_test (system_id, interface_key, tested_on DESC, recorded_at DESC);
CREATE TRIGGER interface_test_append_only BEFORE UPDATE OR DELETE ON interface_test FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE interface_test ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON interface_test USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON interface_test TO omoshine_app;
