/** Her Linear door. The whole workspace through the edge; the key never leaves it.
 *
 *   POST /_host/linear  { action, ...fields }   one closed action, owner session, same-origin, JSON body at most 64 KiB
 *
 *
 * The one Linear key is env.LINEAR_API_KEY (crew-relay.mjs uses the same one) and stays here: it is read at
 * call time inside this module only, sent to api.linear.app and nowhere else, and never returned, logged or placed in an
 * error. Not configured answers LINEAR_NOT_CONFIGURED naming the missing NAME.
 *
 * Closed by construction: there is no raw action. The door builds every query and mutation itself from LINEAR_ACTIONS,
 * and each action takes exactly its own fields, so this table is the whole truth of what she can do. Three kinds of
 * action:
 *   open      reads, and the writes that are hers (comments, issues, documents, status updates, labels). At level
 *             `guarded` every write asks for the owner's fingerprint too.
 *   core      archiving or deleting an issue, a document, a project or a team; a project's or a team's settings or
 *             members; an issue moved to another team. These ask at BOTH levels, through the Class 3 card: the edge
 *             answers CLASS3_WEBAUTHN_REQUIRED and sends a write only with a one-time approval of exactly its bytes, then
 *             once. The owner's card (outward-class3.ts) shows a held core write; her tool stages it for him.
 *   refused   workspace or organisation settings, members, invitations and roles, API keys, OAuth applications,
 *             webhooks, integrations, billing, and any raw GraphQL text (LINEAR_REFUSED_FAMILIES): not offered at all.
 *
 * Bounds: 240 writes and 2,400 reads per hour per owner session (LINEAR_RATE, with the seconds to wait); every answer at
 * most 256 KiB and passed whole through the secret screen. Every write takes a `requestId`; a repeat within 10 minutes
 * returns the first answer and writes nothing twice. The GitHub door keeps no such record (cloud-brokers.mjs
 * githubMutation: "GitHub issues/comments have no atomic idempotency key"), so this one lives in this module, in the
 * isolate's memory, like crew-relay.mjs's post slot. Calling Linear follows crew-relay.mjs callLinear: one deadline over
 * the request and its whole body, no redirect followed, the body read to a byte bound, Linear's text never passed on.
 * docs/auma/linear-door.md is her page for it.
 */
import { canonicalJson } from './owner-grant-policy.mjs'
import { isReaderWindow, readerWindowRefusalResponse } from './reader-window.mjs'

export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql'
export const LINEAR_DOOR_ROUTE = '/_host/linear'
/** The one NAME the edge reads. Its value is never read anywhere else, and never leaves. */
export const LINEAR_KEY_NAME = 'LINEAR_API_KEY'

export const LINEAR_DOOR_LIMITS = Object.freeze({
  requestBytes: 64 * 1024,
  answerBytes: 256 * 1024,
  /** Linear's raw answer to one call, read with room for the answer's own fields; a larger one is not read to its end. */
  upstreamBytes: 1024 * 1024,
  timeoutMs: 20000,
  page: 50,
  readsPerHour: 2400,
  writesPerHour: 240,
  windowMs: 60 * 60 * 1000,
  repeatMs: 10 * 60 * 1000,
  /** Remembered writes (requestId) and owner sessions held in this isolate's memory, oldest dropped first. */
  repeatEntries: 1024,
  sessions: 64,
})

/** The level in force: `open` only when env.LINEAR_DOOR_LEVEL is exactly "open"; anything else is `guarded`. */
export const LINEAR_DOOR_LEVELS = Object.freeze(['open', 'guarded'])
export function linearDoorLevel(env) {
  return env?.LINEAR_DOOR_LEVEL === 'open' ? 'open' : 'guarded'
}

/** What is not offered, by family. An action name matching one is refused with LINEAR_REFUSED and its family; so is a
 * field that would carry GraphQL text. Judged AFTER the offered actions, so `users` (a read) is offered. */
export const LINEAR_REFUSED_FAMILIES = Object.freeze([
  Object.freeze({ family: 'raw-graphql', pattern: /^(?:graphql|gql|raw|query|mutation|mutate|execute)(?:_|$)/ }),
  Object.freeze({ family: 'workspace-settings', pattern: /(?:^|_)(?:organi[sz]ation|workspace|org)(?:_|$)/ }),
  Object.freeze({ family: 'members', pattern: /(?:^|_)(?:users?|members?|invites?|invitations?|roles?|admins?|guests?)(?:_|$)/ }),
  Object.freeze({ family: 'api-keys', pattern: /api_?keys?|(?:^|_)keys?(?:_|$)|(?:^|_)secrets?(?:_|$)/ }),
  Object.freeze({ family: 'oauth', pattern: /oauth|(?:^|_)(?:applications?|apps?|clients?)(?:_|$)/ }),
  Object.freeze({ family: 'webhooks', pattern: /webhooks?/ }),
  Object.freeze({ family: 'integrations', pattern: /integrations?/ }),
  Object.freeze({ family: 'billing', pattern: /billing|subscriptions?|payments?|invoices?|(?:^|_)plans?(?:_|$)/ }),
].map(Object.freeze))
const RAW_FIELDS = new Set(['query', 'mutation', 'graphql', 'gql', 'variables', 'operationName', 'document_text'])

/** One sentence per refusal that needs one. */
export const LINEAR_NEXT = Object.freeze({
  refused: 'this door does not offer it: workspace settings, members, invitations, roles, API keys, OAuth applications, webhooks, integrations, billing and raw GraphQL stay with the owner in Linear itself',
  held: 'nothing was sent: this write goes out only with the owner\'s fingerprint on these exact bytes, and then once',
  rate: 'wait the seconds named, then go on; the door counts 240 writes and 2,400 reads per hour per session',
  tooLarge: 'ask for less: a smaller `first`, or one item by its id',
  withheld: 'the answer carried something shaped like a key or secret, so none of it is shown',
  outcome: 'the write left and its answer was lost: read Linear before trying again with a NEW requestId',
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDENTIFIER = /^[A-Z][A-Z0-9_]{0,9}-[1-9][0-9]{0,8}$/
const TEAM_KEY = /^[A-Z][A-Z0-9_]{0,9}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const CURSOR = /^[A-Za-z0-9+/=_:.-]{1,512}$/
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const ISO_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/
const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const encoder = new TextEncoder()
const bytesOf = text => encoder.encode(text).byteLength

// Field rules: each takes the value and answers whether it is acceptable.
const isId = value => typeof value === 'string' && ID.test(value)
const isNullableId = value => value === null || isId(value)
const isIds = value => Array.isArray(value) && value.length <= 25 && value.every(isId) && new Set(value).size === value.length
const isLine = max => value => typeof value === 'string' && value.trim() !== '' && value.length <= max && !/[\r\n\u0000]/.test(value)
const isText = max => value => typeof value === 'string' && value.trim() !== '' && value.length <= max && !value.includes('\u0000')
const isOptionalText = max => value => typeof value === 'string' && value.length <= max && !value.includes('\u0000')
const isPriority = value => Number.isSafeInteger(value) && value >= 0 && value <= 4
const isDate = value => typeof value === 'string' && DATE.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
const isNullableDate = value => value === null || isDate(value)
const isFirst = value => Number.isSafeInteger(value) && value >= 1 && value <= LINEAR_DOOR_LIMITS.page
const isCursor = value => typeof value === 'string' && CURSOR.test(value)
const isTeam = value => typeof value === 'string' && (TEAM_KEY.test(value) || UUID.test(value))
const isAssignee = value => value === 'me' || isId(value)
const isInstant = value => typeof value === 'string' && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value))
const isHealth = value => ['onTrack', 'atRisk', 'offTrack'].includes(value)
const isColor = value => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
const isBoolean = value => typeof value === 'boolean'
const isRequestId = value => typeof value === 'string' && REQUEST_ID.test(value)

