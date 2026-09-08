'use client'

/**
 * Assistant — the dashboard's chat surface (CLAUDE.md §13, §33).
 *
 * The transcript lives in component state only; nothing is persisted or
 * cached in the browser. Every message goes to POST /assistant/ask, which runs
 * the same orchestrator, tool registry and PolicyGateway as the Telegram bots.
 * The response reports which tools ran and how each was decided, so a limited
 * answer can be explained rather than guessed at. The backend decides; this
 * page only shows.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { PageHeader, Shell } from '@/components/shell'
import { Badge, Card, Empty, Loading } from '@/components/ui'
import { useSession } from '@/components/session'
import { api, ApiRequestError } from '@/lib/api'

/** Response of POST /assistant/ask (apps/api/src/routes/assistant.ts). */
interface AskResponse {
  reply: string
  intent: string | null
  citations: { documentName: string; section: string | null; version: number }[]
  toolCalls: { name: string; decision: 'ALLOW' | 'DENY'; reasonCode: string | null }[]
  refused: boolean
  usage: { inputTokens: number; outputTokens: number } | null
}

type Turn =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'assistant'; text: string; result: AskResponse }

interface FieldIssue {
  path: string
  message: string
}

interface Notice {
  tone: 'error' | 'warn'
  title: string
  message: string
  issues?: FieldIssue[]
  requestId?: string
}

const MAX_CHARS = 2000

const EXAMPLE_PROMPTS = [
  'What is my leave balance?',
  'What are the upcoming holidays?',
  'How much notice period applies after probation?',
  'Show pending leave from my team',
]

/**
 * Accept only what the route documents. Anything missing is left out rather
 * than substituted, so the page never shows a value the API did not return.
 */
function normalise(raw: unknown): AskResponse {
  const r = (raw ?? {}) as Record<string, unknown>
  const usage = r.usage as Record<string, unknown> | undefined
  return {
    reply: typeof r.reply === 'string' ? r.reply : '',
    intent: typeof r.intent === 'string' ? r.intent : null,
    citations: Array.isArray(r.citations) ? (r.citations as AskResponse['citations']) : [],
    toolCalls: Array.isArray(r.toolCalls) ? (r.toolCalls as AskResponse['toolCalls']) : [],
    refused: r.refused === true,
    usage:
      usage && typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number'
        ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
        : null,
  }
}

function issuesOf(details: Record<string, unknown> | undefined): FieldIssue[] | undefined {
  const raw = details?.issues
  if (!Array.isArray(raw)) return undefined
  const issues = raw.filter((i): i is FieldIssue => {
    if (typeof i !== 'object' || i === null) return false
    const o = i as Record<string, unknown>
    return typeof o.path === 'string' && typeof o.message === 'string'
  })
  return issues.length > 0 ? issues : undefined
}

function noticeFor(e: unknown): Notice {
  if (e instanceof ApiRequestError) {
    const requestId = e.error.requestId
    if (e.status === 429) {
      return {
        tone: 'warn',
        title: 'Rate limit reached.',
        message: e.error.message || 'Too many requests. Please wait a moment and try again.',
        requestId,
      }
    }
    if (e.isForbidden) {
      return { tone: 'warn', title: 'Not available to your role.', message: e.error.message, requestId }
    }
    if (e.isUnauthenticated) {
      return { tone: 'warn', title: 'Your session has ended.', message: 'Please sign in again to continue.' }
    }
    return {
      tone: 'error',
      title: 'Could not send your message.',
      message: e.error.message,
      issues: issuesOf(e.error.details),
      requestId,
    }
  }
  return {
    tone: 'error',
    title: 'Could not reach the server.',
    message: 'Check your connection and try again. Your message has been kept below.',
  }
}

