# GitBook Open — Project Context

> Comprehensive engineering context for this repository. This is the **open-source rendering engine** that renders GitBook's published content (docs sites, spaces, PDFs, markdown/LLM feeds, AI assistant, MCP). It is a Next.js 16 app deployed to **both Vercel and Cloudflare Workers** from a single build, inside a Bun + Turborepo monorepo.
>
> License: GNU GPLv3. Node `^22.3.0`, Bun `1.3.7` (pinned). This document is a map of *what exists, how it fits together, and the non-obvious behaviors* — not a substitute for reading the code.

---

## 1. What this project is

GitBook Open takes a **published GitBook URL** (custom domain, `*.gitbook.io`, or the local `/url/<url>` proxy) and renders the corresponding documentation site. The private GitBook backend exposes content through the `@gitbook/api` client; this repo is the presentation/rendering layer only. It:

- Resolves an incoming request URL → structured site/space/page data (via the API).
- Renders pages (React Server Components), navigation, search, AI assistant, OpenAPI reference, ContentKit integrations.
- Serves ancillary formats: PDF export, `llms.txt`/`llms-full.txt`, per-page markdown (`.md`), RSS, sitemaps, robots, OG images, favicons, resized images.
- Exposes an **MCP server** per site and an **embeddable widget**.

Referred to internally as **"v2"** (`GITBOOK_V2: 'true'`). Deployment variants are called **`2v`** (Vercel) and **`2c`** (Cloudflare), served on `open-2c.gitbook.com` / `static-2c.gitbook.com`.

### Local development
```bash
bun install
bun dev          # turbo run dev, all packages
# then open any published site through the proxy:
#   http://localhost:3000/url/gitbook.com/docs
#   http://localhost:3000/url/open-source.gitbook.io/midjourney
```
Core commands: `bun run build`, `bun run typecheck`, `bun run format` (Biome — run after every change), `bun run unit`, `bun run e2e`.

Two footguns worth knowing before you start (full walkthrough in `RUNNING_LOCALLY.md`): the installed **Bun binary must match the pinned `1.3.7`** (`packageManager`) or `bun install` silently rewrites `bun.lock`'s format and leaves the workspace under-installed; and `.env.local` is read from the **repo root** (`packages/gitbook/package.json`'s `dev` script: `env-cmd -f ../../.env.local`), not from `packages/gitbook/`.

---

## 2. Repository layout

```
packages/
  gitbook/          # THE main Next.js app (everything below §4 lives here unless noted)
  openapi-parser/   # OpenAPI 3.1/3.0/Swagger 2.0 parser (wraps Scalar)
  react-openapi/    # Style-less React components to render OpenAPI operations/schemas/webhooks
  react-contentkit/ # Renders ContentKit (integration server-driven UI)
  react-math/       # KaTeX (server) + MathJax (client fallback) formula rendering
  expr/             # Safe expression evaluator (adaptive content conditions/templates)
  embed/            # Embeddable docs/assistant widget (client, standalone script, React)
  colors/           # OKLCH color-scale + contrast token generation
  icons/            # Font Awesome Pro-based icon set + React <Icon> + CLI
  fonts/            # Google Font URL lookup by script/subset
  emoji-codepoints/ # Base→fully-qualified emoji codepoint map (private, generated)
  browser-types/    # Types for the global window.GitBook object (for integrations)
  cache-tags/       # Deterministic cache-tag string generation
scripts/            # publish-if-new.sh, strip-development-exports.mjs
patches/            # next, @vercel/next, decode-named-character-reference
.changeset/         # changesets (release notes) + config
.github/            # CI/CD workflows + composite/custom actions
turbo.json biome.json bun.lock AGENTS.md
```

- **Package manager**: Bun with a text-based lockfile (`bun.lock`, needs Bun ≥1.2.15). Workspace + a `catalog:` of shared dep versions in root `package.json`.
- **All supporting packages** are ESM-only (`"type": "module"`), tree-shakeable (`sideEffects: false`), built with **tsdown** (except `emoji-codepoints` → custom `build.ts`), and published to npm. Main app depends on all 12 via `workspace:*`.
- **Internal package dep graph**: `react-openapi → openapi-parser, expr`; `react-contentkit → icons`; `embed → icons`; `browser-types → icons`; `fonts, cache-tags → api`. The rest are leaves.

---

## 3. Tech stack & conventions

- **Next.js 16** (App Router + a single legacy Pages Router API route), React 19.2, `useCache`/`'use cache'` enabled, built with **`--webpack`** (Turbopack opted out).
- **Tailwind CSS v4** (PostCSS integration), `darkMode: 'class'`, CSS-variable-driven design tokens (see §17).
- **Biome 1.9.4** is the *only* linter+formatter (no ESLint/Prettier). 4-space indent, width 100, single quotes (double in JSX), `es5` trailing commas, semicolons always. `organizeImports` on. Nursery rule **`useSortedClasses: error`** auto-sorts Tailwind classes in `class`/`className`/`style`/`clsx`/`tw`. `security.noDangerouslySetInnerHtml: off`. Many a11y rules as warnings. All `*.css` is ignored by Biome (Tailwind v4).
- **Comments convention** (from `AGENTS.md`): explain *why*, not *what*; keep short/single-line; reserve long comments for genuinely non-obvious rationale.
- **`stylelint`** is a declared devDependency but has **no config and no CI wiring** — effectively dead tooling.
- **Zod** for schema validation, **zustand** for client state, **motion** (Framer Motion) for animation, **nuqs** for URL-backed state, **radix-ui** + **react-aria** for primitives, **shiki** for code highlighting, **flexsearch** for local search, **mermaid** for diagrams.

---

## 4. The core request lifecycle (most important section)

**Every request flows through the Edge middleware first** (`src/middleware.ts`). There is **no `app/layout.tsx` or `app/page.tsx` at the app root** — the entire route tree is reached via a **middleware rewrite**. Understanding this rewrite is the key to the whole app.

### 4.1 `src/middleware.ts`
Matcher excludes only static asset paths (`_next/static`, `_next/image`, `~gitbook/static`, `~gitbook/revalidate`, `~gitbook/monitoring`, `~scalar/proxy`).

Flow:
1. **`validateServerActionRequest`** — reject malformed `next-action` headers (must match a 42-char hex regex) and unparseable server-action bodies (body check skipped on Cloudflare due to a workerd body-read bug).
2. Run handlers in order, first non-null wins: **`serveSiteRoutes`**, then **`serveSpacePDFRoutes`**.
3. Fallthrough → `NextResponse.next()`. Errors → `serveErrorResponse` (a `DataFetcherError` becomes a plain-text response with its code).

**`getSiteURLFromRequest`** determines the content URL + `mode` (priority order):
- `X-GitBook-URL` header → `mode: 'url-host'`.
- `/url/<published-url>` on the main GitBook host (e.g. `localhost:3000/url/gitbook.com/docs`) → `mode: 'url'` (the **local dev / proxy scheme**).
- `X-Forwarded-Host` header (custom domains, set by Vercel) → `mode: 'url-host'`.
- Main/assets host without `/url/` → `null` (not a site request).

`mode` matters everywhere: in `url` mode the app keeps the original URL and generates `/url/:host:path` links; in `url-host` mode it uses the canonical URL/origin (correct links when proxied, e.g. `proxy.gitbook.com/site/<siteId>/...`).

