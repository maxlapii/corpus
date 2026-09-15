'use client'

/**
 * Policies — HR policies, handbook and procedures (CLAUDE.md §23, §24, §33).
 *
 * Layout: a master/detail split. The list on the left is exactly what the API
 * returned after the PolicyGateway filtered by the user's classification
 * clearance, so a document above that clearance is never listed. The panel on
 * the right shows one document with its actions first, then facts, then the
 * version history. "What the bot can quote" calls the same permission-filtered
 * retrieval the assistant uses, so HR sees the passages the bot may cite.
 *
 * Permission checks here are for UX only; every request is re-authorised by
 * the API and a 403 is rendered as the server's own message (CLAUDE.md §34).
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { PageHeader, Shell } from '@/components/shell'
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  Facts,
  Field,
  Loading,
  Notice,
  Pager,
  SubmitError,
  formatDate,
  formatDateTime,
  type BadgeTone,
} from '@/components/ui'
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

/** What the last successful action in the panel produced. */
type Outcome =
  | { kind: 'updated' }
  | { kind: 'published' }
  | { kind: 'archived' }
  | { kind: 'version'; version: number; injectionFlagged: boolean; storageDurable: boolean | null }

// --- Labels and helpers ----------------------------------------------------

const CLASSIFICATIONS: Classification[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']

const CLASSIFICATION_LABEL: Record<Classification, string> = {
  PUBLIC: 'Anyone, including candidates',
  INTERNAL: 'All employees',
  CONFIDENTIAL: 'HR only',
  RESTRICTED: 'HR administrators only',
}

const STATUS_LABEL: Record<DocumentStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Published',
  SUPERSEDED: 'Replaced',
  ARCHIVED: 'Archived',
}

const STATUS_TONE: Record<DocumentStatus, BadgeTone> = {
  DRAFT: 'muted',
  ACTIVE: 'ok',
  SUPERSEDED: 'muted',
  ARCHIVED: 'muted',
}

