/**
 * Document chunking for retrieval.
 *
 * Splits on heading boundaries first so a chunk carries a meaningful section
 * label (which the assistant cites), then packs paragraphs up to a token
 * budget with a small overlap so an answer spanning a boundary is still found.
 */

import { normaliseWhitespace, truncate } from '@corpus/shared'

export interface Chunk {
  section: string | null
  page: number | null
  content: string
  tokenEstimate: number
}

export interface ChunkOptions {
  /** Target chunk size in estimated tokens. */
  targetTokens?: number
  /** Hard ceiling; a single oversized paragraph is split at this size. */
  maxTokens?: number
  /** Tokens of trailing context repeated at the start of the next chunk. */
  overlapTokens?: number
  /** Safety cap on the number of chunks produced from one document. */
  maxChunks?: number
}

const DEFAULTS: Required<ChunkOptions> = {
  targetTokens: 220,
  maxTokens: 320,
  overlapTokens: 30,
  maxChunks: 400,
}

/**
 * Rough token estimate: ~4 characters per token for English prose. Used only
 * for budgeting, so an approximation is fine and avoids a tokeniser dependency.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

const MARKDOWN_HEADING = /^(#{1,6})\s+(.{1,120})$/
const UNDERLINED_HEADING = /^[=-]{3,}$/
/** ALL CAPS or numbered headings common in policy PDFs converted to text. */
const PLAIN_HEADING = /^(?:\d+(?:\.\d+)*\.?\s+)?([A-Z][A-Z0-9 ,'&()/-]{4,80})$/
const PAGE_MARKER = /^\s*(?:page\s+(\d+)(?:\s+of\s+\d+)?|-{0,3}\s*\[?page\s+(\d+)\]?\s*-{0,3})\s*$/i

interface Block {
  section: string | null
  page: number | null
  text: string
}

/** Group the document's lines into blocks tagged with their current section. */
function toBlocks(text: string): Block[] {
  const lines = normaliseWhitespace(text).split('\n')
  const blocks: Block[] = []
  let section: string | null = null
  let page: number | null = null
  let buffer: string[] = []

  const flush = () => {
    const joined = buffer.join('\n').trim()
    if (joined) blocks.push({ section, page, text: joined })
    buffer = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()

    const pageMatch = PAGE_MARKER.exec(line)
    if (pageMatch) {
      flush()
      page = Number(pageMatch[1] ?? pageMatch[2])
      continue
    }

    const md = MARKDOWN_HEADING.exec(line)
    if (md) {
      flush()
      section = md[2]!.trim()
      continue
    }

    // "Heading" followed by ==== / ---- underline.
    const next = (lines[i + 1] ?? '').trim()
    if (line && UNDERLINED_HEADING.test(next) && line.length <= 120) {
      flush()
      section = line
      i++
      continue
    }

    if (line && PLAIN_HEADING.test(line) && line.length <= 80 && !line.endsWith('.')) {
      flush()
      section = line
      continue
    }

    if (line === '') {
      flush()
      continue
    }
    buffer.push(line)
  }
  flush()
  return blocks
}

export function chunkDocument(text: string, options: ChunkOptions = {}): Chunk[] {
  const config = { ...DEFAULTS, ...options }
  const blocks = toBlocks(text)
  const chunks: Chunk[] = []

  let current: { section: string | null; page: number | null; parts: string[]; tokens: number } | null =
    null

  const flush = () => {
    if (!current || current.parts.length === 0) return
    const content = current.parts.join('\n\n').trim()
    if (content) {
      chunks.push({
        section: current.section,
        page: current.page,
        content,
        tokenEstimate: estimateTokens(content),
      })
    }
    current = null
  }

  for (const block of blocks) {
    if (chunks.length >= config.maxChunks) break

    // A section change always starts a new chunk so citations stay accurate.
    if (current && current.section !== block.section) flush()

    for (const piece of splitOversized(block.text, config.maxTokens)) {
      const pieceTokens = estimateTokens(piece)

      if (current && current.tokens + pieceTokens > config.targetTokens) {
        const tail = overlapTail(current.parts, config.overlapTokens)
        flush()
        current = {
          section: block.section,
          page: block.page,
          parts: tail ? [tail] : [],
          tokens: tail ? estimateTokens(tail) : 0,
        }
      }
      if (!current) current = { section: block.section, page: block.page, parts: [], tokens: 0 }
      current.parts.push(piece)
      current.tokens += pieceTokens
      if (current.page === null) current.page = block.page
    }
  }
  flush()

  return chunks.slice(0, config.maxChunks)
}

/** Split a paragraph that alone exceeds the hard ceiling, on sentence bounds. */
function splitOversized(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text]
  const sentences = text.split(/(?<=[.!?])\s+/)
  const out: string[] = []
  let buffer = ''
  for (const sentence of sentences) {
    const candidate = buffer ? `${buffer} ${sentence}` : sentence
    if (estimateTokens(candidate) > maxTokens && buffer) {
      out.push(buffer)
      buffer = sentence
    } else {
      buffer = candidate
    }
  }
  if (buffer) out.push(buffer)
  // A single sentence longer than the ceiling is hard-truncated per slice.
  return out.flatMap((s) =>
    estimateTokens(s) <= maxTokens
      ? [s]
      : hardSlice(s, maxTokens * 4),
  )
}

function hardSlice(text: string, chars: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += chars) out.push(text.slice(i, i + chars))
  return out
}

/** Trailing text reused as overlap context in the next chunk. */
function overlapTail(parts: string[], overlapTokens: number): string | null {
  if (overlapTokens <= 0) return null
  const last = parts[parts.length - 1]
  if (!last) return null
  const chars = overlapTokens * 4
  if (last.length <= chars) return last
  return truncate(last.slice(-chars), chars)
}