**`serveSiteRoutes`** (the heart):
1. `normalizeRequestURL` (may 302-redirect to canonical form).
2. Handle special paths **before** content lookup: `/~gitbook/image` → image resizing; `/~gitbook/__evt` → analytics proxy; `/~gitbook/visitor` → visitor claims JSON; GitBook OAuth `authorize` redirect; malicious-request filter (host with port, `;.jsp` suffix → 400).
3. Extract visitor auth data (`getVisitorData`): JWT token, unsigned claims, `visitor.*` params cookie. Strip client-supplied `x-gitbook-disable-tracking`.
4. **`lookupPublishedContentByUrl`** → `PublishedSiteContent` (`siteURLData`): site/space/section IDs, `basePath`, `pathname`, `canonicalUrl`, `apiToken`, `changeRequest`, `revision`, `shareKey`, `preview`, `contextId`, and possibly a `redirect`.
5. **Redirect handling**: content redirects rebuilt into `/url/...` form in `url` mode; server-action POSTs get a **303 + `X-Action-Redirect` header** (avoids CORS on redirect); unauthenticated requests to OAuth-protected resources (MCP) → RFC 9728 flow.
6. Persist visitor-auth cookies (except on `~gitbook/auth/logout`).
7. **Determine `routeType`** (`static` | `dynamic`): default `static`; flips to `dynamic` on customization override (only honored when `siteURLData.preview` is authoritative or `GITBOOK_ALLOW_CUSTOMIZATION_OVERRIDE=true`), a `theme` override, a `gitbook-dynamic-route` cookie, an adaptive `contextId`, or per pathname classification.
8. Build **`stableSiteURLData`** — a deliberately **minimal, stable subset** of the data so the root layout doesn't re-render across page navigations.
9. Set middleware headers, forward `x-forwarded-host`/`origin` equal (so Next doesn't block proxied server actions).

**`encodePathInSiteContent`** maps the pathname → internal route + classifies static/dynamic. Notable cases: `rss.xml` → `~gitbook/rss/…` (static, emits `rss_request`); `llms-full.txt/<n>` (static); `~gitbook/embed/page/…`; aliases `sitemap.md`/`.well-known/sitemap.md` → `llms.txt`; always-static (`llms.txt`, `sitemap*.xml`, `robots.txt`, `~gitbook/site-index`, embed script/demo); always-dynamic (`~gitbook/mcp[/auth]`, `~gitbook/pdf`, `~gitbook/search`, `~gitbook/auth/login|logout`, `~scalar/proxy`). **Markdown detection** (default case): if path ends `.md`, OR request is from a non-heuristic AI agent (`isAIAgent` from `@vercel/agent-readability`), OR `Accept` prefers markdown (Negotiator) → `~gitbook/markdown/…` (or `~gitbook/markdown-ask/<ask>[/<goal>]` when `?ask=`), else a normal page.

### 4.2 The rewrite target
```
/sites/{routeType}/{mode}/{encodeURIComponent(canonicalHost+basePath)}/{encodeURIComponent(rison.encode(stableSiteURLData))}/{pathname}
```
- `routeType` picks the `app/sites/dynamic` vs `app/sites/static` subtree.
- `siteData` is **Rison-encoded** (undefined values filtered out — Rison can't encode `undefined`).
- Then sets security headers: **CSP** (`getContentSecurityPolicy`), HSTS, `referrer-policy`, `x-content-type-options: nosniff`, debug `x-gitbook-route-type`/`-site`, broad `vary`, CORS (`getAllowedCORSOrigin` — eTLD+1 match via `tldts`; shared hosting domains like `gitbook.io` require *exact* host match to prevent cross-customer reads). For adaptive content (`contextId` set) → `cache-control: public, max-age=0, must-revalidate`.

**`serveSpacePDFRoutes`** handles `/~space/:spaceId/...` and `/~site/:spaceId/...` — pulls a `?token=` into a path-scoped httpOnly cookie via redirect, then forwards with the token in the `x-gitbook-api-token` header. Preview requests (`sites.gitbook.com/preview/<siteId>/...`) similarly scope the token and disable tracking.

### 4.3 Header contract (`src/lib/middleware.ts`)
`enum MiddlewareHeaders`: `x-gitbook-route-type`, `x-gitbook-site-url`, `x-gitbook-site-url-data`, `x-gitbook-url-mode`, `x-gitbook-theme`, `x-gitbook-customization`, `x-gitbook-api-token`. Async accessors (`getSiteURLDataFromMiddleware`, `getThemeFromMiddleware`, etc.) read these — **only valid in dynamic routes/server actions**. In the static subtree the data comes from route params instead.

---

## 5. Routing & the `app/` tree

The `sites/dynamic` and `sites/static` subtrees are **two parallel copies** of the same routes, differing only in caching strategy:
- **static** — pages export `dynamic = 'force-static'`; params fully describe the request → Next prerenders/caches.
- **dynamic** — re-renders per request (reads middleware headers for theme/customization/adaptive).

Full tree under `sites/{dynamic,static}/[mode]/[siteURL]/[siteData]/`:
- `(content)/layout.tsx` + `(content)/[pagePath]/page.tsx` (+ `not-found.tsx`; dynamic also has `loading.tsx`). `(content)` is a route group (no URL segment).
- `~gitbook/embed/{page,assistant,search,layout,demo,script.js}`, `~gitbook/icon`, `~gitbook/pdf`, `~gitbook/ogimage/[pageId]`.
- **static only**: `llms.txt`, `llms-full.txt`(+`[page]`), `sitemap.xml`, `sitemap-pages.xml`, `robots.txt`, `~gitbook/site-index` (`revalidate = 86400`), `~gitbook/markdown/[pagePath]`, `~gitbook/markdown-ask/[question]`(+`[goal]`), `~gitbook/rss/[pagePath]`.
- **dynamic only**: `~gitbook/search`, `~gitbook/mcp`(+`/auth`,`/handler`), `~gitbook/auth/{login,logout}`, `~scalar/proxy` (`force-dynamic`).

**`app/utils.ts`** — bridge from encoded segments to render context. `RouteLayoutParams = {mode, siteURL, siteData}`, `RouteParams` adds `pagePath`. Decoders invert the middleware encoding (`rison.decode`, `decodeURIComponent`; 404 on failure). `getStaticSiteContext` additionally `jwtDecode`s the `apiToken` and calls `forbidden()` if it expires within 120s (static route may revalidate after expiry). `getDynamicSiteContext` also applies `getDynamicCustomizationSettings`.

**Deployment-level routes (outside the site tree):**
- `app/~gitbook/env/route.ts` — GET returns public env + booleans for which secrets are set (introspection).
- `app/~gitbook/revalidate/route.ts` — POST `{tags}`, HMAC-verified, calls `revalidateTag(tag, {expire:0})` (the *only* `revalidateTag` usage). Excluded from middleware.
- `app/~space/[spaceId]/…/~gitbook/pdf/*` (+ `~/changes/[id]`, `~/revisions/[id]`) — space PDF export using the middleware-injected API token (space context, not site).
- `pages/api/~gitbook/force-revalidate.ts` — legacy Pages Router; POST, HMAC-verified with inlined `GITBOOK_SECRET`, calls `res.revalidate(path)` (path-based ISR; paths must be the *rewritten* internal paths since it bypasses middleware).

**Caching:** no `"use cache"` in `app/`/`routes/` — caching is classic segment config + cache tags. Two revalidation paths: tag-based (App Router) and path-based (Pages API), both HMAC-signed with `GITBOOK_SECRET`.

### `src/routes/` — shared response generators
Called by thin `route.ts`/`page.tsx` wrappers:
| File | Generates |
|---|---|
| `icon.tsx` | Favicon/app-icon as `ImageResponse` (next/og); redirects to resized custom icon, else emoji/first-letter over gradient |
| `image.ts` | Cloudflare image resizing; requires signed `url`+`sign`+`sv`; AVIF/WebP negotiation with fallback |
| `llms.ts` | `llms.txt` (root); MDAST tree of section/space/page links; "Agent Instructions" footer when AI enabled |
| `llms-full.ts` | Full-content, **streamed** + **paginated** (100 pages/window, `?page`), concurrency-capped via `pMap` |
| `markdownPage.ts` | Page as markdown; on miss returns **200** "not found" body (agents drop 404 bodies) with similar-page suggestions; prepends LLMs directive unless `displayAgentInstructions=false`; sets `X-Robots-Tag: noindex`, `Vary: Accept` |
| `markdownAsk.ts` | AI answer as markdown (404 if AI disabled); streams `streamSiteAskAnswer`; carries optional `goal` |
| `ogimage.tsx` | OpenGraph 1200×630 `ImageResponse`; redirects to resized custom social preview if set |
| `openapi-proxy.ts` | Scalar "try it" CORS proxy; signed-token + host allowlist; strong **SSRF protection** (blocks private/reserved IPs, DNS re-check, validates every redirect up to 10 hops) |
| `robots.ts` | `robots.txt`; indexable→allow + Content-Signal; public-but-non-indexable→allow named AI UAs only; private→disallow all |
| `rss.ts` | RSS 2.0 from a page's "Updates" blocks (one item per update heading) |
| `sitemap.ts` | Root sitemap index + per-space `sitemap-pages.xml` (depth-decayed priority `2^(-0.25·depth)`) |

---

## 6. Context model (`src/lib/context.ts`)

Rendering is threaded through a nested context hierarchy:
- **`GitBookBaseContext`** = `{ dataFetcher, linker, imageResizer?, locale? }`.
- **`GitBookSpaceContext`** adds `organizationId, space, revision, revisionId, changeRequest, shareKey`.
- **`GitBookSiteContext`** adds `site, siteSpace, siteSpaces, visibleSiteSpaces, sections/visibleSections, customization, structure, scripts, contextId, isFallback, noIndexSearch, isLoggedInVisitor, displayAgentInstructions`.
- **`GitBookPageContext`** = space/site context + current `page`.

`SiteURLData` (a `Pick<PublishedSiteContent>` + `imagesContextId`, `isFallback`, `noIndexSearch`, `isLoggedInVisitor`, `displayAgentInstructions`) is produced by the middleware and threaded via the `x-gitbook-site-url-data` header / route params.

Key assemblers:
- **`getBaseContext({siteURL, siteURLData, urlMode})`** — builds a token-scoped `dataFetcher`, a **`GitBookLinker`** (adapted to `url` vs `url-host` mode), and an `imageResizer`.
- **`fetchSiteContextByIds`** — parallel-fetches site (structure+customizations+scripts) and space context; resolves current `siteSpace`/sections from `SiteStructure` (`type: 'siteSpaces'` vs `'sections'`); computes visible (non-hidden) variants; selects per-site-space customization (falls back to site-level with a warning if unsynced); overrides site title with localized customization title; upgrades linker via `linkerForPublishedURL`.
- **`fetchSpaceContextByIds`** — fetches space (throws on error), optional change request (404→`notFound()`), computes `revisionId` (explicit → CR → space), fetches revision (404→`notFound()`).
- **`fetchSiteContextForSiteSpace`** — derives a context scoped to a different site space (variant switching / markdown-in-space), keeping structure but re-resolving content and forking the linker via `withOtherSiteSpace`.
- `checkIsRootSiteContext`, `filterHiddenSiteSpaces`, section parsers that prune all-hidden sections.

`src/lib/server-actions.ts` rebuilds context from middleware headers inside server actions (always dynamic).

---

## 7. Data & caching layer (`src/lib/data/`)

The **single boundary** to `@gitbook/api`. Everything goes through a **`GitBookDataFetcher`** so the app never touches the client directly.

- **`types.ts`** — the fetcher contract. Every method returns **`DataFetcherResponse<T>`** = `{data}` | `{error}` (errors-as-values; **methods never throw**). Callers pick `throwIfDataError` (throw) or `getDataOrNull` (degrade). Methods: `getPublishedContentSite`, `getSpace`, `getRevision`, `getRevisionPageByPath/Markdown/Document`, `getDocument`, `getComputedDocument`, `getChangeRequest(Changes)`, `getRevisionSemanticChanges`, `getLatestOpenAPISpecVersionContent`, `getSiteRedirectBySource`, `getEmbedByUrl`, `searchSiteContent`, `renderIntegrationUi`, `getUserById`, `listRevisionPageMetaLinks`, plus `api()` and `withToken()` (clone with a different token, for cross-space reusable content).
- **`api.ts`** (⚠️ **CODEOWNERS-guarded** — `@SamyPesse` — because cache-function changes can invalidate all data cache and hammer the API). Each method is wrapped: `cache(...)` (stable-ref React.cache) → `'use cache'` → `wrapDataFetcherError` → `trace`. It passes `noCacheFetchOptions` (`{next:{revalidate:0}}`) to **disable Next's fetch cache** — caching happens at the `'use cache'` boundary. Cache **tags** come from the API `x-gitbook-cache-tag` header + local `getCacheTag(...)`. Cache **lifetimes** via `cacheLife('days'|'max'|'hours'|'minutes'|'weeks')` or dynamic `cacheLifeFromResponse` (parses `x-gitbook-cache-control`). `'use cache: remote'` is **deliberately avoided** for large payloads (revisions — 2MB Vercel limit) and high-cardinality (search — 429 storms). **Cache-busting trick**: dummy version/`_functionName` args change the cache key so the team can invalidate on API-shape changes.
- **`errors.ts`** (tested) — `DataFetcherError`, `wrapDataFetcherError`, `getExposableError`, `throwIfDataError`, `getDataOrNull(res, ignore=[404])`, `extractCacheControl` (treats `max-age=0` as `undefined`).
- **`lookup.ts`** — `lookupPublishedContentByUrl`: computes multiple **lookup alternatives** (`getURLLookupAlternatives`) and `race()`s them against `api.urls.resolvePublishedContentByUrl` (first non-null wins) — a cache optimization letting a cached shorter prefix resolve fastest. Only the primary alternative surfaces errors.
- **`urls.ts`** (tested, extensive) — inbound URL normalization: `getURLLookupAlternatives` (handles `~/revisions/`, `~/changes/`, `/v/<variant>`, custom domain vs `gitbook.io`), `normalizeURL` (rejects >2048 chars, collapses slashes, path-only — query/hash byte-preserved so JWTs survive), `decodeURLPath` (max-2-pass percent-decode DoS guard).
- **`pages.ts`/`revisions.ts`/`visitor.ts`/`cloudflare.ts`** — page-document wrapper; `React.cache`d file/reusable-content `Map`s; VA cookie base-path logic; `getCloudflareContext()`.

### Caching internals
- **`lib/cache.ts`** (tested) — `cache(fn)`, a `React.cache` replacement supporting **non-primitive args**. `React.cache` uses `Object.is` (breaks for per-request object args); this uses `withStableRef` (via `object-identity`) to map structurally-equal objects to one reference. **This is what makes memoization work across a request.**
- **`@gitbook/cache-tags`** — `getCacheTag(spec)` produces stable strings (`site:<id>`, `space:<id>`, `space:<id>:change-request:<id>`, `url:<host>`, `integration:<name>`, `organization:<org>:openapi:<slug>`, etc.). Immutable-data tags (`revision`, `document`, `user`) are `@deprecated` in v2. `getComputedContentSourceCacheTags` derives per-dependency tags for computed documents.
- **`lib/waitUntil.ts`** — extends request lifetime for background work (Cloudflare `ctx.waitUntil`; inline elsewhere). `flushWaitUntil()` for tests.
- **`lib/async.ts`** — `race()` (first-non-null-wins with timeouts, `blockTimeout`/`blockFallback`, abort, worker-safe via `waitUntil`) — engine behind the multi-alternative lookup. `tryCatch()`.

---

## 8. Visitors, adaptive content, auth (OAuth/MCP)

**Two-tier trust model**: signed JWT / API-minted claims **gate** protected + adaptive content; unsigned `visitor.*`/public claims only **personalize**.

- **`lib/visitors.ts`** (tested) — run in middleware. `getVisitorData` returns `{visitorToken, unsignedClaims, visitorParamsCookie}`. Token priority: (1) OAuth Bearer/access_token, (2) `?jwt_token=` (empty string = sign-out), (3) path-scoped VA cookie `gitbook-visitor-token~<hash(path)>`, (4) plain custom visitor cookie. VA cookies are **path-scoped** (via `object-hash`) so co-hosted sites don't collide. Unsigned claims merge `gitbook-visitor-public*` cookies + `visitor.*` params (dot-path nesting, type-coerced). `getResponseCookiesForVisitorAuth` persists the JWT (httpOnly, secure+sameSite:none in prod, `maxAge` tracks JWT `exp`, min 60s/default 7d). `normalizeVisitorURL` strips secrets from canonical URLs. `serveVisitorClaimsDataRequest` serves `/~gitbook/visitor`. Base-path matching tries prefixes **longest-first**.
- **`lib/adaptive.ts`** — `getVisitorAuthClaims` `jwtDecode`s the resolved `apiToken` (a `SiteAPIToken` the API minted *after* validating the visitor JWT). Trust derives from the API minting it (jwtDecode doesn't verify signatures).
- **`lib/oauth-protected.ts`** (tested) — **RFC 9728 OAuth Protected Resource Metadata** for MCP endpoints. `/~gitbook/mcp/auth` always advertises auth; `/~gitbook/mcp` is protected only when the site enforces VA. Emits PRM JSON (`authorization_servers: ["<GITBOOK_OAUTH_SERVER_URL>/<siteId>"]`) or a **401 challenge** (`WWW-Authenticate: Bearer realm="mcp", resource_metadata=...`). Suffix predicates sorted longest-first.
- **`lib/auth-login-link.ts`** (tested) — detects whether an href points at the site's `~gitbook/auth/login` (special link/button treatment) across all serving contexts.

---

## 9. URL / link generation (`src/lib/links.ts` + friends)

Layering (low→high): `paths.ts` (pure string ops) → `urls.ts` (URL classification) → `data/urls.ts` (inbound lookup) → `links.ts` (outbound rendered links). `routes.ts` (despite name) = **HMAC signature verification** (`withVerifySignature`; not constant-time; skipped if no `GITBOOK_SECRET`).

**`GitBookLinker`** models a served URL as `host / siteBasePath / spaceBasePath(section+variant) / page`. Methods: `toPathInSpace`, `toPathInSite`, `toRelativePathInSite`, `toPathForPage`, `toAbsoluteURL`, `toLinkForContent` (downgrades same-site absolute URLs to relative), `fork`, `withOtherSiteSpace`. Decorators: `linkerForPublishedURL` (preview URL rewriting), `linkerWithAbsoluteURLs` (canonical/OG/sitemap), `linkerWithMarkdownPages` (appends `.md`). `fork` vs `withOtherSiteSpace`: fork rebuilds with a new absolute base; the latter resolves relative to the site (cross-space links within one site) and re-binds `toPathForPage`.

- `paths.ts` (tested) — `joinPath`, `removeTrailing/LeadingSlash`, `with(Leading|Trailing)Slash`, `getExtension`.
- `urls.ts` (tested) — `checkIsHttpURL`, `checkIsExternalURL`, `checkIsAnchor`, `resolveAnchorURL`.

---

## 10. Document & page model

- **`lib/document.tsx`** (tested) — stateless helpers over `JSONDocument` (Slate-derived; children under `nodes` OR `fragments`, text in `text.leaves[].text`): `hasFullWidthBlock`/`hasAPIBlock`/`hasTopLevelBlock` (layout), `hasMoreThan`, `getNodeText`/`getNodeReactText`, `getNodeFragmentByType/ByName`, `isNodeEmpty`, `getBlockTitle`, `getBlockById`, `getBlocksByType`, `isHeadingBlock`. ⚠️ Two known quirks: a legacy unused `DocumentSection` export duplicate; `findBlock` returns `null` on first non-block sibling (can miss blocks after text/inline siblings).
- **`lib/document-sections.ts`** (tested) — **async** "on this page" TOC builder. Emits h1/h2 (h2-before-h1 promoted; h3 excluded), recurses `columns`/`stepper`/`updates`, resolves OpenAPI + reusable-content blocks. Failures degrade to omitted sections.
- **`lib/pages.ts`** (tested) — navigation over `Revision.pages`: `resolvePagePath`, `resolvePageId`, `resolvePrevNextPages` (visible-only), `getPagePath(s)`, `resolveFirstDocument`, `extractPagePath`, `getSimilarPages` (typo-tolerant "did you mean" via Levenshtein + segment/token scoring).
- **`lib/markdown.ts`** (tested, snapshots) — `parseMarkdown`: Markdown → **sanitized HTML** via unified (`remarkParse→remarkGfm→remarkRehype→rehypeRaw→rehypeSanitize→rehypeStringify`).
- **`lib/markdownPage.ts`** — the `.md`/LLM page representation. Fetches API pre-rendered markdown → mdast → drops frontmatter → **rewrites links** (content refs to absolute URLs; unresolved → `broken://` sentinel so crawlers don't follow). Empty-with-children pages → generated group listing. AST-level, never emits HTML.
- **`lib/references.tsx`** (tested) — `resolveContentRef` resolves *every* `ContentRef` kind (url/file/anchor/page/space/user/collection/reusable-content/openapi/tag) → `ResolvedContentRef`. Handles cross-space refs via `document.meta.token`, building a scoped context/linker (prefers the space within the current site). Parses the API's stable-ref string form. This is the bridge OpenAPI fetching relies on.

---

## 11. Component architecture (`src/components/`)

~402 TS/TSX files; ~36% are client components (`'use client'`). Server-first.

### Layout composition hierarchy
```
CustomizationRootLayout (server; renders <html>/<body>, no app-root layout exists)
 └ RootLayoutClientContexts (Translate, Tooltip, NavigationStatus, LoadingState, ScrollPage)
   └ SiteLayout (server)
     └ SiteLayoutClientContexts (ThemeProvider/next-themes, NuqsAdapter, LinkContext, SearchContext, ReducedMotion)
       └ AIContextProvider
         └ SpaceLayout (server)
           └ SpaceLayoutServerContext → AdaptiveVisitor → CurrentContent → Visitor → Insights → AIChatProvider
             ├ Announcement, Header, NavigationLoader, AIChat/AskAITextSelection
             ├ TableOfContents (sticky left)
             ├ SitePage → PageContext → (PageCover, PageAside right, PageBody main), PageClientLayout
             └ Footer
```

- **`CustomizationRootLayout`** — preloads fonts, injects color CSS variables (`--primary-*`, `--tint-*`, `--info/warning/danger/success-*`, `--header-*`) from customization, sets HTML data-attributes/classes for theme/corner/sidebar/depth/links style, announcement dismissal script.
- **`SiteLayout`** — preconnects API/icons/assets, preloads the search index (`~gitbook/site-index`), loads integration scripts, `CookiesToast`, `AdminToolbar`; exports `generateSiteLayout{Metadata,Viewport}`.
- **`SpaceLayout`** — sets up all providers; renders Header (sticky, backdrop-blur, theme-aware, section tabs), TOC, content, Footer; content shifts right for open AI chat (`chat-open:mr-(--ai-chat-width)`).
- **`SitePage`** (`fetch.ts` + `SitePage.tsx`) — fetches page by pathname (fallback to root; case-normalization redirects); computes layout flags (`withTopHeader`, `withFullPageCover`, `withSections`, `withPageFeedback`); generates hierarchical metadata + OG image; renders PageAside + PageBody. `PageClientLayout` (client) handles scroll-to-hash, page metadata registration, `--cover-height` tracking.
- **`Header`/`Footer`/`TableOfContents`/`PageBody`/`PageAside`** — all server components with sticky positioning driven by CSS variables (`--toc-top-offset`, `--outline-top-offset`, `--cover-height`), responsive collapsing to mobile SideSheets, layout-aware (`layout-default` max-w-3xl vs `layout-wide` max-w-6xl, `page-has-toc`, `page-api-block`).

### `src/components/DocumentView/` — the block renderer
`Block.tsx` and `Inline.tsx` are `switch`-based **dispatchers** mapping API node `type` → component. `Blocks`/`Inlines` recurse (tracking `ancestorBlocks`/`ancestorInlines`).

**Block types**: paragraph, heading-1/2/3 (rendered as h2/h3/h4), list-ordered/unordered/tasks, list-item, columns, code, hint, images, tabs, expandable, table, swagger/openapi-operation, openapi-schemas, openapi-webhook, embed, blockquote, math, file, divider, drawing, content-ref, integration, reusable-content, stepper, stepper-step, updates, update, prompt, `if` (null — processed by API). Child-only (rendered by parent): image, code-line, tabs-item, column.

**Inline types**: link, inline-math, annotation, emoji, mention, inline-image, button, icon, expression. **Text marks** (in `Text.tsx`): bold, italic, code (sorted last), strikethrough, color, keyboard, superscript, subscript.

Notable subsystems:
- **CodeBlock/** — server-side **Shiki** highlight (diff-notation `[!code ++/--]`, multiple comment styles); client fallback for Mermaid diagrams (fullscreen/pan-zoom), inline expressions, expandable, or offscreen code. Copy + "Ask AI" buttons.
- **Table/** — grid + cards views, sticky header/first-column, client-side **search** with per-column filters (select/checkbox), records sorted by `orderIndex`.
- **OpenAPI/** — wraps `@gitbook/react-openapi`; resolves spec via `lib/openapi/*`; one-operation-per-page mode; "Available in MCP" badge.
- **Integration/** — renders ContentKit via `@gitbook/react-contentkit`; server-renders initial UI, wraps in client context when a **webframe** is present (postMessage validated against first-party domains; supports `@webframe.navigate` and page-context exposure).
- **Tabs/** & **Expandable/** — server structure + client state (localStorage `@gitbook/tabsState`; hash-based selection; synced tabs by title). In print mode: tabs render sequentially, expandables forced open.
- **Math** (KaTeX server + MathJax client fallback), **Embed** (iframely), **InlineLink** (ref resolution + hover tooltip previews, disabled if >500 links), **Annotation** (inline + popover), **Prompt/** (AI prompt block: "Open in" dropdown + "Copy prompt"), **ReusableContent**, **Updates/UpdatesFilter** (tag filtering), **Images** (responsive resizing, dark-theme variants, lazy offscreen / eager in print).
- Print mode (`context.mode==='print'`) changes many behaviors; lazy loading via `isBlockOffscreen`.

### Search (`src/components/Search/`)
URL-backed state via **nuqs** (`q`, `ask`, `scope`). `useSearchController` (Cmd+K open, Cmd+I ask/AI, arrow-key navigation). Results merge **local** (flexsearch over `~gitbook/site-index`) + **remote** (server API) via **Reciprocal Rank Fusion** (`reciprocalRankFusion.ts`, tested). Scopes: `all`/`default`/`extended`/`current`; **default scope splits into two parallel requests** (current site space + others) rendering each as it arrives, current-space scores boosted. **Ask** (AI answer): `SearchAskAnswer` streams `streamAskQuestion` server action (`ai/rsc` `readStreamableValue`) with sources + follow-ups.

### AI / Assistant (`src/components/AI/` + `AIChat/`)
- **`useAI`** — assembles assistants (builtin GitBook + integration assistants); modes overlay/sidebar/search.
- **`useAIChat`** — **zustand** store: `opened, messages, followUpSuggestions, control, responding, loading, references, draft, queuedMessages`. `streamResponse` connects to `streamAIChatResponse` server action, processes `AIStreamResponse` events (finish, tool-call-pending → control UI, followup suggestions), detects superseded streams, flushes queued follow-ups.
- **Tools**: built-in + integration + control tools; `navigateToPage` (opens a page on the reader's behalf, pushed to history), navigation/references. **References** (page/code/text) serialized into a markdown preamble prepended to the user message.
- **UI**: `AIChat` SideSheet (resizable via `useAIChatWidthStore` — zustand+localStorage, 384–640px), `AIChatMessages` (grouped, "Explored with N tools" collapsible, feedback thumbs), queued-message badges, suggested/followup questions, `AskAIParagraphButton` (hover-margin) + `AskAITextSelection`.
- **MCP** (`~gitbook/mcp`): tools `searchDocumentation`, `getPage`, `askQuestion` (AI answer + `goal` param), `sendFeedback` (agent findings → `agent_feedback` insights). Only on AI-enabled sites.

### Behavioral/interactive components
- **ThemeToggler** (next-themes; light/system/dark; hydration guard).
- **PageFeedback** ("Was this helpful?" → `page_post_feedback[_comment]` insights).
- **Announcement** (server resolves refs; client dismiss in localStorage; early inline script prevents flicker; info/warning/danger/success; danger non-dismissible).
- **Ads** (BuySellAds; viewport-lazy; `ad_display`/`ad_click`; `?ads_preview=`).
- **Cookies** (`CookiesToast`; respects GPC; secure sameSite:none cookie 365d; suppressed for AI UAs / custom banners).
- **AutoRefreshContent** (server action compares `revisionId`; polls 5min after load, visibility-aware).
- **AdminToolbar** (ChangeRequest / Revision / AuthenticatedUser variants; refresh button; UTM links; localStorage visibility).
- **Insights** — analytics: `InsightsProvider` batches events per pathname, debounced 1.5s flush, sync flush on unload (`keepalive`). Enriches with session (30min TTL), device/visitor id (synced or random, GPC-aware, cookie-consent gated), location, VA claims. Server side in `lib/tracking.ts`.
- **PageActions** — export/share dropdown: copy/view markdown (LRU cache), open in ChatGPT/Claude/Cursor, edit on Git, MCP URL/command/VSCode, PDF, RSS, open assistant. Zustand per-action "copied" state.
- **Integrations** (`LoadIntegrations`) — global `window.GitBook` API: `registerTool`/`registerAssistant`/`registerCookieBanner`, event dispatcher, zustand stores.
- **Embeddable** — iframe docs/chat widget (`force-static`; events tagged `Embed`; tabs/close/control buttons; no feedback; `robots: noindex`).
- **PDF** — server-only print HTML; `?page`/`only`/`limit`/`back` params; internal-anchor linker; trademark.
- **SiteAuth** — login links enriched with `?location=` for post-auth redirect.

### Primitives / hooks / utils / state
- **`primitives/`** (~28) — Button, Link (insights tracking), StyledLink, Input, Checkbox, Card, Skeleton, DropdownMenu, Popover, HoverCard, SideSheet, Collapsible, Tooltip, ScrollContainer, DateRelative, KeyboardShortcut, SegmentedControl, NavigationLoader, Loading(Pane/StateProvider), StyleProvider, ToggleChevron, DownloadButton, Emoji. ~60% client.
- **`hooks/`** — `useScrollActiveId`, `useScrollPage`, `useHash` (from NavigationStatusContext, not hashchange), `useIsMounted`, `useToggleAnimation`, `useCurrentPagePath`, `useCurrentContent`, `useCurrentPage` (zustand `visitedPagesStore`), `useNow`, `useListOverflow`, `useCurrentPageMetadata` (zustand — Page writes, Layout reads), `useBackToSpace`, `useIsMobile`, `useControlledState`, `useInViewportListener`, `useHasBeenInViewport`, `useScrollListener`.
- **`utils/`** — `Image` (responsive/zoom/resize), `ZoomImage`, `Favicon`, `dates` (memoizee Intl formatters), `getURLForLLM`, `isAIChatEnabled`, `link` (external detection, embed URL normalization).
- **`Adaptive/`** — `AdaptiveVisitorContextProvider` (Suspense-based claims fetch by `contextId`, in-memory cache); feeds OpenAPI prefill + expression evaluation.
- **`PageContext`** (pageId/spaceId/title), **`PageIcon`** (emoji or `@gitbook/icons`).
- **State management**: zustand in ~8 places (page metadata, visited pages, visitor id, AI chat + width, integrations, page actions, embeddable). Only `useAIChatWidthStore` uses `persist` (localStorage). Contexts for LinkContext, NavigationStatus, PageContext, CurrentContent, AdaptiveVisitor.

---

## 12. Customization & theming (§ `tailwind.config.ts`, `@gitbook/colors`)

A **dynamic, CSS-variable-driven design-token system** so one build themes per-site from customization settings.
- **Color scales as CSS vars**: `generateVarShades()` reads `@gitbook/colors` `scale`; semantic scales `primary`, `contrast-primary`, `tint`, `contrast-tint`, `neutral`, `contrast-neutral`, plus `header-background`/`header-link`. Rendered `rgb(var(--primary-500))` — actual values injected per site at runtime. Status colors `info`/`warning`/`danger`/`success` (+`contrast-*`) likewise. Static brand shades (`yellow`, `teal`, `pomegranate`, `periwinkle`) from hex.
- **Tailwind plugins** drive layout/customization via `body:has()`/`html.<class>` variants: `navigation-open`, `chat-open`, `site-header`, `embed`, `hydrated`, theme-preset combos (`theme-clean-tint`, `theme-muted-no-tint`, …), `layout-default`/`layout-wide`, `page-has-toc`, `has-sidebar`, `page-has-outline`, `page-api-block`, `page-cover-background`, `print-mode`. Plus `@tailwindcss/container-queries` and a `perspective` utility.
- **`@gitbook/colors`** — OKLCH/OKLab pipeline. `colorScale(hex, opts)` maps 12 steps to `ColorCategory` roles (backgrounds/components/borders/accents/text); `baseStep` "exact base" anchors a near-neutral extreme tint (e.g. warm off-white `#F5F3EF`) as the exact page background. `dpsContrast` (Andrew Somers' Delta Phi Star) + `colorContrast` pick best foreground. Defaults: primary `#346DDB`, tint `#787878`.

---

## 13. Internationalization (`src/intl/`)

Hand-rolled, tree-shakeable, type-safe (no external i18n lib). **41 locales** in `translations/` (`en` default + bundled eagerly; the rest lazy-loaded via dynamic `import()`; missing keys fall back to English). `t(language, id, ...args)` interpolates `${n}` placeholders → `ReactNode` (or string when no ReactNode args); `tString` collapses to string; missing keys **throw**. `server.ts`: `getSpaceLocale`/`getSpaceLanguage` (prefers `context.locale`, then deprecated `customization.internationalization.locale`, else `'en'`); `getContentLocale` for the HTML `lang`. `client.ts`: `TranslateContext` + `useLanguage()`.

---

## 14. OpenAPI subsystem

- **`lib/openapi/`** bridges GitBook OpenAPI blocks to the parser/renderer packages. `fetch.ts`: new `openapi` refs already carry a parsed filesystem from the API (no HTTP); legacy "swagger" refs fetch + `parseOpenAPI` + `enrichFilesystem`, cache failures ~1 minute, re-throw errors *outside* the `'use cache'` boundary. `enrich.ts` (tested) converts Markdown descriptions → `x-gitbook-description-html`. `resolveOpenAPI{Operation,Schemas,Webhook}Block.ts` are memoized via `WeakMap` keyed by the block object (dedupes double resolution by TOC + render). `proxy-token.ts` (tested) HMAC-signs the allowed-origin list for Scalar "Test it" (constant-time verify, disabled without secret). `computedSourceProps.ts` extracts method/deprecated for TOC badges.
- **`@gitbook/openapi-parser`** — wraps Scalar's parser + json-magic; browser-safe (in-memory `Filesystem` abstraction, no fs). `parseOpenAPI` tries V3, falls back to V2→V3 upgrade. Lenient (trusts successful parse). Rate-limits remote `$ref` fetches (40 default). Rich GitBook `x-` extensions (`x-codeSamples`, `x-gitbook-mcp[-url]`, `x-stability`, prefill, `x-hideTryItPanel`, `x-enable-proxy`, `x-expandAllResponses`, etc.). `shouldIgnoreEntity` hides `x-internal`/`x-gitbook-ignore`.
- **`@gitbook/react-openapi`** (largest support package, ~80 files) — two-phase **resolve → render**. Style-less: delegates code-block/heading/document/icon/translation rendering to a host **context** (`OpenAPIClientContext` marked `$$isClientContext$$` for the server/client boundary). Built-in code-sample generators: HTTP, cURL, JS fetch, Python requests. Prefers Redocly custom samples; Scalar "Test it" via signed proxy. 9 locales. Cycle-safe serialization via `flatted`/`decycle`.

---

## 15. Supporting packages (the other 11)

- **`react-contentkit`** — renders ContentKit (`text`, `block`, `box`, `divider`, `markdown`, `modal`, `image`, `button`, `textinput`, `input`, `hstack`/`vstack`, `card`, `codeblock`, `webframe`). Server-driven: `update()` re-invokes a render callback (a Next server action) with merged state; `dispatchAction` handles `@ui.modal.open/close`, `@ui.url.open`, `@webframe.navigate`; `{ $state: 'key' }` dynamic bindings. Separate `./client` export keeps server rendering out of client bundles. Style-agnostic (host injects icons/codeBlock/markdown).
- **`react-math`** — `MathFormula` three-tier fallback: KaTeX (server, `renderToString`) → MathJax (lazy client, injects `tex-chtml.js`) → plain text. `gitbook-math` CLI copies MathJax assets.
- **`expr`** — safe expression engine behind **adaptive content**. `ExpressionRuntime`: parses a JS-expression subset with **acorn** (rejects non-expression nodes), evaluates with `eval-estree-expression` (no arbitrary code). `evaluateBooleanAll` (AND) gates adaptive content; empty→true, error→false. `{{ expr }}` templates. Typed **symbol system** (`SymbolsTable`, infer from value / JSON Schema, wildcard matching). Autocomplete via `acorn-loose`/`acorn-walk`. Operators: `== != === !== < <= > >= in && || ?:`.
- **`embed`** — three outputs: programmatic client (`createGitBook({siteURL})` → frame URL with theme/`jwt_token`/`visitor.*`, `bidc` postMessage channel), **standalone script** (`window.GitBook(...)` at `~gitbook/embed/script.js`, floating button, forces `clipboard-write`), and React (`GitBookProvider`/`GitBookFrame`). Protocol supports tabs/actions/greeting/suggestions/custom AI tools (`execute` callback + `confirmation`)/trademark.
- **`colors`** — see §12.
- **`icons`** — Font Awesome Pro-based; `<Icon>` inlines server-resolved trusted SVG or uses a CSS-mask over the SVG URL (`currentColor`). `IconsProvider`/`getIconStyle` (style exceptions via generated `styles-map.json`). `GITBOOK_ICONS_ASSET_VERSION='2'` must match client/server. Custom icons (gitbook, gitbook-assistant, cursor, vscode, mcp, chatgpt, claude, …). `gitbook-icons` CLI. Generated `data/icons.json` (gitignored).
- **`fonts`** — `getDefaultFont({font,text,weight})` picks the Google Font subset whose unicode-range best covers `text`. Generated `data/fonts.json` (gitignored).
- **`emoji-codepoints`** — private; `build.ts` maps base→fully-qualified codepoints from `emoji-assets`; consumers import `dist/index.ts` directly.
- **`browser-types`** — types for global `window.GitBook` (`registerTool`/`registerAssistant`/`registerCookieBanner`, `isCookiesTrackingDisabled`, `isGlobalPrivacyControlEnabled`); augments `Window`.
- **`cache-tags`** — see §7.

---

## 16. Images / icons / fonts / emojis / SEO / feeds

- **`lib/images/`** — signed image-resizing pipeline. `createImageResizer` → `getResizedImageURL` yields `/~gitbook/image?url=…&width=…&sign=…&sv=…`. `checkIsSizableImageURL` (tested) classifies Resize/Skip/Passthrough (SVG passthrough). **`signatures.ts`**: three signing generations (v2 FNV-1a over `url:imagesContextId:key` — **context-scoped** so images can't be reused across co-hosted sites; v1 no context; v0 legacy SHA-256). `getImageResizingContextId` (tested) derives context id (proxy/preview/host). `resizer/` backends: `cf-fetch` (Cloudflare `fetch(url,{cf:{image}})`) + `gitbook-service` (`images.gitbook.com` + `GITBOOK_IMAGE_RESIZE_SALT`). Degrades gracefully everywhere.
- **`lib/icons/inline.ts`** (tested) — server-side SVG inlining so icons render at first paint (walks pages/tags/sections/document; parallel fetch with in-flight cache + `pRetry`; sanitizes viewBox/markup). The in-flight-cache lookup (`getInlineIconSource`) now `.catch(() => null)`s the shared promise before returning it to concurrent callers — the original code only guarded the *first* caller's own `try/catch`; any other concurrent request for the same (failing) icon got an unhandled rejection that crashed the whole render (500 → client "Application error"). Trivial to hit locally, since local dev only has the `custom-icons` set (see §25.11).
- **`lib/emojis.ts`** (tested) — `getEmojiForCode` via `@gitbook/emoji-codepoints` (`Object.hasOwn` prototype-pollution guard, ZWJ sequences).
- **`lib/seo.ts`** — `isPageIndexable` (page + ancestors free of `noIndex`/`noRobotsIndex`), `isSiteIndexable` (false for `noIndexSearch`, change requests, non-current revisions, non-public visibility). **`lib/sitemap.ts`** (tested) — `getIndexablePages` (flatten, skip link/computed, prune `noRobotsIndex` subtrees).
- **`lib/llms-directive.ts`** (tested) — `getLLMsTxtURL`, `getPageMarkdownURL`, `renderLLMsTxtMarkdownDirective` (blockquote pointing agents at llms.txt + `.md`).
- **`lib/csp.ts`** — deliberately **permissive** CSP (embeds arbitrary customer/integration content): wildcard `default/connect/font/frame-src`, `script-src` allows `unsafe-inline`/`unsafe-eval`; `object-src 'none'` is the lockdown; `frame-ancestors https:` (prod). ⚠️ interpolates `GITBOOK_ASSETS_URL` (could become literal `"undefined"` if unset).
- **`lib/rollout.ts`** — `isRollout({discriminator, percentageRollout})` deterministic sticky bucketing (djb2 hash mod 100); always true in dev/Vercel preview.
- **`lib/browser/`** — client storage utilities defensive against blocked storage (Safari/Firefox privacy): cookies (js-cookie swallowing `SecurityError`), local/session storage (SSR-guarded), `isAIUserAgent()` (hardcoded AI-bot UA list, hides consent UI from crawlers).
- **`lib/proxy.ts`/`lib/preview.ts`** (both tested) — proxy host + preview host detection and path-scoped short-lived cookies.

---

## 17. Deployment (Vercel + Cloudflare)

Single Next.js build, runtime selected by **`GITBOOK_RUNTIME`** (`vercel` | `cloudflare`).

### Vercel (`2v`)
`next build --webpack` + `vercel build`/`vercel deploy --prebuilt`. `deploymentId` (skew protection) prefixed `t-`/`s-`/`p-` per `VERCEL_TARGET_ENV`, truncated to 32 chars. On Cloudflare `deploymentId` is forced `undefined` (opennextjs-aws #1136).

### Cloudflare (`2c`, OpenNext)
`open-next.config.ts`: two function groups — **default** (Next server, `cloudflare-node` wrapper) and **middleware** (`external: true`, `cloudflare-edge`, split into its own Worker). `enableCacheInterception: true`, `edgeExternals: ['node:crypto']`. Build: `GITBOOK_RUNTIME=cloudflare opennextjs-cloudflare build` → `.open-next/`.

**Three-Worker split** (`openNext/customWorkers/`):
1. **`gitbook-open-v2` (middleware)** — entry for all traffic; binds `ASSETS`; runs Next middleware; if no response, forwards to the server Worker (`DEFAULT_WORKER`), pinning it to the matching `WORKER_VERSION_ID` via `Cloudflare-Workers-Version-Overrides` (version affinity); adds `x-open-next-continent`.
2. **`gitbook-open-v2-server`** — runs the actual Next server handler.
3. **`gitbook-open-v2-do`** — handles no requests; only **hosts the Durable Object classes** cross-script: `DOQueueHandler` (ISR revalidation queue), `DOShardedTagCache` (sharded tag cache), `R2WriteBuffer` (buffers R2 writes around the 1-write/key/sec limit).

**Caching stack**: `incrementalCache/` — `GitbookIncrementalCache` R2-backed (`NEXT_INC_CACHE_R2_BUCKET`), sha256 keys, writes via `R2WriteBuffer` DO, wrapped in OpenNext `withRegionalCache` (5-min regional TTL). `queue/` — `GitbookISRQueue` (`do-queue`, via `waitUntil`). `tagCache/` — `GitbookTagCache` (`do-sharded-tag-cache`, `baseShardSize:12`, 1-day regional TTL, soft/hard replicas 2, default region `enam`). `updateWrangler.ts` injects the server Version ID + preview hostname into the middleware config at deploy time.

**`wrangler.jsonc`** — name `gitbook-open-v2`, compat `2025-04-14`, flags `nodejs_compat`/`allow_importable_env`/`global_fetch_strictly_public`. Per-env (`preview`/`staging`/`production`): R2 buckets, service bindings (`WORKER_SELF_REFERENCE`, `GITBOOK_API` → API-cache service), routes (`open-2c`/`static-2c` on gitbook.com / gitbook-staging.com), tail consumers. **Preview has no Durable Objects** (they block preview-URL generation). Prod: `MAX_REVALIDATE_CONCURRENCY: 100`.

### `next.config.mjs` highlights
`experimental`: `authInterrupts` (throws "forbidden" on expired token during revalidation), `useCache`, `staleTimes {dynamic:3600, static:3600}`, `optimisticClientCache: false`, `prefetchInlining: true`. Passes `GITBOOK_*` env through. `assetPrefix: GITBOOK_ASSETS_PREFIX`. `/~gitbook/static/*` → `Cache-Control: immutable` + `ACAO: *`. Images `remotePatterns: *.gitbook.io`.

### `tsconfig.json`
`strict`, `noUncheckedIndexedAccess`, `moduleResolution: bundler`, `jsx: react-jsx`, `noEmit`, alias `@/*`→`./src/*`, `types: ["bun-types"]`. Excludes the separately-built packages (openapi-parser, react-openapi, react-math).

---

## 18. Turborepo pipeline

Root `turbo.json`: `globalEnv` = `NODE_ENV, CI, ARGOS_*, GITHUB_*, GITBOOK_*, NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`. Tasks: `generate` (prep, outputs `dist`), `build` (`^build`+`generate`, outputs `.next` minus cache + `dist`), `build:cloudflare` (+`.open-next`), `typecheck` (`^typecheck`+`build`), `lint`, `unit` (`^unit`+`^build`+`generate`), `e2e`/`e2e-customers` (env `BASE_URL`/`SITE_BASE_URL`), `dev` (persistent, uncached), `publish-to-npm` (npm provenance env). `packages/gitbook/turbo.json` extends root, overrides `generate` to output `public/~gitbook/static/{icons,math,embed}/**` and depend on `@gitbook/embed#build`.

---

## 19. Patches (`patches/`, wired via `patchedDependencies`)

- **`@vercel/next@4.4.2`** — raises `EDGE_FUNCTION_SIZE_LIMIT` 4 MiB → 10 MiB (the middleware/edge bundle exceeds Vercel's default cap).
- **`decode-named-character-reference@1.0.2`** — removes the `"browser"` export condition so the non-DOM `./index.js` is used everywhere (the DOM variant uses `document`, unavailable in Workers).
- **`next@16.2.6`** — ~1 MB patch to two *compiled* Next runtime files (React Server DOM webpack client + app-page dev runtime); a downstream fix applied directly to vendored output (minified, intent not self-documented).

---

## 20. Scripts

- **`scripts/publish-if-new.sh`** — skips if version already on npm; strips `development` exports; `bun pm pack` (resolves workspace deps) then `npm publish <tarball> --no-workspaces --provenance` (Bun can't publish with provenance yet). `--dry-run` supported.
- **`scripts/strip-development-exports.mjs`** (+ test) — deletes `"development"` keys from `exports` before publishing (the in-repo dev condition must not leak).
- **`packages/gitbook/scripts/generate.sh`** — copies generated static assets into `public/~gitbook/static/`: `gitbook-icons`, `gitbook-math`, copies `../embed/standalone/` → `.../embed`, then `wrangler types`.
- **`packages/gitbook/scripts/clean.sh`** — removes `.next` + generated static dirs.

---

## 21. CI/CD (`.github/`)

- **`ci.yaml`** (PR + push to main) — Format (`biome check`), Test (`bun unit`), Build, Typecheck. `bun install --frozen-lockfile`, `PUPPETEER_SKIP_DOWNLOAD=1`, 6-min timeouts.
- **`deploy-preview.yaml`** — approval gate for forked PRs; deploys to **both** Vercel and Cloudflare; posts/updates a PR comment with a deployments table; runs visual tests (`v2-vercel`, `v2-cloudflare`, `customers-v2-*`) + browserless tests.
- **`deploy-staging.yaml` / `deploy-production.yaml`** — push to main → Vercel + Cloudflare (`deploy: true`) on gitbook-staging.com / gitbook.com.
- **`publish.yaml`** — `changesets/action`: `changeset version` then `publish-all-packages` (Node 22 + npm-latest for provenance; `COREPACK_ENABLE_PROJECT_SPEC=0`).
- **Composite actions**: `setup-bun`, `deploy-vercel` (1Password secrets, `vercel build/deploy`), `deploy-cloudflare` (`turbo build:cloudflare`, uploads 3 Workers in order: DO → server → inject version → middleware). **`gradual-deploy-cloudflare`**: deploys server at 0%, middleware at 100% (safe via version-override pinning), then server at 100% — keeps middleware↔server versions bound during rollout.
- **Secrets**: Cloudflare/Vercel tokens from GH secrets; all `GITBOOK_*` runtime secrets loaded at deploy time from **1Password** (`op://gitbook-open/<env>`), never committed. `download:env` script: `op read op://gitbook-x-dev/gitbook-open/.env.local`.

---

## 22. Testing

- **Unit** — **Bun test** (not vitest/jest). `bun unit` → `bun test {src,packages} --preload ./tests/preload-bun.ts`. `preload-bun.ts` mocks `server-only` (breaks under Bun). Colocated `*.test.ts` throughout `src/`. Notably tested: cache, async, visitors, oauth-protected, document(-sections), pages, markdown, paths, urls, links, references, proxy, preview, sitemap, sites, emojis, llms-directive, updates, embeddable, data/{errors,urls,visitor}, openapi/{enrich,proxy-token}, images/*, icons/inline. Notably **untested**: context, customization, routes, markdownPage, tracking, csp, rollout, adaptive, data/api.
- **Browserless integration** (`tests/`, `bun e2e-browserless`) — HTTP-level against a deployed `BASE_URL`/`SITE_BASE_URL`: `cors`, `llms`, `markdown` (per-UA serving: GPTBot/ClaudeBot yes, Slackbot/Googlebot no), `mcp`, `robots`, `rss`.
- **E2E / visual** — **Playwright + Argos** (`e2e/`), Chromium only with deterministic font rendering (`--disable-lcd-text`, `--font-render-hinting=none`, `reducedMotion: reduce`). `internal.spec.ts` (~214 cases across themes/locales/tints/layouts/header presets), `customers.spec.ts` (real customer sites), `cookie-banner.spec.ts`, `pdf.spec.ts`. `util.ts` harness: `runTestCases`, `getCustomizationURL` (encodes customization into a URL). Argos diffs Vercel vs Cloudflare renders separately (`ARGOS_BUILD_NAME`).

---

## 23. Environment variables

`GITBOOK_*` passed through `next.config.mjs`: `GITBOOK_API_URL`, `GITBOOK_APP_URL`, `GITBOOK_OAUTH_SERVER_URL`, `GITBOOK_PREVIEW_BASE_URL`, `GITBOOK_INTEGRATIONS_HOST`, `GITBOOK_INTEGRATIONS_CONTENT_HOST` (separate origin for WebFrames — stored-XSS mitigation), `GITBOOK_IMAGE_RESIZE_URL/_SALT/_SIGNING_KEY/_MODE`, `GITBOOK_ICONS_URL`, `GITBOOK_ICONS_TOKEN`, `GITBOOK_URL`, `GITBOOK_API_TOKEN`, `GITBOOK_ASSETS_PREFIX`, `GITBOOK_SECRET`, `GITBOOK_FONTS_URL`, `GITBOOK_RUNTIME`, `GITBOOK_BLOCK_SEARCH_INDEXATION`, `GITBOOK_ALLOW_CUSTOMIZATION_OVERRIDE`. Also `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, `BUILD_VERSION` (7-char SHA), hardcoded `GITBOOK_V2: 'true'`. Build/deploy-only: `GITBOOK_HEAD_SHA`, `GITHUB_SHA`, `VERCEL_TARGET_ENV`. Env is centralized in `lib/env/globals.ts` (`server-only`, never leaked to client). Cloudflare-only vars in the `*Wrangler.jsonc` files (`STAGE`, `IS_PREVIEW`, `MAX_REVALIDATE_CONCURRENCY`, `SHOULD_BYPASS_CACHE`, `PREVIEW_HOSTNAME`/`WORKER_VERSION_ID` placeholders, bindings `ASSETS`/`NEXT_INC_CACHE_R2_BUCKET`/`WORKER_SELF_REFERENCE`/`DEFAULT_WORKER`/`GITBOOK_API`/`WRITE_BUFFER`/`NEXT_TAG_CACHE_DO_SHARDED`/`NEXT_CACHE_DO_QUEUE`).

Key roles: `GITBOOK_RUNTIME` selects code paths; `GITBOOK_URL/APP_URL/API_URL/OAUTH_SERVER_URL` point at backends; `GITBOOK_SECRET` signs revalidation + proxy tokens; `GITBOOK_BLOCK_SEARCH_INDEXATION` keeps previews out of search indexes; `GITBOOK_ALLOW_CUSTOMIZATION_OVERRIDE` lets e2e URLs override customization.

---

## 24. Changesets (release management)

`.changeset/config.json`: `commit: false`, `access: public`, `baseBranch: main`, `updateInternalDependencies: patch`. Each change adds a `.changeset/*.md` (frontmatter: package → semver bump). After committing code, add a changeset and commit it separately with message `changeset`. Recent/pending work (a good signal of current direction): cards carousel layout, MCP `askQuestion`/`sendFeedback` tools, assistant queued follow-ups, exact light tint background, cover image background modes, button `size`, embed `navigateToPage` normalization, API reference response-selector sync, system-theme flash fix, prompt block action split, split site search, sticky API page actions, webframe navigate + page-context, plus a11y fixes.

---

## 25. Cross-cutting conventions & gotchas

1. **Middleware-first**: nothing renders without the middleware rewrite. If a URL "doesn't route", trace `getSiteURLFromRequest` → `lookupPublishedContentByUrl` → `encodePathInSiteContent`.
2. **Static vs dynamic is decided per-request** in middleware — the same content URL can be served fully-cached (params-driven) or per-request (header-driven). A query param, cookie, or adaptive `contextId` flips the whole render strategy.
3. **Errors-as-values in the data layer** — fetchers never throw; choose `throwIfDataError` vs `getDataOrNull`.
4. **Caching lives at the `'use cache'` boundary**, not at fetch level (Next fetch cache is disabled). Tags from API headers + `getCacheTag`; push-based revalidation via the signed `/~gitbook/revalidate` route. Avoid `'use cache: remote'` for large/high-cardinality data. **`lib/data/api.ts` is CODEOWNERS-protected** — changing cache keys can trigger mass revalidation.
5. **`lib/cache.ts` stable-ref wrapper** is required for React memoization with object args.
6. **Two-tier visitor trust**: signed JWT/API-token claims gate; unsigned claims only personalize.
7. **Style-less packages** (`react-openapi`, `react-contentkit`, `react-math`) inject all chrome (icons/code/markdown/translations) via a host context — same components render in OSS engine and proprietary app. Watch the server/client boundary markers (`$$isClientContext$$`, `./client` export).
8. **Generated, gitignored data**: `icons/data/*.json`, `fonts/data/fonts.json`, `emoji-codepoints/dist/index.ts` — produced by `generate`/`build` from upstream (FA kit, google-font-metadata, emoji-assets). Run `generate` before typecheck/build.
9. **Image/VA/preview cookies are context/path-scoped** (hashes) so co-hosted sites on shared domains can't read each other. Shared registrable domains (`gitbook.io`) require exact-host CORS.
10. **`--webpack` everywhere** (Turbopack opted out). **Run `bun run format` (Biome) after every change** — `useSortedClasses` will otherwise fail CI.
11. **Icons are incomplete in a plain local checkout.** `packages/gitbook/scripts/generate.sh` runs `gitbook-icons ./public/~gitbook/static/icons custom-icons` — only the small GitBook-authored custom-icon set is generated. The full Font Awesome Pro library (everything `<Icon icon="...">` normally renders) requires a licensed/private source not available in this open-source checkout, so almost every icon 404s against `/~gitbook/static/icons/svgs/**` in local dev. This used to be able to crash the whole page (see §16 fix); now it just degrades to missing icons — cosmetic only.
12. **Viewing a Visitor-Authentication-protected site through the local `/url/<url>` proxy needs a token.** A private/VA-enabled space returns `Authentication missing to access this content` unless the request carries a valid `?jwt_token=` (see §8) signed with that space's VA secret — an org-member browser session does *not* bypass this for the local proxy (only for direct browsing on the real published domain, where the GitBook session cookie applies). `GITBOOK_API_TOKEN` alone does not bypass VA either — it's a separate, orthogonal auth layer.

---

## 26. Key file index

| Concern | Path(s) |
|---|---|
| Request routing | `packages/gitbook/src/middleware.ts`, `src/lib/middleware.ts`, `src/app/utils.ts` |
| Route tree | `src/app/sites/{dynamic,static}/[mode]/[siteURL]/[siteData]/…`, `src/app/~gitbook/{env,revalidate}`, `src/app/~space/[spaceId]/…`, `src/pages/api/~gitbook/force-revalidate.ts` |
| Response generators | `src/routes/{icon,image,llms,llms-full,markdownPage,markdownAsk,ogimage,openapi-proxy,robots,rss,sitemap}.ts(x)` |
| Context & data | `src/lib/context.ts`, `src/lib/server-actions.ts`, `src/lib/data/{api,types,errors,lookup,urls,pages,revisions,visitor,cloudflare}.ts`, `src/lib/cache.ts`, `src/lib/async.ts`, `src/lib/waitUntil.ts` |
| Visitors/auth | `src/lib/{visitors,adaptive,oauth-protected,auth-login-link}.ts` |
| Links/URLs | `src/lib/{links,urls,paths,routes}.ts` |
| Document model | `src/lib/{document.tsx,document-sections,pages,markdown,markdownPage,references.tsx}` |
| OpenAPI | `src/lib/openapi/*`, `packages/{openapi-parser,react-openapi}` |
| Rendering | `src/components/{RootLayout,SiteLayout,SpaceLayout,SitePage,Header,Footer,TableOfContents,PageBody,PageAside}`, `src/components/DocumentView/*` |
| Search/AI | `src/components/{Search,AI,AIChat}/*`, `src/app/.../~gitbook/mcp/*` |
| Theming | `packages/gitbook/tailwind.config.ts`, `packages/colors`, `src/lib/{customization,colors}.ts` |
| i18n | `src/intl/{server,client,translate.tsx,translations/}` |
| Deploy | `packages/gitbook/{next.config.mjs,open-next.config.ts,wrangler.jsonc,openNext/**}`, `turbo.json`, `patches/**`, `.github/**` |
| Env | `src/lib/env/{globals,urls}.ts` |

---

*Generated from a full-repository analysis. When in doubt, the middleware (`src/middleware.ts`) and the context assembler (`src/lib/context.ts`) are the two files that explain the most about how everything connects.*
