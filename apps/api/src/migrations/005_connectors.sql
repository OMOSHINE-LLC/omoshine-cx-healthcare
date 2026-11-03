-- Integrations part 2: BAS trend imports, and Procore / Autodesk Construction Cloud issue sync.

CREATE TABLE bas_trend_import (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  project_id uuid NOT NULL REFERENCES project(id),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  rows_read int NOT NULL,
  summary jsonb NOT NULL,
  imported_by uuid NOT NULL REFERENCES app_user(id),
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER bas_trend_import_append_only BEFORE UPDATE OR DELETE ON bas_trend_import FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE external_connection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  project_id uuid NOT NULL REFERENCES project(id),
  provider text NOT NULL CHECK (provider IN ('procore','acc')),
  base_url text NOT NULL,
  external_project_id text NOT NULL,
  -- Provider-specific required ids, e.g. Procore company id and observation type, ACC issue subtype.
  settings jsonb NOT NULL DEFAULT '{}',
  -- Access token, AES-256-GCM encrypted with the server's secrets key. Never returned by the API.
  token_ciphertext text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  last_sync_at timestamptz,
  last_sync_result jsonb,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, provider)
);

CREATE TABLE external_issue_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  connection_id uuid NOT NULL REFERENCES external_connection(id),
  issue_id uuid NOT NULL REFERENCES issue(id),
  external_id text NOT NULL,
  pushed_sha256 text NOT NULL,
  pushed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, issue_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bas_trend_import','external_connection','external_issue_link']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
                   WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON bas_trend_import TO omoshine_app;
GRANT SELECT, INSERT, UPDATE ON external_connection, external_issue_link TO omoshine_app;
