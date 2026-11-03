/**
 * Specialty hospital systems: nurse call, pneumatic tube, real-time location (RTLS)
 * and imaging. Most of their commissioning risk sits in the interfaces to other
 * systems, so each type lists the interfaces to prove, plus original pre-functional
 * and functional test templates.
 *
 * Wording is OMOSHINE's own. References name the governing documents only; values the
 * project must meet (response times, location accuracy, shielding) come from the
 * project's basis of design, vendor specification and the physicist's report.
 * Everything is verified=false until OMOSHINE's reviewer confirms it.
 */

export type SpecialtyType = 'nurse_call' | 'pneumatic_tube' | 'rtls' | 'imaging';

export interface TemplateItemDef { prompt: string; type: 'pass_fail' | 'number' | 'text'; unit?: string; required?: boolean }
export interface TemplateDef { kind: 'pfc' | 'fpt'; name: string; systemType: string; items: TemplateItemDef[] }

export interface InterfaceDef {
  key: string;
  /** The other side of the interface. */
  with: string;
  label: string;
  /** What the test must show. */
  acceptance: string;
  /** Failures put occupants or patients at immediate risk (fire alarm, essential power, egress). */
  lifeSafety: boolean;
}

export interface SpecialtyDef {
  label: string;
  discipline: string;
  references: string[];
  assetTypes: string[];
  interfaces: InterfaceDef[];
  templates: TemplateDef[];
}

