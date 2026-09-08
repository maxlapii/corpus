/**
 * Role → permission mapping and classification ceilings (CLAUDE.md §9, §10).
 */

import { describe, expect, it } from 'vitest'
import {
  CLASSIFICATIONS,
  PERMISSIONS,
  PUBLIC_PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  classificationCovers,
  classificationsUpTo,
  maxReadableClassification,
  permissionsForRoles,
  type Permission,
} from '@corpus/domain'

describe('role definitions', () => {
  it('grants no permission that is not declared', () => {
    for (const role of ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(PERMISSIONS, `${role} → ${permission}`).toContain(permission)
      }
    }
  })

  it('gives SYSTEM_ADMIN every permission, explicitly enumerated', () => {
    expect([...ROLE_PERMISSIONS.SYSTEM_ADMIN].sort()).toEqual([...PERMISSIONS].sort())
  })

  it('never grants a wildcard-style permission', () => {
    for (const permission of PERMISSIONS) {
      expect(permission).not.toMatch(/[*]|everything|all_access/)
    }
  })

  it('restricts EMPLOYEE to self-service only', () => {
    const employee = new Set<Permission>(ROLE_PERMISSIONS.EMPLOYEE)
    for (const forbidden of [
      'employee.read.all',
      'employee.read.team',
      'employee.read.compensation',
      'leave.read.team',
      'leave.read.all',
      'leave.approve.team',
      'leave.approve.all',
      'candidate.read',
      'application.read',
      'audit.read',
      'security.read',
      'system.manage',
      'policy.read.confidential',
      'policy.read.restricted',
    ] as Permission[]) {
      expect(employee.has(forbidden), `EMPLOYEE must not hold ${forbidden}`).toBe(false)
    }
  })

  it('gives MANAGER team scope but not organisation scope', () => {
    const manager = new Set<Permission>(ROLE_PERMISSIONS.MANAGER)
    expect(manager.has('leave.read.team')).toBe(true)
    expect(manager.has('leave.approve.team')).toBe(true)
    expect(manager.has('leave.read.all')).toBe(false)
    expect(manager.has('leave.approve.all')).toBe(false)
    expect(manager.has('employee.read.all')).toBe(false)
    expect(manager.has('employee.read.compensation')).toBe(false)
  })

  it('withholds compensation, audit and security from HR', () => {
    const hr = new Set<Permission>(ROLE_PERMISSIONS.HR)
    expect(hr.has('employee.read.all')).toBe(true)
    expect(hr.has('employee.read.compensation')).toBe(false)
    expect(hr.has('policy.read.restricted')).toBe(false)
    expect(hr.has('audit.read')).toBe(false)
    expect(hr.has('security.read')).toBe(false)
    expect(hr.has('system.manage')).toBe(false)
  })

  it('gives HR_ADMIN compensation, audit and security but not system management', () => {
    const hrAdmin = new Set<Permission>(ROLE_PERMISSIONS.HR_ADMIN)
    expect(hrAdmin.has('employee.read.compensation')).toBe(true)
    expect(hrAdmin.has('policy.read.restricted')).toBe(true)
    expect(hrAdmin.has('audit.read')).toBe(true)
    expect(hrAdmin.has('security.read')).toBe(true)
    expect(hrAdmin.has('system.manage')).toBe(false)
  })

  it('limits the public permission set to recruitment self-service', () => {
    expect([...PUBLIC_PERMISSIONS].sort()).toEqual(
      ['application.create.public', 'application.read.self', 'candidate.create.public', 'job.read.public'].sort(),
    )
    for (const permission of PUBLIC_PERMISSIONS) {
      expect(permission).not.toMatch(/^(employee|leave|policy|audit|security|system|interview|offer)\./)
    }
  })

  it('unions permissions across multiple roles', () => {
    const both = permissionsForRoles(['EMPLOYEE', 'MANAGER'])
    expect(both.has('leave.read.self')).toBe(true)
    expect(both.has('leave.approve.team')).toBe(true)
    expect(both.has('leave.approve.all')).toBe(false)
  })

  it('returns an empty set for no roles', () => {
    expect(permissionsForRoles([]).size).toBe(0)
  })
})

describe('classification', () => {
  it('orders classifications least to most sensitive', () => {
    expect(CLASSIFICATIONS).toEqual(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'])
  })

  it('covers only equal or lower classifications', () => {
    expect(classificationCovers('CONFIDENTIAL', 'INTERNAL')).toBe(true)
    expect(classificationCovers('CONFIDENTIAL', 'CONFIDENTIAL')).toBe(true)
    expect(classificationCovers('CONFIDENTIAL', 'RESTRICTED')).toBe(false)
    expect(classificationCovers('PUBLIC', 'INTERNAL')).toBe(false)
  })

  it('enumerates the readable set for a ceiling', () => {
    expect(classificationsUpTo('PUBLIC')).toEqual(['PUBLIC'])
    expect(classificationsUpTo('INTERNAL')).toEqual(['PUBLIC', 'INTERNAL'])
    expect(classificationsUpTo('RESTRICTED')).toEqual([
      'PUBLIC',
      'INTERNAL',
      'CONFIDENTIAL',
      'RESTRICTED',
    ])
  })

  it('derives the reading ceiling from permissions, per role', () => {
    expect(maxReadableClassification(permissionsForRoles([]))).toBe('PUBLIC')
    expect(maxReadableClassification(permissionsForRoles(['EMPLOYEE']))).toBe('INTERNAL')
    expect(maxReadableClassification(permissionsForRoles(['MANAGER']))).toBe('INTERNAL')
    expect(maxReadableClassification(permissionsForRoles(['HR']))).toBe('CONFIDENTIAL')
    expect(maxReadableClassification(permissionsForRoles(['HR_ADMIN']))).toBe('RESTRICTED')
    expect(maxReadableClassification(permissionsForRoles(['SYSTEM_ADMIN']))).toBe('RESTRICTED')
  })

  it('gives an anonymous caller PUBLIC only', () => {
    expect(maxReadableClassification(new Set(PUBLIC_PERMISSIONS))).toBe('PUBLIC')
  })
})
