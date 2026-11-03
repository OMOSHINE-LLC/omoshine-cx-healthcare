import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { config } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));

interface SeedItem { prompt: string; type: 'pass_fail' | 'number' | 'text'; unit?: string; required?: boolean; requirementKey?: string }
interface SeedTemplate { kind: 'pfc' | 'fpt' | 'ees_monthly' | 'ees_annual'; name: string; systemType: string; items: SeedItem[] }

/** OMOSHINE global template library (original content). */
export const GLOBAL_TEMPLATES: SeedTemplate[] = [
  {
    kind: 'pfc', name: 'Pre-functional checklist – Air handling unit', systemType: 'hvac',
    items: [
      { prompt: 'Unit installed per approved submittal; nameplate data recorded', type: 'pass_fail' },
      { prompt: 'Filters installed at design MERV rating; final filters sealed in frames', type: 'pass_fail' },
      { prompt: 'Fan rotation verified and belts/couplings aligned', type: 'pass_fail' },
      { prompt: 'Controls point-to-point check complete', type: 'pass_fail' },
      { prompt: 'Humidifier and drain pan installed and trapped', type: 'pass_fail' },
      { prompt: 'Notes', type: 'text', required: false },
    ],
  },
  {
    kind: 'fpt', name: 'Functional test – Airborne infection isolation room', systemType: 'hvac',
    items: [
      { prompt: 'Measured total air changes per hour', type: 'number', unit: 'ACH', requirementKey: 'ashrae170.aiir.total_ach' },
      { prompt: 'Measured outdoor air changes per hour', type: 'number', unit: 'ACH', requirementKey: 'ashrae170.aiir.oa_ach' },
      { prompt: 'Room negative to corridor and anteroom (smoke test at door)', type: 'pass_fail' },
      { prompt: 'Pressure monitor alarms locally and at the nurse station when negative pressure is lost', type: 'pass_fail' },
      { prompt: 'Exhaust discharges outdoors away from intakes', type: 'pass_fail' },
    ],
  },
  {
    kind: 'fpt', name: 'Functional test – Automatic transfer switch (EES)', systemType: 'ees',
    items: [
      { prompt: 'Normal source interrupted at upstream device; generator start signal sent', type: 'pass_fail' },
      { prompt: 'Time from loss of normal power to load energized on emergency source', type: 'number', unit: 's', requirementKey: 'nfpa110.level1.type10.transfer_time' },
      { prompt: 'All branch loads energized on emergency source (spot-check panel)', type: 'pass_fail' },
      { prompt: 'Retransfer to normal after time delay with no nuisance trips', type: 'pass_fail' },
      { prompt: 'Generator cooldown run observed', type: 'pass_fail' },
    ],
  },
  {
    kind: 'ees_monthly', name: 'Monthly generator test (carries into operations)', systemType: 'ees',
    items: [
      { prompt: 'Run time under load', type: 'number', unit: 'min', requirementKey: 'nfpa110.monthly.duration' },
      { prompt: 'Load as percent of nameplate kW', type: 'number', unit: '%', requirementKey: 'nfpa110.monthly.load_pct' },
      { prompt: 'Fuel, coolant, oil and battery checks complete', type: 'pass_fail' },
      { prompt: 'Remote annunciator shows correct status', type: 'pass_fail' },
    ],
  },
];

export async function migrate(adminUrl = config.adminDatabaseUrl): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const dir = join(here, 'migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount) continue;
      await client.query('BEGIN');
      await client.query(readFileSync(join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    }
    await seedGlobalTemplates(client);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

async function seedGlobalTemplates(client: pg.Client): Promise<void> {
  const existing = await client.query('SELECT 1 FROM template WHERE tenant_id IS NULL LIMIT 1');
  if (existing.rowCount) return;
  await client.query('BEGIN');
  for (const t of GLOBAL_TEMPLATES) {
    const familyId = randomUUID();
    const r = await client.query<{ id: string }>(
      `INSERT INTO template (tenant_id, family_id, version, kind, name, applies_to_system_type, published)
       VALUES (NULL, $1, 1, $2, $3, $4, false) RETURNING id`,
      [familyId, t.kind, t.name, t.systemType],
    );
    const templateId = r.rows[0]!.id;
    let seq = 1;
    for (const it of t.items) {
      await client.query(
        `INSERT INTO template_item (template_id, seq, prompt, response_type, unit, required, requirement_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [templateId, seq++, it.prompt, it.type, it.unit ?? null, it.required ?? true, it.requirementKey ?? null],
      );
    }
    await client.query('UPDATE template SET published = true WHERE id = $1', [templateId]);
  }
  await client.query('COMMIT');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate().then(
    () => console.log('Migrations applied'),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
