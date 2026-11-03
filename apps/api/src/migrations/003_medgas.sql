-- Phase 2: medical gas and vacuum system verification (NFPA 99 Chapter 5)

CREATE TABLE medgas_zone (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  project_id uuid NOT NULL REFERENCES project(id),
  department_id uuid REFERENCES department(id),
  name text NOT NULL,
  zone_valve_tag text NOT NULL DEFAULT '',
  gases text[] NOT NULL CHECK (cardinality(gases) > 0 AND gases <@ ARRAY['oxygen','medical_air','nitrous_oxide','carbon_dioxide','nitrogen','instrument_air','vacuum']),
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE medgas_outlet (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  zone_id uuid NOT NULL REFERENCES medgas_zone(id),
  room_id uuid REFERENCES room(id),
  label text NOT NULL,
  gas text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (zone_id, label)
);

-- Every verification reading is kept; a retest adds a row and the latest result counts.
CREATE TABLE medgas_test (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  zone_id uuid NOT NULL REFERENCES medgas_zone(id),
  outlet_id uuid REFERENCES medgas_outlet(id),
  gas text,
  test_type text NOT NULL,
  readings jsonb NOT NULL,
  evaluation jsonb NOT NULL,
  overall text NOT NULL CHECK (overall IN ('pass','fail','incomplete')),
  verifier_credential text NOT NULL,
  instrument text,
  notes text,
  tested_at timestamptz NOT NULL,
  engine_version text NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app_user(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX medgas_test_zone ON medgas_test (zone_id, tested_at);

CREATE TRIGGER medgas_test_append_only BEFORE UPDATE OR DELETE ON medgas_test FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- The verifier's certification is an e-signature on the zone.
ALTER TABLE signature DROP CONSTRAINT signature_record_type_check;
ALTER TABLE signature ADD CONSTRAINT signature_record_type_check
  CHECK (record_type IN ('test_run','room_measurement','ees_test','icra_zone','medgas_zone'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['medgas_zone','medgas_outlet','medgas_test']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
                   WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON medgas_zone, medgas_outlet TO omoshine_app;
GRANT SELECT, INSERT ON medgas_test TO omoshine_app;
