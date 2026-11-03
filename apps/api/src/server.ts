import { buildApp } from './app.js';
import { config } from './config.js';
import { createPool } from './db.js';

import { startWebhookDispatcher } from './webhooks.js';

const db = createPool();
const app = await buildApp({ db, logger: true });
if (config.webhookDispatcher) startWebhookDispatcher(db, 10_000, (e) => app.log.error(e));
await app.listen({ port: config.port, host: '0.0.0.0' });
