# Contributing

Thanks for wanting to help! Keep it small and simple, that's the whole vibe of this project.

## Get going

```bash
npm install
npm test
```

You need Node 18+. Tests use Node's built-in runner and fake model servers, so you don't need Ollama or LM Studio running.

## Before sending a PR

1. One problem per PR, and say what it fixes.
2. Add or update a test if behaviour changes.
3. Run `npm test` and paste the result.
4. Touched setup or usage? Update the README.

## Where things go

- `setup.js` is the first-run wizard. It only uses Node built-ins on purpose, so it works before `npm install`.
- Provider-specific code lives in `adapters/`. Shared bits (timeouts, JSON parsing) go in `adapters/shared.js`.
- Tools live in `tools/`. The engine (`engine/toolEngine.js`) shouldn't know about any specific provider.
- Avoid new dependencies unless there's really no other way.

## Please don't

- Commit API keys, `.env` files or anything machine-specific.
- Add tools that run commands or touch files without thinking about it. Tools run with your user's permissions.

Be kind in issues and reviews. Done.