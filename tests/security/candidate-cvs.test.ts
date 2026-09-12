/**
 * Security tests for candidate CVs (CLAUDE.md §8, §9, §12, §26).
 *
 * A CV is the most personal thing the system holds about someone who does not
 * even work here, so these assert the boundary from both directions: who inside
 * can read one, and what a candidate outside can cause to be stored.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tenantScope } from '@corpus/db'
import { createHarness, seedEmail, TEST_WEBHOOK_SECRET, type Harness } from '../helpers/harness.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function fixture(name: string): ArrayBuffer {
  const buffer = readFileSync(join(__dirname, '../fixtures', name))
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

/** DOCX is the default because it is the only accepted format we can read. */
const DOCX_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

async function storeCv(
  h: Harness,
  input: {
    candidateId: string
    filename?: string
    contentType?: string
    body?: ArrayBuffer
    source?: 'TELEGRAM_EXTERNAL' | 'TELEGRAM_INTERNAL'
  },
) {
  const source = input.source ?? 'TELEGRAM_EXTERNAL'
  return h.container.cvIntake.store({
    tenantId: h.seed.tenantId,
    candidateId: input.candidateId,
    filename: input.filename ?? 'backend-cv.docx',
    contentType: input.contentType ?? DOCX_TYPE,
    body: input.body ?? fixture('backend-cv.docx'),
    source,
    channel: source,
  })
}

/** The seed's first fictional applicant. */
async function firstCandidateId(h: Harness, tenantId = h.seed.tenantId): Promise<string> {
  const candidate = await h.database.repos.candidates.findByEmail(
    tenantScope(tenantId),
    'jordan.applicant@example.test',
  )
  if (!candidate) throw new Error('the seed should provide a candidate')
  return candidate.id
}

describe('CV access is limited to recruitment roles', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  it.each([
    ['employee', 403],
    ['manager', 403],
    ['hr', 200],
    ['hrAdmin', 200],
    ['admin', 200],
  ] as const)('%s listing CVs gets %i', async (key, expected) => {
    const client = await h.login(seedEmail(h.seed, key))
    expect((await client.get('/cvs')).status).toBe(expected)
  })

  it.each(['employee', 'manager'] as const)('%s cannot read a CV body', async (key) => {
    const stored = await storeCv(h, { candidateId: await firstCandidateId(h) })
    const client = await h.login(seedEmail(h.seed, key))
    const response = await client.get(`/cvs/${stored.id}`)
    expect(response.status).toBe(403)
    expect(JSON.stringify(response.body)).not.toContain('Dara Sok')
  })

  it.each(['employee', 'manager'] as const)('%s cannot download the original', async (key) => {
    const stored = await storeCv(h, { candidateId: await firstCandidateId(h) })
    const client = await h.login(seedEmail(h.seed, key))
    expect((await client.get(`/cvs/${stored.id}/download`)).status).toBe(403)
  })

  it.each(['employee', 'manager'] as const)('%s cannot run a match report', async (key) => {
    const stored = await storeCv(h, { candidateId: await firstCandidateId(h) })
    const jobId = h.seed.jobIds.eng001!
    const client = await h.login(seedEmail(h.seed, key))
    expect((await client.get(`/cvs/${stored.id}/match/${jobId}`)).status).toBe(403)
  })

  it('an unauthenticated caller reaches nothing', async () => {
    const stored = await storeCv(h, { candidateId: await firstCandidateId(h) })
    for (const path of ['/cvs', `/cvs/${stored.id}`, `/cvs/${stored.id}/download`]) {
      const response = await h.json(path)
      expect(response.status, path).toBe(401)
    }
  })

  it('HR can read the CV and its match report', async () => {
    const stored = await storeCv(h, { candidateId: await firstCandidateId(h) })
    const hr = await h.login(seedEmail(h.seed, 'hr'))

    const detail = await hr.get(`/cvs/${stored.id}`)
    expect(detail.status).toBe(200)
    expect(detail.body.document.extractedText).toContain('Dara Sok')

    const match = await hr.get(`/cvs/${stored.id}/match/${h.seed.jobIds.eng001}`)
    expect(match.status).toBe(200)
    expect(match.body.report.requirements.length).toBeGreaterThan(0)
    expect(match.body.advisory).toMatch(/advisory/i)
  })
})

