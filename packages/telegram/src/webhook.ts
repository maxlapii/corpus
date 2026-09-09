/**
 * Telegram webhook verification and update normalisation (CLAUDE.md §36).
 *
 * Nothing in an update is identity. `username` and `first_name` are display
 * only; even the numeric `from.id` grants nothing until a verified INTERNAL
 * link exists in the database.
 */

import { stripControlCharacters, timingSafeEqual } from '@corpus/shared'
import type { NormalisedUpdate, TelegramMessage, TelegramUpdate } from './types.js'

export const WEBHOOK_SECRET_HEADER = 'x-telegram-bot-api-secret-token'

export type WebhookVerification =
  | { ok: true }
  | { ok: false; reason: 'NO_SECRET_CONFIGURED' | 'MISSING_HEADER' | 'BAD_SECRET' }

export function verifyWebhookSecret(
  presented: string | null | undefined,
  expected: string,
): WebhookVerification {
  // No configured secret means accept nothing, not accept everything.
  if (!expected) return { ok: false, reason: 'NO_SECRET_CONFIGURED' }
  if (!presented) return { ok: false, reason: 'MISSING_HEADER' }
  return timingSafeEqual(presented, expected) ? { ok: true } : { ok: false, reason: 'BAD_SECRET' }
}

const MAX_TEXT_CHARS = 4096

/** Null when there is nothing actionable: a channel post, a bot, an empty edit. */
export function normaliseUpdate(raw: unknown): NormalisedUpdate | null {
  if (typeof raw !== 'object' || raw === null) return null
  const update = raw as TelegramUpdate
  if (!Number.isFinite(update.update_id)) return null

  const message = update.message ?? update.edited_message
  const callback = update.callback_query

  const from = message?.from ?? callback?.from
  const chat = message?.chat ?? callback?.message?.chat
  if (!from || !Number.isFinite(from.id)) return null
  const isBot = from.is_bot === true
  // Ignore other bots entirely.
  if (isBot) return null

  const text = (message?.text ?? message?.caption ?? callback?.data ?? '')
    .slice(0, MAX_TEXT_CHARS)
    .trim()
  const document = normaliseDocument(message?.document)

  // A file with no caption is a real message; only a genuinely empty one is not.
  if (text.length === 0 && !document) return null

  const commandMatch = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?\s*([\s\S]*)$/.exec(text)

  return {
    updateId: update.update_id,
    telegramUserId: String(from.id),
    chatId: String(chat?.id ?? from.id),
    chatType: chat?.type ?? 'private',
    text,
    command: commandMatch ? commandMatch[1]!.toLowerCase() : null,
    commandArgs: commandMatch ? (commandMatch[2] ?? '').trim() : '',
    displayName: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown',
    isBot,
    document,
  }
}

const MAX_FILENAME_CHARS = 200

/**
 * Everything here is attacker-controlled: the filename becomes a storage key
 * and a Content-Disposition value later, so path separators and control
 * characters are stripped at the boundary rather than downstream.
 */
function normaliseDocument(raw: TelegramMessage['document']): NormalisedUpdate['document'] {
  if (!raw || typeof raw.file_id !== 'string' || raw.file_id.length === 0) return null
  const fileName = stripControlCharacters(String(raw.file_name ?? 'upload'))
    .replace(/[/\\]/g, '_')
    .trim()
    .slice(0, MAX_FILENAME_CHARS)
  return {
    fileId: raw.file_id,
    fileName: fileName.length > 0 ? fileName : 'upload',
    mimeType: String(raw.mime_type ?? '').slice(0, 120),
    fileSize: Number.isFinite(raw.file_size) ? Number(raw.file_size) : 0,
  }
}

/**
 * Telegram retries until it gets a 200, so duplicate `update_id`s are expected
 * and processing one twice would double-submit a leave request.
 */
export interface ReplayGuard {
  seen(botKey: string, updateId: number): Promise<boolean>
}

export interface ReplayStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

export class KvReplayGuard implements ReplayGuard {
  constructor(
    private readonly store: ReplayStore,
    private readonly ttlSeconds = 3600,
  ) {}

  async seen(botKey: string, updateId: number): Promise<boolean> {
    const key = `tg:update:${botKey}:${updateId}`
    if ((await this.store.get(key)) !== null) return true
    await this.store.put(key, '1', { expirationTtl: this.ttlSeconds })
    return false
  }
}

export class MemoryReplayGuard implements ReplayGuard {
  private readonly seenIds = new Map<string, number>()

  async seen(botKey: string, updateId: number): Promise<boolean> {
    const key = `${botKey}:${updateId}`
    if (this.seenIds.has(key)) return true
    this.seenIds.set(key, Date.now())
    if (this.seenIds.size > 5000) {
      const entries = [...this.seenIds.entries()].sort((a, b) => a[1] - b[1])
      for (const [k] of entries.slice(0, 2500)) this.seenIds.delete(k)
    }
    return false
  }
}

export class NoopReplayGuard implements ReplayGuard {
  async seen(): Promise<boolean> {
    return false
  }
}
