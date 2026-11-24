# Post-mortem 0003: Web agent validated a replacement server instead of its current GUI

Status: resolved

## Executive summary

A Web agent changed the GUI source but did not know which URL and process hosted its session. It delegated acceptance to the user, then treated a bare Vite HTTP 200 as success despite a missing `window.__DSH_BOOT__` white screen, and finally validated a replacement `dsh web` server on another port while the original page had already picked up rebuilt artifacts. The fix makes the current URL and runtime mode model-visible and shell-queryable, rejects standalone Vite before listen, and verifies production refresh and development HMR against external state.

## Summary

The session ran inside the DeepSeek Harness Web GUI while its selected Workspace was an empty directory. The model request named neither the GUI nor its source checkout, URL, process, or update mode. Repository affordances exposed `apps/web` with a Vite development script, while the full browser composition lived behind `dsh web`.

The resulting actions were individually plausible but did not share one acceptance target. A source edit, a successful build, an HTTP 200, an injected boot manifest, and the user's existing page were treated as interchangeable facts.

The timeline follows the persisted event log. The session locator, workspace path and trace identifiers have been removed.

## Impact

The user had to identify three consecutive mistakes: acceptance was delegated back to them; the proposed preview was a blank page; and the reported successful URL was not the page they were using. An unmanaged replacement server also outlived the turn until the user challenged it.

The read-only trial services ran throughout the investigation without modification.

## Timeline

- After editing the theme, the agent told the user to run `pnpm run demo:tui` or open an unspecified Web application. It ran no assembled Web acceptance.
- The agent read `apps/web/package.json`, launched bare Vite, observed HTTP 200, and declared success. The browser instead threw `client-modules: window.__DSH_BOOT__ is missing or not an object` and rendered a white page.
- The agent found the full `dsh web` path, rebuilt the shell and launched an unmanaged replacement server. It checked that the replacement returned HTTP 200 with a boot manifest. The original server went unchecked.
- After the user reported that the original page already showed the new theme, the agent inspected the existing process and removed the redundant server.

## Root cause

The Web assembly had no model-visible identity for the current GUI, canonical URL, or runtime mode. The session cwd correctly identified the user's selected Workspace, but the model treated that project directory as the application directory. No durable record related the GUI source checkout, built artifacts, serving process, target origin, and browser acceptance.

The wrong startup path looked legitimate because bare Vite returned HTTP 200. `window.__DSH_BOOT__` is injected only by the full host, so transport readiness did not imply application readiness. The first regression test repeated this mistake in another form: a timeout killed Vite and satisfied a nonzero-exit assertion. Live reproduction exposed that false positive.

Background process semantics were also bypassed with shell `&`, so job identity, completion notices, collection, and cleanup did not apply. Verifying the replacement server therefore proved only that a second service worked.

## Guardrails added

- The Web launcher publishes the canonical loopback URL in the logged `app:web-surface` prompt section and the managed `$DSH_WEB_URL` environment.
- Production guidance requires rebuilding artifacts and verifying the existing URL after refresh. Development guidance explains that the HMR receiver is always on; `pnpm run dev:web` in the same checkout rebuilds client-plugin bundles for refresh-free reload, while shell and plain-package changes still require refresh.
- `apps/web` standalone Vite serve mode rejects during configuration. Its subprocess test proves natural exit and instruments `Server.listen()` so a transient bind cannot pass unnoticed.
- Layered real-path tests cover the CLI request, exact production/development prompts, shell runtime facts, same-port static replacement, source watcher rebuild, host stat polling, and browser HMR under an unchanged page identity.
- PR evidence includes screenshots of the original GUI and a real-model before/after run. Acceptance uses browser, HTTP, process and session-log observations.

## Lessons

- The agent must know hidden runtime prerequisites before it can guide the user; startup mode is application context, not tribal knowledge.
- HTTP readiness, build success, and a boot manifest are different facts. Acceptance names the exact origin and externally observes the requested change there.
- A replacement service cannot prove that an existing page changed. Long-running processes use managed task lifecycles when they are actually requested.
- A regression test must be able to fail for the reported mechanism. Process timeout is not equivalent to fail-fast, and post-exit port availability does not prove the port was never bound.