describe('CV tenant isolation', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness({ secondTenant: true })
  })
  afterEach(() => h.close())

  it('does not expose a CV belonging to another tenant', async () => {
    const other = h.seedB!
    const stored = await h.container.cvIntake.store({
      tenantId: other.tenantId,
      candidateId: await firstCandidateId(h, other.tenantId),
      filename: 'other-tenant.docx',
      contentType: DOCX_TYPE,
      body: fixture('sample-cv.docx'),
      source: 'TELEGRAM_EXTERNAL',
      channel: 'TELEGRAM_EXTERNAL',
    })

    const hr = await h.login(seedEmail(h.seed, 'hr'))
    expect((await hr.get(`/cvs/${stored.id}`)).status).toBe(404)

    const listed = await hr.get('/cvs')
    expect(JSON.stringify(listed.body)).not.toContain('other-tenant.docx')
  })
})

describe('CV intake validation', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  it('refuses a file type that is not a CV format', async () => {
    await expect(
      storeCv(h, {
        candidateId: await firstCandidateId(h),
        filename: 'payload.exe',
        contentType: 'application/x-msdownload',
      }),
    ).rejects.toThrow(/not accepted/i)
  })

  it('refuses a file over the size cap', async () => {
    await expect(
      storeCv(h, {
        candidateId: await firstCandidateId(h),
        filename: 'huge.txt',
        body: new ArrayBuffer(6 * 1024 * 1024),
      }),
    ).rejects.toThrow(/limit/i)
  })

  it('accepts a PDF, keeps the original, and says the text needs entering', async () => {
    const stored = await storeCv(h, {
      candidateId: await firstCandidateId(h),
      filename: 'cv.pdf',
      contentType: 'application/pdf',
      body: fixture('sample-cv.pdf'),
    })
    expect(stored.extractionStatus).toBe('EMPTY')
    expect(stored.extractedText).toBeNull()
    expect(stored.extractionWarnings.join(' ')).toMatch(/paste the text/i)
    expect(await h.container.storage.get(stored.storageKey)).not.toBeNull()
  })

  it('matches a PDF once its text has been entered by hand', async () => {
    const stored = await storeCv(h, {
      candidateId: await firstCandidateId(h),
      filename: 'cv.pdf',
      contentType: 'application/pdf',
      body: fixture('sample-cv.pdf'),
    })
    const hr = await h.login(seedEmail(h.seed, 'hr'))

    const typed = await hr.put(`/cvs/${stored.id}/text`, {
      text:
        'Senior Backend Engineer with 7 years building production backend services. ' +
        'Strong TypeScript and Go, with relational database design in PostgreSQL. ' +
        'BSc Computer Science.',
    })
    expect(typed.status).toBe(200)
    expect(typed.body.document.extractionStatus).toBe('OK')
    expect(typed.body.document.extractor).toBe('manual')

    const match = await hr.get(`/cvs/${stored.id}/match/${h.seed.jobIds.eng001}`)
    expect(match.body.report.score.mandatoryMet).toBeGreaterThan(0)
  })

  it('reads a real DOCX and stores its text', async () => {
    const stored = await storeCv(h, {
      candidateId: await firstCandidateId(h),
      filename: 'cv.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      body: fixture('sample-cv.docx'),
    })
    expect(stored.extractionStatus).toBe('OK')
    expect(stored.extractedText).toContain('Marcus Chen')
  })

  it('keeps a file whose text cannot be read, rather than losing it', async () => {
    const stored = await storeCv(h, {
      candidateId: await firstCandidateId(h),
      filename: 'scan.pdf',
      contentType: 'application/pdf',
      body: new TextEncoder().encode('%PDF-1.7 not a real pdf').buffer as ArrayBuffer,
    })
    expect(stored.extractionStatus).toBe('EMPTY')
    expect(stored.extractedText).toBeNull()
    // The original is still retrievable, which is the point.
    expect(await h.container.storage.get(stored.storageKey)).not.toBeNull()
  })
})

