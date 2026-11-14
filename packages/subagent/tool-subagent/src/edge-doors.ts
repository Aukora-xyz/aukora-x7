/**
 * Whether the edge holds the key a child route needs. In a browser body every provider request leaves through a
 * same-origin door (`/door/<name>/...`) where the edge adds its own key; the edge reports which doors have one as
 * booleans in its health answer (`GET /api/health` → `capabilities.providerDoors`). A deployment maps each LLM provider
 * route to its door, so discovery can say a route is switched on but cannot answer, instead of offering it as usable.
 * Read on every listing (a key set a minute ago counts); a failed or silent answer claims nothing either way.
 */

/** One LLM provider route and the edge door its requests leave by. */
export interface EdgeDoorRoute {
  /** Registered LLM provider id, e.g. `openrouter-door`. */
  readonly provider: string
  /** Edge door name, e.g. `openrouter` for `/door/openrouter/...`. */
  readonly door: string
}

/** A deployment's door table and where its edge reports keys. */
export interface EdgeDoors {
  /** Same-origin path of the edge health answer. */
  readonly healthPath: string
  /** Provider routes that leave through a door. */
  readonly routes: readonly EdgeDoorRoute[]
}

/** What the edge said, or why it said nothing. */
export type EdgeDoorKeys =
  | { readonly kind: 'read'; readonly keys: ReadonlyMap<string, boolean> }
  | { readonly kind: 'unknown'; readonly reason: string }

/** The door states one listing reports. */
export type DoorState =
  | { readonly kind: 'no-key'; readonly door: string }
  | { readonly kind: 'unknown'; readonly reason: string }
  | undefined

const DOOR_NAME = /^[a-z0-9-]{1,64}$/
const HEALTH_DEADLINE_MS = 5_000

/**
 * Reject a door table the edge could never answer for.
 * @param doors - candidate table from a deployment row.
 */
export function assertEdgeDoors(doors: EdgeDoors | undefined): void {
  if (doors === undefined) return
  if (typeof doors.healthPath !== 'string' || !doors.healthPath.startsWith('/') || doors.healthPath.startsWith('//')) {
    throw new Error(`edge door health path "${doors.healthPath}" must be a same-origin path`)
  }
  const seen = new Set<string>()
  for (const route of doors.routes) {
    if (!DOOR_NAME.test(route.door)) {
      throw new Error(`edge door "${route.door}" for provider "${route.provider}" must be a lowercase door name`)
    }
    if (seen.has(route.provider)) throw new Error(`edge door table names provider "${route.provider}" twice`)
    seen.add(route.provider)
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Read which doors hold a key at this body's edge.
 * @param healthPath - same-origin path of the edge health answer.
 * @param signal - the calling tool's cancellation.
 * @returns the door booleans, or why there are none.
 */
export async function readEdgeDoorKeys(healthPath: string, signal: AbortSignal): Promise<EdgeDoorKeys> {
  const origin = (globalThis as { location?: { origin?: unknown } }).location?.origin
  if (typeof origin !== 'string' || !/^https?:\/\//.test(origin)) return { kind: 'unknown', reason: 'this body has no edge origin' }
  const deadline = new AbortController()
  const timer = setTimeout(() => { deadline.abort(new Error('the edge health answer took longer than 5 s')) }, HEALTH_DEADLINE_MS)
  const cancel = (): void => { deadline.abort(signal.reason) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const response = await fetch(new URL(healthPath, origin).href, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: deadline.signal,
    })
    if (!response.ok) return { kind: 'unknown', reason: `the edge health answer was HTTP ${String(response.status)}` }
    const doors = record(record(record(await response.json() as unknown)?.capabilities)?.providerDoors)
    if (doors === undefined) return { kind: 'unknown', reason: 'the edge health answer names no provider doors' }
    const keys = new Map<string, boolean>()
    for (const [door, held] of Object.entries(doors)) if (typeof held === 'boolean') keys.set(door, held)
    return { kind: 'read', keys }
  } catch (error) {
    signal.throwIfAborted()
    return { kind: 'unknown', reason: `the edge health read failed: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
  }
}

/**
 * The state of one provider's door in one edge answer.
 * @param doors - the deployment's door table.
 * @param keys - the edge's answer for this listing.
 * @param provider - LLM provider id.
 * @returns `no-key`, `unknown`, or undefined when the door holds a key or the provider has no door.
 */
export function doorState(doors: EdgeDoors, keys: EdgeDoorKeys, provider: string): DoorState {
  const route = doors.routes.find(candidate => candidate.provider === provider)
  if (route === undefined) return undefined
  if (keys.kind === 'unknown') return keys
  const held = keys.keys.get(route.door)
  if (held === undefined) return { kind: 'unknown', reason: `the edge does not report the ${route.door} door` }
  return held ? undefined : { kind: 'no-key', door: route.door }
}

/**
 * The sentence a listing row carries for a door with no key.
 * @param providerName - the provider's registered display name.
 * @returns the row suffix.
 */
export function noKeySuffix(providerName: string): string {
  return ` - unavailable: ${providerName} is switched on but has no key at the edge`
}
