// the open door level regression, 2026-11-15. At the open door level .github/workflows/proposal-checks.yml ran the fence and nothing
// else, so a card that changed a suite or src/storage/ was judged by no run of its own specs: two of her storage cards
// passed this workflow while the spec they changed was red (exec 43705966964, 1 failed of 15). The fix runs
// new-vitest-tests at that level when the diff touches a suite or the storage module, and requires it exactly when it ran.
// This spec pins the rule and the two constraints main's own guards impose on where it may live (deploy/ci/
// frozen-paths.test.mjs holds the fence job to exactly four steps; deploy/ci/retention.test.mjs keeps the checks job to
// red and level only). It also makes this card touch a suite, so the new arm runs on the change that introduces it.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.github/workflows/proposal-checks.yml', 'utf8')

/** The text of one top-level job, from its name to the next job's name. */
function job(name: string): string {
  const from = workflow.indexOf(`\n  ${name}:\n`)
  if (from < 0) throw new Error(`no job ${name}`)
  const rest = workflow.slice(from + 1)
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

describe('proposal-checks runs new-vitest-tests when a card touches a suite or src/storage', () => {
  it('the fence job reports, as its own output, whether the diff touched one of those paths', () => {
    expect(workflow).toContain('touched: ${{ steps.level.outputs.touched }}')
    expect(workflow).toContain('echo "touched=$(cat "$RUNNER_TEMP/touched.flag")" >> "$GITHUB_OUTPUT"')
  })

  it('the test is our own definition of a touched path, not a substring of the whole diff', () => {
    // A file in packages/.../tests/ or any path holding /src/storage/. Both arms matter: dropping one silently stops
    // judging storage cards again, which is the exact failure this card repairs.
    expect(workflow).toContain('path.startsWith("packages/") && path.includes("/tests/")')
    expect(workflow).toContain('path.includes("/src/storage/")')
  })

  it('the job runs at the open door when that flag is set, and is still skipped when it is not', () => {
    expect(workflow).toContain(
      "if: ${{ needs.fence.outputs.level != 'open' || needs.fence.outputs.touched == '1' }}"
    )
  })

  it('checks requires that job exactly when it ran, so a red added spec cannot pass the door', () => {
    expect(job('checks')).toContain(
      'const ran = process.env.NEW_VITEST_TESTS !== "skipped" && process.env.NEW_VITEST_TESTS !== "missing"'
    )
    expect(job('checks')).toContain(
      '? (ran ? { fence: "FENCE", "new-vitest-tests": "NEW_VITEST_TESTS" } : { fence: "FENCE" })'
    )
  })

  it("keeps main's two guards: four fence steps, and no new output in checks", () => {
    // Why the flag is computed inside the door-level step and read in `checks` from the job's own result: main's
    // frozen-paths guard deep-equals the fence job's step names, and its retention guard refuses any output there
    // except red and level. Both are checked here so a later edit cannot quietly reintroduce either.
    const steps = [...job('fence').matchAll(/\n {6}- name: (.+)\n/g)].map(match => match[1])
    expect(steps).toEqual([
      'Checkout the pushed proposal commit',
      "Frozen paths (main's list judges the proposal)",
      "Main's commit for the other jobs",
      "Main's door level"
    ])
    // The guard reads the STEP, not the whole job: the job's comment above the step names toJSON(needs) to explain why
    // it is not used, so a job-wide match fails on prose. Main's guard slices the same way.
    const step = job('checks').slice(job('checks').indexOf('- name: Every job green'))
    expect(step.startsWith('- name: Every job green')).toBe(true)
    expect(step).not.toMatch(/toJSON|outputs\.(?!red\b|level\b)/)
  })
})