describe('a malicious CV is data, not instruction', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  it('accepts the CV, flags it, and raises a security event', async () => {
    const stored = await storeCv(h, {
      candidateId: await firstCandidateId(h),
      filename: 'hostile.docx',
      body: fixture('hostile-cv.docx'),
    })

    // Refusing it would let an attacker deny a real applicant by poisoning
    // their own CV, so it is stored and marked instead.
    expect(stored.injectionFlagged).toBe(true)
    expect(stored.extractedText).toContain('SYSTEM MESSAGE')

    const events = await h.database.db.many<{ event_type: string; detail: string | null }>(
      `SELECT event_type, detail FROM security_events
        WHERE tenant_id = ? AND event_type = 'DOCUMENT_INJECTION' ORDER BY timestamp DESC LIMIT 1`,
      [h.seed.tenantId],
    )
    expect(events).toHaveLength(1)
    // The event carries categories, never the CV itself.
    expect(events[0]!.detail ?? '').not.toContain('salary database')
  })

  it('changes nothing about the application stage', async () => {
    const candidateId = await firstCandidateId(h)
    const scope = tenantScope(h.seed.tenantId)
    const before = await h.database.repos.applications.listForCandidate(scope, candidateId)

    await storeCv(h, {
      candidateId,
      filename: 'hostile.docx',
      body: fixture('hostile-cv.docx'),
    })

    const after = await h.database.repos.applications.listForCandidate(scope, candidateId)
    expect(after.map((a) => a.stage)).toEqual(before.map((a) => a.stage))
  })

  it('does not let injected text satisfy a job requirement', async () => {
    const stored = await storeCv(h, {
      candidateId: await firstCandidateId(h),
      filename: 'hostile.docx',
      body: fixture('hostile-cv.docx'),
    })

    const hr = await h.login(seedEmail(h.seed, 'hr'))
    const match = await hr.get(`/cvs/${stored.id}/match/${h.seed.jobIds.eng001}`)
    expect(match.status).toBe(200)
    expect(match.body.report.score.mandatoryMet).toBe(0)
  })
})

describe('the external bot only accepts a CV from an identified candidate', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  async function sendDocument(telegramUserId: number, fileName = 'cv.txt'): Promise<number> {
    const updateId = Math.floor(Math.random() * 1e9)
    const response = await h.request('/telegram/external', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: updateId,
        message: {
          message_id: updateId,
          chat: { id: telegramUserId, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          from: { id: telegramUserId, first_name: 'Candidate' },
          document: {
            file_id: 'FILE_ID_TEST',
            file_name: fileName,
            mime_type: 'text/plain',
            file_size: 1024,
          },
        },
      }),
    })
    return response.status
  }

  it('stores nothing for a Telegram id that has never applied', async () => {
    expect(await sendDocument(777001)).toBe(200)

    const count = await h.database.db.count(
      'SELECT COUNT(*) AS c FROM candidate_documents WHERE tenant_id = ?',
      [h.seed.tenantId],
    )
    expect(count, 'an unidentified sender must not create a document row').toBe(0)
  })

  it('refuses an executable before any download is attempted', async () => {
    expect(await sendDocument(777002, 'payload.exe')).toBe(200)
    const count = await h.database.db.count(
      'SELECT COUNT(*) AS c FROM candidate_documents WHERE tenant_id = ?',
      [h.seed.tenantId],
    )
    expect(count).toBe(0)
  })
})

