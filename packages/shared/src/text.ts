/** Text normalisation helpers used by search, chunking and the response filter. */

// Built with RegExp() rather than literals so the source stays pure ASCII.
// Control characters (newline and tab are handled separately) plus DEL.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g')
// Zero-width space/non-joiner/joiner, word joiner and BOM — common homoglyph
// and prompt-smuggling vectors in uploaded documents.
const ZERO_WIDTH = new RegExp('[\\u200B-\\u200D\\u2060\\uFEFF]', 'g')

/** Collapse whitespace and strip control / zero-width characters. */
export function normaliseWhitespace(input: string): string {
  return input
    .replace(CONTROL_CHARS, ' ')
    .replace(ZERO_WIDTH, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max - 1)}…`
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'my', 'me', 'i', 'we', 'you', 'your',
  'it', 'its', 'that', 'this', 'what', 'how', 'when', 'where', 'who', 'which', 'can', 'could',
  'should', 'would', 'will', 'shall', 'may', 'much', 'many', 'about', 'from', 'at', 'as', 'by',
  'so', 'than', 'then', 'there', 'here', 'have', 'has', 'had',
])

/** Lowercase word tokens with stopwords removed, for keyword scoring. */
export function tokenise(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

/** Escape a user string for use inside a SQLite FTS5 MATCH expression. */
export function toFtsQuery(input: string, maxTerms = 12): string {
  const terms = tokenise(input).slice(0, maxTerms)
  if (terms.length === 0) return ''
  // Quote each term so FTS operators inside user input are inert.
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}

/** Escape a value for a SQL LIKE pattern (used with ESCAPE '\'). */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`)
}