const TEXT_MAX = 60 * 1024
const PAGE_FIELDS = { first: isFirst, after: isCursor }
const PAGE_INFO = 'pageInfo { hasNextPage endCursor }'
const ISSUE_LIST_FIELDS = 'id identifier title priority url dueDate createdAt updatedAt state { id name type } team { id key } assignee { id name } project { id name } parent { id identifier }'
const ISSUE_FIELDS = `id identifier title description priority url dueDate createdAt updatedAt state { id name type } team { id key name } assignee { id name } project { id name } parent { id identifier } labels { nodes { id name } }`
const COMMENT_FIELDS = 'id body createdAt updatedAt url user { id name } parent { id }'
const page = input => ({ first: input.first ?? LINEAR_DOOR_LIMITS.page, after: input.after ?? null })
const teamFilter = team => (UUID.test(team) ? { team: { id: { eq: team } } } : { team: { key: { eq: team } } })
const listOf = root => data => ({ result: data?.[root]?.nodes, page: data?.[root]?.pageInfo })

/** Each offered action: its kind (read, open write, or core write), its exact fields, the ones it needs, the GraphQL it
 * sends (built here, never from her text), and what of Linear's answer comes back. `core(input)` names why a write asks
 * for the fingerprint at every level, or null. `resolveIssue` names a field holding an issue id or identifier that is
 * turned into Linear's id by one read first (crew-relay.mjs resolves its issue the same way before it writes). */