/** Statuses a user may filter by. SUPERSEDED is listed but never chosen for a document. */
const FILTER_STATUSES: DocumentStatus[] = ['DRAFT', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED']

const PAGE_SIZE = 20
const MIN_TEXT_LENGTH = 20
/** Client-side hint only — the server enforces the supported content types. */
const ACCEPTED_EXTENSIONS = ['.txt', '.md', '.csv', '.html', '.json']

/** Trails the input by `delay` so the list is not refetched on every keystroke. */
function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
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

/** Category suggestions for the create and edit forms. */
function CategoryOptions({ id, categories }: { id: string; categories: string[] }) {
  return (
    <datalist id={id}>
      {categories.map((category) => (
        <option key={category} value={category} />
      ))}
    </datalist>
  )
}

// --- Page -----------------------------------------------------------------

export default function PoliciesPage() {
  const { user } = useSession()
  const canRead = can(user, 'policy.read')
  const canCreate = can(user, 'policy.create')
  const canUpdate = can(user, 'policy.update')
  const canPreview = can(user, 'faq.manage')

  const [categoryInput, setCategoryInput] = useState('')
  const category = useDebounced(categoryInput.trim())
  const [status, setStatus] = useState('')
  const [offset, setOffset] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const listPath = useMemo(() => {
    const params = new URLSearchParams()
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', String(offset))
    if (category) params.set('category', category)
    if (status) params.set('status', status)
    return `/policies?${params.toString()}`
  }, [category, status, offset])

  const list = useApi<Page<KnowledgeDocument>>(canRead ? listPath : null)

  const categories = useMemo(
    () => Array.from(new Set((list.data?.items ?? []).map((doc) => doc.category))).sort(),
    [list.data],
  )

  // On a narrow screen the panel sits below the list; bring it into view.
  useEffect(() => {
    if (!selectedId && !creating) return
    if (typeof window !== 'undefined' && window.innerWidth < 1200) {
      panelRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
  }, [selectedId, creating])

  function resetForFilter() {
    setOffset(0)
    setSelectedId(null)
  }

  function clearFilters() {
    setCategoryInput('')
    setStatus('')
    resetForFilter()
  }

  function select(id: string) {
    setCreating(false)
    setSelectedId(id)
  }

  if (!canRead) {
    return (
      <Shell>
        <PageHeader title="Policies" />
        <Card>
          <Empty title="You do not have access to policies" hint="Ask an HR administrator." />
        </Card>
      </Shell>
    )
  }

  const page = list.data
  const filtered = Boolean(categoryInput || status)

  return (
    <Shell>
      <PageHeader
        title="Policies"
        description="HR policies and procedures. Each document keeps its history, and the bots only quote what the reader is allowed to see."
        actions={
          canCreate ? (
            <button
              type="button"
              className="primary"
              onClick={() => {
                setSelectedId(null)
                setCreating(true)
              }}
            >
              New document
            </button>
          ) : undefined
        }
      />

      <div className="grid">
        <div className="split">
          <Card title="Documents">
            <div className="toolbar" role="search">
              <label htmlFor="filter-category" className="visually-hidden">
                Category
              </label>
              <input
                id="filter-category"
                type="search"
                placeholder="Search by category"
                value={categoryInput}
                maxLength={60}
                onChange={(e) => {
                  setCategoryInput(e.target.value)
                  resetForFilter()
                }}
              />
              <label htmlFor="filter-status" className="visually-hidden">
                Status
              </label>
              <select
                id="filter-status"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value)
                  resetForFilter()
                }}
              >
                <option value="">All statuses</option>
                {FILTER_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
              {filtered ? (
                <button type="button" onClick={clearFilters}>
                  Clear
                </button>
              ) : null}
            </div>

            {list.loading ? (
              <Loading rows={5} />
            ) : list.error ? (
              <ErrorState error={list.error} />
            ) : !page || page.items.length === 0 ? (
              <Empty
                title="No documents to show"
                hint={
                  filtered
                    ? 'Try clearing the filters.'
                    : canCreate
                      ? 'Create a document, then add its first version from a file or pasted text.'
                      : 'Nothing has been published for you yet.'
                }
              />
            ) : (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Who can read</th>
                        <th scope="col">Status</th>
                        <th scope="col">In effect</th>
                      </tr>
                    </thead>
                    <tbody>
                      {page.items.map((doc) => {
                        const selected = doc.id === selectedId
                        return (
                          <tr
                            key={doc.id}
                            className="selectable"
                            aria-selected={selected}
                            onClick={() => select(doc.id)}
                          >
                            <td>
                              <button
                                type="button"
                                className="link"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  select(doc.id)
                                }}
                              >
                                {doc.name}
                              </button>
                              <div className="small-text muted">{doc.category}</div>
                            </td>
                            <td>{CLASSIFICATION_LABEL[doc.classification]}</td>
                            <td>
                              <Badge
                                value={STATUS_LABEL[doc.status]}
                                tone={STATUS_TONE[doc.status]}
                              />
                            </td>
                            <td>
                              {doc.status === 'ACTIVE' ? (
                                <Badge value="In effect" tone="ok" />
                              ) : (
                                <Badge value="None" tone="muted" />
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <Pager page={page} onChange={setOffset} />
              </>
            )}
          </Card>

          <div ref={panelRef} className="grid">
            {creating && canCreate ? (
              <Card title="New document">
                <CreateDocumentForm
                  categories={categories}
                  onCreated={(document) => {
                    setCreating(false)
                    setSelectedId(document.id)
                    list.reload()
                  }}
                  onCancel={() => setCreating(false)}
                />
              </Card>
            ) : selectedId ? (
              <DocumentPanel
                key={selectedId}
                documentId={selectedId}
                canUpdate={canUpdate}
                categories={categories}
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
        </div>

        {canPreview ? (
          <Card title="What the bot can quote">
            <QuotePreview />
          </Card>
        ) : null}
      </div>
    </Shell>
  )
}

// --- Create ----------------------------------------------------------------

function CreateDocumentForm({
  categories,
  onCreated,
  onCancel,
}: {
  categories: string[]
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
      const result = await api<{ document: KnowledgeDocument }>('/policies', {
        method: 'POST',
        body,
      })
      onCreated(result.document)
    } catch (e) {
      setError(e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={onSubmit} aria-label="New document">
      <SubmitError error={error} />
      <Field id="new-name" label="Document name">
        <input
          id="new-name"
          required
          minLength={2}
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field id="new-category" label="Category" hint="For example leave, conduct or benefits.">
        <input
          id="new-category"
          required
          minLength={2}
          maxLength={60}
          list="new-category-options"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <CategoryOptions id="new-category-options" categories={categories} />
      </Field>
      <Field id="new-classification" label="Who can read this">
        <select
          id="new-classification"
          value={classification}
          onChange={(e) => setClassification(e.target.value as Classification)}
        >
          {CLASSIFICATIONS.map((c) => (
            <option key={c} value={c}>
              {CLASSIFICATION_LABEL[c]}
            </option>
          ))}
        </select>
      </Field>
      <details className="more">
        <summary>More options</summary>
        <Field
          id="new-owner"
          label="Owner"
          hint="The team or role responsible for keeping it current."
        >
          <input
            id="new-owner"
            maxLength={120}
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          />
        </Field>
      </details>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create document'}
        </button>
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// --- Detail panel ----------------------------------------------------------

type PanelMode = 'view' | 'version' | 'edit'

function DocumentPanel({
  documentId,
  canUpdate,
  categories,
  onChanged,
}: {
  documentId: string
  canUpdate: boolean
  categories: string[]
  onChanged(): void
}) {
  const detail = useApi<DocumentDetail>(`/policies/${documentId}`)
  const [mode, setMode] = useState<PanelMode>('view')
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const document = detail.data?.document

  function finish(result: Outcome) {
    setOutcome(result)
    setMode('view')
    detail.reload()
    onChanged()
  }

  function toggle(next: PanelMode) {
    setOutcome(null)
    setActionError(null)
    setMode((current) => (current === next ? 'view' : next))
  }

  async function changeStatus(next: 'ACTIVE' | 'ARCHIVED') {
    if (!document) return
    if (
      next === 'ARCHIVED' &&
      !window.confirm(`Archive “${document.name}”? The bots will stop quoting it.`)
    ) {
      return
    }
    setBusy(true)
    setOutcome(null)
    setActionError(null)
    try {
      await api<{ document: KnowledgeDocument }>(`/policies/${document.id}`, {
        method: 'PUT',
        body: { status: next },
      })
      setMode('view')
      finish({ kind: next === 'ACTIVE' ? 'published' : 'archived' })
    } catch (e) {
      setActionError(e)
    } finally {
      setBusy(false)
    }
  }

  if (detail.loading) {
    return (
      <Card title="Document">
        <Loading rows={4} />
      </Card>
    )
  }
  if (detail.error) {
    return (
      <Card title="Document">
        <ErrorState error={detail.error} />
      </Card>
    )
  }
  if (!detail.data || !document) {
    return (
      <Card title="Document">
        <Empty title="Document not found" />
      </Card>
    )
  }

  const { versions, effectiveVersion } = detail.data

  return (
    <>
      <Card>
        <div className="card-header">
          <div className="actions">
            <h2>{document.name}</h2>
            {effectiveVersion ? (
              <Badge value="In effect" tone="ok" />
            ) : (
              <Badge value="No version in effect" tone="muted" />
            )}
          </div>
        </div>

        <div className="grid">
          {canUpdate ? (
            <div className="actions">
              <button
                type="button"
                onClick={() => toggle('version')}
                aria-pressed={mode === 'version'}
              >
                Add new version
              </button>
              <button type="button" onClick={() => toggle('edit')} aria-pressed={mode === 'edit'}>
                Edit details
              </button>
              {document.status === 'DRAFT' ? (
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => changeStatus('ACTIVE')}
                >
                  Publish
                </button>
              ) : null}
              {document.status !== 'ARCHIVED' ? (
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => changeStatus('ARCHIVED')}
                >
                  Archive
                </button>
              ) : null}
            </div>
          ) : null}

          {mode === 'version' && canUpdate ? (
            <AddVersionForm
              document={document}
              onDone={(result) => finish(result)}
              onCancel={() => setMode('view')}
            />
          ) : null}
          {mode === 'edit' && canUpdate ? (
            <EditDocumentForm
              document={document}
              categories={categories}
              onSaved={() => finish({ kind: 'updated' })}
              onCancel={() => setMode('view')}
            />
          ) : null}

          <SubmitError error={actionError} />
          {outcome ? <OutcomeNotice outcome={outcome} /> : null}
        </div>
      </Card>

      <Card title="Details">
        <Facts
          items={[
            { label: 'Category', value: document.category },
            { label: 'Who can read', value: CLASSIFICATION_LABEL[document.classification] },
            { label: 'Status', value: STATUS_LABEL[document.status] },
            { label: 'Owner', value: document.owner },
            { label: 'Updated', value: formatDateTime(document.updatedAt) },
          ]}
        />
      </Card>

      <Card title="Versions">
        {versions.length === 0 ? (
          <Empty
            title="No versions yet"
            hint={
              canUpdate
                ? 'Add a version from a file or pasted text so the bots can quote it.'
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
                  <th scope="col">Added</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id}>
                    <td>
                      {v.version}{' '}
                      {effectiveVersion?.id === v.id ? <Badge value="In effect" tone="ok" /> : null}
                    </td>
                    <td>{formatDate(v.effectiveFrom)}</td>
                    <td>{v.effectiveTo ? formatDate(v.effectiveTo) : 'No end date'}</td>
                    <td>{formatDateTime(v.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}

function OutcomeNotice({ outcome }: { outcome: Outcome }) {
  if (outcome.kind === 'updated') return <Notice tone="ok">Details saved.</Notice>
  if (outcome.kind === 'published')
    return <Notice tone="ok">Published. The bots can quote it now.</Notice>
  if (outcome.kind === 'archived') return <Notice tone="ok">Archived.</Notice>
  return (
    <Notice tone="ok">
      Version {outcome.version} saved and searchable.
      {outcome.injectionFlagged
        ? ' This file contains text that looks like instructions to a system; it is kept as plain text.'
        : ''}
      {outcome.storageDurable === false
        ? ' Uploaded files are not kept permanently in this environment.'
        : ''}
    </Notice>
  )
}

// --- Add a version (file or pasted text) -----------------------------------

function AddVersionForm({
  document,
  onDone,
  onCancel,
}: {
  document: KnowledgeDocument
  onDone(result: Outcome): void
  onCancel(): void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [text, setText] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso())
  const [effectiveTo, setEffectiveTo] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setLocalError(null)
    setError(null)

    if (file && !hasAcceptedExtension(file.name)) {
      setLocalError(`Only ${ACCEPTED_EXTENSIONS.join(', ')} files are accepted.`)
      return
    }
    if (!file && text.trim().length < MIN_TEXT_LENGTH) {
      setLocalError(`Choose a file, or paste at least ${MIN_TEXT_LENGTH} characters of text.`)
      return
    }

    setSubmitting(true)
    try {
      if (file) {
        const response = await uploadPolicyFile(document.id, effectiveFrom, file)
        onDone({
          kind: 'version',
          version: response.version.version,
          injectionFlagged: response.injectionFlagged || response.version.injectionFlagged,
          storageDurable: response.storageDurable,
        })
      } else {
        const body: Record<string, string> = { text, effectiveFrom }
        if (effectiveTo) body.effectiveTo = effectiveTo
        const result = await api<{ version: IngestResult }>(`/policies/${document.id}/versions`, {
          method: 'POST',
          body,
        })
        onDone({
          kind: 'version',
          version: result.version.version,
          injectionFlagged: result.version.injectionFlagged,
          storageDurable: null,
        })
      }
    } catch (e) {
      setError(e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={onSubmit} aria-label="Add new version" className="card flat">
      <h3>Add new version</h3>
      <p className="hint">
        The current version stops applying the day before this one takes effect.
      </p>
      <SubmitError error={error} />
      {localError ? <Notice tone="error">{localError}</Notice> : null}
      <Field
        id="version-file"
        label="File"
        hint={`Text, Markdown, CSV, HTML or JSON.${file ? ` Selected: ${file.name}.` : ''}`}
      >
        <input
          id="version-file"
          type="file"
          accept={ACCEPTED_EXTENSIONS.join(',')}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null)
            setLocalError(null)
          }}
        />
      </Field>
      <Field
        id="version-text"
        label="Or paste the text"
        hint={file ? 'Ignored while a file is chosen.' : `At least ${MIN_TEXT_LENGTH} characters.`}
      >
        <textarea
          id="version-text"
          rows={8}
          value={text}
          disabled={Boolean(file)}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <Field id="version-from" label="Effective from">
        <input
          id="version-from"
          type="date"
          required
          value={effectiveFrom}
          onChange={(e) => setEffectiveFrom(e.target.value)}
        />
      </Field>
      <details className="more">
        <summary>More options</summary>
        <Field
          id="version-to"
          label="Effective to"
          hint={file ? 'Not used when uploading a file.' : 'Leave blank if there is no end date.'}
        >
          <input
            id="version-to"
            type="date"
            value={effectiveTo}
            min={effectiveFrom || undefined}
            disabled={Boolean(file)}
            onChange={(e) => setEffectiveTo(e.target.value)}
          />
        </Field>
      </details>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save version'}
        </button>
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// --- Edit details ----------------------------------------------------------

function EditDocumentForm({
  document,
  categories,
  onSaved,
  onCancel,
}: {
  document: KnowledgeDocument
  categories: string[]
  onSaved(): void
  onCancel(): void
}) {
  const [name, setName] = useState(document.name)
  const [category, setCategory] = useState(document.category)
  const [classification, setClassification] = useState<Classification>(document.classification)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const changes: Record<string, string> = {}
  if (name.trim() !== document.name) changes.name = name.trim()
  if (category.trim() !== document.category) changes.category = category.trim()
  if (classification !== document.classification) changes.classification = classification
  const dirty = Object.keys(changes).length > 0

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!dirty) return

    if (
      changes.classification &&
      !window.confirm(
        `Change who can read “${document.name}” to “${CLASSIFICATION_LABEL[classification]}”?`,
      )
    ) {
      return
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
    <form onSubmit={onSubmit} aria-label="Edit details" className="card flat">
      <h3>Edit details</h3>
      <SubmitError error={error} />
      <Field id="edit-name" label="Document name">
        <input
          id="edit-name"
          required
          minLength={2}
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field id="edit-category" label="Category">
        <input
          id="edit-category"
          required
          minLength={2}
          maxLength={60}
          list="edit-category-options"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <CategoryOptions id="edit-category-options" categories={categories} />
      </Field>
      <Field id="edit-classification" label="Who can read this">
        <select
          id="edit-classification"
          value={classification}
          onChange={(e) => setClassification(e.target.value as Classification)}
        >
          {CLASSIFICATIONS.map((c) => (
            <option key={c} value={c}>
              {CLASSIFICATION_LABEL[c]}
            </option>
          ))}
        </select>
      </Field>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={submitting || !dirty}>
          {submitting ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// --- What the bot can quote ------------------------------------------------

function QuotePreview() {
  const [question, setQuestion] = useState('')
  const [result, setResult] = useState<SearchResponse | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [searching, setSearching] = useState(false)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setSearching(true)
    setError(null)
    try {
      setResult(
        await api<SearchResponse>('/policies/search', {
          method: 'POST',
          body: { question: question.trim() },
        }),
      )
    } catch (e) {
      setResult(null)
      setError(e)
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="grid">
      <form onSubmit={onSubmit} aria-label="What the bot can quote">
        <Field
          id="quote-question"
          label="Question"
          hint="Ask the way an employee would. You see the passages the bot could quote to you."
        >
          <input
            id="quote-question"
            required
            minLength={3}
            maxLength={500}
            placeholder="How many days of annual leave do new employees get?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </Field>
        <div className="form-actions">
          <button
            type="submit"
            className="primary"
            disabled={searching || question.trim().length < 3}
          >
            {searching ? 'Checking…' : 'Check'}
          </button>
        </div>
      </form>

      <div>
        {searching ? (
          <Loading rows={3} />
        ) : error ? (
          <ErrorState error={error} />
        ) : result ? (
          result.passages.length === 0 ? (
            <Empty title="Nothing found" hint="The bot would tell the employee to contact HR." />
          ) : (
            <div className="rows">
              {result.passages.map((p, i) => (
                <div className="row-card" key={`${p.documentName}-${p.version}-${i}`}>
                  <div className="row-head">
                    <strong>{p.documentName}</strong>
                    {p.section ? <span className="muted small-text">{p.section}</span> : null}
                  </div>
                  <pre className="plain">{p.content}</pre>
                </div>
              ))}
            </div>
          )
        ) : null}
      </div>
    </div>
  )
}
