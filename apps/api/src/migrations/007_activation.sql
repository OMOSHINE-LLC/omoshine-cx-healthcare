-- Phased occupancy and activation: a checklist per phase and the ready / occupied sign-offs.

CREATE TABLE activation_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  phase_id uuid NOT NULL REFERENCES phase(id),
  key text NOT NULL,
  label text NOT NULL,
  category text NOT NULL CHECK (category IN ('regulatory','life_safety','infection_control','facilities','clinical','it')),
  required boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'template' CHECK (source IN ('template','custom')),
  sort int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','na')),
  evidence text,
  completed_by uuid REFERENCES app_user(id),
  completed_at timestamptz,
  UNIQUE (phase_id, key),
  CHECK (status = 'open' OR (evidence IS NOT NULL AND length(evidence) >= 3 AND completed_by IS NOT NULL))
);

CREATE TABLE phase_signoff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  phase_id uuid NOT NULL REFERENCES phase(id),
  kind text NOT NULL CHECK (kind IN ('ready','occupied')),
  occupied_on date,
  snapshot jsonb NOT NULL,
  snapshot_sha256 text NOT NULL,
  signature_id uuid NOT NULL REFERENCES signature(id),
  signed_by uuid NOT NULL REFERENCES app_user(id),
  signed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'occupied' OR occupied_on IS NOT NULL)
);
CREATE TRIGGER phase_signoff_append_only BEFORE UPDATE OR DELETE ON phase_signoff FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- An occupied phase is a closed record: its checklist and status no longer change.
CREATE FUNCTION guard_activation_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM phase WHERE id = COALESCE(NEW.phase_id, OLD.phase_id) AND status = 'occupied') THEN
    RAISE EXCEPTION 'IMMUTABLE: the phase is occupied; its activation checklist is closed' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER activation_item_guard BEFORE INSERT OR UPDATE OR DELETE ON activation_item FOR EACH ROW EXECUTE FUNCTION guard_activation_item();

CREATE FUNCTION guard_phase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'occupied' THEN
    RAISE EXCEPTION 'IMMUTABLE: an occupied phase cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER phase_guard BEFORE UPDATE ON phase FOR EACH ROW EXECUTE FUNCTION guard_phase();

ALTER TABLE signature DROP CONSTRAINT signature_record_type_check;
ALTER TABLE signature ADD CONSTRAINT signature_record_type_check
  CHECK (record_type IN ('test_run','room_measurement','ees_test','icra_zone','medgas_zone','phase'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['activation_item','phase_signoff']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
                   WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON activation_item TO omoshine_app;
GRANT SELECT, INSERT ON phase_signoff TO omoshine_app;
GRANT UPDATE ON phase TO omoshine_app;
