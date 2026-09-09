/**
 * Dependency container.
 *
 * Built once per request (Workers are stateless — CLAUDE.md §4), from bindings
 * only. Nothing is cached in module scope except pure functions, so no request
 * can observe another request's state.
 */

import {
  createLogger,
  loadConfig,
  todayUtc,
  validateConfig,
  type AppConfig,
  type Logger,
} from '@corpus/shared'
import {
  DatabaseService,
  MemoryStorageService,
  R2StorageService,
  createRepositories,
  fromD1,
  type Repositories,
  type StorageService,
} from '@corpus/db'
import {
  IdentityResolver,
  LoginService,
  SessionService,
  TelegramIdentityService,
} from '@corpus/auth'
import {
  D1RateLimiter,
  KvRateLimiter,
  MemoryRateLimiter,
  PolicyGateway,
  SecurityEventService,
  createRateLimits,
  type RateLimitConfig,
  type RateLimiter,
} from '@corpus/security'
import {
  CvIntakeService,
  D1AnswerSearchService,
  D1KnowledgeSearchService,
  DocumentIngestionService,
} from '@corpus/knowledge'
import {
  AIOrchestrator,
  ALL_TOOLS,
  IntentClassifier,
  ToolRegistry,
  createAIProvider,
  type AIProvider,
} from '@corpus/ai'
import {
  CommandSyncService,
  KvReplayGuard,
  MemoryReplayGuard,
  TelegramClient,
  type ReplayGuard,
} from '@corpus/telegram'
import type { WorkerEnv } from './env.js'

export interface Container {
  config: AppConfig
  logger: Logger
  db: DatabaseService
  repos: Repositories
  storage: StorageService
  storageDurable: boolean
  gateway: PolicyGateway
  securityEvents: SecurityEventService
  sessions: SessionService
  login: LoginService
  identityResolver: IdentityResolver
  telegramIdentity: TelegramIdentityService
  rateLimiter: RateLimiter
  rateLimits: RateLimitConfig
  replayGuard: ReplayGuard
  aiProvider: AIProvider
  tools: ToolRegistry
  orchestrator: AIOrchestrator
  knowledgeSearch: D1KnowledgeSearchService
  answerSearch: D1AnswerSearchService
  cvIntake: CvIntakeService
  commandSync: CommandSyncService
  ingestion: DocumentIngestionService
  externalBotClient: TelegramClient
  internalBotClient: TelegramClient
  today: string
  configProblems: ReturnType<typeof validateConfig>
}

/**
 * Process-lifetime fallbacks. Used only when the corresponding binding is
 * absent, so local `wrangler dev` and unit tests still work. Production
 * `/health` reports the degradation rather than hiding it.
 */
const memoryRateLimiter = new MemoryRateLimiter()
const memoryReplayGuard = new MemoryReplayGuard()
const memoryStorage = new MemoryStorageService()

