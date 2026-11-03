-- Integrations part 1: API keys for system-to-system access, and signed outbound webhooks.

-- Integration (service) users act through API keys. They hold role assignments like people,
-- but have no signing PIN, so they can never apply an e-signature.
ALTER TABLE app_user ADD COLUMN is_service boolean NOT NULL DEFAULT false;

CREATE TABLE api_key (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  name text NOT NULL,
  prefix text NOT NULL UNIQUE,
  secret_sha256 text NOT NULL,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- Keys are looked up before the tenant is known, so resolution runs as the owner
-- and returns only what authentication needs.
CREATE FUNCTION resolve_api_key(p_prefix text)
RETURNS TABLE (key_id uuid, tenant_id uuid, user_id uuid, user_name text, secret_sha256 text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT k.id, k.tenant_id, k.user_id, u.name, k.secret_sha256
    FROM api_key k JOIN app_user u ON u.id = k.user_id
   WHERE k.prefix = p_prefix AND k.revoked_at IS NULL
$$;
REVOKE ALL ON FUNCTION resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO omoshine_app;

CREATE FUNCTION touch_api_key(p_key uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE api_key SET last_used_at = now() WHERE id = p_key AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')
$$;
REVOKE ALL ON FUNCTION touch_api_key(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION touch_api_key(uuid) TO omoshine_app;

CREATE TABLE webhook (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  project_id uuid REFERENCES project(id),
  url text NOT NULL,
  secret text NOT NULL,
  events text[] NOT NULL CHECK (cardinality(events) > 0),
  active boolean NOT NULL DEFAULT true,
  description text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Outbox: deliveries are written in the same transaction as the change that caused them.
CREATE TABLE webhook_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  webhook_id uuid NOT NULL REFERENCES webhook(id),
  event text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status_code int,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_delivery_due ON webhook_delivery (next_attempt_at) WHERE status = 'pending';

-- The dispatcher works across tenants: it claims due deliveries with a lease, then reports the outcome.
CREATE FUNCTION claim_webhook_deliveries(p_limit int, p_lease_seconds int)
RETURNS TABLE (id uuid, tenant_id uuid, event text, payload jsonb, attempts int, url text, secret text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH due AS (
    SELECT d.id FROM webhook_delivery d JOIN webhook w ON w.id = d.webhook_id
     WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND w.active
     ORDER BY d.next_attempt_at LIMIT p_limit FOR UPDATE OF d SKIP LOCKED
  )
  UPDATE webhook_delivery d SET next_attempt_at = now() + make_interval(secs => p_lease_seconds), attempts = d.attempts + 1
    FROM due, webhook w
   WHERE d.id = due.id AND w.id = d.webhook_id
  RETURNING d.id, d.tenant_id, d.event, d.payload, d.attempts, w.url, w.secret
$$;
REVOKE ALL ON FUNCTION claim_webhook_deliveries(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_webhook_deliveries(int, int) TO omoshine_app;

CREATE FUNCTION complete_webhook_delivery(p_id uuid, p_ok boolean, p_status_code int, p_error text, p_retry_in_seconds int)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE webhook_delivery SET
    status = CASE WHEN p_ok THEN 'delivered' WHEN p_retry_in_seconds IS NULL THEN 'failed' ELSE 'pending' END,
    delivered_at = CASE WHEN p_ok THEN now() ELSE NULL END,
    next_attempt_at = CASE WHEN p_retry_in_seconds IS NULL THEN next_attempt_at ELSE now() + make_interval(secs => p_retry_in_seconds) END,
    last_status_code = p_status_code,
    last_error = left(p_error, 500)
  WHERE id = p_id
$$;
REVOKE ALL ON FUNCTION complete_webhook_delivery(uuid, boolean, int, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_webhook_delivery(uuid, boolean, int, text, int) TO omoshine_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_key','webhook','webhook_delivery']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
                   WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON api_key, webhook TO omoshine_app;
GRANT SELECT, INSERT ON webhook_delivery TO omoshine_app;
