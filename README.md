# Krafto

> Visual editor for your existing React codebase.

Click any element in your live app and edit its text and classes. Changes land in your source files as real code, committed to a krafto-owned branch — your working tree and branches are never touched.

**Status: early preview.** Next.js and Vite+React, macOS/Linux.

## Try it

In a Next.js or Vite+React project (Node 18+):

```bash
npx krafto init   # detect the project, connect it, tag elements for the editor
npx krafto dev    # start the agent — open the editor from your dashboard
```

`init` makes two commits on your current branch: one tagging JSX elements with `data-krafto-id` (this is why it asks for clean `.tsx`/`.jsx` files) and one adding `.krafto/config.json`. Your project token stays in gitignored `.krafto/secrets.env`.

## How editing works

Every design session lives on its own branch:

- Opening the editor creates a session — a git worktree under `.krafto/worktrees/` on branch `krafto/<id>`, running its own dev server.
- Each applied edit is written to that worktree (your app hot-reloads it instantly) and committed to the session branch.
- Fork a session from the editor to branch off its current state and experiment.
- Like the look? `git merge krafto/<id>` whenever you want — krafto never merges or pushes for you.

The agent (`krafto dev`) talks to the gateway over an outbound WSS tunnel — no inbound ports, nothing deployed.

## Links

- Follow the build: [github.com/getkrafto/cli](https://github.com/getkrafto/cli)
- Contact: [hello@krafto.ai](mailto:hello@krafto.ai)

## License

[Apache License 2.0](./LICENSE). Copyright © Okto Labs LLP.
