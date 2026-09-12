/**
 * CV intake — one path for every source (CLAUDE.md §26).
 *
 * A CV arrives from a candidate on the recruitment bot, or from a member of
 * staff forwarding one on the employee bot. Both go through here, so the size
 * cap, the format allow-list, the storage key, the extraction and the injection
 * scan cannot drift apart between them.
 *
 * A CV is untrusted data end to end. Injection-shaped text is recorded as a
 * security event but never rejects the upload: refusing it would let an
 * attacker deny a genuine applicant by pasting "ignore previous instructions"
 * into their own CV, and the protection is the framing at read time.
 */

import { normaliseWhitespace, type Logger } from '@corpus/shared'
import { cvKey, tenantScope, type CandidateDocumentRepository, type StorageService } from '@corpus/db'
import type { CandidateDocument } from '@corpus/domain'
import { injectionSeverity, scanForInjection, type SecurityEventService } from '@corpus/security'
import { extractText, UnsupportedDocumentError } from './extraction.js'

/**
 * The formats a CV actually arrives in. Deliberately narrow: an allow-list is
 * only as good as its shortest entry, and every extra type is another parser
 * pointed at a stranger's file.
 */
export const CV_CONTENT_TYPES: readonly string[] = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]

export const CV_EXTENSIONS: readonly string[] = ['.pdf', '.doc', '.docx']

/** Shown to a candidate, so it names formats rather than MIME types. */
export const CV_FORMATS_LABEL = 'PDF, DOC or DOCX'

/** Telegram caps a bot download at 20 MB; a CV has no business being close. */
export const MAX_CV_BYTES = 5 * 1024 * 1024

export interface CvIntakeDeps {
  documents: CandidateDocumentRepository
  storage: StorageService
  securityEvents: SecurityEventService
  logger: Logger
}

export interface CvIntakeRequest {
  tenantId: string
  candidateId: string
  filename: string
  contentType: string
  body: ArrayBuffer
  source: CandidateDocument['source']
  kind?: CandidateDocument['kind']
  uploadedByUserId?: string | null
  /** Channel recorded on a security event, so the source is visible. */
  channel: 'TELEGRAM_EXTERNAL' | 'TELEGRAM_INTERNAL' | 'WEB'
}

export class CvTooLargeError extends Error {
  constructor(readonly byteSize: number) {
    super(`The file is ${Math.ceil(byteSize / 1024)} KB; the limit is ${MAX_CV_BYTES / 1024 / 1024} MB.`)
    this.name = 'CvTooLargeError'
  }
}

export class UnsupportedCvError extends Error {
  constructor(readonly contentType: string) {
    super(`That file type is not accepted. Send a ${CV_FORMATS_LABEL} file.`)
    this.name = 'UnsupportedCvError'
  }
}

export function looksLikeAcceptedCv(filename: string, contentType: string): boolean {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (CV_CONTENT_TYPES.includes(base)) return true
  const lower = filename.toLowerCase()
  return CV_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** Content hash, so a re-upload of the same file is recognisable. */
async function checksumOf(body: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', body)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export class CvIntakeService {
  constructor(private readonly deps: CvIntakeDeps) {}

  async store(request: CvIntakeRequest): Promise<CandidateDocument> {
    if (request.body.byteLength > MAX_CV_BYTES) throw new CvTooLargeError(request.body.byteLength)
    if (!looksLikeAcceptedCv(request.filename, request.contentType)) {
      throw new UnsupportedCvError(request.contentType)
    }

    const scope = tenantScope(request.tenantId)

    // Stored before extraction: the original is the record of what the
    // candidate actually sent, and it must survive a parser failure.
    const key = cvKey(request.tenantId, request.candidateId, request.filename)
    await this.deps.storage.put(key, request.body, request.contentType)

    let text = ''
    let extractor: string | null = null
    let warnings: string[] = []
    let status: CandidateDocument['extractionStatus'] = 'OK'

    try {
      const extraction = await extractText(request.body, request.contentType, request.filename)
      text = normaliseWhitespace(extraction.text)
      extractor = extraction.extractor
      warnings = extraction.warnings
      if (text.length === 0) status = 'EMPTY'
    } catch (e) {
      if (e instanceof UnsupportedDocumentError) {
        status = 'UNSUPPORTED'
        warnings = [e.message]
      } else {
        status = 'FAILED'
        warnings = [e instanceof Error ? e.message : 'The file could not be read.']
        this.deps.logger.warn('CV extraction failed', {
          action: 'cv.intake',
          result: 'extract_failed',
          tenantId: request.tenantId,
        })
      }
    }

    const scan = text.length > 0 ? scanForInjection(text) : null
    if (scan?.detected) {
      await this.deps.securityEvents.record({
        tenantId: request.tenantId,
        eventType: 'DOCUMENT_INJECTION',
        severity: injectionSeverity(scan),
        channel: request.channel,
        userId: request.uploadedByUserId ?? null,
        summary: `Uploaded CV "${request.filename}" contains instruction-like text`,
        // Evidence samples only — never the CV, which is personal data.
        detail: {
          candidateId: request.candidateId,
          categories: scan.categories,
          score: scan.score,
        },
      })
    }

    return this.deps.documents.create(scope, {
      candidateId: request.candidateId,
      kind: request.kind ?? 'CV',
      filename: request.filename,
      contentType: request.contentType,
      byteSize: request.body.byteLength,
      checksum: await checksumOf(request.body),
      storageKey: key,
      extractedText: text.length > 0 ? text : null,
      extractionStatus: status,
      extractor,
      extractionWarnings: warnings,
      injectionFlagged: scan?.detected === true,
      source: request.source,
      uploadedByUserId: request.uploadedByUserId ?? null,
    })
  }
}
