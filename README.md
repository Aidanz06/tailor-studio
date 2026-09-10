# Tailor Studio

A personal desktop app that turns a folder of clothing photos into ready-to-post
[Grailed](https://www.grailed.com) listings — and then fills Grailed's sell form
for you, one reviewed click at a time.

**Form-fill assistance, not a bot.** The app never logs in, never solves
captchas, and never clicks Publish. You do those yourself, in a real Chrome
window. Everything the app automates happens *before* the point of sale:
grouping photos, writing listings, pricing against sold comps, and typing the
draft into the sell form for your review.

**[📄 Design overview deck](docs/tailor-studio-design.pdf)** — a 12-page visual
walkthrough of the product: the problem, the five-stage workflow, and the
safety rails.

## The workflow

1. **Import** — point the app at a photo-shoot folder. Claude vision groups the
   photos by garment (batched-vision clustering, per-photo fallback), extracts
   attributes (brand, category, size, condition, color), and flags anything
   ambiguous for review.
2. **Draft** — each group becomes a draft: generated title/description
   (structured parts, no authenticity claims), a price range computed from
   Grailed sold comps (rate-limited, cached, relevance-weighted, with a
   confidence estimate).
3. **Review** — fix groupings, confirm the suggested Grailed category, tweak
   text. Measurements go through Grailed's own listing fields, not the app.
4. **Fill** — with the app-launched Chrome sitting on `grailed.com/sell/new`,
   one click types the whole draft into the form: title, description, price,
   condition, color, style, country, photos, and — once you've confirmed the
   category — the full category → size → sub-category → designer cascade.
   A live checklist streams per-field progress.
5. **Publish** — you review the filled form in Chrome and click Publish
   yourself. Then "I published — fill next draft" advances to the next item.

## Architecture

```
ui/                Electron app
├── main.js        main process: IPC, SQLite, keys (never in the renderer)
├── preload.js     contextBridge → window.tailor
├── autofill-driver.js  CDP driver for the sell form (:9222, never submits)
├── chrome-launch.js    in-app launcher for the dedicated Chrome
├── chrome-status.js    read-only readiness probe (HTTP /json/list only)
├── chrome-dock.js      snaps the Chrome window against the app (§5.5)
└── src/           React 19 + Vite + TypeScript renderer

pipeline/          Node backend (also used headless via CLIs)
├── store.js       SQLite (node:sqlite) — items, photos, albums, telemetry
├── cluster.js     photo grouping strategies
├── vision.js      attribute extraction (Claude vision)
├── content.js     listing text generation
├── priceProvider.js / range.js / compGuard.js
│                  sold-comp scraping, weighted range + confidence,
│                  and the cache/rate-limit/circuit-breaker guard
└── processItem.js per-item orchestration

phase0b*.js        CDP research harness + probe scripts (reference impls)
grailed-selectors.json  ALL DOM selectors, URL patterns, value maps —
                        never hardcoded in app code
```

The fill drives a **real, separately-launched Google Chrome** over the Chrome
DevTools Protocol (port 9222, dedicated profile in `.chrome-profile/`). The
app can launch it, dock it beside its own window, and watch its readiness —
but login and publishing stay human.

## Safety rails (non-negotiable)

- **The app never submits the Grailed form.** Every listing is reviewed and
  published by hand.
- **Login/captcha are always manual**, in the real Chrome — never automated,
  never in an embedded browser.
- **No fingerprint/UA/navigator spoofing, ever** (verified counterproductive).
- **Circuit breaker**: any 403/challenge/logout signal disables scraping and
  autofill immediately; comps are cached and rate-limited.
- **No autonomous bumping, offers, or messaging.** One manual click per fill.

## Running it

Requirements: macOS, Node 20+, Google Chrome in `/Applications`.

```bash
npm install
# .env.local (not committed):
#   export ANTHROPIC_API_KEY=...
#   export GRAILED_ALGOLIA_KEY=...      # sold-comp search
#   export CONTENT_MODEL=claude-haiku-4-5-20251001   # optional cost mix

npm run ui:build && npm run ui   # build renderer, start the desktop app
```

In the app: **Launch Chrome** (Home banner or workspace header) → sign in to
Grailed in that window → open a Sell form → import a photo folder → review →
Fill.

Development:

```bash
npm run ui:dev          # renderer in the browser with mock data (no keys/Chrome)
npm run ui:typecheck
npm run clustering:gate # regression gate — run before shipping pipeline changes
npm run pipeline        # headless per-item pipeline CLI
```

Renderer changes only reach the desktop app after `npm run ui:build`
(Electron loads `ui/dist`).

## Status

Personal-use v1: the full photo-folder → published-listing loop works end to
end. A planned second phase swaps the CDP fill for a browser-extension shell.