export const SPECIALTY_SYSTEMS: Record<SpecialtyType, SpecialtyDef> = {
  nurse_call: {
    label: 'Nurse call', discipline: 'communications',
    references: ['UL 1069', 'FGI Guidelines (nurse call and communication systems)', 'NFPA 99 (essential electrical system connections)'],
    assetTypes: ['nurse_call_master', 'nurse_call_station', 'dome_light', 'code_blue_station'],
    interfaces: [
      { key: 'ees', with: 'Essential electrical system', label: 'Nurse call stays up on emergency power', acceptance: 'Head-end and stations keep working through a transfer to generator, with no lost calls', lifeSafety: true },
      { key: 'phones', with: 'Wireless phones and pagers', label: 'Calls reach assigned staff devices', acceptance: 'Each call type reaches the assigned caregiver, then escalates to the next tier when not answered', lifeSafety: false },
      { key: 'rtls', with: 'RTLS', label: 'Staff presence cancels and logs calls', acceptance: 'Badge entering the room registers presence and the call clears or changes priority as programmed', lifeSafety: false },
      { key: 'ehr_adt', with: 'EHR / ADT', label: 'Patient assignments follow admissions', acceptance: 'Bed assignments from ADT appear on the console without patient data leaving the nurse call system', lifeSafety: false },
      { key: 'code_blue', with: 'Code blue and staff assist', label: 'Code calls annunciate unit-wide', acceptance: 'Code blue from any station annunciates at the console, corridor lights and every assigned device', lifeSafety: true },
    ],
    templates: [
      {
        kind: 'pfc', name: 'Pre-functional checklist – Nurse call', systemType: 'nurse_call',
        items: [
          { prompt: 'Head-end and network equipment installed and labeled; listing on file', type: 'pass_fail' },
          { prompt: 'Head-end on the branch shown in the design, with UPS where specified', type: 'pass_fail' },
          { prompt: 'Every patient, staff, bath and code station installed per device schedule', type: 'pass_fail' },
          { prompt: 'Dome lights visible from the corridor at each patient room', type: 'pass_fail' },
          { prompt: 'Pull cords reach the floor in toilets and showers', type: 'pass_fail' },
          { prompt: 'Notes', type: 'text', required: false },
        ],
      },
      {
        kind: 'fpt', name: 'Functional test – Nurse call', systemType: 'nurse_call',
        items: [
          { prompt: 'Patient call annunciates at console, dome light and assigned device', type: 'pass_fail' },
          { prompt: 'Time from patient call to annunciation on the assigned device', type: 'number', unit: 's' },
          { prompt: 'Bath and shower call has distinct priority and can only be cancelled in the room', type: 'pass_fail' },
          { prompt: 'Code blue annunciates at every required location', type: 'pass_fail' },
          { prompt: 'Unanswered call escalates to the next tier as programmed', type: 'pass_fail' },
          { prompt: 'Supervision: disconnected station or cord reports a fault at the console', type: 'pass_fail' },
          { prompt: 'System keeps working through a transfer to emergency power', type: 'pass_fail' },
        ],
      },
    ],
  },
  pneumatic_tube: {
    label: 'Pneumatic tube', discipline: 'conveying',
    references: ['Manufacturer installation and performance specification', 'Infection prevention policy (carrier and station cleaning)', 'NFPA 101 (penetrations and fire alarm interface)'],
    assetTypes: ['blower', 'diverter', 'tube_station', 'transfer_unit'],
    interfaces: [
      { key: 'fire_alarm', with: 'Fire alarm', label: 'Tube system responds to a fire alarm as designed', acceptance: 'On alarm, transactions stop or route as the sequence requires and blowers do not move smoke between zones', lifeSafety: true },
      { key: 'ees', with: 'Essential electrical system', label: 'System recovers from a power transfer', acceptance: 'Carriers in transit are delivered or held safely, and the system resumes without manual reset where specified', lifeSafety: false },
      { key: 'lab_pharmacy', with: 'Lab and pharmacy', label: 'Secure and specimen routes work end to end', acceptance: 'Secure deliveries need the recipient credential, and specimen routes deliver within the specified time', lifeSafety: false },
    ],
    templates: [
      {
        kind: 'pfc', name: 'Pre-functional checklist – Pneumatic tube', systemType: 'pneumatic_tube',
        items: [
          { prompt: 'Tube runs supported, joints sealed and rated penetrations firestopped', type: 'pass_fail' },
          { prompt: 'Blowers, diverters and stations installed and labeled per station schedule', type: 'pass_fail' },
          { prompt: 'Carrier cleaning supplies and procedure delivered to the owner', type: 'pass_fail' },
          { prompt: 'Notes', type: 'text', required: false },
        ],
      },
      {
        kind: 'fpt', name: 'Functional test – Pneumatic tube', systemType: 'pneumatic_tube',
        items: [
          { prompt: 'Every station sends to and receives from the main station', type: 'pass_fail' },
          { prompt: 'Longest route transit time', type: 'number', unit: 's' },
          { prompt: 'Specimen carrier with test vials arrives without leaks or hemolysis indicators', type: 'pass_fail' },
          { prompt: 'Secure transaction releases only to the authorized credential', type: 'pass_fail' },
          { prompt: 'Fire alarm input produces the designed response', type: 'pass_fail' },
          { prompt: 'Lost or stuck carrier is reported at the management console', type: 'pass_fail' },
        ],
      },
    ],
  },
  rtls: {
    label: 'Real-time location (RTLS)', discipline: 'communications',
    references: ['Vendor location accuracy specification', 'Owner clinical workflow requirements', 'NFPA 101 (locking arrangements tied to infant and patient protection)'],
    assetTypes: ['rtls_sensor', 'rtls_gateway', 'rtls_exciter'],
    interfaces: [
      { key: 'nurse_call', with: 'Nurse call', label: 'Staff badges register presence', acceptance: 'Presence in a room is reported to nurse call within the specified time', lifeSafety: false },
      { key: 'door_locks', with: 'Infant and patient protection locks', label: 'Protection locks release on fire alarm', acceptance: 'Tag alarms lock the designated doors, and a fire alarm or power loss releases them for egress', lifeSafety: true },
      { key: 'assets', with: 'Equipment management', label: 'Tagged equipment appears in the right room', acceptance: 'Tagged pumps and beds show the correct room on the asset view', lifeSafety: false },
    ],
    templates: [
      {
        kind: 'pfc', name: 'Pre-functional checklist – RTLS', systemType: 'rtls',
        items: [
          { prompt: 'Sensors and exciters installed at surveyed locations', type: 'pass_fail' },
          { prompt: 'Gateways networked and reporting to the server', type: 'pass_fail' },
          { prompt: 'Floor maps loaded with room numbers matching the project room list', type: 'pass_fail' },
          { prompt: 'Notes', type: 'text', required: false },
        ],
      },
      {
        kind: 'fpt', name: 'Functional test – RTLS', systemType: 'rtls',
        items: [
          { prompt: 'Room-level accuracy across the sample rooms', type: 'number', unit: '%' },
          { prompt: 'Time from entering a room to location update', type: 'number', unit: 's' },
          { prompt: 'Tag low-battery and tamper alerts reach the console', type: 'pass_fail' },
          { prompt: 'Infant or patient protection door locks on tag alarm and releases on fire alarm', type: 'pass_fail' },
        ],
      },
    ],
  },
  imaging: {
    label: 'Imaging', discipline: 'medical_equipment',
    references: ['State radiation control program (shielding plan and survey)', 'Qualified medical physicist report', 'Manufacturer site planning guide (power, cooling, structure)'],
    assetTypes: ['ct_scanner', 'mri_scanner', 'xray_unit', 'fluoroscopy_unit', 'imaging_chiller'],
    interfaces: [
      { key: 'hvac', with: 'HVAC and process cooling', label: 'Equipment room and chiller hold the site planning conditions', acceptance: 'Temperature and humidity stay inside the manufacturer range at full scanning load', lifeSafety: false },
      { key: 'ees', with: 'Essential electrical system', label: 'Imaging power matches the design branch', acceptance: 'Circuits on the designated branch, and power quality within the manufacturer limits', lifeSafety: false },
      { key: 'mri_quench', with: 'MRI quench vent and oxygen monitor', label: 'MRI safety systems work', acceptance: 'Quench vent path clear and terminated outdoors; oxygen monitor alarms and starts emergency exhaust', lifeSafety: true },
      { key: 'warning_lights', with: 'Door interlocks and warning lights', label: 'X-ray warning lights and interlocks work', acceptance: 'Warning lights energize during exposure and door interlocks act as designed', lifeSafety: true },
    ],
    templates: [
      {
        kind: 'pfc', name: 'Pre-functional checklist – Imaging room', systemType: 'imaging',
        items: [
          { prompt: 'Shielding installed per the physicist plan; inspection before cover-up recorded', type: 'pass_fail' },
          { prompt: 'Power, grounding and emergency off installed per site planning guide', type: 'pass_fail' },
          { prompt: 'Process cooling and room HVAC started and controls checked', type: 'pass_fail' },
          { prompt: 'MRI: RF shield, quench vent and zone signage installed (if applicable)', type: 'pass_fail', required: false },
          { prompt: 'Notes', type: 'text', required: false },
        ],
      },
      {
        kind: 'fpt', name: 'Functional test – Imaging room', systemType: 'imaging',
        items: [
          { prompt: 'Physicist radiation survey accepted (reference in notes)', type: 'pass_fail' },
          { prompt: 'Equipment room temperature at full scanning load', type: 'number', unit: '°F' },
          { prompt: 'Warning lights and door interlocks work during exposure', type: 'pass_fail' },
          { prompt: 'Emergency off stops the equipment', type: 'pass_fail' },
          { prompt: 'MRI: oxygen monitor alarms and starts emergency exhaust (if applicable)', type: 'pass_fail', required: false },
          { prompt: 'Images transfer to PACS', type: 'pass_fail' },
        ],
      },
    ],
  },
};

export const SPECIALTY_VERIFIED = false;

export const SPECIALTY_TEMPLATES: TemplateDef[] = Object.values(SPECIALTY_SYSTEMS).flatMap((s) => s.templates);

export const isSpecialtyType = (t: string): t is SpecialtyType => t in SPECIALTY_SYSTEMS;

/** Status of a system's interface tests: every interface needs a passing latest result. */
export function interfaceReadiness(type: SpecialtyType, latest: Record<string, 'pass' | 'fail' | undefined>): { total: number; passed: number; failed: number; untested: number; ready: boolean } {
  const keys = SPECIALTY_SYSTEMS[type].interfaces.map((i) => i.key);
  const passed = keys.filter((k) => latest[k] === 'pass').length;
  const failed = keys.filter((k) => latest[k] === 'fail').length;
  return { total: keys.length, passed, failed, untested: keys.length - passed - failed, ready: passed === keys.length };
}
