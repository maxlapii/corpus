/**
 * Users, roles, sessions, Telegram links and one-time verification codes.
 *
 * Nothing here accepts a role or permission from the caller: roles are only
 * ever read from `user_roles`, and only `grantRole` (an authorised admin
 * operation) writes them.
 */

import { nowIso, prefixedId } from '@corpus/shared'
import { isRole, type Role, type TelegramAccount, type User } from '@corpus/domain'
import type { DatabaseService } from '../database-service.js'
import { assertSameTenant, type TenantScope } from '../tenant.js'
import { mapTelegramAccount, mapUser, type Row } from './mappers.js'

export interface UserWithSecret extends User {
  /** Only read by the auth package; never returned from an API route. */
  passwordHash: string | null
  lockedUntil: string | null
}

export class UserRepository {
  constructor(private readonly db: DatabaseService) {}

  async findById(scope: TenantScope, id: string): Promise<User | null> {
    const row = await this.db.one<Row>('SELECT * FROM users WHERE tenant_id = ? AND id = ?', [
      scope.tenantId,
      id,
    ])
    return row ? mapUser(row) : null
  }

  /** Includes the password hash. Restricted to the authentication flow. */
  async findByEmailWithSecret(scope: TenantScope, email: string): Promise<UserWithSecret | null> {
    const row = await this.db.one<Row>(
      'SELECT * FROM users WHERE tenant_id = ? AND email = ?',
      [scope.tenantId, email.toLowerCase()],
    )
    if (!row) return null
    return {
      ...mapUser(row),
      passwordHash: row.password_hash === null || row.password_hash === undefined ? null : String(row.password_hash),
      lockedUntil: row.locked_until === null || row.locked_until === undefined ? null : String(row.locked_until),
    }
  }

  async findByEmployeeId(scope: TenantScope, employeeId: string): Promise<User | null> {
    const row = await this.db.one<Row>(
      'SELECT * FROM users WHERE tenant_id = ? AND employee_id = ? LIMIT 1',
      [scope.tenantId, employeeId],
    )
    return row ? mapUser(row) : null
  }

  async listRoles(scope: TenantScope, userId: string): Promise<Role[]> {
    const rows = await this.db.many<{ role_code: string }>(
      'SELECT role_code FROM user_roles WHERE tenant_id = ? AND user_id = ?',
      [scope.tenantId, userId],
    )
    // Unknown role codes in the database are ignored rather than trusted.
    return rows.map((r) => r.role_code).filter(isRole)
  }

