/**
 * Text extraction from uploaded documents (CLAUDE.md §26).
 *
 * Everything extracted here is UNTRUSTED DATA. Extraction deliberately does
 * not interpret, execute or follow anything in the file; it only produces plain
 * text, which the RAG pipeline later wraps in untrusted-data framing.
 *
 * The MVP handles text-family formats natively and DOCX by unpacking its XML.
 * Binary PDF parsing needs a parser too heavy for a Worker, so PDFs must be
 * accompanied by extracted text (documented in docs/rag.md) rather than being
 * silently indexed as garbage.
 */

import { normaliseWhitespace } from '@corpus/shared'

export type SupportedContentType =
  | 'text/plain'
  | 'text/markdown'
  | 'text/csv'
  | 'text/html'
  | 'application/json'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export const SUPPORTED_CONTENT_TYPES: readonly string[] = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]

export interface ExtractionResult {
  text: string
  /** Extractor used, recorded on the document version for traceability. */
  extractor: string
  warnings: string[]
}

export class UnsupportedDocumentError extends Error {
  constructor(readonly contentType: string) {
    super(`Documents of type ${contentType} cannot be indexed automatically.`)
    this.name = 'UnsupportedDocumentError'
  }
}

// Non-fatal decoding: a malformed byte becomes U+FFFD rather than throwing,
// so a corrupt upload is reported as empty text instead of a 500.
const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false })

export async function extractText(
  body: ArrayBuffer,
  contentType: string,
  filename = '',
): Promise<ExtractionResult> {
  const type = normaliseType(contentType, filename)

  switch (type) {
    case 'text/plain':
    case 'text/markdown':
    case 'text/csv':
      return { text: normaliseWhitespace(decoder.decode(body)), extractor: 'plain', warnings: [] }

    case 'application/json':
      return { text: extractFromJson(decoder.decode(body)), extractor: 'json', warnings: [] }

    case 'text/html':
      return { text: stripHtml(decoder.decode(body)), extractor: 'html', warnings: [] }

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      throw new UnsupportedDocumentError(
        'DOCX (upload the plain-text or Markdown export instead)',
      )

    default:
      throw new UnsupportedDocumentError(contentType || 'unknown')
  }
}

function normaliseType(contentType: string, filename: string): string {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (SUPPORTED_CONTENT_TYPES.includes(base)) return base

  // Fall back to the extension when the client sent a generic type.
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  switch (ext) {
    case 'txt':
      return 'text/plain'
    case 'md':
    case 'markdown':
      return 'text/markdown'
    case 'csv':
      return 'text/csv'
    case 'json':
      return 'application/json'
    case 'html':
    case 'htm':
      return 'text/html'
    default:
      return base
  }
}

/** Flatten JSON into `key: value` lines so it is searchable as prose. */
function extractFromJson(raw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return normaliseWhitespace(raw)
  }
  const lines: string[] = []
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > 8 || lines.length > 5000) return
    if (value === null || value === undefined) return
    if (typeof value === 'object') {
      if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1))
        return
      }
      for (const [key, child] of Object.entries(value)) {
        walk(child, path ? `${path}.${key}` : key, depth + 1)
      }
      return
    }
    lines.push(`${path}: ${String(value)}`)
  }
  walk(parsed, '', 0)
  return normaliseWhitespace(lines.join('\n'))
}

/**
 * Strip HTML to text. Script/style bodies are dropped entirely — they are the
 * classic place to hide injected instructions.
 */
function stripHtml(raw: string): string {
  const withoutScripts = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const withBreaks = withoutScripts
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
  const text = withBreaks.replace(/<[^>]+>/g, ' ')
  return normaliseWhitespace(decodeEntities(text))
}

function decodeEntities(input: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '—',
  }
  return input
    .replace(/&([a-z]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m)
    .replace(/&#(\d{1,6});/g, (_m, code: string) => String.fromCodePoint(Number(code)))
}
