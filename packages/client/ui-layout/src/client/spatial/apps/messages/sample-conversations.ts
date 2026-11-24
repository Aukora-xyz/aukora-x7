// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE FOUR SAMPLE CONVERSATIONS THE PREDECESSOR'S X5 MESSAGES SHOWED, AND WHAT X6.1 WOULD NEED TO SHOW REAL ONES.
 *
 * Maya, Rowan, Sora and Aster (an earlier repository `LOCAL_MESSAGES`) are invented people. They are kept only as
 * sample content: every row, the list header and the open thread carry a visible SAMPLE pill, and nothing typed into
 * them leaves this page.
 *
 * ROUND 11: the surface reads this node's own `/aukora-messages/*` routes first (`messages-client.ts`). These samples
 * appear ONLY when those routes cannot be reached; a reachable node with no conversations shows an empty list.
 *
 * @module apps/messages/sample-conversations
 */

import type { MessageTier, MlsGroupState, TurnDelivery } from './messages-client.ts'

/** One turn in a conversation. `unsent` marks a turn typed here that went nowhere; `delivery` is the host's word. */
export interface MessageTurn {
  readonly from: 'them' | 'you'
  readonly text: string
  readonly at: string
  readonly unsent?: true
  readonly delivery?: TurnDelivery
}

/** One conversation row. `sample` is true for every row this file supplies. */
export interface Conversation {
  readonly id: string
  readonly name: string
  readonly preview: string
  readonly at: string
  readonly pinned: boolean
  readonly unread: boolean
  readonly archived: boolean
  readonly sample: boolean
  readonly turns: readonly MessageTurn[]
  /** Live rows only: where the conversation lives, and its Marmot MLS state when the host gave one. */
  readonly tier?: MessageTier
  readonly mls?: MlsGroupState | null
}

/** The predecessor's local conversations, unchanged in content, marked as samples. */
export const SAMPLE_CONVERSATIONS: readonly Conversation[] = [
  { id: 'maya', name: 'Maya', preview: 'The field moves only when there is live activity.', at: '09:44', pinned: true, unread: true, archived: false,
    sample: true, turns: [
      { from: 'them', text: 'The liquid field is ready when you are.', at: '09:41' },
      { from: 'you', text: 'Keep the Pentora subtle in the centre.', at: '09:43' },
      { from: 'them', text: 'It is. The field moves only when there is live activity.', at: '09:44' },
    ] },
  { id: 'rowan', name: 'Rowan', preview: 'Keep health undetermined until a route reports it.', at: '10:11', pinned: false, unread: true, archived: false,
    sample: true, turns: [
      { from: 'them', text: 'Send the coherence Pentora, not another wireframe.', at: '10:08' },
      { from: 'you', text: 'The same five-organ figure is mounted now.', at: '10:09' },
      { from: 'them', text: 'Good. Keep health undetermined until a route reports it.', at: '10:11' },
    ] },
  { id: 'sora', name: 'Sora', preview: 'The conversation stays inside its tab.', at: '11:29', pinned: false, unread: false, archived: false,
    sample: true, turns: [
      { from: 'them', text: 'I’ll review the Nostr layout at noon.', at: '11:26' },
      { from: 'you', text: 'Search and the thread controls are ready to try.', at: '11:28' },
      { from: 'them', text: 'Perfect. The conversation stays inside its tab.', at: '11:29' },
    ] },
  { id: 'aster', name: 'Aster', preview: 'Archived planning note: portal buttons stay uniform.', at: 'Tuesday', pinned: false, unread: false, archived: true,
    sample: true, turns: [
      { from: 'them', text: 'Archived planning note: portal buttons stay uniform.', at: 'Tuesday' },
      { from: 'you', text: 'Kept with the same 68px height and 14px rhythm.', at: 'Tuesday' },
    ] },
]

/** The node's same-origin message routes (Round 11 contract; see `messages-client.ts`). */
export const MESSAGES_ROUTES_NEEDED = [
  'GET /aukora-messages/contacts.json',
  'POST /aukora-messages/thread',
  'POST /aukora-messages/send',
  'POST /aukora-messages/add-contact',
] as const

/** The one sentence a sample thread's compose bar shows. */
export const NOT_SENT_NOTE = 'not sent: the node\'s message routes could not be reached'

/** What is missing when the samples are shown. */
export const MESSAGES_MISSING = 'this node\'s /aukora-messages/ routes could not be reached, so these are sample conversations'

/**
 * A clock label for a turn typed here.
 * @param now - the moment it was typed.
 * @returns `HH:MM`, local time.
 */
export function clockLabel(now: Date): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

/**
 * Filter the list the way the predecessor's toolbar does: search over name and preview, pinned-only, unread-only, and archived
 * either only or never.
 * @param conversations - every conversation.
 * @param filters - the toolbar state.
 * @returns the visible rows, in their original order.
 */
export function visibleConversations(conversations: readonly Conversation[], filters: {
  readonly query: string
  readonly pinnedOnly: boolean
  readonly unreadOnly: boolean
  readonly archivedOnly: boolean
}): Conversation[] {
  const needle = filters.query.trim().toLowerCase()
  return conversations.filter((conversation) => {
    const haystack = `${conversation.name} ${conversation.preview}`.toLowerCase()
    return haystack.includes(needle)
      && (!filters.pinnedOnly || conversation.pinned)
      && (!filters.unreadOnly || conversation.unread)
      && (filters.archivedOnly ? conversation.archived : !conversation.archived)
  })
}
