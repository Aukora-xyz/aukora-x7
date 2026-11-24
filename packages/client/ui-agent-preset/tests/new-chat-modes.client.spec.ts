/**
 * The new-chat mode picker offers one mode, Auma (`auma-alien`), and hides the four
 * stock modes from the picker only. A blank new chat is handed her mode once through the ordinary stage/apply path; a
 * started thread in any mode is never touched; a roster without her preset hides nothing.
 */
import { describe, expect, it } from 'vitest'
import { AgentPresetSeatController } from '../src/client/seat-store.ts'
import { AUMA_MODE_ID, newChatDefaultMode, newChatLabelOption, newChatModes, STOCK_MODE_IDS } from '../src/client/new-chat-modes.ts'

const STOCK = [
  { id: 'standard', isDefault: true }, { id: 'ptc', isDefault: false }, { id: 'minimal', isDefault: false }, { id: 'cordis', isDefault: false },
]
const AUMA = { id: 'auma-alien', name: 'Alien Creator', description: 'Auma in full alien presence.', isDefault: false }

type Session = { id: string; blank: boolean; projectionValues?: { agentPreset?: string } }
function bench(presets: ReadonlyArray<Record<string, unknown>>, session: () => Session | undefined, refuse = false) {
  const selects: Array<[string, string]> = []
  const ctx = {
    remote: {
      agentPresets: {
        list: async () => ({ ok: true, value: { presets } }),
        select: async (sessionId: string, id: string) => {
          selects.push([sessionId, id])
          return refuse ? { ok: false, error: { message: 'refused', details: {} } } : { ok: true, value: id }
        },
      },
    },
  }
  const seat = new AgentPresetSeatController(ctx as never, session as never)
  return { seat, selects }
}

describe('the picker policy', () => {
  it('offers her mode alone, named Auma, when the roster has it', () => {
    const options = [{ id: 'standard' }, { id: 'ptc' }, { id: 'minimal' }, { id: 'cordis' }, { id: 'auma-alien', name: 'Alien Creator', description: 'd' }]
    expect(newChatModes(options)).toEqual([{ id: 'auma-alien', name: 'Auma', description: 'd' }])
    expect(STOCK_MODE_IDS).toEqual(['standard', 'ptc', 'minimal', 'cordis'])
  })

  it('hides nothing when her preset is absent, so a new chat is never left on an invisible mode', () => {
    const options = [{ id: 'standard' }, { id: 'cordis' }]
    expect(newChatModes(options)).toEqual(options)
    expect(newChatDefaultMode(['standard', 'cordis'], 'standard')).toBe('standard')
    expect(newChatDefaultMode(['standard', 'auma-alien'], 'standard')).toBe(AUMA_MODE_ID)
  })

  it('labels her mode Auma and leaves a stock mode its own copy (an old thread keeps showing its real mode)', () => {
    expect(newChatLabelOption({ id: 'auma-alien', name: 'Alien Creator' })).toEqual({ id: 'auma-alien', name: 'Auma' })
    expect(newChatLabelOption({ id: 'standard' })).toEqual({ id: 'standard' })
    expect(newChatLabelOption(undefined)).toBeUndefined()
  })
})

