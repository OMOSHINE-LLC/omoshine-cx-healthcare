import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  EES_REQUIREMENTS,
  SECTIONS,
  SPACE_REQUIREMENTS,
  SPACE_TYPES,
  STANDARDS,
  STATE_PROFILES,
  applyOverlays,
  citationFor,
  findSpaceType,
  findStateProfile,
  describeRequired,
} from '@omoshine/rules';
import { notFound } from '../http.js';

/** Read-only code-requirement library. Global, not tenant data. */
export async function libraryRoutes(api: FastifyInstance) {
  api.get('/code-standards', async () => STANDARDS);
  api.get('/code-sections', async (req) => {
    const q = z.object({ standard: z.string().optional() }).parse(req.query);
    return SECTIONS.filter((s) => !q.standard || s.standardId === q.standard);
  });
  api.get('/states', async () => STATE_PROFILES);
  api.get('/space-types', async () => SPACE_TYPES);
  api.get('/space-types/:id/requirements', async (req) => {
    const { id } = req.params as { id: string };
    const q = z.object({ state: z.string().length(2).optional() }).parse(req.query);
    if (!findSpaceType(id)) throw notFound('Space type');
    const overlays = q.state ? findStateProfile(q.state)?.overlays ?? [] : [];
    return applyOverlays(SPACE_REQUIREMENTS.filter((r) => r.appliesToId === id), overlays).map((r) => ({
      ...r,
      required: describeRequired(r),
      citation: citationFor(r.sectionId),
    }));
  });
  api.get('/requirements', async (req) => {
    const q = z.object({ applies_to: z.string().optional(), state: z.string().length(2).optional() }).parse(req.query);
    const overlays = q.state ? findStateProfile(q.state)?.overlays ?? [] : [];
    return applyOverlays([...SPACE_REQUIREMENTS, ...EES_REQUIREMENTS], overlays)
      .filter((r) => !q.applies_to || r.appliesTo === q.applies_to)
      .map((r) => ({ ...r, required: describeRequired(r), citation: citationFor(r.sectionId) }));
  });
}
