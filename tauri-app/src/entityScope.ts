export type EntityScopeSide = "tb" | "je";

export type EntityScopeCandidate = {
  sourceSide: EntityScopeSide;
  sourceEntity: string;
  targetEntity: string;
  rowCount?: number;
  amount?: number;
  absoluteAmount?: number;
  reason?: string;
};

export type EntityScopeSuggestions = {
  anchors: string[];
  candidates: EntityScopeCandidate[];
};

export type EntityScopeMapping = {
  side: EntityScopeSide;
  source: string;
  target: string;
};

export type EntityScopeSelection = {
  mode: "strict" | "aggregate";
  mappings: EntityScopeMapping[];
};

export const STRICT_ENTITY_SCOPE: EntityScopeSelection = {
  mode: "strict",
  mappings: [],
};

export function candidateKey(candidate: EntityScopeCandidate): string {
  return [candidate.sourceSide, candidate.sourceEntity, candidate.targetEntity].join("\u001f");
}

export function selectionFromCandidates(
  candidates: EntityScopeCandidate[],
  selected: ReadonlySet<string>,
): EntityScopeSelection {
  return {
    mode: "aggregate",
    mappings: candidates
      .filter((candidate) => selected.has(candidateKey(candidate)))
      .map((candidate) => ({
        side: candidate.sourceSide,
        source: candidate.sourceEntity,
        target: candidate.targetEntity,
      })),
  };
}