describe('the new-chat chip controller', () => {
  it('a blank new chat composed under the stock default is handed Auma, once', async () => {
    const session: Session = { id: 's-new', blank: true, projectionValues: { agentPreset: 'standard' } }
    const { seat, selects } = bench([...STOCK, AUMA], () => session)
    await seat.load()
    expect(selects).toEqual([['s-new', 'auma-alien']])
    expect(seat.store.getSnapshot().current).toBe('auma-alien')
    // The list keeps all presets: nothing is disabled; only the chip renders the filtered view.
    expect(seat.store.getSnapshot().options.map(option => option.id)).toEqual(['standard', 'ptc', 'minimal', 'cordis', 'auma-alien'])
    await seat.apply()
    expect(selects).toEqual([['s-new', 'auma-alien']])
  })

  it('a started thread in any stock mode is never touched, and keeps showing its own mode', async () => {
    for (const mode of ['standard', 'ptc', 'minimal', 'cordis']) {
      const session: Session = { id: `s-${mode}`, blank: false, projectionValues: { agentPreset: mode } }
      const { seat, selects } = bench([...STOCK, AUMA], () => session)
      await seat.load()
      await seat.apply()
      expect(selects).toEqual([])
      expect(seat.store.getSnapshot().current).toBe(mode)
    }
  })

  it('a blank chat that appears after the roster loaded is handed Auma when it appears', async () => {
    const box: { session?: Session } = {}
    const { seat, selects } = bench([...STOCK, AUMA], () => box.session)
    await seat.load()
    expect(selects).toEqual([])
    expect(seat.store.getSnapshot().current).toBe('auma-alien')
    box.session = { id: 's-late', blank: true, projectionValues: { agentPreset: 'standard' } }
    await seat.apply()
    expect(selects).toEqual([['s-late', 'auma-alien']])
  })

  it('a refused hand-over is not retried in a loop, and a later explicit choice for that chat is left alone', async () => {
    const session: Session = { id: 's-refused', blank: true, projectionValues: { agentPreset: 'standard' } }
    const { seat, selects } = bench([...STOCK, AUMA], () => session, true)
    await seat.load()
    await seat.apply()
    await seat.apply()
    expect(selects).toEqual([['s-refused', 'auma-alien']])
  })

  // The exact reproduction: a blank chat already on Auma, then Settings chooses Standard.
  it('an explicit Settings choice for a blank chat already on Auma stands on every later update', async () => {
    const session: Session = { id: 's-explicit', blank: true, projectionValues: { agentPreset: 'auma-alien' } }
    const { seat, selects } = bench([...STOCK, AUMA], () => session)
    await seat.load()
    expect(selects).toEqual([])
    expect(await seat.syncBlankSession('s-explicit' as never, 'standard')).toBeUndefined()
    session.projectionValues = { agentPreset: 'standard' }
    await seat.apply()
    await seat.load()
    await seat.apply()
    expect(selects).toEqual([['s-explicit', 'standard']])
    expect(seat.store.getSnapshot().current).toBe('standard')
  })

  it('an explicit pick on the chip settles the chat too, even before the roster said anything', async () => {
    const session: Session = { id: 's-pick', blank: true, projectionValues: { agentPreset: 'standard' } }
    const { seat, selects } = bench([...STOCK, AUMA], () => session)
    seat.stage('standard')
    await seat.load()
    await seat.apply()
    expect(selects.every(([, id]) => id !== 'auma-alien')).toBe(true)
  })

  // Settings' "Create plugin" stages `cordis` BEFORE the blank session exists.
  it('an explicit choice staged before the blank session exists stands on every later update', async () => {
    const box: { session?: Session } = {}
    const { seat, selects } = bench([...STOCK, AUMA], () => box.session)
    seat.stage('cordis', true)
    await seat.load()
    box.session = { id: 's-create', blank: true, projectionValues: { agentPreset: 'standard' } }
    await seat.apply()
    expect(selects).toEqual([['s-create', 'cordis']])
    box.session.projectionValues = { agentPreset: 'cordis' }
    await seat.apply()
    await seat.load()
    await seat.apply()
    expect(selects).toEqual([['s-create', 'cordis']])
    expect(seat.store.getSnapshot().current).toBe('cordis')
  })

  it('and across controller recreation: the settled record lives on the shared stage', async () => {
    const shared = { id: undefined as string | undefined, introduce: false }
    const session: Session = { id: 's-recreated', blank: true, projectionValues: { agentPreset: 'standard' } }
    const selects: Array<[string, string]> = []
    const ctx = { remote: { agentPresets: {
      list: async () => ({ ok: true, value: { presets: [...STOCK, AUMA] } }),
      select: async (sessionId: string, id: string) => { selects.push([sessionId, id]); return { ok: true, value: id } },
    } } }
    const first = new AgentPresetSeatController(ctx as never, (() => session) as never, shared)
    first.stage('cordis')
    await first.apply()
    session.projectionValues = { agentPreset: 'cordis' }
    const second = new AgentPresetSeatController(ctx as never, (() => session) as never, shared)
    await second.load()
    await second.apply()
    expect(selects).toEqual([['s-recreated', 'cordis']])
  })

  it('without her preset in the roster nothing is staged and the host default stands', async () => {
    const session: Session = { id: 's-plain', blank: true, projectionValues: { agentPreset: 'standard' } }
    const { seat, selects } = bench(STOCK, () => session)
    await seat.load()
    expect(selects).toEqual([])
    expect(seat.store.getSnapshot().current).toBe('standard')
  })

  it('a broken auma-alien preset is not chosen as the default', async () => {
    const session: Session = { id: 's-broken', blank: true, projectionValues: { agentPreset: 'standard' } }
    const { seat, selects } = bench([...STOCK, { ...AUMA, broken: 'manifest unreadable' }], () => session)
    await seat.load()
    expect(selects).toEqual([])
  })
})
