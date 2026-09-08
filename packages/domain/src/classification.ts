/**
 * Data classification (CLAUDE.md §9). A backend property of a resource, never
 * inferred from a prompt, an LLM, or anything a caller sends.
 */

export const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const
export type Classification = (typeof CLASSIFICATIONS)[number]

const RANK: Record<Classification, number> = {
  PUBLIC: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
}

export function classificationRank(c: Classification): number {
  return RANK[c]
}

export function isClassification(v: unknown): v is Classification {
  return typeof v === 'string' && (CLASSIFICATIONS as readonly string[]).includes(v)
}

export function classificationCovers(granted: Classification, required: Classification): boolean {
  return RANK[granted] >= RANK[required]
}

export function classificationsUpTo(max: Classification): Classification[] {
  return CLASSIFICATIONS.filter((c) => RANK[c] <= RANK[max])
}
