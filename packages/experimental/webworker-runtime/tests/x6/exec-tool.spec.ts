/** Her `x6_exec` tool (exec-tool.ts) over a made-up edge. No GitHub, no runner, no network. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyActionIrreversibility } from '../../src/x6/ball-loader.ts'
import { classifyToolMutation } from '../../src/x6/capability-index.ts'
import { createExecTool, EXEC_TOOL_ACTIONS, EXEC_TOOL_DESCRIPTION, EXEC_TOOL_LIMITS, EXEC_TOOL_PARAMETERS } from '../../src/x6/exec-tool.ts'
import { voiceRefusal, voiceVerdict } from '../../src/x6/voice-read-only.ts'
import { mountE4, type Call } from './e4-fixture.ts'

type J = Record<string, unknown>
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const RUN = (id: number, label: string, extra: J = {}): J => ({ id, status: 'queued', conclusion: null, created: '2026-11-14T10:00:00Z',
  runName: `auma-exec ${label} @ main`, label, ref: 'main', url: `https://github.com/your_org_x/your-node/actions/runs/${String(id)}`, ...extra })

/** A made-up edge: `lists` are the successive exec_runs answers (the last one repeats); a list that is not an array is the
 * whole answer (a refusal). */
function edge(lists: (J[] | J)[], dispatch: J = { ok: true, action: 'dispatch_workflow' }) {
  const sent: J[] = []
  let listed = 0
  const sleeps: number[] = []
  const tool = createExecTool({
    post: (body) => {
      sent.push(body)
      if (body.action === 'dispatch_workflow') return Promise.resolve(dispatch)
      if (body.action === 'exec_runs') {
        const runs = lists[Math.min(listed, lists.length - 1)] ?? []
        listed += 1
        return Promise.resolve(Array.isArray(runs) ? { ok: true, action: 'exec_runs', runs } : runs)
      }
      return Promise.resolve({ ok: true, action: body.action, echo: body })
    },
    sleep: (ms) => { sleeps.push(ms); return Promise.resolve() },
    randomHex: () => '0123abcd',
  })
  return { tool, sent, sleeps }
}