  async create(
    scope: TenantScope,
    input: {
      email: string
      displayName: string
      passwordHash: string | null
      employeeId: string | null
      status?: User['status']
    },
  ): Promise<User> {
    const id = prefixedId('usr')
    const ts = nowIso()
    await this.db.run(
      `INSERT INTO users
         (id, tenant_id, email, display_name, password_hash, status, employee_id,
          failed_login_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        id,
        scope.tenantId,
        input.email.toLowerCase(),
        input.displayName,
        input.passwordHash,
        input.status ?? 'ACTIVE',
        input.employeeId,
        ts,
        ts,
      ],
    )
    return {
      id,
      tenantId: scope.tenantId,
      email: input.email.toLowerCase(),
      displayName: input.displayName,
      status: input.status ?? 'ACTIVE',
      employeeId: input.employeeId,
      lastLoginAt: null,
      failedLoginCount: 0,
      createdAt: ts,
      updatedAt: ts,
    }
  }

  async grantRole(
    scope: TenantScope,
    userId: string,
    role: Role,
    grantedBy: string | null,
  ): Promise<void> {
    await this.db.run(
      `INSERT OR IGNORE INTO user_roles (user_id, role_code, tenant_id, granted_at, granted_by)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, role, scope.tenantId, nowIso(), grantedBy],
    )
  }

  async revokeRole(scope: TenantScope, userId: string, role: Role): Promise<void> {
    await this.db.run(
      'DELETE FROM user_roles WHERE tenant_id = ? AND user_id = ? AND role_code = ?',
      [scope.tenantId, userId, role],
    )
  }

  async recordLoginSuccess(scope: TenantScope, userId: string): Promise<void> {
    const ts = nowIso()
    await this.db.run(
      `UPDATE users
          SET last_login_at = ?, failed_login_count = 0, locked_until = NULL,
              -- A lockout is transient. Leaving status = 'LOCKED' behind would
              -- make the freshly issued session unresolvable, so a failed-login
              -- flood could permanently disable an account.
              status = CASE WHEN status = 'LOCKED' THEN 'ACTIVE' ELSE status END,
              updated_at = ?
        WHERE tenant_id = ? AND id = ?`,
      [ts, ts, scope.tenantId, userId],
    )
  }

  /**
   * Release an expired lockout: reset the counter so a single later mistake
   * does not immediately re-lock, and restore ACTIVE. A DISABLED account is
   * left untouched — that suspension is deliberate, not transient.
   */
  async clearExpiredLock(scope: TenantScope, userId: string): Promise<void> {
    await this.db.run(
      `UPDATE users
          SET failed_login_count = 0, locked_until = NULL,
              status = CASE WHEN status = 'LOCKED' THEN 'ACTIVE' ELSE status END,
              updated_at = ?
        WHERE tenant_id = ? AND id = ? AND locked_until IS NOT NULL AND locked_until <= ?`,
      [nowIso(), scope.tenantId, userId, nowIso()],
    )
  }

  /**
   * Increment the failure counter and lock the account past a threshold.
   * Returns the new failure count.
   */
  async recordLoginFailure(
    scope: TenantScope,
    userId: string,
    maxAttempts: number,
    lockMinutes: number,
  ): Promise<number> {
    const ts = nowIso()
    await this.db.run(
      `UPDATE users SET failed_login_count = failed_login_count + 1, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
      [ts, scope.tenantId, userId],
    )
    const row = await this.db.one<{ failed_login_count: number }>(
      'SELECT failed_login_count FROM users WHERE tenant_id = ? AND id = ?',
      [scope.tenantId, userId],
    )
    const count = Number(row?.failed_login_count ?? 0)
    if (count >= maxAttempts) {
      const until = new Date(Date.now() + lockMinutes * 60_000).toISOString()
      await this.db.run(
        "UPDATE users SET locked_until = ?, status = 'LOCKED', updated_at = ? WHERE tenant_id = ? AND id = ?",
        [until, ts, scope.tenantId, userId],
      )
    }
    return count
  }

  async setStatus(scope: TenantScope, userId: string, status: User['status']): Promise<void> {
    await this.db.run(
      'UPDATE users SET status = ?, updated_at = ? WHERE tenant_id = ? AND id = ?',
      [status, nowIso(), scope.tenantId, userId],
    )
  }

  async setPasswordHash(scope: TenantScope, userId: string, hash: string): Promise<void> {
    await this.db.run(
      `UPDATE users SET password_hash = ?, failed_login_count = 0, locked_until = NULL,
              status = CASE WHEN status = 'LOCKED' THEN 'ACTIVE' ELSE status END, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
      [hash, nowIso(), scope.tenantId, userId],
    )
  }

  async list(scope: TenantScope, limit: number, offset: number): Promise<{ items: User[]; total: number }> {
    const rows = await this.db.many<Row>(
      'SELECT * FROM users WHERE tenant_id = ? ORDER BY display_name LIMIT ? OFFSET ?',
      [scope.tenantId, limit, offset],
    )
    const total = await this.db.count('SELECT COUNT(*) AS c FROM users WHERE tenant_id = ?', [
      scope.tenantId,
    ])
    return { items: rows.map(mapUser), total }
  }
}

export interface SessionRow {
  id: string
  tenantId: string
  userId: string
  csrfToken: string
  expiresAt: string
  revokedAt: string | null
}

export class SessionRepository {
  constructor(private readonly db: DatabaseService) {}

