-- Single sign-on (OpenID Connect, authorization code with PKCE), configured per tenant.

CREATE TABLE sso_connection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL,
  issuer text NOT NULL,
  client_id text NOT NULL,
  client_secret_ciphertext text,
  -- Users whose email is at one of these domains sign in through this connection.
  email_domains text[] NOT NULL CHECK (cardinality(email_domains) > 0),
  -- Create an account (with no project roles) on first sign-in; otherwise an administrator adds people first.
  auto_provision boolean NOT NULL DEFAULT false,
  -- When false, e-signatures need an SSO step-up; the signing PIN is refused.
  allow_pin_signing boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One active connection per email domain across all tenants.
CREATE TABLE sso_domain (
  domain text PRIMARY KEY CHECK (domain = lower(domain)),
  connection_id uuid NOT NULL REFERENCES sso_connection(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenant(id)
);

-- The identity provider's subject for each linked user. Once linked, a different subject for the same email is refused.
ALTER TABLE app_user ADD COLUMN sso_issuer text, ADD COLUMN sso_subject text;
CREATE UNIQUE INDEX app_user_sso_identity ON app_user (sso_issuer, sso_subject) WHERE sso_subject IS NOT NULL;

-- Pending sign-ins. Looked up before the tenant is known; holds no tenant data beyond the connection id.
CREATE TABLE sso_login_state (
  state text PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES sso_connection(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('login','reauth')),
  user_id uuid REFERENCES app_user(id),
  code_verifier text NOT NULL,
  nonce text NOT NULL,
  redirect_uri text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);

ALTER TABLE sso_connection ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sso_connection USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE sso_domain ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sso_domain USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON sso_connection TO omoshine_app;
GRANT SELECT, INSERT, DELETE ON sso_domain TO omoshine_app;
REVOKE ALL ON sso_login_state FROM omoshine_app;

-- Pre-authentication lookups run as the owner and return only what sign-in needs.
CREATE FUNCTION sso_connection_for_domain(p_domain text)
RETURNS TABLE (id uuid, tenant_id uuid, issuer text, client_id text, allow_pin_signing boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.tenant_id, c.issuer, c.client_id, c.allow_pin_signing
    FROM sso_domain d JOIN sso_connection c ON c.id = d.connection_id
   WHERE d.domain = lower(p_domain) AND c.active
$$;

CREATE FUNCTION sso_begin(p_state text, p_connection uuid, p_purpose text, p_user uuid, p_verifier text, p_nonce text, p_redirect text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM sso_login_state WHERE created_at < now() - interval '1 day';
  INSERT INTO sso_login_state (state, connection_id, purpose, user_id, code_verifier, nonce, redirect_uri)
  VALUES (p_state, p_connection, p_purpose, p_user, p_verifier, p_nonce, p_redirect);
$$;

-- Single use and valid for 10 minutes.
CREATE FUNCTION sso_consume(p_state text)
RETURNS TABLE (connection_id uuid, tenant_id uuid, purpose text, user_id uuid, code_verifier text, nonce text, redirect_uri text,
               issuer text, client_id text, client_secret_ciphertext text, auto_provision boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE sso_login_state s SET used_at = now()
    FROM sso_connection c
   WHERE s.state = p_state AND s.used_at IS NULL AND s.created_at > now() - interval '10 minutes' AND c.id = s.connection_id AND c.active
  RETURNING s.connection_id, c.tenant_id, s.purpose, s.user_id, s.code_verifier, s.nonce, s.redirect_uri,
            c.issuer, c.client_id, c.client_secret_ciphertext, c.auto_provision
$$;

-- Find (or provision) the user for a verified identity inside the connection's tenant.
CREATE FUNCTION sso_resolve_user(p_tenant uuid, p_email text, p_name text, p_issuer text, p_subject text, p_provision boolean)
RETURNS TABLE (id uuid, name text, outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u app_user%ROWTYPE;
BEGIN
  SELECT * INTO u FROM app_user WHERE sso_issuer = p_issuer AND sso_subject = p_subject;
  IF FOUND THEN
    IF u.tenant_id <> p_tenant THEN RETURN QUERY SELECT NULL::uuid, NULL::text, 'wrong_tenant'; RETURN; END IF;
    RETURN QUERY SELECT u.id, u.name, 'ok'; RETURN;
  END IF;
  SELECT * INTO u FROM app_user WHERE lower(email) = lower(p_email);
  IF FOUND THEN
    IF u.tenant_id <> p_tenant THEN RETURN QUERY SELECT NULL::uuid, NULL::text, 'wrong_tenant'; RETURN; END IF;
    IF u.is_service THEN RETURN QUERY SELECT NULL::uuid, NULL::text, 'no_account'; RETURN; END IF;
    IF u.sso_subject IS NOT NULL THEN RETURN QUERY SELECT NULL::uuid, NULL::text, 'identity_mismatch'; RETURN; END IF;
    UPDATE app_user SET sso_issuer = p_issuer, sso_subject = p_subject WHERE app_user.id = u.id;
    RETURN QUERY SELECT u.id, u.name, 'linked'; RETURN;
  END IF;
  IF NOT p_provision THEN RETURN QUERY SELECT NULL::uuid, NULL::text, 'no_account'; RETURN; END IF;
  INSERT INTO app_user (tenant_id, email, name, sso_issuer, sso_subject) VALUES (p_tenant, lower(p_email), p_name, p_issuer, p_subject) RETURNING * INTO u;
  RETURN QUERY SELECT u.id, u.name, 'provisioned';
END $$;

REVOKE ALL ON FUNCTION sso_connection_for_domain(text), sso_begin(text, uuid, text, uuid, text, text, text), sso_consume(text),
  sso_resolve_user(uuid, text, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sso_connection_for_domain(text), sso_begin(text, uuid, text, uuid, text, text, text), sso_consume(text),
  sso_resolve_user(uuid, text, text, text, text, boolean) TO omoshine_app;