describe('x6_exec run, status and the label search', () => {
  it('run makes a label when none is given, dispatches auma-exec.yml with the inputs as strings, and finds the run by its label', async () => {
    const { tool, sent, sleeps } = edge([[RUN(7, 'x-other')], [RUN(9, 'x-0123abcd'), RUN(7, 'x-other')]])
    const answer = await tool.execute({ action: 'run', command: 'node -v', timeoutMinutes: 5, browser: true })
    expect(answer).toEqual({ ok: true, run: 9, label: 'x-0123abcd', ref: 'main', status: 'queued', conclusion: null,
      url: 'https://github.com/your_org_x/your-node/actions/runs/9' })
    expect(sent).toEqual([
      { action: 'dispatch_workflow', workflow: 'auma-exec.yml', inputs: { ref: 'main', command: 'node -v', label: 'x-0123abcd', timeout_minutes: '5', browser: 'true' } },
      { action: 'exec_runs' }, { action: 'exec_runs' }])
    expect(sleeps).toEqual([EXEC_TOOL_LIMITS.pollMs, EXEC_TOOL_LIMITS.pollMs])
  })

  it('a run GitHub has not shown after the bounded polls answers pending with its label, and status { label } finds it later', async () => {
    const { tool, sent } = edge([[]])
    const answer = await tool.execute({ action: 'run', command: 'ls', ref: 'auma/proposal/my-fix' })
    expect(answer).toMatchObject({ ok: true, pending: true, label: 'x-0123abcd', ref: 'auma/proposal/my-fix' })
    expect(String(answer.next)).toContain('x6_exec status { label: "x-0123abcd" }')
    expect(sent.filter(body => body.action === 'exec_runs')).toHaveLength(EXEC_TOOL_LIMITS.polls)
    const later = edge([[RUN(12, 'x-0123abcd', { status: 'in_progress', ref: 'auma/proposal/my-fix' })]])
    expect(await later.tool.execute({ action: 'status', label: 'x-0123abcd' })).toEqual({ ok: true, run: 12, label: 'x-0123abcd',
      ref: 'auma/proposal/my-fix', status: 'in_progress', conclusion: null, url: 'https://github.com/your_org_x/your-node/actions/runs/12' })
    expect(await edge([[]]).tool.execute({ action: 'status', label: 'x-gone' })).toMatchObject({ ok: true, pending: true, found: false, label: 'x-gone' })
  })

  it('a label she chose gets - and 8 hex, so only the run she just started is answered', async () => {
    const { tool, sent } = edge([[RUN(5, 'tests')], [RUN(6, 'tests-0123abcd'), RUN(5, 'tests')]])
    expect(await tool.execute({ action: 'run', command: 'ls', label: 'tests' })).toMatchObject({ ok: true, run: 6, label: 'tests-0123abcd' })
    expect(sent.map(body => body.action)).toEqual(['dispatch_workflow', 'exec_runs', 'exec_runs'])
    expect((sent[0]?.inputs as J).label).toBe('tests-0123abcd')
  })

  it('an earlier run under the same fixed label is never answered as hers, even when a listing fails', async () => {
    // Yesterday's spec-self-check succeeded; today GitHub does not show the new run within the polls, and one listing fails.
    const yesterday = RUN(5, 'spec-self-check', { status: 'completed', conclusion: 'success' })
    const { tool, sent } = edge([{ ok: false, code: 'BROKER_UPSTREAM_FAILED' }, [yesterday]])
    const answer = await tool.execute({ action: 'run', command: 'ls', label: 'spec-self-check' })
    expect(answer).toMatchObject({ ok: true, pending: true, label: 'spec-self-check-0123abcd' })
    expect(answer.run).toBeUndefined()
    expect(String(answer.next)).toContain('status { label: "spec-self-check-0123abcd" }')
    expect(sent.filter(body => body.action === 'exec_runs')).toHaveLength(EXEC_TOOL_LIMITS.polls)
    // Her status with the label run answered finds nothing of yesterday's.
    expect(await edge([[yesterday]]).tool.execute({ action: 'status', label: 'spec-self-check-0123abcd' })).toMatchObject({ ok: true, pending: true, found: false })
  })

  it('a chosen label that is empty, not text, or longer than 55 is refused before anything is sent', async () => {
    for (const label of ['', 7, 'a'.repeat(EXEC_TOOL_LIMITS.labelChars + 1)]) {
      const { tool, sent } = edge([[]])
      expect(await tool.execute({ action: 'run', command: 'ls', label })).toMatchObject({ ok: false, code: 'EXEC_LABEL_INVALID', sent: false })
      expect(sent).toEqual([])
    }
    const { tool, sent } = edge([[]])
    await tool.execute({ action: 'run', command: 'ls', label: 'a'.repeat(EXEC_TOOL_LIMITS.labelChars) })
    expect((sent[0]?.inputs as J).label as string).toHaveLength(64)
  })

  it('a refused dispatch comes back as the edge said it, with sent: false, and nothing is polled', async () => {
    const refusal = { ok: false, code: 'EXEC_RATE_LIMITED', retryAt: 1794650400000, limit: '60 runs per hour' }
    const { tool, sent, sleeps } = edge([[]], refusal)
    expect(await tool.execute({ action: 'run', command: 'ls' })).toEqual({ ...refusal, sent: false })
    expect(sent).toHaveLength(1)
    expect(sleeps).toEqual([])
  })

  it('status, logs, cancel, list and artifacts send exactly their edge action; an unknown field or action sends nothing', async () => {
    const { tool, sent } = edge([[]])
    await tool.execute({ action: 'status', run: 10 })
    await tool.execute({ action: 'logs', run: 10 })
    await tool.execute({ action: 'logs', run: 10, job: 1000 })
    await tool.execute({ action: 'cancel', run: 10 })
    await tool.execute({ action: 'list' })
    await tool.execute({ action: 'artifacts', run: 10 })
    expect(sent).toEqual([{ action: 'exec_run', run: 10 }, { action: 'exec_logs', run: 10 }, { action: 'exec_logs', run: 10, job: 1000 },
      { action: 'exec_cancel', run: 10 }, { action: 'exec_runs' }, { action: 'exec_artifacts', run: 10 }])
    sent.length = 0
    expect(await tool.execute({ action: 'run', command: 'ls', secrets: 'x' })).toEqual({ ok: false, code: 'EXEC_FIELD_UNKNOWN', sent: false, fields: ['secrets'] })
    expect(await tool.execute({ action: 'list', limit: 5 })).toMatchObject({ ok: false, code: 'EXEC_FIELD_UNKNOWN' })
    expect(await tool.execute({ action: 'status', run: 1, label: 'x' })).toMatchObject({ ok: false, code: 'EXEC_FIELDS_INVALID' })
    expect(await tool.execute({ action: 'status' })).toMatchObject({ ok: false, code: 'EXEC_FIELDS_INVALID' })
    expect(await tool.execute({ action: 'shell', command: 'ls' })).toMatchObject({ ok: false, code: 'EXEC_ACTION_INVALID' })
    expect(sent).toEqual([])
  })
})