export const LINEAR_ACTIONS = Object.freeze({
  status: { kind: 'read', fields: {}, required: [],
    query: 'query LinearDoorStatus { viewer { id name displayName } organization { name urlKey } }',
    variables: () => ({}),
    pick: data => ({ result: { workspace: data?.organization?.name ?? null, urlKey: data?.organization?.urlKey ?? null,
      viewer: data?.viewer?.displayName || data?.viewer?.name || null, viewerId: data?.viewer?.id ?? null } }) },
  teams: { kind: 'read', fields: { ...PAGE_FIELDS }, required: [],
    query: `query LinearDoorTeams($first: Int!, $after: String) { teams(first: $first, after: $after) { nodes { id key name description private } ${PAGE_INFO} } }`,
    variables: input => page(input), pick: listOf('teams') },
  projects: { kind: 'read', fields: { ...PAGE_FIELDS }, required: [],
    query: `query LinearDoorProjects($first: Int!, $after: String) { projects(first: $first, after: $after) { nodes { id name description state url progress startDate targetDate lead { id name } teams { nodes { id key } } } ${PAGE_INFO} } }`,
    variables: input => page(input), pick: listOf('projects') },
  issue: { kind: 'read', fields: { id: isId }, required: ['id'],
    query: `query LinearDoorIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
    variables: input => ({ id: input.id }), pick: data => ({ result: data?.issue, single: 'issue' }) },
  issues: { kind: 'read', fields: { team: isTeam, project: isId, state: isLine(64), assignee: isAssignee, updatedSince: isInstant, ...PAGE_FIELDS }, required: [],
    query: `query LinearDoorIssues($filter: IssueFilter, $first: Int!, $after: String) { issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) { nodes { ${ISSUE_LIST_FIELDS} } ${PAGE_INFO} } }`,
    variables: input => {
      const filter = {
        ...(input.team !== undefined ? teamFilter(input.team) : {}),
        ...(input.project !== undefined ? { project: { id: { eq: input.project } } } : {}),
        ...(input.state !== undefined ? { state: { name: { eq: input.state } } } : {}),
        ...(input.assignee !== undefined ? { assignee: input.assignee === 'me' ? { isMe: { eq: true } } : { id: { eq: input.assignee } } } : {}),
        ...(input.updatedSince !== undefined ? { updatedAt: { gte: input.updatedSince } } : {}),
      }
      return { filter: Object.keys(filter).length ? filter : null, ...page(input) }
    },
    pick: listOf('issues') },
  search: { kind: 'read', fields: { text: isLine(256), ...PAGE_FIELDS }, required: ['text'],
    query: `query LinearDoorSearch($filter: IssueFilter, $first: Int!, $after: String) { issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) { nodes { ${ISSUE_LIST_FIELDS} } ${PAGE_INFO} } }`,
    variables: input => ({ filter: { or: [{ title: { containsIgnoreCase: input.text } }, { description: { containsIgnoreCase: input.text } }] }, ...page(input) }),
    pick: listOf('issues') },
  comments: { kind: 'read', fields: { issue: isId, project: isId, document: isId, ...PAGE_FIELDS }, required: [], oneOf: ['issue', 'project', 'document'],
    query: input => {
      const [root, label] = input.issue !== undefined ? ['issue', 'identifier'] : input.project !== undefined ? ['project', 'name'] : ['document', 'title']
      return `query LinearDoorComments($id: String!, $first: Int!, $after: String) { ${root}(id: $id) { id ${label} comments(first: $first, after: $after) { nodes { ${COMMENT_FIELDS} } ${PAGE_INFO} } } }`
    },
    variables: input => ({ id: input.issue ?? input.project ?? input.document, ...page(input) }),
    pick: (data, input) => {
      const root = input.issue !== undefined ? 'issue' : input.project !== undefined ? 'project' : 'document'
      return { result: data?.[root]?.comments?.nodes, page: data?.[root]?.comments?.pageInfo, single: data?.[root] === null ? root : undefined }
    } },
  documents: { kind: 'read', fields: { project: isId, ...PAGE_FIELDS }, required: [],
    query: `query LinearDoorDocuments($filter: DocumentFilter, $first: Int!, $after: String) { documents(filter: $filter, first: $first, after: $after) { nodes { id title url updatedAt project { id name } } ${PAGE_INFO} } }`,
    variables: input => ({ filter: input.project !== undefined ? { project: { id: { eq: input.project } } } : null, ...page(input) }),
    pick: listOf('documents') },
  document: { kind: 'read', fields: { id: isId }, required: ['id'],
    query: 'query LinearDoorDocument($id: String!) { document(id: $id) { id title content url createdAt updatedAt project { id name } creator { id name } } }',
    variables: input => ({ id: input.id }), pick: data => ({ result: data?.document, single: 'document' }) },
  labels: { kind: 'read', fields: { team: isTeam, ...PAGE_FIELDS }, required: [],
    query: `query LinearDoorLabels($filter: IssueLabelFilter, $first: Int!, $after: String) { issueLabels(filter: $filter, first: $first, after: $after) { nodes { id name color description team { id key } } ${PAGE_INFO} } }`,
    variables: input => ({ filter: input.team !== undefined ? teamFilter(input.team) : null, ...page(input) }),
    pick: listOf('issueLabels') },
  states: { kind: 'read', fields: { team: isTeam, ...PAGE_FIELDS }, required: [],
    query: `query LinearDoorStates($filter: WorkflowStateFilter, $first: Int!, $after: String) { workflowStates(filter: $filter, first: $first, after: $after) { nodes { id name type position team { id key } } ${PAGE_INFO} } }`,
    variables: input => ({ filter: input.team !== undefined ? teamFilter(input.team) : null, ...page(input) }),
    pick: listOf('workflowStates') },
  users: { kind: 'read', fields: { ...PAGE_FIELDS }, required: [],
    query: `query LinearDoorUsers($first: Int!, $after: String) { users(first: $first, after: $after) { nodes { id name displayName active } ${PAGE_INFO} } }`,
    variables: input => page(input), pick: listOf('users') },

  // Open writes: hers at level `open`; at `guarded` each asks too.
  comment: { kind: 'write', fields: { issue: isId, parent: isId, body: isText(TEXT_MAX) }, required: ['issue', 'body'], resolveIssue: 'issue',
    root: 'commentCreate',
    query: 'mutation LinearDoorComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url createdAt } } }',
    variables: (input, issueId) => ({ input: { issueId, body: input.body, ...(input.parent !== undefined ? { parentId: input.parent } : {}) } }) },
  comment_update: { kind: 'write', fields: { id: isId, body: isText(TEXT_MAX) }, required: ['id', 'body'], ownComment: 'id',
    root: 'commentUpdate',
    query: 'mutation LinearDoorCommentUpdate($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success comment { id url updatedAt } } }',
    variables: input => ({ id: input.id, input: { body: input.body } }) },
  issue_create: { kind: 'write', required: ['teamId', 'title'],
    fields: { teamId: isId, title: isLine(512), description: isOptionalText(TEXT_MAX), stateId: isId, priority: isPriority, assigneeId: isId,
      labelIds: isIds, projectId: isId, parentId: isId, dueDate: isDate },
    root: 'issueCreate',
    query: 'mutation LinearDoorIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url } } }',
    variables: input => ({ input: copy(input, ['teamId', 'title', 'description', 'stateId', 'priority', 'assigneeId', 'labelIds', 'projectId', 'parentId', 'dueDate']) }) },
  issue_update: { kind: 'write', required: ['id'], atLeastOne: ['title', 'description', 'stateId', 'priority', 'assigneeId', 'labelIds', 'projectId', 'parentId', 'dueDate', 'teamId'],
    fields: { id: isId, title: isLine(512), description: isOptionalText(TEXT_MAX), stateId: isId, priority: isPriority, assigneeId: isNullableId,
      labelIds: isIds, projectId: isNullableId, parentId: isNullableId, dueDate: isNullableDate, teamId: isId },
    resolveIssue: 'id', root: 'issueUpdate',
    // Moving an issue to another team is the dangerous core: it changes who sees it and which workflow it lives in.
    core: input => (input.teamId !== undefined ? 'team-move' : null),
    query: 'mutation LinearDoorIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier title url } } }',
    variables: (input, issueId) => ({ id: issueId, input: copy(input, ['title', 'description', 'stateId', 'priority', 'assigneeId', 'labelIds', 'projectId', 'parentId', 'dueDate', 'teamId']) }) },
  document_create: { kind: 'write', required: ['title'], fields: { title: isLine(512), content: isOptionalText(TEXT_MAX), projectId: isId },
    root: 'documentCreate',
    query: 'mutation LinearDoorDocumentCreate($input: DocumentCreateInput!) { documentCreate(input: $input) { success document { id title url } } }',
    variables: input => ({ input: copy(input, ['title', 'content', 'projectId']) }) },
  document_update: { kind: 'write', required: ['id'], atLeastOne: ['title', 'content'], fields: { id: isId, title: isLine(512), content: isOptionalText(TEXT_MAX) },
    root: 'documentUpdate',
    query: 'mutation LinearDoorDocumentUpdate($id: String!, $input: DocumentUpdateInput!) { documentUpdate(id: $id, input: $input) { success document { id title url updatedAt } } }',
    variables: input => ({ id: input.id, input: copy(input, ['title', 'content']) }) },
  project_update_post: { kind: 'write', required: ['projectId', 'body'], fields: { projectId: isId, body: isText(TEXT_MAX), health: isHealth },
    root: 'projectUpdateCreate',
    query: 'mutation LinearDoorProjectUpdate($input: ProjectUpdateCreateInput!) { projectUpdateCreate(input: $input) { success projectUpdate { id url createdAt } } }',
    variables: input => ({ input: copy(input, ['projectId', 'body', 'health']) }) },
  label_create: { kind: 'write', required: ['name'], fields: { name: isLine(128), color: isColor, description: isOptionalText(1024), teamId: isId },
    root: 'issueLabelCreate',
    query: 'mutation LinearDoorLabelCreate($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name color } } }',
    variables: input => ({ input: copy(input, ['name', 'color', 'description', 'teamId']) }) },

  // The dangerous core: asks for the owner's fingerprint at every level.
  issue_archive: { kind: 'write', required: ['id'], fields: { id: isId }, resolveIssue: 'id', root: 'issueArchive', core: () => 'archive',
    query: 'mutation LinearDoorIssueArchive($id: String!) { issueArchive(id: $id) { success } }', variables: (input, issueId) => ({ id: issueId }) },
  issue_delete: { kind: 'write', required: ['id'], fields: { id: isId }, resolveIssue: 'id', root: 'issueDelete', core: () => 'delete',
    query: 'mutation LinearDoorIssueDelete($id: String!) { issueDelete(id: $id) { success } }', variables: (input, issueId) => ({ id: issueId }) },
  document_delete: { kind: 'write', required: ['id'], fields: { id: isId }, root: 'documentDelete', core: () => 'delete',
    query: 'mutation LinearDoorDocumentDelete($id: String!) { documentDelete(id: $id) { success } }', variables: input => ({ id: input.id }) },
  project_archive: { kind: 'write', required: ['id'], fields: { id: isId }, root: 'projectArchive', core: () => 'archive',
    query: 'mutation LinearDoorProjectArchive($id: String!) { projectArchive(id: $id) { success } }', variables: input => ({ id: input.id }) },
  project_delete: { kind: 'write', required: ['id'], fields: { id: isId }, root: 'projectDelete', core: () => 'delete',
    query: 'mutation LinearDoorProjectDelete($id: String!) { projectDelete(id: $id) { success } }', variables: input => ({ id: input.id }) },
  team_delete: { kind: 'write', required: ['id'], fields: { id: isId }, root: 'teamDelete', core: () => 'delete',
    query: 'mutation LinearDoorTeamDelete($id: String!) { teamDelete(id: $id) { success } }', variables: input => ({ id: input.id }) },
  project_settings: { kind: 'write', required: ['id'], atLeastOne: ['name', 'description', 'leadId', 'memberIds', 'teamIds', 'startDate', 'targetDate', 'statusId'],
    fields: { id: isId, name: isLine(256), description: isOptionalText(TEXT_MAX), leadId: isNullableId, memberIds: isIds, teamIds: isIds,
      startDate: isNullableDate, targetDate: isNullableDate, statusId: isId },
    root: 'projectUpdate', core: () => 'project-settings',
    query: 'mutation LinearDoorProjectSettings($id: String!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { success project { id name url } } }',
    variables: input => ({ id: input.id, input: copy(input, ['name', 'description', 'leadId', 'memberIds', 'teamIds', 'startDate', 'targetDate', 'statusId']) }) },
  team_settings: { kind: 'write', required: ['id'], atLeastOne: ['name', 'description', 'key', 'private'],
    fields: { id: isId, name: isLine(256), description: isOptionalText(4096), key: value => typeof value === 'string' && TEAM_KEY.test(value), private: isBoolean },
    root: 'teamUpdate', core: () => 'team-settings',
    query: 'mutation LinearDoorTeamSettings($id: String!, $input: TeamUpdateInput!) { teamUpdate(id: $id, input: $input) { success team { id key name } } }',
    variables: input => ({ id: input.id, input: copy(input, ['name', 'description', 'key', 'private']) }) },
  team_member_add: { kind: 'write', required: ['teamId', 'userId'], fields: { teamId: isId, userId: isId }, root: 'teamMembershipCreate', core: () => 'team-membership',
    query: 'mutation LinearDoorTeamMemberAdd($input: TeamMembershipCreateInput!) { teamMembershipCreate(input: $input) { success teamMembership { id } } }',
    variables: input => ({ input: { teamId: input.teamId, userId: input.userId } }) },
  team_member_remove: { kind: 'write', required: ['id'], fields: { id: isId }, root: 'teamMembershipDelete', core: () => 'team-membership',
    query: 'mutation LinearDoorTeamMemberRemove($id: String!) { teamMembershipDelete(id: $id) { success } }', variables: input => ({ id: input.id }) },
})
for (const value of Object.values(LINEAR_ACTIONS)) Object.freeze(value)

/** The action names by kind, for her tool, her page and reviewers. */
export const LINEAR_READS = Object.freeze(Object.keys(LINEAR_ACTIONS).filter(name => LINEAR_ACTIONS[name].kind === 'read'))
export const LINEAR_CORE = Object.freeze(Object.keys(LINEAR_ACTIONS).filter(name => LINEAR_ACTIONS[name].kind === 'write'
  && name !== 'issue_update' && typeof LINEAR_ACTIONS[name].core === 'function'))
export const LINEAR_OPEN_WRITES = Object.freeze(Object.keys(LINEAR_ACTIONS).filter(name => LINEAR_ACTIONS[name].kind === 'write' && !LINEAR_CORE.includes(name)))

const ISSUE_ID_QUERY = 'query LinearDoorIssueId($id: String!) { issue(id: $id) { id } }'
const COMMENT_OWNER_QUERY = 'query LinearDoorCommentOwner($id: String!) { viewer { id } comment(id: $id) { id user { id } } }'

function copy(input, keys) {
  const out = {}
  for (const key of keys) if (input[key] !== undefined) out[key] = input[key]
  return out
}

const reply = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
})

// Only an error this module made leaves as its own code, status and fixed extra words; anything else is LINEAR_DOOR_FAILED.
const DOOR_ERRORS = new WeakSet()
const EXTRA_KEYS = ['field', 'family', 'reason', 'level', 'missing', 'retryAfterSeconds', 'limit', 'next', 'outcome', 'requestId']
function coded(code, status, extra = {}) {
  const error = new Error(code)
  error.code = code
  error.status = status
  error.extra = extra
  DOOR_ERRORS.add(error)
  return error
}
const refusal = error => ({ ok: false, code: error.code, ...Object.fromEntries(Object.entries(error.extra ?? {}).filter(([key]) => EXTRA_KEYS.includes(key))) })

/**
 * The secret screen. The same shapes as the brokers' screen (cloud-brokers.mjs safeText, which is not exported), plus
 * Linear's own key formats: a private key block, a provider key, a GitHub or Cloudflare credential, a JSON field named
 * like a secret; and the exact value of every configured secret in env (any NAME ending in TOKEN, SECRET, PASSWORD or
 * API_KEY, or naming a private or signing key or a credential), LINEAR_API_KEY among them.
 * @param {string} text An answer as it would leave, or her text before it goes out.
 * @param {object} env Worker bindings; only compared against, never copied.
 * @returns {boolean} True when the text is clean.
 */
export function linearScreenClean(text, env) {
  if (typeof text !== 'string' || text.includes('\u0000')) return false
  if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:cfk|cfut|cfat)_[A-Za-z0-9_-]{16,}|lin_(?:api|oauth|wh)_[A-Za-z0-9]{16,})\b|["'](?:seedHex|privateKey(?:Hex|Pkcs8|Jwk)?|secretKey(?:Hex)?|access_token|refresh_token|client_secret)["']\s*:/i.test(text)) return false
  for (const [name, value] of Object.entries(env ?? {})) {
    if (/(?:TOKEN|SECRET|PASSWORD|API_KEY)$|(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|SIGNING_KEY|CREDENTIAL)(?:_|$)/.test(name)
      && typeof value === 'string' && value !== '' && text.includes(value)) return false // every length, as safeText screens it
  }
  return true
}

/** Lets a stream go without waiting for it (crew-relay.mjs letGo). */
function letGo(cancel) {
  try {
    const done = cancel()
    if (done && typeof done.catch === 'function') done.catch(() => {})
  } catch { /* already gone */ }
}

/**
 * One call to Linear under one deadline covering the request and its whole body (crew-relay.mjs callLinear). The key is
 * read by the caller from env at call time and goes in the authorization header to api.linear.app only; a redirect is
 * refused, never followed. Every failure is a closed code: Linear's own words never leave.
 */
async function callLinear(send, timeoutMs, key, query, variables) {
  const deadline = AbortSignal.timeout(timeoutMs)
  let expire
  const late = new Promise((_, reject) => {
    expire = () => reject(coded('LINEAR_UPSTREAM_UNAVAILABLE', 502))
    if (deadline.aborted) expire()
    else deadline.addEventListener('abort', expire, { once: true })
  })
  late.catch(() => {})
  const startedAt = Date.now()
  const expired = () => deadline.aborted || Date.now() - startedAt > timeoutMs
  let response = null
  let reader = null
  let sent = null
  try {
    try {
      sent = send(LINEAR_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: key },
        body: JSON.stringify({ query, variables }),
        redirect: 'manual',
        signal: deadline,
      })
      response = await Promise.race([sent, late])
    } catch {
      if (sent && typeof sent.then === 'function') sent.then(lost => { if (lost?.body) letGo(() => lost.body.cancel()) }, () => {})
      throw coded('LINEAR_UPSTREAM_UNAVAILABLE', 502)
    }
    if (expired()) throw coded('LINEAR_UPSTREAM_UNAVAILABLE', 502)
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) throw coded('LINEAR_UPSTREAM_REFUSED', 502)
    if (response.status === 429) throw coded('LINEAR_UPSTREAM_RATE_LIMITED', 429)
    if (response.status === 401 || response.status === 403) throw coded('LINEAR_UPSTREAM_REFUSED', 502)
    reader = response.body?.getReader?.() ?? null
    const chunks = []
    let total = 0
    let reads = 0
    while (reader) {
      reads += 1
      if (expired() || reads > 65536) throw coded('LINEAR_UPSTREAM_UNAVAILABLE', 502)
      let step
      try {
        step = await Promise.race([reader.read(), late])
      } catch (error) {
        throw DOOR_ERRORS.has(error) ? error : coded('LINEAR_UPSTREAM_UNAVAILABLE', 502)
      }
      if (expired()) throw coded('LINEAR_UPSTREAM_UNAVAILABLE', 502)
      if (step.done) break
      total += step.value.byteLength
      if (total > LINEAR_DOOR_LIMITS.upstreamBytes) throw coded('LINEAR_UPSTREAM_TOO_LARGE', 502)
      chunks.push(step.value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    let payload
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      throw coded('LINEAR_UPSTREAM_MALFORMED', 502)
    }
    if (!record(payload)) throw coded('LINEAR_UPSTREAM_MALFORMED', 502)
    const errors = Array.isArray(payload.errors) ? payload.errors : []
    if (errors.some(item => item?.extensions?.code === 'RATELIMITED')) throw coded('LINEAR_UPSTREAM_RATE_LIMITED', 429)
    // An id Linear does not know (another workspace's, or none) is "not found": read from its answer, never repeated.
    if (errors.length && errors.every(item => typeof item?.message === 'string' && /\bnot found\b/i.test(item.message))) throw coded('LINEAR_NOT_FOUND', 404)
    if (!response.ok || errors.length) throw coded('LINEAR_UPSTREAM_ERROR', 502)
    if (!record(payload.data)) throw coded('LINEAR_UPSTREAM_MALFORMED', 502)
    return payload.data
  } finally {
    deadline.removeEventListener('abort', expire)
    if (reader) {
      letGo(() => reader.cancel())
      try { reader.releaseLock() } catch { /* a pending read holds it; the cancel ends it */ }
    } else if (response?.body) letGo(() => response.body.cancel())
  }
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Her request, read to its byte bound (the worker has already bounded it once). */
async function readInput(request) {
  const type = request.headers.get('content-type') ?? ''
  if (!/^application\/json(?:\s*;|$)/i.test(type)) throw coded('LINEAR_JSON_REQUIRED', 415)
  if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') throw coded('LINEAR_BODY_MALFORMED', 400)
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > LINEAR_DOOR_LIMITS.requestBytes)) throw coded('LINEAR_BODY_TOO_LARGE', 413)
  const reader = request.body?.getReader?.()
  if (!reader) throw coded('LINEAR_BODY_MALFORMED', 400)
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > LINEAR_DOOR_LIMITS.requestBytes) { letGo(() => reader.cancel()); throw coded('LINEAR_BODY_TOO_LARGE', 413) }
      chunks.push(value)
    }
  } finally { try { reader.releaseLock() } catch { /* cancelled */ } }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  let input
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw coded('LINEAR_BODY_MALFORMED', 400) }
  if (!record(input) || Object.getPrototypeOf(input) !== Object.prototype) throw coded('LINEAR_BODY_MALFORMED', 400)
  return input
}

/** The action and its exact fields, or a refusal. Nothing she wrote is used before this passes. */
function judge(input) {
  const name = input.action
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw coded('LINEAR_ACTION_UNKNOWN', 400)
  for (const key of Object.keys(input)) if (RAW_FIELDS.has(key)) throw coded('LINEAR_REFUSED', 403, { family: 'raw-graphql', next: LINEAR_NEXT.refused })
  const spec = Object.hasOwn(LINEAR_ACTIONS, name) ? LINEAR_ACTIONS[name] : null
  if (spec === null) {
    const refused = LINEAR_REFUSED_FAMILIES.find(row => row.pattern.test(name))
    if (refused) throw coded('LINEAR_REFUSED', 403, { family: refused.family, next: LINEAR_NEXT.refused })
    throw coded('LINEAR_ACTION_UNKNOWN', 400)
  }
  const write = spec.kind === 'write'
  for (const key of Object.keys(input)) {
    if (key === 'action' || (write && key === 'requestId')) continue
    if (!Object.hasOwn(spec.fields, key)) throw coded('LINEAR_FIELD_UNKNOWN', 400, { field: key.slice(0, 64) })
    if (!spec.fields[key](input[key])) throw coded('LINEAR_FIELD_INVALID', 400, { field: key })
  }
  if (write && !isRequestId(input.requestId)) throw coded('LINEAR_REQUEST_ID_REQUIRED', 400, { field: 'requestId' })
  for (const key of spec.required) if (input[key] === undefined) throw coded('LINEAR_FIELD_REQUIRED', 400, { field: key })
  if (spec.atLeastOne && !spec.atLeastOne.some(key => input[key] !== undefined)) throw coded('LINEAR_FIELD_REQUIRED', 400, { field: spec.atLeastOne.join('|') })
  if (spec.oneOf && spec.oneOf.filter(key => input[key] !== undefined).length !== 1) throw coded('LINEAR_FIELD_REQUIRED', 400, { field: spec.oneOf.join('|') })
  return { name, spec, write }
}

/** The owner, and only the owner, with a session still live (cloud-brokers.mjs requireOwner). */
function requireOwner(access, env, now) {
  const email = value => typeof value === 'string' && value.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(value)
  if (access?.type !== 'owner' || !email(access.email) || !email(env?.OWNER_EMAIL) || access.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()
    || !Number.isFinite(access.expires) || access.expires * 1000 <= now) throw coded('OWNER_SESSION_REQUIRED', 403)
}

/**
 * Her Linear door, one per Worker isolate.
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, upstreamTimeoutMs?: number }} [options] Tests inject a fake Linear
 *   and a clock; the Worker passes none.
 * @returns {(request: Request, env: object, options: { access?: object|null, authorizeClass3?: ((input: object) => Promise<object>)|null }) => Promise<Response>}
 */
export function createLinearDoor({ fetchImpl, now = Date.now, upstreamTimeoutMs = LINEAR_DOOR_LIMITS.timeoutMs } = {}) {
  /** requestId → { digest, at, pending } or { digest, at, status, body }: the first answer to a write, for 10 minutes. */
  const repeats = new Map()
  /** session key → { read: number[], write: number[] }: when each call in the last hour was let through. */
  const sessions = new Map()

  const linear = (env, query, variables) => callLinear(fetchImpl ?? globalThis.fetch, upstreamTimeoutMs, env[LINEAR_KEY_NAME], query, variables)

  function sweep(at) {
    for (const [id, entry] of repeats) if (at - entry.at >= LINEAR_DOOR_LIMITS.repeatMs && !entry.pending) repeats.delete(id)
    while (repeats.size >= LINEAR_DOOR_LIMITS.repeatEntries) repeats.delete(repeats.keys().next().value)
  }

  async function sessionOf(access) {
    const key = typeof access.session === 'string' && access.session !== '' ? 'session:' + await sha256(access.session) : `owner:${access.expires}`
    let entry = sessions.get(key)
    if (!entry) {
      while (sessions.size >= LINEAR_DOOR_LIMITS.sessions) sessions.delete(sessions.keys().next().value)
      entry = { read: [], write: [] }
      sessions.set(key, entry)
    }
    return entry
  }

  /** Throws LINEAR_RATE when this session has used its hour; `take` records one call. */
  function rate(entry, kind, at, take) {
    const limit = kind === 'write' ? LINEAR_DOOR_LIMITS.writesPerHour : LINEAR_DOOR_LIMITS.readsPerHour
    const list = entry[kind]
    while (list.length && at - list[0] >= LINEAR_DOOR_LIMITS.windowMs) list.shift()
    if (list.length >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((list[0] + LINEAR_DOOR_LIMITS.windowMs - at) / 1000))
      throw coded('LINEAR_RATE', 429, { retryAfterSeconds, limit: `${limit} ${kind}s per hour`, next: LINEAR_NEXT.rate })
    }
    if (take) list.push(at)
  }

  /** The answer as it leaves: bounded and screened whole. */
  function finish(value, env) {
    const text = JSON.stringify(value)
    if (bytesOf(text) > LINEAR_DOOR_LIMITS.answerBytes) throw coded('LINEAR_ANSWER_TOO_LARGE', 413, { next: LINEAR_NEXT.tooLarge })
    if (!linearScreenClean(text, env)) throw coded('LINEAR_ANSWER_WITHHELD', 502, { next: LINEAR_NEXT.withheld })
    return text
  }

  async function issueIdOf(env, value) {
    if (UUID.test(value)) return value
    const data = await linear(env, ISSUE_ID_QUERY, { id: value })
    const id = data?.issue?.id
    if (data?.issue === null || data?.issue === undefined) throw coded('LINEAR_NOT_FOUND', 404)
    if (typeof id !== 'string' || !ID.test(id)) throw coded('LINEAR_UPSTREAM_MALFORMED', 502)
    return id
  }

  async function read(name, spec, input, env, level) {
    const query = typeof spec.query === 'function' ? spec.query(input) : spec.query
    const data = await linear(env, query, spec.variables(input))
    const picked = spec.pick(data, input)
    if (picked.single !== undefined && (picked.result === null || picked.result === undefined) && name !== 'status') throw coded('LINEAR_NOT_FOUND', 404)
    if (picked.result === undefined || (picked.page === undefined && !picked.single && name !== 'status')
      || (picked.page !== undefined && !Array.isArray(picked.result))) throw coded('LINEAR_UPSTREAM_MALFORMED', 502)
    const pageInfo = record(picked.page) ? { hasNextPage: picked.page.hasNextPage === true, endCursor: typeof picked.page.endCursor === 'string' ? picked.page.endCursor : null } : undefined
    return { ok: true, action: name, level, ...(name === 'status' ? { configured: true, ...picked.result, asks: LINEAR_CORE, asksAtGuarded: 'every write' } : { result: picked.result }),
      ...(pageInfo ? { page: pageInfo } : {}) }
  }

  async function handle(request, env, access, authorizeClass3, state) {
    if (!access) throw coded('OWNER_ACCESS_REQUIRED', 401)
    const url = new URL(request.url)
    if (url.pathname !== LINEAR_DOOR_ROUTE || url.search || url.hash) throw coded('NOT_FOUND', 404)
    if (request.method !== 'POST') throw coded('METHOD_UNAVAILABLE', 405)
    if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') !== 'same-origin') throw coded('SAME_ORIGIN_BROWSER_REQUIRED', 403)
    const at = now()
    requireOwner(access, env, at)
    const input = await readInput(request)
    const { name, spec, write } = judge(input)
    const level = linearDoorLevel(env)
    // ---- reader window begin: classify Linear actions at the boundary; open writes remain refused for readers even with an approval header ----
    if (write && isReaderWindow(request, env)) {
      const reason = typeof spec.core === 'function' ? spec.core(input) : null
      const asks = reason !== null || level !== 'open'
      if (!asks || !request.headers.get('x-x6-class3-approval')) throw coded('READER_WINDOW', 403)
    }
    // ---- READER-WINDOW end ----
    const key = env?.[LINEAR_KEY_NAME]
    const configured = typeof key === 'string' && key.trim() !== '' && key.length <= 4096 && !/\s/.test(key)
    if (!configured) {
      if (name === 'status') return { status: 200, body: { ok: true, action: 'status', level, configured: false, missing: LINEAR_KEY_NAME } }
      throw coded('LINEAR_NOT_CONFIGURED', 503, { missing: LINEAR_KEY_NAME })
    }
    const session = await sessionOf(access)
    if (!write) {
      rate(session, 'read', at, true)
      return { status: 200, body: await read(name, spec, input, env, level) }
    }

    // Her own words go out only when clean: a key or secret in them never leaves for Linear.
    if (!linearScreenClean(JSON.stringify(input), env)) throw coded('LINEAR_PRIVATE_CONTENT_REFUSED', 403)
    const digest = await sha256(canonicalJson(input))
    sweep(at)
    const earlier = repeats.get(input.requestId)
    if (earlier && at - earlier.at < LINEAR_DOOR_LIMITS.repeatMs) {
      if (earlier.digest !== digest) throw coded('LINEAR_REQUEST_ID_REUSED', 409, { requestId: input.requestId })
      if (earlier.pending) throw coded('LINEAR_REQUEST_IN_FLIGHT', 409, { requestId: input.requestId })
      return { status: earlier.status, body: { ...earlier.body, repeated: true } }
    }
    const reason = typeof spec.core === 'function' ? spec.core(input) : null
    const asks = reason !== null || level !== 'open'
    const mine = { digest, at, pending: true }
    repeats.set(input.requestId, mine)
    try {
      // Everything that can still refuse this write comes before the owner's approval, because HEAD uses an approval up the
      // moment it accepts it: the hour's write (taken now, so a write racing for the last one cannot pass after an
      // approval was spent; a held attempt counts too), then the identifier lookup and the comment-owner read.
      rate(session, 'write', at, true)
      const issueId = spec.resolveIssue ? await issueIdOf(env, input[spec.resolveIssue]) : null
      if (spec.ownComment) {
        const owner = await linear(env, COMMENT_OWNER_QUERY, { id: input[spec.ownComment] })
        if (owner?.comment === null || owner?.comment === undefined) throw coded('LINEAR_NOT_FOUND', 404)
        if (typeof owner?.viewer?.id !== 'string' || owner.comment.user?.id !== owner.viewer.id) throw coded('LINEAR_NOT_HER_COMMENT', 403)
      }
      if (asks) {
        const held = () => coded('CLASS3_WEBAUTHN_REQUIRED', 403, { reason: reason ?? 'guarded-level', level, next: LINEAR_NEXT.held })
        if (typeof authorizeClass3 !== 'function') throw held()
        const requestUrl = new URL(request.url)
        const binding = { schema: 'aukora.class3.action.v1', audience: requestUrl.origin, method: request.method, pathname: requestUrl.pathname, bodySha256: digest }
        let approval
        try { approval = await authorizeClass3(input) } catch { throw held() }
        if (approval?.ok !== true || canonicalJson(approval.binding) !== canonicalJson(binding)
          || !Number.isSafeInteger(approval.expiresAt) || approval.expiresAt <= now()) throw held()
      }
      const variables = spec.variables(input, issueId)
      // From here the write may happen: whatever comes back is the answer to this requestId, never sent again.
      state.dispatched = { requestId: input.requestId, entry: mine }
      const data = await linear(env, spec.query, variables)
      const result = data?.[spec.root]
      if (!record(result) || result.success !== true) throw coded('LINEAR_WRITE_REFUSED', 502)
      const { success: _success, ...rest } = result
      return { status: 200, body: { ok: true, action: name, level, requestId: input.requestId, result: rest, ...(asks ? { approved: reason ?? 'guarded-level' } : {}) } }
    } finally {
      if (state.dispatched === null && repeats.get(input.requestId) === mine) repeats.delete(input.requestId)
    }
  }

  /** Every answer leaves through here: bounded, screened, and for a write that left, remembered under its requestId. */
  return async function handleLinearDoor(request, env, { access = null, authorizeClass3 = null } = {}) {
    const state = { dispatched: null }
    let status, body
    try {
      ({ status, body } = await handle(request, env, access, authorizeClass3, state))
    } catch (error) {
      if (DOOR_ERRORS.has(error) && error.code === 'READER_WINDOW') return readerWindowRefusalResponse()
      if (DOOR_ERRORS.has(error)) {
        const unknown = state.dispatched !== null && ['LINEAR_UPSTREAM_UNAVAILABLE', 'LINEAR_UPSTREAM_MALFORMED', 'LINEAR_UPSTREAM_TOO_LARGE'].includes(error.code)
        status = unknown ? 503 : error.status
        body = unknown ? { ok: false, code: 'LINEAR_WRITE_OUTCOME_UNKNOWN', outcome: 'unknown', next: LINEAR_NEXT.outcome } : refusal(error)
      } else {
        status = state.dispatched !== null ? 503 : 500
        body = state.dispatched !== null ? { ok: false, code: 'LINEAR_WRITE_OUTCOME_UNKNOWN', outcome: 'unknown', next: LINEAR_NEXT.outcome } : { ok: false, code: 'LINEAR_DOOR_FAILED' }
      }
    }
    let text
    try {
      text = finish(body, env)
    } catch (error) {
      status = error.status
      body = { ...refusal(error), ...(state.dispatched !== null ? { outcome: 'written' } : {}) }
      text = JSON.stringify(body)
    }
    if (state.dispatched !== null) {
      const { requestId, entry } = state.dispatched
      if (repeats.get(requestId) === entry) repeats.set(requestId, { digest: entry.digest, at: entry.at, status, body: JSON.parse(text) })
    }
    return reply(JSON.parse(text), status)
  }
}

// ---- WAKE block begin ----
/** The cloud wake's Linear reader (lead's word, 2026-11-14). An internal principal, never an owner access: only
 * HEAD imports it, no request or JSON body can produce it, and the owner handler above never accepts it. What it may
 * do is exactly two reads (her issues: assigned to her or labelled `auma:go`; one such issue with its newest comments);
 * no write is reachable from it. Every answer is bounded, screened whole and marked untrusted; HEAD counts the reads per
 * UTC day in its own storage. */
export const WAKE_LINEAR_READER = Object.freeze({ kind: 'wake-linear-reader' })
/** The linear_comment act's own principal, separate from the reader. It writes ONE comment, and only with
 * the mandate use receipt HEAD wrote for the exact comment bytes (its `actionSha256`); never any other write. */
export const WAKE_LINEAR_COMMENTER = Object.freeze({ kind: 'wake-linear-commenter' })
export const LINEAR_WAKE_LIMITS = Object.freeze({ issues: 20, comments: 8, titleChars: 200, textChars: 600, answerBytes: 8192, timeoutMs: 8000 })
export const LINEAR_WAKE_GO_LABEL = 'auma:go'
const WAKE_ISSUE = 'id identifier title url updatedAt state { name } assignee { id } labels { nodes { name } }'
const WAKE_ISSUES_QUERY = `query LinearWakeIssues($first: Int!) { viewer { id } issues(filter: { or: [{ assignee: { isMe: { eq: true } } }, { labels: { name: { eq: "${LINEAR_WAKE_GO_LABEL}" } } }] }, first: $first, orderBy: updatedAt) { nodes { ${WAKE_ISSUE} } } }`
const WAKE_ONE_ISSUE_QUERY = `query LinearWakeIssue($id: String!, $comments: Int!) { viewer { id } issue(id: $id) { ${WAKE_ISSUE} description comments(last: $comments) { nodes { id body createdAt user { name } } } } }`
const cut = (value, max) => typeof value === 'string' ? value.slice(0, max) : null
const wakeReadable = (issue, viewerId) => record(issue) && typeof viewerId === 'string'
  && (issue.assignee?.id === viewerId || (Array.isArray(issue.labels?.nodes) && issue.labels.nodes.some(label => label?.name === LINEAR_WAKE_GO_LABEL)))
const wakeIssueView = issue => ({ id: cut(issue.id, 64), identifier: cut(issue.identifier, 32), title: cut(issue.title, LINEAR_WAKE_LIMITS.titleChars),
  state: cut(issue.state?.name, 64), updatedAt: cut(issue.updatedAt, 40), url: cut(issue.url, 200) })

/** The step's own abort signal joins every Linear request's deadline, so a step that ends cancels it. */
function wakeSend(fetchImpl, signal) {
  const send = fetchImpl ?? globalThis.fetch
  if (!signal) return send
  return (url, init = {}) => signal.aborted ? Promise.reject(signal.reason ?? new Error('aborted'))
    : send(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal })
}

async function wakeLinear(env, fetchImpl, signal, query, variables) {
  const key = env?.[LINEAR_KEY_NAME]
  if (typeof key !== 'string' || key.trim() === '' || key.length > 4096 || /\s/.test(key)) throw coded('LINEAR_NOT_CONFIGURED', 503, { missing: LINEAR_KEY_NAME })
  if (signal?.aborted) throw coded('LINEAR_UPSTREAM_UNAVAILABLE', 502)
  return await callLinear(wakeSend(fetchImpl, signal), LINEAR_WAKE_LIMITS.timeoutMs, key, query, variables)
}

/**
 * The wake's ONE read-only Linear export. `{ action: 'issues' }` lists her issues (assigned to her or labelled
 * auma:go); `{ action: 'issue', issue }` reads one such issue and its newest comments (another issue is refused
 * LINEAR_ISSUE_NOT_READABLE). Never throws: `{ ok: false, code }`.
 * @param {object} reader WAKE_LINEAR_READER, nothing else.
 */
export async function linearWakeRead(reader, input, env, { fetchImpl, signal } = {}) {
  try {
    if (reader !== WAKE_LINEAR_READER) throw coded('LINEAR_WAKE_READER_REQUIRED', 403)
    if (!record(input) || !['issues', 'issue'].includes(input.action)) throw coded('LINEAR_ACTION_UNKNOWN', 400)
    let answer
    if (input.action === 'issues') {
      if (Object.keys(input).length !== 1) throw coded('LINEAR_FIELD_UNKNOWN', 400)
      const data = await wakeLinear(env, fetchImpl, signal, WAKE_ISSUES_QUERY, { first: LINEAR_WAKE_LIMITS.issues })
      const nodes = data?.issues?.nodes
      if (!Array.isArray(nodes) || nodes.length > LINEAR_WAKE_LIMITS.issues) throw coded('LINEAR_UPSTREAM_MALFORMED', 502)
      answer = { ok: true, action: 'issues', untrusted: true, issues: nodes.filter(issue => wakeReadable(issue, data?.viewer?.id)).map(wakeIssueView) }
    } else {
      if (Object.keys(input).length !== 2 || !isId(input.issue)) throw coded('LINEAR_FIELD_INVALID', 400)
      const data = await wakeLinear(env, fetchImpl, signal, WAKE_ONE_ISSUE_QUERY, { id: input.issue, comments: LINEAR_WAKE_LIMITS.comments })
      if (data?.issue === null || data?.issue === undefined) throw coded('LINEAR_NOT_FOUND', 404)
      if (!wakeReadable(data.issue, data?.viewer?.id)) throw coded('LINEAR_ISSUE_NOT_READABLE', 403)
      const comments = Array.isArray(data.issue.comments?.nodes) ? data.issue.comments.nodes.slice(-LINEAR_WAKE_LIMITS.comments) : []
      answer = { ok: true, action: 'issue', untrusted: true, issue: { ...wakeIssueView(data.issue), description: cut(data.issue.description, LINEAR_WAKE_LIMITS.textChars) },
        comments: comments.map(comment => ({ id: cut(comment?.id, 64), at: cut(comment?.createdAt, 40), author: cut(comment?.user?.name, 64), body: cut(comment?.body, LINEAR_WAKE_LIMITS.textChars) })) }
    }
    const text = JSON.stringify(answer)
    if (bytesOf(text) > LINEAR_WAKE_LIMITS.answerBytes) throw coded('LINEAR_ANSWER_TOO_LARGE', 413)
    if (!linearScreenClean(text, env)) throw coded('LINEAR_ANSWER_WITHHELD', 502)
    return answer
  } catch (error) {
    return { ok: false, code: DOOR_ERRORS.has(error) ? error.code : 'LINEAR_DOOR_FAILED' }
  }
}

/** The mandate use receipt HEAD wrote for exactly this comment (scope linear.comment, one linearComments
 * use, its actionSha256 the SHA-256 of canonicalJson({ act: 'linear_comment', issue, body })). */
async function wakeCommentPaid(spent, issue, body) {
  return record(spent) && spent.kind === 'use' && spent.scope === 'linear.comment' && spent.use === 'linearComments' && spent.units === 1
    && typeof spent.mandateId === 'string' && spent.mandateId.length > 0 && typeof spent.actionSha256 === 'string'
    && spent.actionSha256 === await sha256(canonicalJson({ act: 'linear_comment', issue, body }))
}

/**
 * The linear_comment act, called by HEAD only AFTER it has spent the owner's mandate for it, with the commenter
 * principal (never the reader) and that use's receipt for these exact bytes (`spent`). The issue must pass the same
 * rule as the read (one read first); then ONE commentCreate. `{ ok: true, commentId }` or `{ ok: false, code,
 * dispatched }` (dispatched: the write may have left; outcome unknown). Never another write.
 */
export async function linearWakeComment(commenter, { issue, body, requestId, spent } = {}, env, { fetchImpl, signal } = {}) {
  let dispatched = false
  try {
    if (commenter !== WAKE_LINEAR_COMMENTER) throw coded('LINEAR_WAKE_COMMENTER_REQUIRED', 403)
    if (!isId(issue) || !isText(4000)(body) || !isRequestId(requestId)) throw coded('LINEAR_FIELD_INVALID', 400)
    if (!await wakeCommentPaid(spent, issue, body)) throw coded('LINEAR_WAKE_SPEND_REQUIRED', 403)
    if (!linearScreenClean(body, env)) throw coded('LINEAR_PRIVATE_CONTENT_REFUSED', 403)
    const data = await wakeLinear(env, fetchImpl, signal, WAKE_ONE_ISSUE_QUERY, { id: issue, comments: 1 })
    if (data?.issue === null || data?.issue === undefined) throw coded('LINEAR_NOT_FOUND', 404)
    if (!wakeReadable(data.issue, data?.viewer?.id) || typeof data.issue.id !== 'string' || !ID.test(data.issue.id)) throw coded('LINEAR_ISSUE_NOT_READABLE', 403)
    if (signal?.aborted) throw coded('LINEAR_UPSTREAM_UNAVAILABLE', 502)
    dispatched = true
    const spec = LINEAR_ACTIONS.comment
    const written = await wakeLinear(env, fetchImpl, signal, spec.query, spec.variables({ body }, data.issue.id))
    const result = written?.[spec.root]
    if (!record(result) || result.success !== true || typeof result.comment?.id !== 'string') throw coded('LINEAR_WRITE_REFUSED', 502)
    return { ok: true, commentId: result.comment.id.slice(0, 64), issue: cut(data.issue.identifier, 32) }
  } catch (error) {
    return { ok: false, code: DOOR_ERRORS.has(error) ? error.code : 'LINEAR_DOOR_FAILED', dispatched }
  }
}
// ---- WAKE block end ----
