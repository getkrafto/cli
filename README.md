# Yondo

> **Visual editor for live web products.**
> A bird's-eye canvas of your actual app pages, with AI-powered edits.

**Status: pre-alpha placeholder.** This npm package reserves the name. The real CLI ships in a later release.

---

## The idea in one sentence

Connect your repository → Yondo adapts your project for embedding via a Claude-driven onboarding agent → designers open a single URL and see a live, navigable map of every page in your product, with a chat panel to make AI-driven edits in place.

Not codegen-from-scratch like v0 or Bolt — **edits on top of your existing product**.

## How it differs

| Tool | What it does | Where Yondo is different |
|---|---|---|
| v0, Bolt, Lovable | Generate new UI from a prompt | Yondo works with your already-built product |
| Builder.io Visual Copilot | Visual editor over its own framework | Yondo adapts to any React / Next / Vite stack via an onboarding agent |
| Storybook | Isolated components | Yondo shows full pages and product navigation |
| Figma | Static design files | Yondo edits live code, not design mocks |

## How it will work

1. **Connect** your GitHub repo
2. **Onboarding agent** (Claude) opens a single PR adapting your project for iframe embedding — auth bridge, CSP whitelist, route map. All changes feature-flagged; production builds untouched.
3. **Canvas** — a zoomable map of every page in your product, rendered as live iframes
4. **Chat** — three scopes: edit the whole canvas (new pages, new sections), edit a single page, iterate on a generated mock
5. **PR flow** — every batch of edits opens a pull request your team reviews on GitHub

## Try the placeholder

```bash
npx yondo
```

You will see this banner and a link back to the repo. That is currently the entire feature set.

## Build status

| Stage | Status |
|---|---|
| Internal PoC (`canvas-sandbox`) | shipping |
| Public CLI (`yondo init`) | in progress |
| Hosted SaaS | planned |
| Self-hosted enterprise | planned |

## Get notified

Open an issue on [github.com/cranch42/yondo](https://github.com/cranch42/yondo) to join the waitlist.

## License

Source-available under the [Functional Source License, Version 1.1 (Apache 2.0 Future License)](./LICENSE) — the same license Sentry uses.

Free for any use except a Competing Use (a commercial product or service that substitutes for Yondo or offers substantially the same functionality). Two years after each release, every version converts automatically to Apache 2.0. See `LICENSE` for the exact terms.