  async create(input: {
    tenantId: string
    userId: string
    tokenHash: string
    csrfToken: string
    userAgent: string | null
    ipHash: string | null
    expiresAt: string
  }): Promise<string> {
    const id = prefixedId('ses')
    const ts = nowIso()
    await this.db.run(
      `INSERT INTO sessions
         (id, tenant_id, user_id, token_hash, csrf_token, user_agent, ip_hash,
          created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.tenantId,
        input.userId,
        input.tokenHash,
        input.csrfToken,
        input.userAgent,
        input.ipHash,
        ts,
        input.expiresAt,
        ts,
      ],
    )
    return id
  }

  /** Look a session up by the *hash* of the presented token. */
  async findByTokenHash(tokenHash: string): Promise<SessionRow | null> {
    const row = await this.db.one<Row>(
      `SELECT id, tenant_id, user_id, csrf_token, expires_at, revoked_at
         FROM sessions WHERE token_hash = ?`,
      [tokenHash],
    )
    if (!row) return null
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      userId: String(row.user_id),
      csrfToken: String(row.csrf_token),
      expiresAt: String(row.expires_at),
      revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : String(row.revoked_at),
    }
  }

  async touch(id: string): Promise<void> {
    await this.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [nowIso(), id])
  }

  async revoke(id: string): Promise<void> {
    await this.db.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
      nowIso(),
      id,
    ])
  }

  async revokeAllForUser(scope: TenantScope, userId: string): Promise<void> {
    await this.db.run(
      'UPDATE sessions SET revoked_at = ? WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL',
      [nowIso(), scope.tenantId, userId],
    )
  }

  async deleteExpired(before: string): Promise<number> {
    const res = await this.db.run('DELETE FROM sessions WHERE expires_at < ?', [before])
    return res.meta.changes
  }
}

export class TelegramAccountRepository {
  constructor(private readonly db: DatabaseService) {}

  async findVerified(
    scope: TenantScope,
    telegramUserId: string,
    accountScope: 'EXTERNAL' | 'INTERNAL',
  ): Promise<TelegramAccount | null> {
    const row = await this.db.one<Row>(
      `SELECT * FROM telegram_accounts
        WHERE tenant_id = ? AND telegram_user_id = ? AND scope = ?
          AND verified_at IS NOT NULL AND revoked_at IS NULL`,
      [scope.tenantId, telegramUserId, accountScope],
    )
    if (!row) return null
    assertSameTenant(scope, row as { tenant_id?: string })
    return mapTelegramAccount(row)
  }

  async findAny(
    scope: TenantScope,
    telegramUserId: string,
    accountScope: 'EXTERNAL' | 'INTERNAL',
  ): Promise<TelegramAccount | null> {
    const row = await this.db.one<Row>(
      'SELECT * FROM telegram_accounts WHERE tenant_id = ? AND telegram_user_id = ? AND scope = ?',
      [scope.tenantId, telegramUserId, accountScope],
    )
    return row ? mapTelegramAccount(row) : null
  }

  async listForEmployee(scope: TenantScope, employeeId: string): Promise<TelegramAccount[]> {
    const rows = await this.db.many<Row>(
      'SELECT * FROM telegram_accounts WHERE tenant_id = ? AND employee_id = ?',
      [scope.tenantId, employeeId],
    )
    return rows.map(mapTelegramAccount)
  }

  /**
   * Link a Telegram id to a *backend-resolved* employee and user. The caller
   * must have verified a one-time code first; this repository does not decide.
   */
  async link(
    scope: TenantScope,
    input: {
      telegramUserId: string
      scope: 'EXTERNAL' | 'INTERNAL'
      employeeId: string | null
      userId: string | null
    },
  ): Promise<TelegramAccount> {
    const ts = nowIso()
    const existing = await this.findAny(scope, input.telegramUserId, input.scope)
    if (existing) {
      await this.db.run(
        `UPDATE telegram_accounts
            SET employee_id = ?, user_id = ?, verified_at = ?, revoked_at = NULL
          WHERE id = ? AND tenant_id = ?`,
        [input.employeeId, input.userId, ts, existing.id, scope.tenantId],
      )
      return { ...existing, employeeId: input.employeeId, userId: input.userId, verifiedAt: ts, revokedAt: null }
    }
    const id = prefixedId('tga')
    await this.db.run(
      `INSERT INTO telegram_accounts
         (id, tenant_id, telegram_user_id, scope, employee_id, user_id, verified_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, scope.tenantId, input.telegramUserId, input.scope, input.employeeId, input.userId, ts, ts],
    )
    return {
      id,
      tenantId: scope.tenantId,
      telegramUserId: input.telegramUserId,
      employeeId: input.employeeId,
      userId: input.userId,
      scope: input.scope,
      verifiedAt: ts,
      revokedAt: null,
      createdAt: ts,
    }
  }

