# Security boundaries

This fork hardens the local MCP and Studio entry points. It is not a security certification or an operating-system sandbox.

## Supported setup

Build the reviewed source with `npm ci --ignore-scripts` and `npm run build`, then run `dist/index.js` with an explicit absolute `RIVE_MCP_WORKSPACE`. See the [setup example](README.md#quick-start).

Use a dedicated folder containing only animation inputs and outputs. The server runs with your account's OS permissions; do not run it as administrator/root. Keep its installation, credentials, source repositories and client configuration outside the workspace. Tools can overwrite files inside the workspace. Pin a reviewed Git commit when deploying updates.

This fork is private/source-only in package metadata. It does not publish or register the upstream npm package; the upstream registry manifest has been removed. `npx rive-mcp-server` does not run these fixes. The local plugin points to `../dist/index.js` and requires the complete built checkout and the workspace environment variable.

## Protections

- MCP tool, batch-render, comparison and Studio file operations enforce the workspace boundary. Traversal, hidden components (including `.env`, `.ssh`, `.git` and client instruction folders), `node_modules`, symlinks, hard-linked files, special files and alternate-stream paths are denied. New output paths are checked through their existing ancestors. File reads/writes are capped at 64 MiB. Fixed bundled fonts/runtime/schema files are read separately; callers cannot select arbitrary paths through those exceptions.
- Studio listens only on IPv4 loopback. All data, assets, event streams and editing routes require a random 256-bit session credential. The public root only serves a sign-in page. The credential is passed in a URL fragment, exchanged for an HttpOnly/SameSite=Strict session cookie and removed from the address bar. Restarting invalidates prior credentials. Cookies are local HTTP session cookies, not HTTPS credentials; do not proxy or expose Studio remotely.
- Exact Host validation, Origin/fetch-site checks and same-origin cookie-authenticated POST requirements protect against DNS rebinding and browser cross-origin edits. CSP limits scripts to same-origin resources and a nonce, blocks framing and prevents external network access from the Studio UI. No permissive CORS headers are emitted.
- Studio bodies are limited to 16 MiB, with request/header timeouts, connection/event-stream caps, bounded notes/chat/snapshot history, and export frame/dimension checks. These are resource limits, not a complete denial-of-service defense.
- Studio notes remain untrusted feedback. MCP reads/replies only to the Studio owned by that process; the caller cannot redirect it to another local HTTP service. The tool text explicitly limits feedback to work already authorized in the main chat. Model/tool approval controls still matter.
- Automatic skill installation into `.claude/skills` is disabled. Review skills before manually installing them.
- Chromium's process sandbox is enabled. Its rendering context blocks network requests except intercepted local runtime resources and disables service workers. Externally hosted assets in animations may consequently need to be embedded first. There is no fallback that disables the sandbox.
- Direct dependencies are pinned and transitive dependencies locked. The updated lockfile passed `npm audit` with zero reported vulnerabilities when this change was prepared. This is a point-in-time result, not a guarantee against unknown vulnerabilities.

## Network access

Node-side Iconify search/import and optional Figma import still make their documented outbound requests. Figma import uses `FIGMA_TOKEN` if supplied; leave it unset unless needed. Dependencies are downloaded at installation. Rive CLI/explorer tooling and CI workflows are separate developer paths, not part of the MCP entry point's filesystem/network boundary.

## Remaining limits

The path checks do not defend against a malicious process running as the same OS user racing filesystem changes. Only place trusted assets in the workspace, and do not let untrusted processes modify it concurrently. Complex SVG, fonts, PNGs and `.riv` files are parsed by third-party runtimes and may still cause failures or excessive resource use. For genuinely untrusted assets, use a disposable VM/container with only the animation folder mounted and no secrets. Do not disable Chromium's sandbox to make a container run.

Anyone who obtains the Studio link has access to that session. Other local applications, browser extensions, compromised dependencies and the MCP host itself are outside the session authentication boundary. Keep normal MCP approval settings enabled.

## Verification

```bash
npm ci --ignore-scripts
npm run build
npm run test:security
npm run test:security:browser   # requires installed Chrome/Edge or RIVE_MCP_CHROME
npm run test:e2e               # requires Chromium; creates sample outputs
node test/studio-features.mjs  # run after e2e creates its image fixture
npm audit
```

Security regressions cover unauthenticated routes, Host/Origin attacks, cookie CSRF, session rotation, workspace traversal and link escapes, actual MCP tool paths, cross-workspace font embedding, oversized requests, snapshots and occupied-port handling. The browser test covers private-link sign-in, CSP-compatible rendering, HttpOnly cookies, same-origin editing and blocked renderer networking.