export function createContainer(env: WorkerEnv, requestId: string): Container {
  const config = loadConfig(env)
  const configProblems = validateConfig(config)
  const logger = createLogger(config.logLevel, { requestId, env: config.environment })

  const db = new DatabaseService(fromD1(env.DB))
  const repos = createRepositories(db)

  const securityEvents = new SecurityEventService(repos.securityEvents, logger)
  const gateway = new PolicyGateway({ audit: repos.audit, securityEvents, logger })

  // Storage: R2 when bound, otherwise in-memory (non-durable, reported).
  const hasR2 = isR2(env.DOCUMENTS)
  const storage: StorageService = hasR2
    ? new R2StorageService(env.DOCUMENTS as never)
    : memoryStorage

  // Rate limiting: KV when bound, else the D1 table, else memory.
  const rateLimiter: RateLimiter = isKv(env.RATE_LIMIT)
    ? new KvRateLimiter(env.RATE_LIMIT as never)
    : env.DB
      ? new D1RateLimiter(db)
      : memoryRateLimiter

  const replayGuard: ReplayGuard = isKv(env.RATE_LIMIT)
    ? new KvReplayGuard(env.RATE_LIMIT as never)
    : memoryReplayGuard

  // Every limit comes from configuration, so a deployment can tune them
  // without a code change (CLAUDE.md §45).
  const rateLimits = createRateLimits({
    telegramPerUser: { limit: config.rateLimits.telegramPerUserPerMinute, windowSeconds: 60 },
    aiPerUser: { limit: config.rateLimits.aiPerUserPerHour, windowSeconds: 3600 },
    loginPerIdentifier: { limit: config.rateLimits.loginPer15Minutes, windowSeconds: 900 },
    verificationPerUser: { limit: config.rateLimits.verificationPer15Minutes, windowSeconds: 900 },
    applicationPerSubject: { limit: config.rateLimits.applicationsPerHour, windowSeconds: 3600 },
    adminApiPerUser: { limit: config.rateLimits.adminApiPerMinute, windowSeconds: 60 },
    publicApiPerIp: { limit: config.rateLimits.publicApiPerMinute, windowSeconds: 60 },
  })

  const sessions = new SessionService({ sessions: repos.sessions, users: repos.users })
  const login = new LoginService({ repos, sessions, logger })
  const identityResolver = new IdentityResolver({ repos, logger, secret: config.sessionSecret })
  const telegramIdentity = new TelegramIdentityService({ repos, logger })

  const knowledgeSearch = new D1KnowledgeSearchService({ knowledge: repos.knowledge, logger })
  const answerSearch = new D1AnswerSearchService({ answers: repos.knowledgeAnswers, logger })
  // Hoisted so the command-sync service and the returned container share one
  // client per bot rather than each making its own.
  const externalBotClient = new TelegramClient(config.telegram.externalBotToken, { logger })
  const internalBotClient = new TelegramClient(config.telegram.internalBotToken, { logger })

  const commandSync = new CommandSyncService({
    answers: repos.knowledgeAnswers,
    externalBot: externalBotClient,
    internalBot: internalBotClient,
    logger,
  })
  const cvIntake = new CvIntakeService({
    documents: repos.candidateDocuments,
    storage,
    securityEvents,
    logger,
  })
  const ingestion = new DocumentIngestionService({
    knowledge: repos.knowledge,
    storage,
    securityEvents,
    logger,
  })

  // Workers AI authenticates by binding rather than by key, so the binding is
  // handed to the factory; every other provider ignores it.
  const aiProvider = createAIProvider(config, { workersAi: env.AI })
  const tools = new ToolRegistry(gateway, logger, securityEvents)
  tools.registerAll(ALL_TOOLS)

  const classifier = new IntentClassifier({ provider: aiProvider, logger })
  const orchestrator = new AIOrchestrator({
    provider: aiProvider,
    classifier,
    tools,
    gateway,
    repos,
    knowledgeSearch,
    answerSearch,
    securityEvents,
    rateLimiter,
    logger,
    limits: {
      maxOutputTokens: config.ai.maxOutputTokens,
      maxContextChunks: config.ai.maxContextChunks,
      maxHistoryTurns: 4,
      maxPageSize: config.limits.maxPageSize,
      aiRule: rateLimits.aiPerUser,
    },
  })

  return {
    config,
    logger,
    db,
    repos,
    storage,
    storageDurable: hasR2,
    gateway,
    securityEvents,
    sessions,
    login,
    identityResolver,
    telegramIdentity,
    rateLimiter,
    rateLimits,
    replayGuard,
    aiProvider,
    tools,
    orchestrator,
    knowledgeSearch,
    answerSearch,
    cvIntake,
    commandSync,
    ingestion,
    externalBotClient,
    internalBotClient,
    today: todayUtc(),
    configProblems,
  }
}

function isR2(binding: unknown): boolean {
  return (
    typeof binding === 'object' &&
    binding !== null &&
    typeof (binding as { put?: unknown }).put === 'function' &&
    typeof (binding as { head?: unknown }).head === 'function'
  )
}

function isKv(binding: unknown): boolean {
  return (
    typeof binding === 'object' &&
    binding !== null &&
    typeof (binding as { get?: unknown }).get === 'function' &&
    typeof (binding as { put?: unknown }).put === 'function' &&
    typeof (binding as { head?: unknown }).head !== 'function'
  )
}