function ReplyMeta({ result }: { result: AskResponse }) {
  const { intent, toolCalls, citations, refused, usage } = result
  const row = { display: 'flex', flexWrap: 'wrap' as const, gap: 6, alignItems: 'center' }
  return (
    <div className="bubble-meta" style={{ whiteSpace: 'normal', display: 'grid', gap: 5 }}>
      {intent || refused ? (
        <div style={row}>
          {intent ? (
            <>
              <span>Intent</span>
              <Badge value={intent} />
            </>
          ) : null}
          {refused ? <span className="badge warn">refused</span> : null}
        </div>
      ) : null}

      {toolCalls.length > 0 ? (
        <div style={row}>
          <span>Tools</span>
          {toolCalls.map((t, i) => (
            <span
              key={`${t.name}-${i}`}
              className={`badge ${t.decision === 'ALLOW' ? 'ok' : 'danger'}`}
              title={t.decision === 'DENY' && t.reasonCode ? `Denied: ${t.reasonCode}` : undefined}
            >
              {t.name}: {t.decision}
              {t.decision === 'DENY' && t.reasonCode ? ` (${t.reasonCode})` : ''}
            </span>
          ))}
        </div>
      ) : null}

      {citations.length > 0 ? (
        <div>
          <span>Sources</span>
          <ul style={{ margin: '2px 0 0', paddingLeft: 16 }}>
            {citations.map((c, i) => (
              <li key={`${c.documentName}-${c.version}-${i}`}>
                {c.documentName}
                {c.section ? ` — ${c.section}` : ''} (v{c.version})
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {usage && usage.inputTokens + usage.outputTokens > 0 ? (
        <div className="mono" style={{ fontSize: 11 }}>
          tokens: {usage.inputTokens.toLocaleString()} in / {usage.outputTokens.toLocaleString()} out
        </div>
      ) : null}
    </div>
  )
}

export default function AssistantPage() {
  const { user } = useSession()

  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [announcement, setAnnouncement] = useState('')

  const nextId = useRef(1)
  const abortRef = useRef<AbortController | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  // Abandon an in-flight request if the page unmounts.
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  // Keep the latest turn (or the pending indicator) in view.
  useEffect(() => {
    if (turns.length > 0) endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [turns.length, busy])

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim()
      if (text.length === 0 || busy) return

      setNotice(null)
      setAnnouncement('')
      const userTurnId = nextId.current++
      setTurns((prev) => [...prev, { id: userTurnId, role: 'user', text }])
      setDraft('')
      setBusy(true)

      const controller = new AbortController()
      abortRef.current = controller

      try {
        const payload = await api<unknown>('/assistant/ask', {
          method: 'POST',
          body: { message: text },
          signal: controller.signal,
        })
        if (controller.signal.aborted) return
        const result = normalise(payload)
        setTurns((prev) => [
          ...prev,
          { id: nextId.current++, role: 'assistant', text: result.reply, result },
        ])
        setAnnouncement(result.refused ? 'The assistant declined the request.' : 'Reply received.')
      } catch (e) {
        if (controller.signal.aborted) return
        // The message never reached the assistant: take it out of the transcript
        // and hand it back so it can be corrected or retried.
        setTurns((prev) => prev.filter((t) => t.id !== userTurnId))
        setDraft(text)
        setNotice(noticeFor(e))
      } finally {
        if (abortRef.current === controller) abortRef.current = null
        if (!controller.signal.aborted) {
          setBusy(false)
          textareaRef.current?.focus()
        }
      }
    },
    [busy],
  )

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    void send(draft)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send(draft)
    }
  }

  function clearConversation() {
    if (busy) return
    if (!window.confirm('Clear this conversation from the screen? Nothing is deleted on the server.')) return
    setTurns([])
    setNotice(null)
    setAnnouncement('Conversation cleared.')
    textareaRef.current?.focus()
  }

  const canSend = !busy && draft.trim().length > 0

  return (
    <Shell>
      <PageHeader
        title="Assistant"
        description="Ask about your leave, holidays and HR policy. Answers use only what your role is allowed to see."
      />

      <div className="notice info" role="note">
        <strong>Every answer is authorised by the backend. </strong>
        The assistant can understand your question, but the PolicyGateway decides which tools may run
        and which documents it may read, based on your verified identity and role — not on anything
        typed into the chat. Denied tools are shown under each reply so you can see why an answer was
        limited. This transcript is not saved in your browser.
      </div>

      <Card
        title="Conversation"
        actions={
          turns.length > 0 ? (
            <button type="button" onClick={clearConversation} disabled={busy}>
              Clear conversation
            </button>
          ) : undefined
        }
      >
        <div className="chat" role="log" aria-label="Conversation transcript" style={{ marginBottom: 14 }}>
          {turns.length === 0 && !busy ? (
            <Empty
              title="No messages yet"
              hint={`Ask a question below or pick an example. Answers are scoped to ${
                user?.displayName ?? 'your account'
              }; the assistant cannot act as anyone else.`}
            />
          ) : null}

          {turns.map((turn) =>
            turn.role === 'user' ? (
              <div key={turn.id} className="bubble user">
                <span className="visually-hidden">You: </span>
                {turn.text}
              </div>
            ) : (
              <div key={turn.id} className="bubble assistant">
                <span className="visually-hidden">Assistant: </span>
                {turn.text ? (
                  turn.text
                ) : (
                  <em style={{ color: 'var(--text-faint)' }}>The assistant returned no text.</em>
                )}
                <ReplyMeta result={turn.result} />
              </div>
            ),
          )}

          {busy ? (
            <div className="bubble assistant" style={{ minWidth: 220 }}>
              <Loading rows={2} label="Waiting for the assistant" />
            </div>
          ) : null}

          <div ref={endRef} />
        </div>

        <div role="status" aria-live="polite" className="visually-hidden">
          {announcement}
        </div>

        {notice ? (
          <div className={`notice ${notice.tone}`} role="alert">
            <strong>{notice.title} </strong>
            {notice.message}
            {notice.issues ? (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {notice.issues.map((issue, i) => (
                  <li key={`${issue.path}-${i}`}>
                    <span className="mono">{issue.path}</span>: {issue.message}
                  </li>
                ))}
              </ul>
            ) : null}
            {notice.requestId ? (
              <div className="mono" style={{ marginTop: 6, fontSize: 11 }}>
                Reference: {notice.requestId}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="toolbar" role="group" aria-label="Example prompts" style={{ marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Try asking:</span>
          {EXAMPLE_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              disabled={busy}
              onClick={() => void send(prompt)}
              style={{ borderRadius: 99, padding: '4px 11px', fontSize: 12 }}
            >
              {prompt}
            </button>
          ))}
        </div>

        <form onSubmit={onSubmit} aria-label="Send a message to the assistant">
          <div className="field" style={{ marginBottom: 8 }}>
            <label htmlFor="assistant-message">Your message</label>
            <textarea
              id="assistant-message"
              ref={textareaRef}
              rows={3}
              maxLength={MAX_CHARS}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask about your leave, holidays or HR policy…"
              aria-describedby="assistant-message-hint"
              style={{ resize: 'vertical' }}
            />
            <div className="hint" id="assistant-message-hint">
              Enter sends, Shift+Enter adds a new line. {draft.length.toLocaleString()}/{MAX_CHARS.toLocaleString()}{' '}
              characters.
            </div>
          </div>
          <div className="toolbar" style={{ marginBottom: 0, justifyContent: 'flex-end' }}>
            <button className="primary" type="submit" disabled={!canSend}>
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      </Card>
    </Shell>
  )
}
