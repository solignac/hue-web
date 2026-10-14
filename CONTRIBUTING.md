# Contributing

Thanks for helping. Bug reports with a reproduction, and fixes for behaviour seen on real hardware, are the most valuable contributions.

## Setup

```sh
npm ci
npm run verify   # lint, types, tests, build, package checks: what CI runs
```

`npm run fix` formats and fixes lint findings.

## Principles

- **Zero runtime dependencies.** The package must stay small and auditable.
- **Every behaviour is tested** against the in-memory bridge in `test/fake-bridge.ts`. If the real bridge behaves differently from the fake, fix the fake first, in the same pull request.
- **Comments explain why** (an API quirk, a race, a limit), never what the code does.
- **Errors are `HueError`s** with a `reason` code can branch on, and a message a user can act on.
- Public API changes go in `CHANGELOG.md`.

## Pull requests

Keep them focused. Say how you checked the change, and whether it ran against a real bridge.
