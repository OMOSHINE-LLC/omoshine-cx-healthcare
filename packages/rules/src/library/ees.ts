import type { Requirement } from '../types.js';

/**
 * Essential Electrical System requirements (NFPA 99 Type 1 EES on an NFPA 110
 * Level 1, Type 10 EPSS). Seeded verified=false pending licensed-copy review.
 */
export const EES_REQUIREMENTS: Requirement[] = [
  {
    id: 'req_ees_ats_transfer_time',
    key: 'nfpa110.level1.type10.transfer_time',
    sectionId: 'sec_nfpa110_2022_4_1',
    description: 'Power restored to the load within 10 seconds of loss of normal power',
    parameter: 'transfer_time_s',
    operator: 'lte',
    valueMax: 10,
    unit: 's',
    appliesTo: 'asset_type',
    appliesToId: 'ats',
    severity: 'life_safety',
    verified: false,
  },
  {
    id: 'req_ees_monthly_duration',
    key: 'nfpa110.monthly.duration',
    sectionId: 'sec_nfpa110_2022_8_4_2',
    description: 'Monthly generator exercise under load for at least 30 minutes',
    parameter: 'duration_min',
    operator: 'gte',
    valueMin: 30,
    unit: 'min',
    appliesTo: 'test_type',
    appliesToId: 'generator_monthly',
    severity: 'regulatory',
    verified: false,
  },
  {
    id: 'req_ees_monthly_load',
    key: 'nfpa110.monthly.load_pct',
    sectionId: 'sec_nfpa110_2022_8_4_2',
    description: 'Monthly load at least 30% of nameplate kW, or manufacturer minimum exhaust temperature reached',
    parameter: 'load_pct',
    operator: 'gte',
    valueMin: 30,
    unit: '% nameplate kW',
    appliesTo: 'test_type',
    appliesToId: 'generator_monthly',
    severity: 'regulatory',
    verified: false,
  },
  {
    id: 'req_ees_triennial_duration',
    key: 'nfpa110.triennial.duration',
    sectionId: 'sec_nfpa110_2022_8_4_9',
    description: '36-month test for at least 4 hours',
    parameter: 'duration_min',
    operator: 'gte',
    valueMin: 240,
    unit: 'min',
    appliesTo: 'test_type',
    appliesToId: 'generator_triennial',
    severity: 'regulatory',
    verified: false,
  },
  {
    id: 'req_ees_triennial_load',
    key: 'nfpa110.triennial.load_pct',
    sectionId: 'sec_nfpa110_2022_8_4_9',
    description: '36-month test at not less than 30% of nameplate kW',
    parameter: 'load_pct',
    operator: 'gte',
    valueMin: 30,
    unit: '% nameplate kW',
    appliesTo: 'test_type',
    appliesToId: 'generator_triennial',
    severity: 'regulatory',
    verified: false,
  },
];

export type EesBranch = 'life_safety' | 'critical' | 'equipment';
export const EES_BRANCHES: { id: EesBranch; name: string }[] = [
  { id: 'life_safety', name: 'Life Safety branch' },
  { id: 'critical', name: 'Critical branch' },
  { id: 'equipment', name: 'Equipment branch' },
];
