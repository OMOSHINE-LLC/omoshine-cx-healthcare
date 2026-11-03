import type { Requirement, SpaceType } from '../types.js';

const T71 = 'sec_ashrae170_2021_t7_1';

/**
 * ASHRAE 170-2021 space types seeded for the MVP.
 *
 * VALUES ARE SEEDED FROM ENGINEERING REFERENCE AND MARKED verified=false.
 * They must be checked against a licensed copy of the adopted edition before
 * any project relies on them. Projects can override per state or per AHJ.
 */
export const SPACE_TYPES: SpaceType[] = [
  {
    id: 'or_class_bc', name: 'Operating room (Class B and C)', category: 'Surgery', standardEdition: '2021',
    pressureRelationship: 'positive', minTotalAch: 20, minOaAch: 4, allExhaust: false, recircByRoomUnitsAllowed: false,
    rhMin: 20, rhMax: 60, tempMinF: 68, tempMaxF: 75, sectionId: T71, verified: false,
  },
  {
    id: 'aiir', name: 'Airborne infection isolation room (AIIR)', category: 'Isolation', standardEdition: '2021',
    pressureRelationship: 'negative', minPressureDiffInWc: 0.01, minTotalAch: 12, minOaAch: 2, allExhaust: true,
    recircByRoomUnitsAllowed: false, rhMax: 60, tempMinF: 70, tempMaxF: 75, sectionId: T71, verified: false,
  },
  {
    id: 'pe_room', name: 'Protective environment (PE) room', category: 'Isolation', standardEdition: '2021',
    pressureRelationship: 'positive', minPressureDiffInWc: 0.01, minTotalAch: 12, minOaAch: 2,
    recircByRoomUnitsAllowed: false, rhMax: 60, tempMinF: 70, tempMaxF: 75, sectionId: T71, verified: false,
  },
  {
    id: 'spd_decon', name: 'Sterile processing – decontamination', category: 'Sterile processing', standardEdition: '2021',
    pressureRelationship: 'negative', minTotalAch: 6, minOaAch: 2, allExhaust: true, recircByRoomUnitsAllowed: false,
    rhMax: 60, tempMinF: 60, tempMaxF: 73, sectionId: T71, verified: false,
  },
  {
    id: 'spd_clean_work', name: 'Sterile processing – clean workroom', category: 'Sterile processing', standardEdition: '2021',
    pressureRelationship: 'positive', minTotalAch: 4, minOaAch: 2, recircByRoomUnitsAllowed: false,
    rhMax: 60, tempMinF: 68, tempMaxF: 73, sectionId: T71, verified: false,
  },
  {
    id: 'patient_room', name: 'Patient room', category: 'Inpatient', standardEdition: '2021',
    pressureRelationship: 'not_required', minTotalAch: 4, minOaAch: 2, rhMax: 60, tempMinF: 70, tempMaxF: 75,
    sectionId: T71, verified: false,
  },
  {
    id: 'lab_general', name: 'Laboratory, general', category: 'Laboratory', standardEdition: '2021',
    pressureRelationship: 'negative', minTotalAch: 6, minOaAch: 2, allExhaust: true, recircByRoomUnitsAllowed: false,
    tempMinF: 70, tempMaxF: 75, sectionId: T71, verified: false,
  },
  {
    id: 'imaging_xray_dx', name: 'Imaging – diagnostic X-ray', category: 'Imaging', standardEdition: '2021',
    pressureRelationship: 'not_required', minTotalAch: 6, minOaAch: 2, rhMax: 60, tempMinF: 72, tempMaxF: 78,
    sectionId: T71, verified: false,
  },
  {
    id: 'ed_waiting', name: 'Emergency department waiting room', category: 'Emergency', standardEdition: '2021',
    pressureRelationship: 'negative', minTotalAch: 12, minOaAch: 2, allExhaust: true, rhMax: 65,
    tempMinF: 70, tempMaxF: 75, sectionId: T71, verified: false,
  },
  {
    id: 'usp797_buffer', name: 'Pharmacy – USP 797 buffer room (ISO 7)', category: 'Pharmacy', standardEdition: '2023',
    pressureRelationship: 'positive', minPressureDiffInWc: 0.02, minTotalAch: 30, rhMax: 60, tempMaxF: 68,
    sectionId: 'sec_usp797_2023_ch4', verified: false,
  },
  {
    id: 'usp800_buffer', name: 'Pharmacy – USP 800 hazardous buffer room', category: 'Pharmacy', standardEdition: '2020',
    pressureRelationship: 'negative', minPressureDiffInWc: 0.01, minTotalAch: 30, allExhaust: true, rhMax: 60, tempMaxF: 68,
    sectionId: 'sec_usp800_2020_s5', verified: false,
  },
];

