import type { StateProfile } from '../types.js';

/**
 * First four state profiles requested by OMOSHINE: CA, NY, FL, TX.
 *
 * These record WHO regulates and WHICH codes the state points to. Requirement
 * overlays (numeric amendments) start empty and are added as data releases
 * after OMOSHINE's code reviewer confirms each one against the state's
 * published rules. Everything here is verified=false until that review.
 *
 * CMS minimums (NFPA 101-2012 and NFPA 99-2012) apply to every Medicare-
 * certified hospital in addition to the state profile.
 */
export const STATE_PROFILES: StateProfile[] = [
  {
    stateCode: 'CA',
    name: 'California',
    regulators: [
      'Department of Health Care Access and Information (HCAI, formerly OSHPD) – plan review and construction',
      'California Department of Public Health (CDPH) – licensing',
    ],
    adoptedCodes: [
      { code: 'California Building Standards Code (Title 24)', note: 'Parts 2, 3, 4 (California Mechanical Code) and 9 apply to hospital construction; confirm current cycle.' },
      { code: 'California Mechanical Code ventilation tables', note: 'California uses its own ventilation tables for health facilities; overlay ASHRAE 170 values after review.' },
    ],
    overlays: [],
    verified: false,
  },
  {
    stateCode: 'NY',
    name: 'New York',
    regulators: ['New York State Department of Health (NYSDOH) – licensing and construction review'],
    adoptedCodes: [
      { code: '10 NYCRR Part 711 / 712', note: 'State hospital construction standards referencing FGI Guidelines; confirm edition.' },
      { code: 'FGI Guidelines (incorporates ASHRAE 170)', note: 'Confirm adopted FGI edition per project.' },
    ],
    overlays: [],
    verified: false,
  },
  {
    stateCode: 'FL',
    name: 'Florida',
    regulators: ['Agency for Health Care Administration (AHCA) – Office of Plans and Construction'],
    adoptedCodes: [
      { code: 'Florida Building Code', note: 'Includes hospital-specific provisions; confirm current edition.' },
      { code: 'FGI Guidelines (incorporates ASHRAE 170)', note: 'Confirm adopted FGI edition per project.' },
    ],
    overlays: [],
    verified: false,
  },
  {
    stateCode: 'TX',
    name: 'Texas',
    regulators: ['Texas Health and Human Services Commission (HHSC) – architectural review and licensing'],
    adoptedCodes: [
      { code: 'Texas Administrative Code, Title 25 / Title 26 hospital rules', note: 'Confirm current chapter references for hospital construction.' },
      { code: 'FGI Guidelines (incorporates ASHRAE 170)', note: 'Confirm adopted FGI edition per project.' },
    ],
    overlays: [],
    verified: false,
  },
];

export function findStateProfile(code: string): StateProfile | undefined {
  return STATE_PROFILES.find((s) => s.stateCode === code.toUpperCase());
}
