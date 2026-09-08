'use client'

/**
 * Knowledge base — policies, handbook and procedures (CLAUDE.md §23, §24, §33).
 *
 * Everything on this page is what the API returned after the PolicyGateway
 * filtered by the user's classification clearance. The "search preview" calls
 * the same permission-filtered retrieval the assistant uses, so HR can see
 * exactly which passages a model would be allowed to read for this user.
 *
 * Permission checks here are for UX only; every request is re-authorised by
 * the API and a 403 is rendered as the server's own message (CLAUDE.md §34).
 */

import { useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import { PageHeader, Shell } from '@/components/shell'
import { Badge, Card, Empty, ErrorState, Loading, formatDate, formatDateTime } from '@/components/ui'
import { useSession } from '@/components/session'
import {
  API_BASE,
  ApiRequestError,
  CSRF_HEADER,
  api,
  can,
  getCsrfToken,
  type ApiError,
  type Page,
} from '@/lib/api'
import { useApi } from '@/lib/use-api'

// --- Response shapes (mirror apps/api/src/routes/knowledge.ts) -------------

type Classification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED'
type DocumentStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'ARCHIVED'

interface KnowledgeDocument {
  id: string
  tenantId: string
  name: string
  category: string
  classification: Classification
  owner: string | null
  status: DocumentStatus
  createdAt: string
  updatedAt: string
}

interface DocumentVersion {
  id: string
  documentId: string
  tenantId: string
  version: number
  effectiveFrom: string
  effectiveTo: string | null
  filePath: string | null
  contentType: string | null
  byteSize: number | null
  createdAt: string
  createdBy: string | null
}

interface DocumentDetail {
  document: KnowledgeDocument
  versions: DocumentVersion[]
  effectiveVersion: DocumentVersion | null
}

interface IngestResult {
  versionId: string
  version: number
  chunkCount: number
  storageKey: string | null
  byteSize: number
  injectionFlagged: boolean
}

interface UploadResponse {
  version: IngestResult
  injectionFlagged: boolean
  storageDurable: boolean
}

interface SearchPassage {
  documentName: string
  section: string | null
  page: number | null
  version: number
  classification: Classification
  content: string
  injectionFlagged: boolean
}

interface SearchResponse {
  strategy: 'fts' | 'like' | 'none'
  maxClassification: Classification
  passages: SearchPassage[]
}

/** What the last successful mutation produced, shown above the versions table. */
type Outcome =
  | { kind: 'updated' }
  | { kind: 'version'; result: IngestResult; storageDurable: boolean | null }

// --- Constants and local helpers -------------------------------------------

const CLASSIFICATIONS: Classification[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']
const STATUSES: DocumentStatus[] = ['DRAFT', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED']
const PAGE_SIZE = 20
/** Client-side hint only — the server enforces the supported content types. */
const ACCEPTED_EXTENSIONS = ['.txt', '.md', '.csv', '.html', '.json']

const STRATEGY_LABEL: Record<SearchResponse['strategy'], string> = {
  fts: 'Full-text index',
  like: 'Keyword fallback',
  none: 'No searchable terms',
}

const linkButtonStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: 'var(--accent)',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}

const passageStyle: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  background: 'var(--surface-alt)',
  padding: '10px 12px',
}

function rankOf(classification: Classification): number {
  return CLASSIFICATIONS.indexOf(classification)
}

interface FieldIssue {
  path: string
  message: string
}

/** Per-field validation issues, when the API supplied them. */
function issuesOf(error: unknown): FieldIssue[] {
  if (!(error instanceof ApiRequestError)) return []
  const issues = error.error.details?.issues
  if (!Array.isArray(issues)) return []
  return issues.filter(
    (issue): issue is FieldIssue =>
      typeof issue === 'object' &&
      issue !== null &&
      typeof (issue as FieldIssue).path === 'string' &&
      typeof (issue as FieldIssue).message === 'string',
  )
}

function messageOf(error: unknown): string {
  if (error instanceof ApiRequestError) return error.error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function todayIso(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function hasAcceptedExtension(filename: string): boolean {
  const lower = filename.toLowerCase()
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * Multipart upload. The shared api() helper only sends JSON, so this one call
 * builds its own request: same cookie, same CSRF header, same error shape.
 */
async function uploadPolicyFile(
  documentId: string,
  effectiveFrom: string,
  file: File,
): Promise<UploadResponse> {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('documentId', documentId)
  form.append('effectiveFrom', effectiveFrom)

  // No content-type header: the browser sets the multipart boundary itself.
  const headers: Record<string, string> = {}
  const token = getCsrfToken()
  if (token) headers[CSRF_HEADER] = token

  const response = await fetch(`${API_BASE}/policies/upload`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: form,
  })

  const text = await response.text()
  let payload: Record<string, unknown> = {}
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    payload = {}
  }

  if (!response.ok) {
    const error = (payload.error as ApiError | undefined) ?? {
      code: 'UNKNOWN',
      message: 'The upload failed.',
    }
    throw new ApiRequestError(response.status, error)
  }
  return payload as unknown as UploadResponse
}

/** Error notice for a failed form submission, with per-field issues when given. */
function SubmitError({ error }: { error: unknown }) {
  if (error instanceof ApiRequestError && error.isForbidden) {
    return <ErrorState error={error} />
  }
  const issues = issuesOf(error)
  return (
    <div className="notice error" role="alert">
      <strong>Could not save. </strong>
      {messageOf(error)}
      {issues.length > 0 ? (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {issues.map((issue, i) => (
            <li key={`${issue.path}-${i}`}>
              <span className="mono">{issue.path || 'form'}</span> {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

// --- Page -----------------------------------------------------------------

export default function KnowledgePage() {
  const { user } = useSession()
  const canCreate = can(user, 'policy.create')
  const canUpdate = can(user, 'policy.update')

  const [categoryInput, setCategoryInput] = useState('')
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState('')
  const [offset, setOffset] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const listPath = useMemo(() => {
    const params = new URLSearchParams()
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', String(offset))
    if (category) params.set('category', category)
    if (status) params.set('status', status)
    return `/policies?${params.toString()}`
  }, [category, status, offset])

  const list = useApi<Page<KnowledgeDocument>>(listPath)

  function applyFilters(event: FormEvent) {
    event.preventDefault()
    setCategory(categoryInput.trim())
    setOffset(0)
  }

  function clearFilters() {
    setCategoryInput('')
    setCategory('')
    setStatus('')
    setOffset(0)
  }

  const page = list.data
  const from = page && page.items.length > 0 ? page.offset + 1 : 0
  const to = page ? page.offset + page.items.length : 0

  return (
    <Shell>
      <PageHeader
        title="Knowledge"
        description="HR policies, handbook and procedures — versioned, classified, and retrieved for the assistant only within each user’s clearance."
        actions={
          canCreate ? (
            <button
              type="button"
              className="primary"
              onClick={() => setShowCreate((v) => !v)}
              aria-expanded={showCreate}
            >
              {showCreate ? 'Close' : 'New document'}
            </button>
          ) : undefined
        }
      />

      {showCreate && canCreate ? (
        <div style={{ marginBottom: 14 }}>
          <Card title="New document">
            <CreateDocumentForm
              onCreated={(document) => {
                setShowCreate(false)
                setSelectedId(document.id)
                list.reload()
              }}
              onCancel={() => setShowCreate(false)}
            />
          </Card>
        </div>
      ) : null}

      <div className="grid two" style={{ marginBottom: 14 }}>
        <Card title="Documents">
          <div className="notice info" style={{ marginBottom: 12, fontSize: 13 }}>
            This list only shows documents you are cleared to read. Anything above your
            classification clearance is not listed at all, and the assistant is filtered by the
            same rule.
          </div>

          <form className="toolbar" onSubmit={applyFilters} aria-label="Filter documents">
            <label htmlFor="filter-category" className="visually-hidden">
              Category
            </label>
            <input
              id="filter-category"
              type="search"
              placeholder="Category"
              value={categoryInput}
              onChange={(e) => setCategoryInput(e.target.value)}
              maxLength={60}
            />
            <label htmlFor="filter-status" className="visually-hidden">
              Status
            </label>
            <select
              id="filter-status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                setOffset(0)
              }}
            >
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.charAt(0) + s.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
            <button type="submit">Apply</button>
            {category || status ? (
              <button type="button" onClick={clearFilters}>
                Clear
              </button>
            ) : null}
          </form>

          {list.loading ? (
            <Loading rows={5} />
          ) : list.error ? (
            <ErrorState error={list.error} />
          ) : !page || page.items.length === 0 ? (
            <Empty
              title="No documents to show"
              hint={
                category || status
                  ? 'Try clearing the filters.'
                  : canCreate
                    ? 'Create a document, then add a version from text or upload a file.'
                    : 'Nothing within your clearance has been published yet.'
              }
            />
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Category</th>
                      <th scope="col">Classification</th>
                      <th scope="col">Status</th>
                      <th scope="col">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((doc) => {
                      const selected = doc.id === selectedId
                      return (
                        <tr
                          key={doc.id}
                          style={selected ? { background: 'var(--accent-soft)' } : undefined}
                        >
                          <td>
                            <button
                              type="button"
                              style={{ ...linkButtonStyle, fontWeight: selected ? 600 : 500 }}
                              onClick={() => setSelectedId(doc.id)}
                              aria-current={selected ? 'true' : undefined}
                            >
                              {doc.name}
                            </button>
                          </td>
                          <td>{doc.category}</td>
                          <td>
                            <Badge value={doc.classification} />
                          </td>
                          <td>
                            <Badge value={doc.status} />
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(doc.updatedAt)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div
                className="toolbar"
                style={{ justifyContent: 'space-between', marginTop: 12, marginBottom: 0 }}
              >
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }} aria-live="polite">
                  Showing {from}–{to} of {page.total.toLocaleString()}
                </span>
                {page.hasMore || page.offset > 0 ? (
                  <span style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      disabled={page.offset === 0}
                      onClick={() => setOffset(Math.max(0, page.offset - PAGE_SIZE))}
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      disabled={!page.hasMore}
                      onClick={() => setOffset(page.offset + PAGE_SIZE)}
                    >
                      Next
                    </button>
                  </span>
                ) : null}
              </div>
            </>
          )}
        </Card>

        {selectedId ? (
          <DocumentPanel
            key={selectedId}
            documentId={selectedId}
            canUpdate={canUpdate}
            onChanged={() => list.reload()}
          />
        ) : (
          <Card title="Document">
            <Empty
              title="Select a document"
              hint="Choose a document from the list to see its versions and manage it."
            />
          </Card>
        )}
      </div>

      <Card title="Search preview">
        <SearchPreview />
      </Card>
    </Shell>
  )
}

// --- Create ----------------------------------------------------------------

function CreateDocumentForm({
  onCreated,
  onCancel,
}: {
  onCreated(document: KnowledgeDocument): void
  onCancel(): void
}) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [classification, setClassification] = useState<Classification>('INTERNAL')
  const [owner, setOwner] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const body: Record<string, string> = {
        name: name.trim(),
        category: category.trim(),
        classification,
      }
      if (owner.trim()) body.owner = owner.trim()
      const result = await api<{ document: KnowledgeDocument }>('/policies', { method: 'POST', body })
      onCreated(result.document)
    } catch (e) {
      setError(e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={onSubmit} aria-label="New document">
      {error ? <SubmitError error={error} /> : null}
      <div className="form-row">
        <div className="field">
          <label htmlFor="new-name">Name</label>
          <input
            id="new-name"
            required
            minLength={2}
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="new-category">Category</label>
          <input
            id="new-category"
            required
            minLength={2}
            maxLength={60}
            placeholder="e.g. leave, conduct, benefits"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="new-classification">Classification</label>
          <select
            id="new-classification"
            value={classification}
            onChange={(e) => setClassification(e.target.value as Classification)}
          >
            {CLASSIFICATIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <div className="hint">
            Decides who can read it — here and through the assistant. Enforced by the server.
          </div>
        </div>
        <div className="field">
          <label htmlFor="new-owner">Owner (optional)</label>
          <input
            id="new-owner"
            maxLength={120}
            placeholder="Team or role responsible"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          />
        </div>
      </div>
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <button type="submit" className="primary" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create document'}
        </button>
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <span role="status" aria-live="polite" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {submitting ? 'Saving…' : ''}
        </span>
      </div>
    </form>
  )
}

// --- Detail ----------------------------------------------------------------

type PanelMode = 'view' | 'edit' | 'version' | 'upload'

function DocumentPanel({
  documentId,
  canUpdate,
  onChanged,
}: {
  documentId: string
  canUpdate: boolean
  onChanged(): void
}) {
  const detail = useApi<DocumentDetail>(`/policies/${documentId}`)
  const [mode, setMode] = useState<PanelMode>('view')
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  function finish(result: Outcome | null) {
    setOutcome(result)
    setMode('view')
    detail.reload()
    onChanged()
  }

  const document = detail.data?.document
  const toggle = (next: PanelMode) => () => {
    setOutcome(null)
    setMode((current) => (current === next ? 'view' : next))
  }

  return (
    <Card
      title="Document"
      actions={
        canUpdate && document ? (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button type="button" onClick={toggle('edit')} aria-pressed={mode === 'edit'}>
              Edit
            </button>
            <button type="button" onClick={toggle('version')} aria-pressed={mode === 'version'}>
              Add version from text
            </button>
            <button type="button" onClick={toggle('upload')} aria-pressed={mode === 'upload'}>
              Upload file
            </button>
          </div>
        ) : undefined
      }
    >
      {detail.loading ? (
        <Loading rows={4} />
      ) : detail.error ? (
        <ErrorState error={detail.error} />
      ) : !detail.data || !document ? (
        <Empty title="Document not found" />
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <h3 style={{ fontSize: 16, marginBottom: 6 }}>{document.name}</h3>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <Badge value={document.classification} />
              <Badge value={document.status} />
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{document.category}</span>
            </div>
            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                gap: '4px 12px',
                margin: '10px 0 0',
                fontSize: 13,
              }}
            >
              <dt style={{ color: 'var(--text-muted)' }}>Owner</dt>
              <dd style={{ margin: 0 }}>{document.owner ?? '—'}</dd>
              <dt style={{ color: 'var(--text-muted)' }}>Updated</dt>
              <dd style={{ margin: 0 }}>{formatDateTime(document.updatedAt)}</dd>
              <dt style={{ color: 'var(--text-muted)' }}>Effective today</dt>
              <dd style={{ margin: 0 }}>
                {detail.data.effectiveVersion ? (
                  <>
                    Version {detail.data.effectiveVersion.version} — from{' '}
                    {formatDate(detail.data.effectiveVersion.effectiveFrom)}
                    {detail.data.effectiveVersion.effectiveTo
                      ? ` to ${formatDate(detail.data.effectiveVersion.effectiveTo)}`
                      : ', open-ended'}
                  </>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>
                    No version is in effect today — the assistant will not cite this document.
                  </span>
                )}
              </dd>
            </dl>
          </div>

          {outcome ? <OutcomeNotice outcome={outcome} /> : null}

          {mode === 'edit' && canUpdate ? (
            <EditDocumentForm
              document={document}
              onSaved={() => finish({ kind: 'updated' })}
              onCancel={() => setMode('view')}
            />
          ) : null}
          {mode === 'version' && canUpdate ? (
            <AddVersionForm
              document={document}
              nextVersion={detail.data.versions.length + 1}
              onDone={(result) => finish({ kind: 'version', result, storageDurable: null })}
              onCancel={() => setMode('view')}
            />
          ) : null}
          {mode === 'upload' && canUpdate ? (
            <UploadVersionForm
              document={document}
              nextVersion={detail.data.versions.length + 1}
              onDone={(response) =>
                finish({
                  kind: 'version',
                  result: response.version,
                  storageDurable: response.storageDurable,
                })
              }
              onCancel={() => setMode('view')}
            />
          ) : null}

          <h3 style={{ margin: '14px 0 8px' }}>Versions</h3>
          {detail.data.versions.length === 0 ? (
            <Empty
              title="No versions yet"
              hint={
                canUpdate
                  ? 'Add a version from text or upload a file to make this document searchable.'
                  : 'This document has no content yet.'
              }
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Version</th>
                    <th scope="col">Effective from</th>
                    <th scope="col">Effective to</th>
                    <th scope="col">Size</th>
                    <th scope="col">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.versions.map((v) => {
                    const effective = detail.data?.effectiveVersion?.id === v.id
                    return (
                      <tr key={v.id}>
                        <td>
                          v{v.version}{' '}
                          {effective ? <span className="badge ok">Effective</span> : null}
                        </td>
                        <td>{formatDate(v.effectiveFrom)}</td>
                        <td>{v.effectiveTo ? formatDate(v.effectiveTo) : 'Open-ended'}</td>
                        <td className="num">{formatBytes(v.byteSize)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(v.createdAt)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

function OutcomeNotice({ outcome }: { outcome: Outcome }) {
  if (outcome.kind === 'updated') {
    return (
      <div className="notice info" role="status">
        Document updated.
      </div>
    )
  }
  const { result, storageDurable } = outcome
  return (
    <div role="status" aria-live="polite">
      <div className="notice info">
        <strong>Version {result.version} added. </strong>
        {result.chunkCount.toLocaleString()} passage{result.chunkCount === 1 ? '' : 's'} indexed
        {result.byteSize ? ` from ${formatBytes(result.byteSize)}` : ''}. Any earlier version was
        closed the day before this one takes effect.
      </div>
      {result.injectionFlagged ? (
        <div className="notice warn">
          <strong>Instruction-like text detected. </strong>
          The document contained text that reads like instructions to an AI. It has been indexed as
          plain data only — it can never act as instructions — and a security event was recorded
          for review.
        </div>
      ) : null}
      {storageDurable === false ? (
        <div className="notice warn">
          <strong>Document storage is ephemeral in this deployment. </strong>
          The extracted text is indexed, but the original file is not kept durably. Keep a copy
          elsewhere.
        </div>
      ) : null}
    </div>
  )
}

// --- Edit ------------------------------------------------------------------

function EditDocumentForm({
  document,
  onSaved,
  onCancel,
}: {
  document: KnowledgeDocument
  onSaved(): void
  onCancel(): void
}) {
  const [name, setName] = useState(document.name)
  const [category, setCategory] = useState(document.category)
  const [classification, setClassification] = useState<Classification>(document.classification)
  const [status, setStatus] = useState<DocumentStatus>(document.status)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const changes: Record<string, string> = {}
  if (name.trim() !== document.name) changes.name = name.trim()
  if (category.trim() !== document.category) changes.category = category.trim()
  if (classification !== document.classification) changes.classification = classification
  if (status !== document.status) changes.status = status
  const dirty = Object.keys(changes).length > 0

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!dirty) return

    if (rankOf(classification) > rankOf(document.classification)) {
      const ok = window.confirm(
        `Raise “${document.name}” from ${document.classification} to ${classification}?\n\n` +
          `Users cleared only up to ${document.classification} will no longer see this document, ` +
          'here or through the assistant.',
      )
      if (!ok) return
    } else if (rankOf(classification) < rankOf(document.classification)) {
      const ok = window.confirm(
        `Lower “${document.name}” from ${document.classification} to ${classification}?\n\n` +
          'More users will be able to read it, including through the assistant.',
      )
      if (!ok) return
    }
    if (status !== document.status && status === 'ARCHIVED') {
      const ok = window.confirm(`Archive “${document.name}”? It will no longer be offered as current policy.`)
      if (!ok) return
    }

    setSubmitting(true)
    setError(null)
    try {
      await api<{ document: KnowledgeDocument }>(`/policies/${document.id}`, {
        method: 'PUT',
        body: changes,
      })
      onSaved()
    } catch (e) {
      setError(e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Edit document"
      style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginBottom: 12 }}
    >
      <h3 style={{ marginBottom: 10 }}>Edit</h3>
      {error ? <SubmitError error={error} /> : null}
      <div className="form-row">
        <div className="field">
          <label htmlFor="edit-name">Name</label>
          <input
            id="edit-name"
            required
            minLength={2}
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="edit-category">Category</label>
          <input
            id="edit-category"
            required
            minLength={2}
            maxLength={60}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="edit-classification">Classification</label>
          <select
            id="edit-classification"
            value={classification}
            onChange={(e) => setClassification(e.target.value as Classification)}
          >
            {CLASSIFICATIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {classification !== document.classification ? (
            <div className="hint">
              {rankOf(classification) > rankOf(document.classification)
                ? 'Raising — you will be asked to confirm.'
                : 'Lowering widens who can read this — you will be asked to confirm.'}
            </div>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="edit-status">Status</label>
          <select
            id="edit-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as DocumentStatus)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <button type="submit" className="primary" disabled={submitting || !dirty}>
          {submitting ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <span role="status" aria-live="polite" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {submitting ? 'Saving…' : dirty ? '' : 'No changes yet.'}
        </span>
      </div>
    </form>
  )
}

// --- Add version from text -------------------------------------------------

function AddVersionForm({
  document,
  nextVersion,
  onDone,
  onCancel,
}: {
  document: KnowledgeDocument
  nextVersion: number
  onDone(result: IngestResult): void
  onCancel(): void
}) {
  const [text, setText] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso())
  const [effectiveTo, setEffectiveTo] = useState('')
  const [filename, setFilename] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    const ok = window.confirm(
      `Add version ${nextVersion} of “${document.name}”, effective ${effectiveFrom}?\n\n` +
        'The current version will be closed the day before this one takes effect. ' +
        'The text is indexed as untrusted data.',
    )
    if (!ok) return

    setSubmitting(true)
    setError(null)
    try {
      const body: Record<string, string> = { text, effectiveFrom }
      if (effectiveTo) body.effectiveTo = effectiveTo
      if (filename.trim()) body.filename = filename.trim()
      const result = await api<{ version: IngestResult }>(`/policies/${document.id}/versions`, {
        method: 'POST',
        body,
      })
      onDone(result.version)
    } catch (e) {
      setError(e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Add version from text"
      style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginBottom: 12 }}
    >
      <h3 style={{ marginBottom: 10 }}>Add version {nextVersion} from text</h3>
      {error ? <SubmitError error={error} /> : null}
      <div className="field">
        <label htmlFor="version-text">Policy text</label>
        <textarea
          id="version-text"
          required
          minLength={20}
          rows={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
        />
        <div className="hint">
          At least 20 characters. Headings and paragraphs are split into searchable passages; the
          text is stored as data, never as instructions.
        </div>
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="version-from">Effective from</label>
          <input
            id="version-from"
            type="date"
            required
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="version-to">Effective to (optional)</label>
          <input
            id="version-to"
            type="date"
            value={effectiveTo}
            min={effectiveFrom || undefined}
            onChange={(e) => setEffectiveTo(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="version-filename">Filename (optional)</label>
          <input
            id="version-filename"
            maxLength={200}
            placeholder={`${document.name}.txt`}
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
          />
        </div>
      </div>
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <button type="submit" className="primary" disabled={submitting}>
          {submitting ? 'Indexing…' : 'Add version'}
        </button>
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <span role="status" aria-live="polite" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {submitting ? 'Extracting, chunking and indexing…' : ''}
        </span>
      </div>
    </form>
  )
}

// --- Upload file -----------------------------------------------------------

function UploadVersionForm({
  document,
  nextVersion,
  onDone,
  onCancel,
}: {
  document: KnowledgeDocument
  nextVersion: number
  onDone(response: UploadResponse): void
  onCancel(): void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setLocalError(null)
    if (!file) {
      setLocalError('Choose a file to upload.')
      return
    }
    if (!hasAcceptedExtension(file.name)) {
      setLocalError(`Only ${ACCEPTED_EXTENSIONS.join(', ')} files are accepted.`)
      return
    }
    const ok = window.confirm(
      `Upload “${file.name}” (${formatBytes(file.size)}) as version ${nextVersion} of “${document.name}”, ` +
        `effective ${effectiveFrom}?\n\n` +
        'The current version will be closed the day before this one takes effect. ' +
        'The file is treated as untrusted data.',
    )
    if (!ok) return

    setSubmitting(true)
    setError(null)
    try {
      const response = await uploadPolicyFile(document.id, effectiveFrom, file)
      onDone(response)
    } catch (e) {
      setError(e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Upload file"
      style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginBottom: 12 }}
    >
      <h3 style={{ marginBottom: 10 }}>Upload version {nextVersion} from a file</h3>
      {error ? <SubmitError error={error} /> : null}
      {localError ? (
        <div className="notice error" role="alert">
          {localError}
        </div>
      ) : null}
      <div className="form-row">
        <div className="field">
          <label htmlFor="upload-file">File</label>
          <input
            id="upload-file"
            type="file"
            required
            accept={ACCEPTED_EXTENSIONS.join(',')}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null)
              setLocalError(null)
            }}
          />
          <div className="hint">
            {ACCEPTED_EXTENSIONS.join(', ')} only. The server checks the content type and enforces
            a size limit.
            {file ? ` Selected: ${file.name} (${formatBytes(file.size)}).` : ''}
          </div>
        </div>
        <div className="field">
          <label htmlFor="upload-from">Effective from</label>
          <input
            id="upload-from"
            type="date"
            required
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
          />
        </div>
      </div>
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <button type="submit" className="primary" disabled={submitting}>
          {submitting ? 'Uploading…' : 'Upload'}
        </button>
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <span role="status" aria-live="polite" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {submitting ? 'Uploading, extracting and indexing…' : ''}
        </span>
      </div>
    </form>
  )
}

// --- Search preview --------------------------------------------------------

function SearchPreview() {
  const [question, setQuestion] = useState('')
  const [category, setCategory] = useState('')
  const [result, setResult] = useState<SearchResponse | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [searching, setSearching] = useState(false)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setSearching(true)
    setError(null)
    try {
      const body: Record<string, string> = { question: question.trim() }
      if (category.trim()) body.category = category.trim()
      setResult(await api<SearchResponse>('/policies/search', { method: 'POST', body }))
    } catch (e) {
      setResult(null)
      setError(e)
    } finally {
      setSearching(false)
    }
  }

  return (
    <>
      <p style={{ margin: '0 0 12px', color: 'var(--text-muted)', fontSize: 13, maxWidth: '72ch' }}>
        Ask a question the way an employee would. The passages below are exactly the ones the
        assistant would be allowed to see when answering it for <em>you</em> — retrieval is
        filtered by your classification clearance before any model sees a word.
      </p>
      <form onSubmit={onSubmit} aria-label="Search preview">
        <div className="form-row">
          <div className="field" style={{ gridColumn: 'span 2' }}>
            <label htmlFor="search-question">Question</label>
            <input
              id="search-question"
              required
              minLength={3}
              maxLength={500}
              placeholder="e.g. How many days of annual leave do new employees get?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="search-category">Category (optional)</label>
            <input
              id="search-category"
              maxLength={60}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
          </div>
        </div>
        <div className="toolbar">
          <button type="submit" className="primary" disabled={searching || question.trim().length < 3}>
            {searching ? 'Searching…' : 'Preview retrieval'}
          </button>
          <span role="status" aria-live="polite" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {searching ? 'Retrieving authorised passages…' : ''}
          </span>
        </div>
      </form>

      {searching ? (
        <Loading rows={3} />
      ) : error ? (
        <ErrorState error={error} />
      ) : result ? (
        <div>
          <div
            className="toolbar"
            style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}
            aria-live="polite"
          >
            <span>
              Strategy: <span className="mono">{result.strategy}</span> — {STRATEGY_LABEL[result.strategy]}
            </span>
            <span>
              Your clearance ceiling: <Badge value={result.maxClassification} />
            </span>
            <span>
              {result.passages.length.toLocaleString()} passage{result.passages.length === 1 ? '' : 's'}
            </span>
          </div>

          {result.passages.length === 0 ? (
            <Empty
              title="No passages found"
              hint="Nothing within your clearance matched. The assistant would say it lacks verified information and refer to HR rather than guess."
            />
          ) : (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
              {result.passages.map((p, i) => (
                <li key={`${p.documentName}-${p.version}-${i}`} style={passageStyle}>
                  <div
                    style={{
                      display: 'flex',
                      gap: 8,
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      marginBottom: 6,
                      fontSize: 13,
                    }}
                  >
                    <strong>{p.documentName}</strong>
                    {p.section ? <span style={{ color: 'var(--text-muted)' }}>{p.section}</span> : null}
                    {p.page !== null ? <span style={{ color: 'var(--text-faint)' }}>p. {p.page}</span> : null}
                    <span style={{ color: 'var(--text-faint)' }}>v{p.version}</span>
                    <Badge value={p.classification} />
                    {p.injectionFlagged ? (
                      <span
                        className="badge warn"
                        title="This passage contains instruction-like text. It is shown to the assistant as data only."
                      >
                        Instruction-like text
                      </span>
                    ) : null}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{p.content}</div>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : (
        <Empty
          title="No search yet"
          hint="Enter a question above to see which passages retrieval would hand to the assistant."
        />
      )}
    </>
  )
}