describe('accepted CV formats', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  it.each([
    ['cv.pdf', 'application/pdf'],
    ['cv.doc', 'application/msword'],
    ['cv.docx', DOCX_TYPE],
  ] as const)('accepts %s', async (filename, contentType) => {
    const body =
      filename === 'cv.pdf'
        ? fixture('sample-cv.pdf')
        : filename === 'cv.doc'
          ? fixture('sample-cv.doc')
          : fixture('backend-cv.docx')

    const stored = await storeCv(h, {
      candidateId: await firstCandidateId(h),
      filename,
      contentType,
      body,
    })
    expect(stored.filename).toBe(filename)
    // Whatever the parser managed, the original is always retrievable.
    expect(await h.container.storage.get(stored.storageKey)).not.toBeNull()
  })

  it.each([
    ['notes.txt', 'text/plain'],
    ['notes.md', 'text/markdown'],
    ['sheet.csv', 'text/csv'],
    ['payload.exe', 'application/x-msdownload'],
    ['photo.png', 'image/png'],
  ] as const)('refuses %s', async (filename, contentType) => {
    await expect(
      storeCv(h, { candidateId: await firstCandidateId(h), filename, contentType }),
    ).rejects.toThrow(/PDF, DOC or DOCX/i)
  })

  it('reads a DOCX, and says so', async () => {
    const stored = await storeCv(h, { candidateId: await firstCandidateId(h) })
    expect(stored.extractionStatus).toBe('OK')
    expect(stored.extractor).toBe('docx')
    expect(stored.extractedText).toContain('Dara Sok')
  })

  it.each([
    ['cv.pdf', 'application/pdf', 'sample-cv.pdf'],
    ['cv.doc', 'application/msword', 'sample-cv.doc'],
  ] as const)('stores %s without pretending to have read it', async (filename, contentType, file) => {
    const stored = await storeCv(h, {
      candidateId: await firstCandidateId(h),
      filename,
      contentType,
      body: fixture(file),
    })
    expect(stored.extractionStatus).toBe('EMPTY')
    expect(stored.extractedText).toBeNull()
    expect(stored.extractionWarnings.join(' ')).toMatch(/paste the text/i)
  })

  it('matches a .doc once its text has been entered by hand', async () => {
    const stored = await storeCv(h, {
      candidateId: await firstCandidateId(h),
      filename: 'cv.doc',
      contentType: 'application/msword',
      body: fixture('sample-cv.doc'),
    })
    const hr = await h.login(seedEmail(h.seed, 'hr'))

    const typed = await hr.put(`/cvs/${stored.id}/text`, {
      text:
        'Senior Backend Engineer with 7 years building production backend services. ' +
        'Strong TypeScript and Go, with relational database design in PostgreSQL.',
    })
    expect(typed.status).toBe(200)
    expect(typed.body.document.extractor).toBe('manual')

    const match = await hr.get(`/cvs/${stored.id}/match/${h.seed.jobIds.eng001}`)
    expect(match.body.report.score.mandatoryMet).toBeGreaterThan(0)
  })
})

describe('CVs are ingested by the bots, not the dashboard', () => {
  let h: Harness
  beforeEach(async () => {
    h = await createHarness()
  })
  afterEach(() => h.close())

  it('exposes no upload route — intake is the bots', async () => {
    const hrAdmin = await h.login(seedEmail(h.seed, 'hrAdmin'))
    expect((await hrAdmin.post('/cvs', { candidateId: 'x' })).status).toBe(404)
  })

  it('filters the listing by source, text status and flag', async () => {
    const candidateId = await firstCandidateId(h)
    await storeCv(h, { candidateId, filename: 'from-candidate.docx' })
    await storeCv(h, {
      candidateId,
      filename: 'forwarded.docx',
      body: fixture('sample-cv.docx'),
      source: 'TELEGRAM_INTERNAL',
    })
    await storeCv(h, {
      candidateId,
      filename: 'scan.pdf',
      contentType: 'application/pdf',
      body: fixture('sample-cv.pdf'),
    })

    const hr = await h.login(seedEmail(h.seed, 'hr'))
    const names = (body: { items: { filename: string }[] }) => body.items.map((d) => d.filename)

    expect(names((await hr.get('/cvs?source=TELEGRAM_INTERNAL')).body)).toEqual(['forwarded.docx'])
    expect(names((await hr.get('/cvs?extraction=EMPTY')).body)).toEqual(['scan.pdf'])
    expect(names((await hr.get('/cvs?source=TELEGRAM_EXTERNAL')).body)).not.toContain(
      'forwarded.docx',
    )

    // Facets describe everything, not just the filtered page.
    const filtered = await hr.get('/cvs?source=TELEGRAM_INTERNAL')
    expect(filtered.body.facets.total).toBe(3)
    expect(filtered.body.facets.bySource.TELEGRAM_INTERNAL).toBe(1)
    expect(filtered.body.facets.byExtraction.EMPTY).toBe(1)
  })
})

