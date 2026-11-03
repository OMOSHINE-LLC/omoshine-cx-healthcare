/**
 * Core types for the OMOSHINE code-requirement library and compliance engine.
 *
 * The library stores machine-checkable requirement VALUES and original summaries
 * only. Licensed code text is never stored.
 */

export type StandardCode =
  | 'ASHRAE 170'
  | 'NFPA 99'
  | 'NFPA 101'
  | 'NFPA 110'
  | 'NFPA 72'
  | 'FGI'
  | 'USP 797'
  | 'USP 800'
  | 'ASHRAE 188'
  | 'STATE';

export interface CodeStandard {
  id: string;
  code: StandardCode;
  edition: string;
  publisher: string;
  title: string;
}

export interface CodeSection {
  id: string;
  standardId: string;
  sectionRef: string;
  title: string;
  summary: string;
}

export type Operator = 'gte' | 'lte' | 'between' | 'eq' | 'in' | 'gt' | 'lt';

export type Severity = 'life_safety' | 'regulatory' | 'performance';

export type AppliesTo = 'space_type' | 'system_type' | 'asset_type' | 'test_type';

export interface Requirement {
  id: string;
  sectionId: string;
  /** Stable key, e.g. "ashrae170.or_class_bc.total_ach". */
  key: string;
  description: string;
  parameter: string;
  operator: Operator;
  valueMin?: number;
  valueMax?: number;
  /** For eq / in on non-numeric parameters (e.g. pressure relationship). */
  values?: string[];
  unit?: string;
  appliesTo: AppliesTo;
  appliesToId: string;
  severity: Severity;
  /** True until a licensed copy has been checked by OMOSHINE's code reviewer. */
  verified: boolean;
}

export type OverlayAction = 'replace' | 'add' | 'disable';

export interface JurisdictionOverlay {
  id: string;
  stateCode: string;
  action: OverlayAction;
  /** For replace/disable: the requirement key affected. */
  requirementKey: string;
  /** For replace/add: the full or partial requirement. */
  requirement?: Partial<Requirement>;
  effectiveDate: string;
  sourceNote: string;
  verified: boolean;
}

export interface StateProfile {
  stateCode: string;
  name: string;
  /** Agency that licenses hospitals / reviews plans. */
  regulators: string[];
  /** Codes and guidelines adopted at the state level (editions to confirm per project). */
  adoptedCodes: { code: string; note: string }[];
  overlays: JurisdictionOverlay[];
  verified: boolean;
}

export type ResultStatus = 'pass' | 'fail' | 'not_evaluated';

export interface EvaluationResult {
  requirementKey: string;
  requirementId: string;
  parameter: string;
  status: ResultStatus;
  measured?: number | string | boolean | null;
  required: string;
  unit?: string;
  severity: Severity;
  citation: string;
  reason?: string;
}

export type PressureRelationship = 'positive' | 'negative' | 'equal' | 'not_required';

export interface SpaceType {
  id: string;
  name: string;
  category: string;
  standardEdition: string;
  pressureRelationship: PressureRelationship;
  /** Minimum differential magnitude in in. w.c., when the code sets one. */
  minPressureDiffInWc?: number;
  minTotalAch?: number;
  minOaAch?: number;
  allExhaust?: boolean;
  recircByRoomUnitsAllowed?: boolean;
  rhMin?: number;
  rhMax?: number;
  tempMinF?: number;
  tempMaxF?: number;
  sectionId: string;
  verified: boolean;
}

export interface RoomMeasurement {
  /** Measured supply airflow, cfm. */
  supplyCfm?: number;
  returnCfm?: number;
  exhaustCfm?: number;
  /** Outdoor air delivered to the room, cfm. */
  oaCfm?: number;
  /** Room minus reference space, in. w.c. Positive number = room is positive. */
  pressureDiffInWc?: number;
  tempF?: number;
  rhPct?: number;
  /** Observed: is all room air exhausted directly outdoors? */
  allExhaust?: boolean;
  /** Observed: does the room use recirculating room units? */
  recircRoomUnits?: boolean;
}