describe('classification, voice and her words', () => {
  it('run and cancel are not reads; status, logs, list and artifacts are, everywhere they are classified', () => {
    for (const action of EXEC_TOOL_ACTIONS) {
      expect([action, classifyActionIrreversibility({ tool: 'x6_exec', action, run: 1 })]).toEqual([action, ['run', 'cancel'].includes(action) ? 1 : 0])
    }
    const parameters = [{ name: 'action', type: 'string', required: true, enum: [...EXEC_TOOL_ACTIONS] }]
    expect(classifyToolMutation('x6_exec', parameters)).toEqual({ readOnly: false, mutating: true,
      actions: { read: ['artifacts', 'list', 'logs', 'status'], write: ['cancel', 'run'] } })
  })

  it('a look-only voice turn refuses run and cancel, and logs (a second host); list, status and artifacts are on its list', () => {
    const verdict = (args: J) => voiceVerdict({ tool: 'x6_exec', args, origin: { kind: 'builtin' } })
    expect(verdict({ action: 'run', command: 'ls' })).toBe(voiceRefusal('x6_exec', 'run'))
    expect(verdict({ action: 'cancel', run: 1 })).toBe(voiceRefusal('x6_exec', 'cancel'))
    expect(verdict({ action: 'logs', run: 1 })).toBe(voiceRefusal('x6_exec', 'logs'))
    expect(verdict({})).toBe(voiceRefusal('x6_exec', null))
    for (const args of [{ action: 'list' }, { action: 'status', run: 1 }, { action: 'status', label: 'x-1' }, { action: 'artifacts', run: 1 }]) {
      expect(verdict(args)).toBeUndefined()
    }
    // Only as her own built-in: an organ or a preset tool of the same name is refused.
    expect(voiceVerdict({ tool: 'x6_exec', args: { action: 'list' }, origin: { kind: 'preset' } })).toContain('VOICE_LOOK_ONLY')
  })

  it('her words say what the machine has, that nothing comes back by itself, the bounds, and never the word for a key', () => {
    for (const words of ['Node, pnpm', 'Python 3, git, gh (not signed in), jq and rg', 'It holds no secret',
      'does NOT come back by itself', '$ARTIFACTS', 'commit through x6_repo', 'one to three minutes to start', 'at most 30 minutes',
      'one at a time per branch', '`browser: true` adds headless Chromium', '60 runs an hour and 300 a day', 'docs/auma/exec.md',
      'without sudo', 'not durably', '`-` and 8 hex are added']) {
      expect(EXEC_TOOL_DESCRIPTION).toContain(words)
    }
    expect(EXEC_TOOL_DESCRIPTION).not.toMatch(/token/iu)
    expect(Object.keys(EXEC_TOOL_PARAMETERS).sort()).toEqual(['action', 'browser', 'command', 'job', 'label', 'ref', 'run', 'timeoutMinutes'])
  })
})

describe('x6_exec on her mounted runtime', () => {
  it('is registered as her built-in, posts to /_host/repo on her own origin, and returns the edge answer', async () => {
    const answers: Record<string, J> = {
      exec_runs: { ok: true, action: 'exec_runs', runs: [RUN(3, 'x-1')] },
      exec_logs: { ok: true, action: 'exec_logs', run: 3, jobId: 300, log: 'hello\n', truncated: false },
      dispatch_workflow: { ok: false, code: 'EXEC_COMMAND_INVALID' },
    }
    const m = await mountE4({ respond: (call: Call) => call.path === '/_host/repo' && call.method === 'POST'
      ? Response.json(answers[String((call.body as J).action)] ?? { ok: false, code: 'X' }, { status: (call.body as J).action === 'dispatch_workflow' ? 400 : 200 }) : null })
    const tool = m.tool('x6_exec')
    expect((tool.parameters.action as { enum: string[] }).enum).toEqual([...EXEC_TOOL_ACTIONS])
    const from = m.calls.length
    expect(await tool.execute({ action: 'list' })).toEqual(answers.exec_runs)
    expect(await tool.execute({ action: 'logs', run: 3 })).toEqual(answers.exec_logs)
    expect(await tool.execute({ action: 'run', command: '' })).toMatchObject({ ok: false, code: 'EXEC_COMMAND_INVALID', sent: false })
    const sent = m.calls.slice(from)
    expect(sent.map(call => [call.method, call.path, call.credentials])).toEqual(Array(3).fill(['POST', '/_host/repo', 'same-origin']))
    expect(sent.map(call => (call.body as J).action)).toEqual(['exec_runs', 'exec_logs', 'dispatch_workflow'])
    const index = await m.tool('x6_capability_index').execute({ action: 'lookup', name: 'x6_exec' }) as J
    expect(index).toMatchObject({ ok: true, tool: { readOnly: false, mutating: true, actions: { read: ['artifacts', 'list', 'logs', 'status'], write: ['cancel', 'run'] } } })
  }, 60_000)
})
