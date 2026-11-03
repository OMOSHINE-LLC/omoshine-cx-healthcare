export const config = {
  /** Owner connection: runs migrations. */
  adminDatabaseUrl: process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:5432/omoshine',
  /** Application connection: non-owner role subject to row-level security. */
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://omoshine_app:omoshine_app@localhost:5432/omoshine',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-secret-change-me-dev-only-secret',
  /** 'dev' enables email + PIN login. Production uses OIDC/SAML via the IdP broker. */
  authMode: (process.env.AUTH_MODE ?? 'dev') as 'dev' | 'oidc',
  port: Number(process.env.PORT ?? 3001),
  reauthMaxAgeSeconds: 300,
  /** Allow http and private-network webhook targets. Development and tests only. */
  webhookAllowInsecure: process.env.WEBHOOK_ALLOW_INSECURE === '1',
  /** Deliver webhooks from the API process (disable when a separate worker runs the dispatcher). */
  webhookDispatcher: process.env.WEBHOOK_DISPATCHER !== 'off',
};
