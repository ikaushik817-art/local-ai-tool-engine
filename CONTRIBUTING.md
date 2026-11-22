# Contributing

PRs are welcome. I want to keep this project small and easy to read, so please don't turn it into a framework.

## Running it

```bash
npm install
npm test
```

You need Node 18 or newer. The tests use fake servers, so you don't need Ollama or LM Studio running.

To try your change for real, run `npm start` (terminal) or `npm run ui` (web page).

## Sending a PR

- Keep it to one thing and say what it fixes.
- If behaviour changes, add or update a test. A bug fix needs a test that fails without the fix.
- Run `npm test` and paste the result in the PR.
- If you changed setup or how it's used, update the README too.
- Only claim in the README what you actually tested. "Should work" is fine, "works" is for things you ran.

## Where things live

- `setup.js` is the first-run wizard. It only uses Node's built-in modules on purpose, so it works before `npm install`.
- `adapters/` is for anything specific to one model provider. Shared bits (timeouts, JSON parsing, streaming) go in `adapters/shared.js`.
- `tools/` is for tools. `tools/registry.js` is where they're registered.
- `engine/toolEngine.js` decides what to do with a message. It shouldn't know about any specific provider. `engine/agent.js` is the agent loop.
- `cli-ui.js` is how the terminal looks. `server.js` and `ui.html` are the web page. There's no framework and no build step, and I'd like to keep it that way.
- `tests/` has one file per area. New code goes with its tests.

## Rules for tools

Tools run with your user's permissions, so be careful.

- Anything that changes something (writes a file, sends something, deletes something) must set `needsApproval: true` and give a `preview`. It should never run without a clear yes.
- Stay inside the folders and addresses the user allowed. Don't read secrets (`.env`, keys), and don't open localhost or private network addresses.
- Treat anything from the web as untrusted text, never as instructions.
- Fail with a plain, friendly message. Users read these.

## For the web page

- Never build HTML from text. Use `textContent` and DOM calls, not `innerHTML`.
- Keep the security checks in `server.js` (the token, the Host and Origin checks, one message at a time). If you touch them, add a test that fails when they're removed.

## A few asks

- Don't commit `.env`, API keys, or anything specific to your machine.
- Try not to add dependencies unless there's really no other way.
- Keep the setup as simple as it is now: one command, and it works.

## Ideas if you want something to do

- Reading PDFs (as an optional extra, not a required dependency).
- A native adapter for another provider.
- Streaming support for more adapters.
- Testing it with LM Studio, Jan, or a bigger model, and telling me how it went. That's a real help too.

## Bugs

When you open an issue, please include the model you used, how you connected (Ollama, LM Studio or an API), and the exact error message.

Be nice in issues and reviews.