  async revoke(scope: TenantScope, id: string): Promise<void> {
    await this.db.run(
      'UPDATE telegram_accounts SET revoked_at = ? WHERE tenant_id = ? AND id = ?',
      [nowIso(), scope.tenantId, id],
    )
  }
}

export interface VerificationCodeRow {
  id: string
  tenantId: string
  purpose: 'TELEGRAM_LINK' | 'PASSWORD_RESET'
  employeeId: string | null
  userId: string | null
  telegramUserId: string | null
  codeHash: string
  attempts: number
  maxAttempts: number
  consumedAt: string | null
  expiresAt: string
}

export class VerificationCodeRepository {
  constructor(private readonly db: DatabaseService) {}

  async create(
    scope: TenantScope,
    input: {
      purpose: 'TELEGRAM_LINK' | 'PASSWORD_RESET'
      employeeId: string | null
      userId: string | null
      telegramUserId: string | null
      codeHash: string
      expiresAt: string
      maxAttempts?: number
    },
  ): Promise<string> {
    const id = prefixedId('vfc')
    await this.db.run(
      `INSERT INTO verification_codes
         (id, tenant_id, purpose, employee_id, user_id, telegram_user_id, code_hash,
          attempts, max_attempts, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        id,
        scope.tenantId,
        input.purpose,
        input.employeeId,
        input.userId,
        input.telegramUserId,
        input.codeHash,
        input.maxAttempts ?? 5,
        input.expiresAt,
        nowIso(),
      ],
    )
    return id
  }

  /** Invalidate any outstanding codes before issuing a new one. */
  async consumeOutstanding(
    scope: TenantScope,
    purpose: 'TELEGRAM_LINK' | 'PASSWORD_RESET',
    telegramUserId: string | null,
    userId: string | null,
  ): Promise<void> {
    await this.db.run(
      `UPDATE verification_codes SET consumed_at = ?
        WHERE tenant_id = ? AND purpose = ? AND consumed_at IS NULL
          AND (telegram_user_id IS ? OR user_id IS ?)`,
      [nowIso(), scope.tenantId, purpose, telegramUserId, userId],
    )
  }

  async findActive(
    scope: TenantScope,
    purpose: 'TELEGRAM_LINK' | 'PASSWORD_RESET',
    telegramUserId: string | null,
    now: string,
  ): Promise<VerificationCodeRow | null> {
    const row = await this.db.one<Row>(
      `SELECT * FROM verification_codes
        WHERE tenant_id = ? AND purpose = ? AND telegram_user_id IS ?
          AND consumed_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1`,
      [scope.tenantId, purpose, telegramUserId, now],
    )
    if (!row) return null
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      purpose: String(row.purpose) as VerificationCodeRow['purpose'],
      employeeId: row.employee_id === null || row.employee_id === undefined ? null : String(row.employee_id),
      userId: row.user_id === null || row.user_id === undefined ? null : String(row.user_id),
      telegramUserId:
        row.telegram_user_id === null || row.telegram_user_id === undefined
          ? null
          : String(row.telegram_user_id),
      codeHash: String(row.code_hash),
      attempts: Number(row.attempts ?? 0),
      maxAttempts: Number(row.max_attempts ?? 5),
      consumedAt: row.consumed_at === null || row.consumed_at === undefined ? null : String(row.consumed_at),
      expiresAt: String(row.expires_at),
    }
  }

  async recordAttempt(id: string): Promise<void> {
    await this.db.run('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?', [id])
  }

  async markConsumed(id: string): Promise<void> {
    await this.db.run('UPDATE verification_codes SET consumed_at = ? WHERE id = ?', [nowIso(), id])
  }

  async deleteExpired(before: string): Promise<number> {
    const res = await this.db.run('DELETE FROM verification_codes WHERE expires_at < ?', [before])
    return res.meta.changes
  }
}