/** Expand a space type into individual machine-checkable requirements. */
export function requirementsForSpaceType(st: SpaceType): Requirement[] {
  const base = (param: string, partial: Partial<Requirement> & Pick<Requirement, 'operator' | 'description'>): Requirement => ({
    id: `req_${st.id}_${param}`,
    key: `ashrae170.${st.id}.${param}`,
    sectionId: st.sectionId,
    parameter: param,
    appliesTo: 'space_type',
    appliesToId: st.id,
    severity: 'regulatory',
    verified: st.verified,
    ...partial,
  });

  const reqs: Requirement[] = [];
  // Pressure relationship is life safety for isolation rooms; regulatory elsewhere.
  const isolation = st.id === 'aiir' || st.id === 'pe_room' || st.id === 'usp800_buffer';
  if (st.pressureRelationship !== 'not_required') {
    reqs.push(
      base('pressure_relationship', {
        operator: 'eq',
        values: [st.pressureRelationship],
        description: `Room is ${st.pressureRelationship} to adjacent areas`,
        severity: isolation ? 'life_safety' : 'regulatory',
        ...(st.minPressureDiffInWc !== undefined ? { valueMin: st.minPressureDiffInWc, unit: 'in. w.c.' } : {}),
      }),
    );
  }
  if (st.minTotalAch !== undefined) {
    reqs.push(base('total_ach', { operator: 'gte', valueMin: st.minTotalAch, unit: 'ACH', description: `At least ${st.minTotalAch} total air changes per hour` }));
  }
  if (st.minOaAch !== undefined) {
    reqs.push(base('oa_ach', { operator: 'gte', valueMin: st.minOaAch, unit: 'ACH', description: `At least ${st.minOaAch} outdoor air changes per hour` }));
  }
  if (st.allExhaust) {
    reqs.push(base('all_exhaust', { operator: 'eq', values: ['true'], description: 'All room air exhausted directly outdoors', severity: isolation ? 'life_safety' : 'regulatory' }));
  }
  if (st.recircByRoomUnitsAllowed === false) {
    reqs.push(base('no_recirc_room_units', { operator: 'eq', values: ['true'], description: 'No recirculating room units' }));
  }
  if (st.rhMin !== undefined || st.rhMax !== undefined) {
    reqs.push(
      base('rh_pct', {
        operator: st.rhMin !== undefined && st.rhMax !== undefined ? 'between' : st.rhMax !== undefined ? 'lte' : 'gte',
        valueMin: st.rhMin,
        valueMax: st.rhMax,
        unit: '%RH',
        description: `Relative humidity ${st.rhMin ?? '–'} to ${st.rhMax ?? '–'} %`,
        severity: 'performance',
      }),
    );
  }
  if (st.tempMinF !== undefined || st.tempMaxF !== undefined) {
    reqs.push(
      base('temp_f', {
        operator: st.tempMinF !== undefined && st.tempMaxF !== undefined ? 'between' : st.tempMaxF !== undefined ? 'lte' : 'gte',
        valueMin: st.tempMinF,
        valueMax: st.tempMaxF,
        unit: '°F',
        description: `Temperature ${st.tempMinF ?? '–'} to ${st.tempMaxF ?? '–'} °F`,
        severity: 'performance',
      }),
    );
  }
  return reqs;
}

export const SPACE_REQUIREMENTS: Requirement[] = SPACE_TYPES.flatMap(requirementsForSpaceType);

export function findSpaceType(id: string): SpaceType | undefined {
  return SPACE_TYPES.find((s) => s.id === id);
}