/**
 * Stands in for api.telegram.org so the download → store path can be exercised.
 * `getFile` resolves, the file endpoint returns `body`, and everything else is
 * an empty success so `sendMessage` does not fail the turn.
 */
function telegramStub(body: ArrayBuffer) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes('/getFile')) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: { file_path: 'documents/cv.docx', file_size: body.byteLength },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.includes('/file/bot')) return new Response(body)
    return new Response(JSON.stringify({ ok: true, result: true }), {
      headers: { 'content-type': 'application/json' },
    })
  }
}

const BOT_TOKEN = '1234567890:test-token-for-download-path-000000000'

describe('the /cv command and bot intake', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness({
      env: {
        TELEGRAM_EXTERNAL_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_INTERNAL_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_FETCH: telegramStub(fixture('backend-cv.docx')),
      },
    })
  })
  afterEach(() => h.close())

  async function post(
    bot: 'internal' | 'external',
    telegramUserId: number,
    message: Record<string, unknown>,
  ): Promise<number> {
    const updateId = Math.floor(Math.random() * 1e9)
    const response = await h.request(`/telegram/${bot}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: updateId,
        message: {
          message_id: updateId,
          chat: { id: telegramUserId, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          from: { id: telegramUserId, first_name: 'T' },
          ...message,
        },
      }),
    })
    return response.status
  }

  const attachment = (fileName = 'cv.docx', mimeType = DOCX_TYPE) => ({
    document: { file_id: 'FILE_ID_TEST', file_name: fileName, mime_type: mimeType, file_size: 900 },
  })

  async function linkStaff(key: string, telegramUserId: number): Promise<void> {
    const employee = h.seed.employees[key]!
    await h.database.repos.telegramAccounts.link(tenantScope(h.seed.tenantId), {
      telegramUserId: String(telegramUserId),
      scope: 'INTERNAL',
      employeeId: employee.id,
      userId: employee.userId,
    })
  }

  const documentCount = () =>
    h.database.db.count('SELECT COUNT(*) AS c FROM candidate_documents WHERE tenant_id = ?', [
      h.seed.tenantId,
    ])

  it('is reserved, so no curated answer can take it', async () => {
    const hrAdmin = await h.login(seedEmail(h.seed, 'hrAdmin'))
    const response = await hrAdmin.post('/knowledge/answers', {
      question: 'Hijack the CV flow',
      answer: 'Should never be created.',
      audience: 'BOTH',
      classification: 'PUBLIC',
      command: 'cv',
      commandDescription: 'Definitely not',
    })
    expect(response.status).toBe(400)
    expect(String(response.body.error.message)).toMatch(/built-in/i)
  })

  it('appears in both bot command menus', async () => {
    const hr = await h.login(seedEmail(h.seed, 'hr'))
    const menus = await hr.get('/knowledge/answers/commands')
    for (const menu of menus.body.menus) {
      expect(
        menu.effective.map((c: { command: string }) => c.command),
        menu.compartment,
      ).toContain('cv')
    }
  })

  // --- Recruitment bot: the candidate's own CV

  it('external: /cv with a file attaches it to the sender, with no staff attribution', async () => {
    const scope = tenantScope(h.seed.tenantId)
    const candidate = await h.database.repos.candidates.findByEmail(
      scope,
      'priya.seeker@example.test',
    )
    await h.database.repos.candidates.linkTelegramAccount(scope, candidate!.id, '885001')

    expect(await post('external', 885001, { caption: '/cv', ...attachment() })).toBe(200)

    const documents = await h.database.repos.candidateDocuments.listForCandidate(scope, candidate!.id)
    expect(documents).toHaveLength(1)
    expect(documents[0]!.source).toBe('TELEGRAM_EXTERNAL')
    expect(documents[0]!.uploadedByUserId).toBeNull()
    expect(documents[0]!.extractedText).toContain('Dara Sok')
  })

  it('external: a file with no command still works', async () => {
    const scope = tenantScope(h.seed.tenantId)
    const candidate = await h.database.repos.candidates.findByEmail(
      scope,
      'priya.seeker@example.test',
    )
    await h.database.repos.candidates.linkTelegramAccount(scope, candidate!.id, '885002')

    expect(await post('external', 885002, attachment())).toBe(200)
    expect(await documentCount()).toBe(1)
  })

  it('external: /cv alone explains and stores nothing', async () => {
    expect(await post('external', 885003, { text: '/cv' })).toBe(200)
    expect(await documentCount()).toBe(0)
  })

  it('external: a Telegram id that has never applied stores nothing', async () => {
    expect(await post('external', 885004, { caption: '/cv', ...attachment() })).toBe(200)
    expect(await documentCount()).toBe(0)
  })

  it('external: refuses an unaccepted format before downloading it', async () => {
    expect(
      await post('external', 885005, {
        caption: '/cv',
        ...attachment('payload.exe', 'application/x-msdownload'),
      }),
    ).toBe(200)
    expect(await documentCount()).toBe(0)
  })

  // --- Employee bot: a forwarded CV

  it('internal: /cv <e-mail> with a file attaches it, recording who forwarded it', async () => {
    const hrEmployee = h.seed.employees.hr!
    await linkStaff('hr', 885010)

    expect(
      await post('internal', 885010, {
        caption: '/cv jordan.applicant@example.test',
        ...attachment('forwarded.docx'),
      }),
    ).toBe(200)

    const documents = await h.database.repos.candidateDocuments.listForCandidate(
      tenantScope(h.seed.tenantId),
      await firstCandidateId(h),
    )
    expect(documents.map((d) => d.filename)).toContain('forwarded.docx')
    expect(documents[0]!.source).toBe('TELEGRAM_INTERNAL')
    expect(documents[0]!.uploadedByUserId).toBe(hrEmployee.userId)
  })

  it('internal: an application reference resolves the candidate too', async () => {
    await linkStaff('hr', 885011)
    const applications = await h.database.repos.applications.listForCandidate(
      tenantScope(h.seed.tenantId),
      await firstCandidateId(h),
    )

    expect(
      await post('internal', 885011, {
        caption: `/cv ${applications[0]!.reference}`,
        ...attachment('by-reference.docx'),
      }),
    ).toBe(200)
    expect(await documentCount()).toBe(1)
  })

  it('internal: a bare caption with no command still works', async () => {
    await linkStaff('hr', 885012)
    expect(
      await post('internal', 885012, {
        caption: 'jordan.applicant@example.test',
        ...attachment('bare.docx'),
      }),
    ).toBe(200)
    expect(await documentCount()).toBe(1)
  })

  it('internal: /cv alone explains and stores nothing', async () => {
    await linkStaff('hr', 885013)
    expect(await post('internal', 885013, { text: '/cv' })).toBe(200)
    expect(await documentCount()).toBe(0)
  })

  it.each(['employee', 'manager'] as const)(
    'internal: %s cannot forward a CV, whatever the caption says',
    async (key) => {
      const uid = key === 'employee' ? 885014 : 885015
      await linkStaff(key, uid)
      expect(
        await post('internal', uid, {
          caption: '/cv jordan.applicant@example.test',
          ...attachment(),
        }),
      ).toBe(200)
      expect(await documentCount()).toBe(0)
    },
  )

  it('internal: an unverified Telegram id stores nothing', async () => {
    expect(
      await post('internal', 885016, {
        caption: '/cv jordan.applicant@example.test',
        ...attachment(),
      }),
    ).toBe(200)
    expect(await documentCount()).toBe(0)
  })

  it('internal: a caption never creates a candidate', async () => {
    await linkStaff('hr', 885017)
    expect(
      await post('internal', 885017, { caption: '/cv nobody@example.invalid', ...attachment() }),
    ).toBe(200)
    expect(await documentCount()).toBe(0)

    const created = await h.database.db.count(
      'SELECT COUNT(*) AS c FROM candidates WHERE tenant_id = ? AND email = ?',
      [h.seed.tenantId, 'nobody@example.invalid'],
    )
    expect(created, 'a caption must not create a candidate').toBe(0)
  })

  it('internal: a file with no caption stores nothing', async () => {
    await linkStaff('hr', 885018)
    expect(await post('internal', 885018, attachment())).toBe(200)
    expect(await documentCount()).toBe(0)
  })
})

describe('a candidate can get from nothing to a stored CV', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness({
      env: {
        TELEGRAM_EXTERNAL_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_FETCH: telegramStub(fixture('backend-cv.docx')),
      },
    })
  })
  afterEach(() => h.close())

  async function send(telegramUserId: number, message: Record<string, unknown>): Promise<void> {
    const updateId = Math.floor(Math.random() * 1e9)
    await h.request('/telegram/external', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: updateId,
        message: {
          message_id: updateId,
          chat: { id: telegramUserId, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          from: { id: telegramUserId, first_name: 'Monika' },
          ...message,
        },
      }),
    })
  }

  async function lastReply(): Promise<string> {
    const rows = await h.database.db.many<{ content: string }>(
      `SELECT m.content FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.tenant_id = ? AND c.channel = 'TELEGRAM_EXTERNAL' AND m.role = 'assistant'
        ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`,
      [h.seed.tenantId],
    )
    return rows[0]?.content ?? ''
  }

  it('applies with one line, then attaches a CV — the flow that used to dead-end', async () => {
    const uid = 886001
    const scope = tenantScope(h.seed.tenantId)

    // 1. /apply in the documented format creates the candidate and the
    //    application, and links this Telegram id to them.
    await send(uid, { text: '/apply ENG-001 | Monika Chan | monika.chan@example.test' })

    const candidate = await h.database.repos.candidates.findByEmail(
      scope,
      'monika.chan@example.test',
    )
    expect(candidate, 'the application should create the candidate').toBeTruthy()
    expect(candidate!.telegramUserId).toBe(String(uid))
    // The name is stored exactly as given. A previous attempt routed these
    // fields back through the provider, which re-read the name out of the
    // rendered sentence and stored "Monika Chan and my email is monika".
    expect(candidate!.name).toBe('Monika Chan')

    const applications = await h.database.repos.applications.listForCandidate(scope, candidate!.id)
    expect(applications).toHaveLength(1)

    // 2. The CV now has an owner, so it stores.
    await send(uid, { caption: '/cv', ...{ document: { file_id: 'F', file_name: 'monika.docx', mime_type: DOCX_TYPE, file_size: 900 } } })

    const documents = await h.database.repos.candidateDocuments.listForCandidate(scope, candidate!.id)
    expect(documents).toHaveLength(1)
    expect(documents[0]!.filename).toBe('monika.docx')
    expect(documents[0]!.source).toBe('TELEGRAM_EXTERNAL')
  })

  it('reports the reference back, so the candidate can check their status', async () => {
    const uid = 886004
    await send(uid, { text: '/apply ENG-001 | Sokha Chan | sokha.chan@example.test' })

    const reply = await lastReply()
    expect(reply).toMatch(/Application submitted/i)
    expect(reply).toMatch(/Reference: SPA-/)
  })

  it('answers /apply with the exact format when a field is missing', async () => {
    await send(886002, { text: '/apply' })
    expect(await lastReply()).toBe('')

    // The format reply is sent, not persisted as an assistant turn, so assert
    // on the effect instead: nothing was created from an incomplete apply.
    const count = await h.database.db.count(
      'SELECT COUNT(*) AS c FROM candidates WHERE tenant_id = ? AND telegram_user_id = ?',
      [h.seed.tenantId, '886002'],
    )
    expect(count).toBe(0)
  })

  it('an unrecognised message tells a candidate what they can do, not to contact HR', async () => {
    await send(886003, { text: 'Name: Monika' })

    const reply = await lastReply()
    expect(reply).not.toMatch(/contact HR/i)
    expect(reply).toMatch(/\/apply/)
    expect(reply).toMatch(/\/jobs/)
  })
})

describe('the guided application flow', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness({
      env: {
        TELEGRAM_EXTERNAL_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_FETCH: telegramStub(fixture('backend-cv.docx')),
      },
    })
  })
  afterEach(() => h.close())

  async function say(uid: number, message: Record<string, unknown>): Promise<void> {
    const updateId = Math.floor(Math.random() * 1e9)
    await h.request('/telegram/external', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': TEST_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: updateId,
        message: {
          message_id: updateId,
          chat: { id: uid, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          from: { id: uid, first_name: 'Dara' },
          ...message,
        },
      }),
    })
  }

  const draftOf = (uid: number) =>
    h.database.repos.applicationDrafts.find(tenantScope(h.seed.tenantId), String(uid))

  it('collects the three fields one at a time, with no format to learn', async () => {
    const uid = 887001
    await say(uid, { text: '/apply' })
    expect((await draftOf(uid))?.jobCode ?? null).toBeNull()

    await say(uid, { text: 'ENG-001' })
    expect((await draftOf(uid))?.jobCode).toBe('ENG-001')

    await say(uid, { text: 'Dara Sok' })
    expect((await draftOf(uid))?.fullName).toBe('Dara Sok')

    await say(uid, { text: 'dara.sok@example.test' })

    // Completing the draft submits the application and clears the scratch row.
    const candidate = await h.database.repos.candidates.findByEmail(
      tenantScope(h.seed.tenantId),
      'dara.sok@example.test',
    )
    expect(candidate?.name).toBe('Dara Sok')
    expect(candidate?.telegramUserId).toBe(String(uid))
    expect(await draftOf(uid)).toBeNull()
  })

  it('classifies each answer by shape, so order does not matter', async () => {
    const uid = 887002
    await say(uid, { text: '/apply' })
    await say(uid, { text: 'dara.two@example.test' })
    await say(uid, { text: 'ENG-001' })

    const draft = await draftOf(uid)
    expect(draft?.email).toBe('dara.two@example.test')
    expect(draft?.jobCode).toBe('ENG-001')
    // A job code typed at the name question must not become a name.
    expect(draft?.fullName).toBeNull()
  })

  it('still accepts everything on one line for anyone who prefers it', async () => {
    const uid = 887003
    await say(uid, { text: '/apply ENG-001 Dara Three dara.three@example.test' })

    const candidate = await h.database.repos.candidates.findByEmail(
      tenantScope(h.seed.tenantId),
      'dara.three@example.test',
    )
    expect(candidate?.name).toBe('Dara Three')
    expect(await draftOf(uid)).toBeNull()
  })

  it('/cancel abandons the draft', async () => {
    const uid = 887004
    await say(uid, { text: '/apply' })
    await say(uid, { text: 'ENG-001' })
    expect(await draftOf(uid)).not.toBeNull()

    await say(uid, { text: '/cancel' })
    expect(await draftOf(uid)).toBeNull()
  })

  it('does not capture ordinary conversation when no draft is open', async () => {
    const uid = 887005
    await say(uid, { text: 'do you have any backend roles?' })
    expect(await draftOf(uid)).toBeNull()
  })

  it('leaves a half-finished draft holding no candidate record', async () => {
    const uid = 887006
    await say(uid, { text: '/apply' })
    await say(uid, { text: 'ENG-001' })
    await say(uid, { text: 'Someone Halfway' })

    // A draft is scratch space: until the tool runs there is no candidate.
    const count = await h.database.db.count(
      'SELECT COUNT(*) AS c FROM candidates WHERE tenant_id = ? AND telegram_user_id = ?',
      [h.seed.tenantId, String(uid)],
    )
    expect(count).toBe(0)
  })

  it('answers a photo instead of ignoring it', async () => {
    const uid = 887007
    await say(uid, {
      photo: [{ file_id: 'AgACAg', file_unique_id: 'x', width: 1280, height: 960, file_size: 90_000 }],
    })

    // The bug this pins: a photographed CV normalised to nothing, so the bot
    // replied with silence and looked broken.
    const count = await h.database.db.count(
      'SELECT COUNT(*) AS c FROM candidate_documents WHERE tenant_id = ?',
      [h.seed.tenantId],
    )
    expect(count).toBe(0)
  })
})
