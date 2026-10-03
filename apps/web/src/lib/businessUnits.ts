import type { OrganizationalUnit, PendingChange, Units } from '../api/adminSchemas';

/** The API `path` lists OU names from the top level down to the OU itself (admin-probe). */
function ouLabel(ou: { name: string; path: readonly string[] }): string {
  return (ou.path.length > 0 ? ou.path : [ou.name]).join(' › ');
}

// Area names are data, and `constructor` is a valid area (`^[a-z0-9-]{2,32}$`). Never read them
// as properties of a plain object: `units.constructor` would be Object, not an OU list (ADM-02).
// Every lookup goes through own entries or a Map.

/** Editor limits (the API may enforce lower ones; its errors are shown as usual). */
export const MAX_AREAS = 20;
export const MAX_OUS_PER_AREA = 15; // Must match mango_core.business_units (request body limit).
export const MAX_PENDING = 10; // mango_api.admin.MAX_PENDING_CHANGES.

export type UnitsMap = ReadonlyMap<string, readonly string[]>;

/** Own entries of a mapping as a Map, sorted by area. */
export function unitsToMap(units: Units): Map<string, string[]> {
  return new Map(
    Object.entries(units)
      .filter(([, ous]) => Array.isArray(ous))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Mapping object for the API. `Object.fromEntries` defines own properties for every key. */
export function mapToUnits(map: UnitsMap): Units {
  return Object.fromEntries([...map].map(([area, ous]) => [area, [...ous]]));
}

/** OUs of `area`, or an empty list when the mapping has no such own key. */
export function ousOf(units: Units, area: string): string[] {
  if (!Object.hasOwn(units, area)) return [];
  const ous: unknown = units[area];
  return Array.isArray(ous) ? (ous as string[]) : [];
}

export interface AreaDiff {
  area: string;
  kind: 'added' | 'removed' | 'changed';
  added: string[];
  removed: string[];
}

const sorted = (values: Iterable<string>) => [...values].sort((a, b) => a.localeCompare(b));

/** Per-area difference between two mappings; unchanged areas are omitted (TM-A1: visible diff). */
export function diffUnits(before: Units, after: Units): AreaDiff[] {
  const was = unitsToMap(before);
  const now = unitsToMap(after);
  const diffs: AreaDiff[] = [];
  for (const area of sorted(new Set([...was.keys(), ...now.keys()]))) {
    const beforeOus = new Set(was.get(area) ?? []);
    const afterOus = new Set(now.get(area) ?? []);
    const added = sorted([...afterOus].filter((ou) => !beforeOus.has(ou)));
    const removed = sorted([...beforeOus].filter((ou) => !afterOus.has(ou)));
    if (!was.has(area)) diffs.push({ area, kind: 'added', added, removed: [] });
    else if (!now.has(area)) diffs.push({ area, kind: 'removed', added: [], removed });
    else if (added.length > 0 || removed.length > 0) {
      diffs.push({ area, kind: 'changed', added, removed });
    }
  }
  return diffs;
}

/** True when the change adds, removes or modifies `area` (D17: nobody changes their own area). */
export function touchesArea(before: Units, after: Units, area: string | null): boolean {
  if (!area) return false;
  return diffUnits(before, after).some((diff) => diff.area === area);
}

/** Proposer label: email when the API has it, else the user id. */
export function proposerOf(change: PendingChange): string {
  return change.proposed_by_email ?? change.proposed_by;
}

/** True once the proposal reached its `expires_at` (the API refuses to approve it: 410). */
export function isExpired(change: PendingChange, now: number = Date.now()): boolean {
  const expires = Date.parse(change.expires_at);
  return Number.isNaN(expires) || now >= expires;
}

export interface OuNode extends OrganizationalUnit {
  /** "Workloads › Finanzas" (breadcrumb including the OU itself). */
  label: string;
  depth: number;
}

/**
 * OUs in tree order (parents before children, siblings in API order) with their depth, for the
 * OU picker (design gov/data.js `tree`). OUs whose parent is unknown are roots.
 */
export function ouTree(ous: readonly OrganizationalUnit[]): OuNode[] {
  const ids = new Set(ous.map((ou) => ou.id));
  const children = new Map<string, OrganizationalUnit[]>();
  const roots: OrganizationalUnit[] = [];
  for (const ou of ous) {
    if (ids.has(ou.parent_id) && ou.parent_id !== ou.id) {
      const list = children.get(ou.parent_id) ?? [];
      list.push(ou);
      children.set(ou.parent_id, list);
    } else {
      roots.push(ou);
    }
  }
  const out: OuNode[] = [];
  const seen = new Set<string>();
  const walk = (list: readonly OrganizationalUnit[], depth: number) => {
    for (const ou of list) {
      if (seen.has(ou.id)) continue; // Defensive: a cycle in the data must not loop forever.
      seen.add(ou.id);
      out.push({ ...ou, label: ouLabel(ou), depth });
      walk(children.get(ou.id) ?? [], depth + 1);
    }
  };
  walk(roots, 0);
  // Anything left (only possible with cyclic parents) is listed flat at the end.
  for (const ou of ous) {
    if (!seen.has(ou.id)) out.push({ ...ou, label: ouLabel(ou), depth: 0 });
  }
  return out;
}
