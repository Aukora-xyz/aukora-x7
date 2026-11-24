/**
 * Paint the SuperAgent readout into caller-owned room elements.
 *
 * Mount is additive: each room gains one section and loses only that section on
 * stop. This module does not search the document, does not replace `#root`, and
 * does not open a worker. Live attachment to the Spatial rooms is unverified
 * until the room owner calls {@link mountSuperagentRooms}.
 */
import type { SuperagentPhase } from './contract.ts'
import { phrase } from './phrases.ts'
import { paintLines, showRefresh, type SuperagentRoom } from './present.ts'
import { createSuperagentRead, type SuperagentRead, type SuperagentReadOptions } from './read.ts'

/** DOM operations the readout uses. Tests can supply the same methods. */
export interface ReadoutNode {
  textContent: string
  setAttribute(name: string, value: string): void
  getAttribute(name: string): string | null
  append(...nodes: ReadoutNode[]): void
  addEventListener(type: 'click', listener: () => void): void
  replaceChildren(...nodes: ReadoutNode[]): void
  remove(): void
}

/** Document operations the readout uses. */
export interface ReadoutDocument {
  createElement(tag: string): ReadoutNode
}

/** Where the two rooms attach. At least one element is required. */
export interface MountSuperagentRoomsOptions extends SuperagentReadOptions {
  readonly world?: ReadoutNode | null
  readonly self?: ReadoutNode | null
  readonly document?: ReadoutDocument
  /** Existing reader. Omit to create one reader for every mounted room. */
  readonly read?: SuperagentRead
}

/** Mounted sections and their reader. */
export interface MountedSuperagentRooms {
  readonly read: SuperagentRead
  /** Remove the sections this mount added. Stops the reader only when this mount created it. */
  stop(): void
}

const STYLE = [
  '.auma-superagent{font:inherit;color:inherit;display:grid;gap:.75rem;margin:0;padding:.75rem 0}',
  '.auma-superagent button{font:inherit;color:inherit;background:transparent;border:1px solid currentColor;padding:.35rem .7rem}',
  '.auma-superagent p,.auma-superagent li{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}',
  '.auma-superagent ul{margin:0;padding-left:1.1rem;display:grid;gap:.35rem}',
].join('')

/**
 * Append one World section and one Self section, sharing a single reader.
 * @param options - Room elements and the existing worker transport.
 * @returns The mount.
 */
export function mountSuperagentRooms(options: MountSuperagentRoomsOptions): MountedSuperagentRooms {
  if (options.world == null && options.self == null) {
    throw new Error('superagent readout: a World or Self element is required')
  }
  const doc = options.document ?? globalDocument()
  const ownsRead = options.read === undefined
  const read = options.read ?? createSuperagentRead(options)
  const sections: ReadoutNode[] = []
  const paint = (phase: SuperagentPhase): void => {
    for (const section of sections) paintSection(doc, section, phase, read)
  }
  if (options.world != null) sections.push(attach(doc, options.world, 'world'))
  if (options.self != null) sections.push(attach(doc, options.self, 'self'))
  const unsubscribe = read.subscribe(paint)
  return {
    read,
    stop() {
      unsubscribe()
      if (ownsRead) read.stop()
      for (const section of sections) section.remove()
    },
  }
}

function attach(doc: ReadoutDocument, container: ReadoutNode, room: SuperagentRoom): ReadoutNode {
  const section = doc.createElement('section')
  section.setAttribute('class', 'auma-superagent')
  section.setAttribute('data-superagent-room', room)
  section.setAttribute('data-superagent-mount', 'unverified')
  section.setAttribute('aria-label', room === 'world' ? phrase('room.world') : phrase('room.self'))
  container.append(section)
  return section
}

function paintSection(doc: ReadoutDocument, section: ReadoutNode, phase: SuperagentPhase, read: SuperagentRead): void {
  const room: SuperagentRoom = section.getAttribute('data-superagent-room') === 'self' ? 'self' : 'world'
  section.setAttribute('data-superagent-phase', phase.kind)
  const style = doc.createElement('style')
  style.textContent = STYLE
  const list = doc.createElement('div')
  const items = doc.createElement('ul')
  for (const line of paintLines(phase, room)) {
    const node = doc.createElement(line.role === 'heading' ? 'h3' : line.role === 'item' ? 'li' : 'p')
    node.textContent = line.text
    if (line.role === 'item') items.append(node)
    else list.append(node)
  }
  list.append(items)
  const children = [style, list]
  if (showRefresh(phase)) {
    const button = doc.createElement('button')
    button.setAttribute('type', 'button')
    button.textContent = phrase('action.refresh')
    button.addEventListener('click', () => { read.refresh() })
    children.push(button)
  }
  section.replaceChildren(...children)
}

function globalDocument(): ReadoutDocument {
  const doc = (globalThis as { document?: ReadoutDocument }).document
  if (doc === undefined || typeof doc.createElement !== 'function') {
    throw new Error('superagent readout: document.createElement is unavailable')
  }
  return doc
}
