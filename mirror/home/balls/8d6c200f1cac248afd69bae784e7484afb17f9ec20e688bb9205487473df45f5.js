/**
 * Seed v4 + Cordis Hybrid Organ: `auma-web-eyes`
 *
 * Host-brokered Web Fetch & Search provider ball (`ctx.web.registerFetchProvider` + `ctx.web.registerSearchProvider`)
 * plus direct `auma_web_eyes` tool (`fetch`, `search`, `status`).
 *
 * Requires zero API keys inside the worker: the host half (`/_host/web-eyes` and `/api/fetch`)
 * performs the network fetch, strips HTML chrome into readable text/markdown, and returns
 * structured results to both DSH's native `web_fetch`/`web_search` tools and `auma_web_eyes`.
 */

async function callHostWebEyes(payload) {
  const origin = (typeof globalThis !== 'undefined' && globalThis.location && globalThis.location.origin && globalThis.location.origin !== 'null')
    ? globalThis.location.origin
    : 'http://127.0.0.1:4610'
  const res = await fetch(new URL('/_host/web-eyes', origin).href, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    credentials: 'same-origin',
  })
  return await res.json()
}

'use strict'

module.exports = {
  name: 'auma-web-eyes',
  description:
    'Host-brokered Web Fetch & Search organ (`ctx.web.registerFetchProvider` + `ctx.web.registerSearchProvider`). '
    + 'Provides readable web fetching and web search without needing an API key in the sandbox.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['fetch', 'search', 'status', 'web_service_fetch'],
        description: 'Operation: "fetch" (read a URL), "search" (search the web), "web_service_fetch" (call ctx.web.fetch directly), or "status" (inspect active web providers).',
      },
      url: {
        type: 'string',
        description: 'Target URL to fetch when action="fetch".',
      },
      query: {
        type: 'string',
        description: 'Search query when action="search".',
      },
      limit: {
        type: 'number',
        description: 'Max search results when action="search" (default 8).',
      },
      maxLength: {
        type: 'number',
        description: 'Maximum characters to return when action="fetch" (default 80000).',
      },
    },
    additionalProperties: false,
  },
  setup(ctx) {
    const disposers = []
    if (ctx && ctx.web && typeof ctx.web.registerFetchProvider === 'function') {
      const disposeFetch = ctx.web.registerFetchProvider({
        id: 'auma-web-eyes',
        available() {
          return true
        },
        async fetch(request) {
          const data = await callHostWebEyes({
            action: 'fetch',
            url: request.url,
          })
          if (!data || !data.ok) {
            throw new Error((data && data.error) ? data.error : `auma-web-eyes fetch failed for ${request.url}`)
          }
          const headerPrefix = data.title ? `# ${data.title}\n\n` : ''
          return {
            url: data.finalUrl || request.url,
            statusCode: data.status || 200,
            body: {
              kind: 'text',
              content: `${headerPrefix}${String(data.content || '')}`,
            },
            truncated: false,
          }
        },
      })
      if (typeof disposeFetch === 'function') disposers.push(disposeFetch)
    }
    if (ctx && ctx.web && typeof ctx.web.registerSearchProvider === 'function') {
      const disposeSearch = ctx.web.registerSearchProvider({
        id: 'auma-web-eyes-search',
        available() {
          return true
        },
        async search(request) {
          const data = await callHostWebEyes({
            action: 'search',
            query: request.query,
            limit: request.maxResults || 8,
          })
          if (!data || !data.ok) {
            throw new Error((data && data.error) ? data.error : `auma-web-eyes search failed for ${request.query}`)
          }
          return {
            sources: Array.isArray(data.results) ? data.results : [],
            truncated: false,
          }
        },
      })
      if (typeof disposeSearch === 'function') disposers.push(disposeSearch)
    }
    return () => {
      for (const d of disposers.splice(0)) {
        try { d() } catch {}
      }
    }
  },
  async run(args = {}, ctx = {}) {
    const action = args.action || (args.url ? 'fetch' : (args.query ? 'search' : 'status'))
    if (action === 'status') {
      const webSvc = ctx.web
      return {
        ok: true,
        organ: 'auma-web-eyes',
        fetchProviderPinned: webSvc && webSvc.config && webSvc.config.fetchProvider ? webSvc.config.fetchProvider.get() : 'auma-web-eyes',
        searchProviderPinned: webSvc && webSvc.config && webSvc.config.searchProvider ? webSvc.config.searchProvider.get() : 'auma-web-eyes-search',
        endpoints: ['/_host/web-eyes', '/api/fetch'],
      }
    }
    if (action === 'web_service_fetch') {
      if (!ctx.web || typeof ctx.web.fetch !== 'function') {
        return { ok: false, error: 'ctx.web.fetch is not available' }
      }
      const res = await ctx.web.fetch({ url: args.url })
      return { ok: true, via: 'ctx.web.fetch', result: res }
    }
    if (action === 'fetch') {
      return await callHostWebEyes({
        action: 'fetch',
        url: args.url,
        maxLength: args.maxLength,
      })
    }
    if (action === 'search') {
      return await callHostWebEyes({
        action: 'search',
        query: args.query,
        limit: args.limit,
      })
    }
    return { ok: false, error: `Unknown auma-web-eyes action: ${String(action)}` }
  },
}
