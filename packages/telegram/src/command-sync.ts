/**
 * Sync each bot's Telegram command menu from the dashboard's bot training.
 *
 * The menu is the one part of a curated answer that Telegram shows to people
 * who have not spoken to the bot yet — it is visible on opening the chat,
 * before any verification. That makes publishing a command a **public** act
 * whichever bot it belongs to, which is why only PUBLIC answers reach the menu
 * (`KnowledgeAnswerRepository.listMenuCommands`). An answer above PUBLIC keeps
 * a working command; it is simply not listed.
 *
 * `setMyCommands` replaces the whole list, so the built-ins are always sent
 * alongside the curated ones or they disappear from the menu.
 */

import { tenantScope, type KnowledgeAnswerRepository } from '@corpus/db'
import type { DateOnly, Logger } from '@corpus/shared'
import type { TelegramClient } from './client.js'

export interface BotCommand {
  command: string
  description: string
}

/** Built into `commandToNaturalLanguage` in `external-bot.ts`. */
export const EXTERNAL_BUILTIN_COMMANDS: readonly BotCommand[] = [
  { command: 'start', description: 'Start again and see what I can do' },
  { command: 'help', description: 'What I can help with' },
  { command: 'jobs', description: 'Browse current openings' },
  { command: 'apply', description: 'Apply for a job by its code' },
  { command: 'status', description: 'Check your application status' },
  { command: 'cv', description: 'Attach your CV to your application' },
  { command: 'cancel', description: 'Stop what we are in the middle of' },
]

/** Built into `commandToNaturalLanguage` in `internal-bot.ts`. */
export const INTERNAL_BUILTIN_COMMANDS: readonly BotCommand[] = [
  { command: 'start', description: 'Start again and see what I can do' },
  { command: 'help', description: 'What I can help with' },
  { command: 'verify', description: 'Link your Telegram account to your employee record' },
  { command: 'code', description: 'Submit the 6-digit verification code' },
  { command: 'balance', description: 'Your remaining leave balance' },
  { command: 'leave', description: 'Your leave requests' },
  { command: 'request', description: 'Submit a leave request' },
  { command: 'holidays', description: 'Upcoming public holidays' },
  { command: 'policy', description: 'Search HR policy' },
  { command: 'approvals', description: 'Leave awaiting your decision' },
  { command: 'cv', description: 'Forward a candidate CV (HR)' },
]

/** Telegram's own ceiling on a command menu. */
export const MAX_BOT_COMMANDS = 100

export interface CommandMenu {
  compartment: 'EXTERNAL' | 'INTERNAL'
  builtIn: BotCommand[]
  curated: BotCommand[]
  /** What would actually be sent, in the order Telegram will show it. */
  effective: BotCommand[]
  /** Curated commands dropped because the menu is full. */
  omitted: BotCommand[]
}

export interface CommandSyncDeps {
  answers: KnowledgeAnswerRepository
  externalBot: TelegramClient
  internalBot: TelegramClient
  logger: Logger
}

export interface CommandSyncResult {
  compartment: 'EXTERNAL' | 'INTERNAL'
  /** False when the bot has no token configured — a normal local state. */
  configured: boolean
  synced: boolean
  commands: BotCommand[]
  omitted: BotCommand[]
}

export class CommandSyncService {
  constructor(private readonly deps: CommandSyncDeps) {}

  /** What the menu would contain, without touching Telegram. */
  async preview(input: {
    tenantId: string
    compartment: 'EXTERNAL' | 'INTERNAL'
    onDate: DateOnly
  }): Promise<CommandMenu> {
    const builtIn = [
      ...(input.compartment === 'EXTERNAL'
        ? EXTERNAL_BUILTIN_COMMANDS
        : INTERNAL_BUILTIN_COMMANDS),
    ]

    const curatedRows = await this.deps.answers.listMenuCommands(tenantScope(input.tenantId), {
      compartment: input.compartment,
      onDate: input.onDate,
    })

    // A built-in always wins. `validateAnswerDraft` refuses a reserved command,
    // so this only bites if the reserved list and the bots ever drift apart —
    // in which case losing the curated entry is the safe direction.
    const reserved = new Set(builtIn.map((c) => c.command))
    const curated = curatedRows.filter((row) => !reserved.has(row.command))

    const room = Math.max(0, MAX_BOT_COMMANDS - builtIn.length)
    return {
      compartment: input.compartment,
      builtIn,
      curated,
      effective: [...builtIn, ...curated.slice(0, room)],
      omitted: curated.slice(room),
    }
  }

  async syncOne(input: {
    tenantId: string
    compartment: 'EXTERNAL' | 'INTERNAL'
    onDate: DateOnly
  }): Promise<CommandSyncResult> {
    const menu = await this.preview(input)
    const client = input.compartment === 'EXTERNAL' ? this.deps.externalBot : this.deps.internalBot

    if (!client.configured) {
      return {
        compartment: input.compartment,
        configured: false,
        synced: false,
        commands: menu.effective,
        omitted: menu.omitted,
      }
    }

    const synced = await client.setMyCommands(menu.effective)
    this.deps.logger.info('telegram command menu sync', {
      action: 'telegram.commands.sync',
      result: synced ? 'ok' : 'failed',
      channel: input.compartment === 'EXTERNAL' ? 'TELEGRAM_EXTERNAL' : 'TELEGRAM_INTERNAL',
    })

    return {
      compartment: input.compartment,
      configured: true,
      synced,
      commands: menu.effective,
      omitted: menu.omitted,
    }
  }

  async syncAll(input: { tenantId: string; onDate: DateOnly }): Promise<CommandSyncResult[]> {
    return [
      await this.syncOne({ ...input, compartment: 'EXTERNAL' }),
      await this.syncOne({ ...input, compartment: 'INTERNAL' }),
    ]
  }
}
