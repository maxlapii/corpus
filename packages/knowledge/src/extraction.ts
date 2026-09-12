/**
 * Text extraction from uploaded documents (CLAUDE.md §26).
 *
 * Everything extracted here is UNTRUSTED DATA. Extraction deliberately does
 * not interpret, execute or follow anything in the file; it only produces plain
 * text, which the RAG pipeline later wraps in untrusted-data framing.
 *
 * Text-family formats are handled natively and DOCX by unpacking its XML with
 * `DecompressionStream`, which needs no dependency.
 *
 * Legacy `.doc` (an OLE2 compound binary, not XML) is accepted and stored but
 * not parsed: a crude byte scrape produces plausible-looking garbage, which is
 * worse than an honest "text not read" for something a hiring decision rests on.
 *
 * PDF is deliberately NOT parsed. `unpdf` (serverless pdf.js) works under Node
 * and fails under workerd — its `PDFWorker` static initialiser throws
 * "Cannot set properties of undefined (setting '_isSameOrigin')" once wrangler
 * has bundled it — so it would have passed every test here and returned empty
 * text in production, at a cost of ~590 KB gzipped against a 1 MB budget.
 * A PDF is stored and stays downloadable; its text is entered by hand.
 * See docs/rag.md §14a.
 */

import { normaliseWhitespace } from '@corpus/shared'

export type SupportedContentType =
  | 'text/plain'
  | 'text/markdown'
  | 'text/csv'
  | 'text/html'
  | 'application/json'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/msword'
  | 'application/pdf'

export const SUPPORTED_CONTENT_TYPES: readonly string[] = [
  'application/pdf',
  'application/msword',
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

    // Accepted and stored, but not parsed — see the note at the top.
    case 'application/pdf':
      return {
        text: '',
        extractor: 'pdf-none',
        warnings: [
          'PDF text cannot be read automatically. Download the original, or paste the text in ' +
            'so the CV can be matched against a job.',
        ],
      }

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return extractFromDocx(body)

    // Stored, not parsed — see the note at the top.
    case 'application/msword':
      return {
        text: '',
        extractor: 'doc-none',
        warnings: [
          'Legacy .doc text cannot be read automatically. Download the original, or paste the ' +
            'text in so the CV can be matched against a job. Saving it as .docx also works.',
        ],
      }

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
    case 'pdf':
      return 'application/pdf'
    case 'doc':
      return 'application/msword'
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    default:
      return base
  }
}

/**
 * DOCX text by unzipping `word/document.xml` and stripping its markup.
 *
 * Workers expose `DecompressionStream('deflate-raw')`, so the stored entry can
 * be inflated without a ZIP dependency. Only that one entry is read: a DOCX
 * also carries headers, footers and embedded objects, and none of them are the
 * document body.
 */
async function extractFromDocx(body: ArrayBuffer): Promise<ExtractionResult> {
  try {
    const xml = await readZipEntry(body, 'word/document.xml')
    if (!xml) {
      return { text: '', extractor: 'docx', warnings: ['No word/document.xml in the archive.'] }
    }
    return { text: docxXmlToText(xml), extractor: 'docx', warnings: [] }
  } catch (e) {
    return {
      text: '',
      extractor: 'docx',
      warnings: [`The DOCX could not be read: ${e instanceof Error ? e.message : 'unknown error'}`],
    }
  }
}

/** Paragraph and break tags become newlines; everything else is dropped. */
function docxXmlToText(xml: string): string {
  const withBreaks = xml
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<w:br\s*\/?>/g, '\n')
    .replace(/<w:tab\s*\/?>/g, '\t')
  return normaliseWhitespace(stripHtml(withBreaks))
}

/**
 * Minimal ZIP reader: locate one entry through the central directory and
 * inflate it. Deliberately not a general ZIP library — it reads a single named
 * entry and ignores everything else, including anything with a traversal path.
 */
async function readZipEntry(archive: ArrayBuffer, wanted: string): Promise<string | null> {
  const view = new DataView(archive)
  const bytes = new Uint8Array(archive)
  const eocd = findEndOfCentralDirectory(view, bytes.length)
  if (eocd === -1) return null

  const entryCount = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) return null
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))

    if (name === wanted) {
      const localNameLength = view.getUint16(localOffset + 26, true)
      const localExtraLength = view.getUint16(localOffset + 28, true)
      const start = localOffset + 30 + localNameLength + localExtraLength
      const data = bytes.subarray(start, start + compressedSize)
      if (method === 0) return decoder.decode(data)
      if (method !== 8) return null
      return decoder.decode(await inflateRaw(data))
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  return null
}

function findEndOfCentralDirectory(view: DataView, length: number): number {
  // The record is at the end, after a comment of up to 64 KB.
  const earliest = Math.max(0, length - 65_557)
  for (let i = length - 22; i >= earliest; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i
  }
  return -1
}

async function inflateRaw(data: Uint8Array): Promise<ArrayBuffer> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).arrayBuffer()
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
