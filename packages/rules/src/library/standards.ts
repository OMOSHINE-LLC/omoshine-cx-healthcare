import type { CodeSection, CodeStandard } from '../types.js';

/**
 * Code standards and the sections the MVP cites.
 *
 * Summaries are OMOSHINE's own words. Every requirement derived from these is
 * seeded with verified=false until checked against a licensed copy.
 */
export const STANDARDS: CodeStandard[] = [
  { id: 'std_ashrae170_2021', code: 'ASHRAE 170', edition: '2021', publisher: 'ASHRAE/ASHE', title: 'Ventilation of Health Care Facilities' },
  { id: 'std_nfpa99_2021', code: 'NFPA 99', edition: '2021', publisher: 'NFPA', title: 'Health Care Facilities Code' },
  { id: 'std_nfpa99_2012', code: 'NFPA 99', edition: '2012', publisher: 'NFPA', title: 'Health Care Facilities Code (CMS-adopted edition)' },
  { id: 'std_nfpa101_2012', code: 'NFPA 101', edition: '2012', publisher: 'NFPA', title: 'Life Safety Code (CMS-adopted edition)' },
  { id: 'std_nfpa110_2022', code: 'NFPA 110', edition: '2022', publisher: 'NFPA', title: 'Standard for Emergency and Standby Power Systems' },
  { id: 'std_nfpa110_2010', code: 'NFPA 110', edition: '2010', publisher: 'NFPA', title: 'Standard for Emergency and Standby Power Systems (referenced by NFPA 99-2012)' },
  { id: 'std_usp797_2023', code: 'USP 797', edition: '2023', publisher: 'USP', title: 'Pharmaceutical Compounding – Sterile Preparations' },
  { id: 'std_usp800_2020', code: 'USP 800', edition: '2020', publisher: 'USP', title: 'Hazardous Drugs – Handling in Healthcare Settings' },
];

export const SECTIONS: CodeSection[] = [
  {
    id: 'sec_ashrae170_2021_t7_1',
    standardId: 'std_ashrae170_2021',
    sectionRef: 'Table 7-1',
    title: 'Design parameters for inpatient spaces',
    summary: 'Room-by-room pressure relationship, outdoor and total air change rates, exhaust, recirculation, humidity and temperature.',
  },
  {
    id: 'sec_usp797_2023_ch4',
    standardId: 'std_usp797_2023',
    sectionRef: 'Chapter 4',
    title: 'Facilities and engineering controls',
    summary: 'Air change rates, pressure cascade and environmental limits for classified compounding areas.',
  },
  {
    id: 'sec_usp800_2020_s5',
    standardId: 'std_usp800_2020',
    sectionRef: 'Section 5.3',
    title: 'Sterile compounding of hazardous drugs',
    summary: 'Hazardous-drug buffer rooms are externally exhausted and negative to adjacent spaces.',
  },
  {
    id: 'sec_nfpa110_2022_4_1',
    standardId: 'std_nfpa110_2022',
    sectionRef: '4.1 / Table 4.1(b)',
    title: 'EPSS classification by type',
    summary: 'A Type 10 Level 1 system restores power to the load within 10 seconds of loss of normal power.',
  },
  {
    id: 'sec_nfpa110_2022_8_4_2',
    standardId: 'std_nfpa110_2022',
    sectionRef: '8.4.2',
    title: 'Monthly generator exercise',
    summary: 'Monthly operation under load for at least 30 minutes at a minimum loading (30% of nameplate kW for diesel) or the manufacturer’s minimum exhaust gas temperature.',
  },
  {
    id: 'sec_nfpa110_2022_8_4_2_3',
    standardId: 'std_nfpa110_2022',
    sectionRef: '8.4.2.3',
    title: 'Annual supplemental load test',
    summary: 'When monthly tests do not meet minimum loading, an annual supplemental load test at stepped loads is required.',
  },
  {
    id: 'sec_nfpa110_2022_8_4_9',
    standardId: 'std_nfpa110_2022',
    sectionRef: '8.4.9',
    title: 'Triennial (36-month) test',
    summary: 'Level 1 EPSS is tested at least once every 36 months for the assigned class duration, not less than 4 hours, at a minimum load.',
  },
  {
    id: 'sec_nfpa99_2021_6_7',
    standardId: 'std_nfpa99_2021',
    sectionRef: '6.7',
    title: 'Type 1 essential electrical system',
    summary: 'Life safety, critical and equipment branches, each served by its own transfer switch, supplied from a Level 1 EPSS.',
  },
];

export function findSection(id: string): CodeSection | undefined {
  return SECTIONS.find((s) => s.id === id);
}

export function findStandard(id: string): CodeStandard | undefined {
  return STANDARDS.find((s) => s.id === id);
}

/** "ASHRAE 170-2021 Table 7-1" */
export function citationFor(sectionId: string): string {
  const section = findSection(sectionId);
  if (!section) return 'Unknown section';
  const std = findStandard(section.standardId);
  return std ? `${std.code}-${std.edition} ${section.sectionRef}` : section.sectionRef;
}
