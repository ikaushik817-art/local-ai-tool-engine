# Security

L.A.T.E. is built to run **on your own computer, for you**. The web UI listens on `127.0.0.1` only and needs a secret token that is built
into the page. That is the safe way to run it, and what this page describes.

## What it protects

- **Files:** the file tools only see one folder (`AI_FILES_DIR`, default: where you started it). They skip `.env`, key files and
  `node_modules`, and refuse symlinks that lead outside. Writes go only into `ai-output`, only plain `.md/.txt/.json/.csv` names, never
  overwrite, and can't delete, rename or move anything.
- **Permission:** every write or append asks first and shows what it will write. Only a clear yes counts.
- **Text from outside is data, not orders:** web pages, text inside a file or a picture, and PDF text can't make it save, read your files
  or change your notes in the same task. The model is told that quoted material is data, never instructions.
- **Notes:** `remember` refuses passwords and API keys.
- **Web UI:** `127.0.0.1` only, secret token on every call, wrong `Host` names refused (DNS rebinding), other websites refused, strict
  content policy, 20 KB request limit, messages per minute (`AI_RATE_LIMIT`), stalled connections dropped.
- **Limits:** message length (`AI_MAX_QUESTION_CHARS`), file counts, number ranges. Long runs of spaces and other slow-down tricks are
  neutralised (tested).
- **Logs:** `logs/late.log` records tool names, timings and errors, never message text. API keys, bearer tokens and passwords are blanked
  before anything is written. `npm run logs` summarises it.
- **Alerts and numbers (optional):** `AI_ERROR_WEBHOOK` (a Slack-style URL) hears about errors, at most one a minute, redacted.
  `AI_METRICS_TOKEN` turns on `/api/metrics` (Prometheus text, no message text).

## What it does NOT protect

- **It's not a server for other people.** One person, one chat, one notes file, no logins. Don't put it on the internet or a shared network.
- **It can't make a model honest.** Small models can still invent facts in text they write (summaries, stories, reports). Maths, dates,
  counting, files and notes are done by code. In research reports the links come from the real search.
- **Your API key lives in `.env` as plain text.** It's in `.gitignore`. Revoke any key you pasted somewhere public.
- **Notes are plain text** in `.ai-memory.json`, and the model sees them in every chat. Chat history on disk (`AI_KEEP_HISTORY=on`) is
  your messages and the answers, never tool results or web pages.
- **Your model provider sees your chats** when you use an API model. **Web search sends your search words** to the engine (DuckDuckGo, or
  Brave / Tavily if you set a key; your own SearXNG stays with you).
- It can't run commands. If you add your own tools that can, you own that risk; use `needsApproval: true`.

## Docker

`docker compose up --build` runs it in a container: port published to `127.0.0.1` only, non-root user, files/notes/logs in a volume.
`AI_UI_HOST=0.0.0.0` inside the container is what lets the published port work; the app warns when the host isn't loopback. Don't publish
the port to a network address. (I haven't run the Docker files myself; CI runs the tests, not Docker.)

## Before you rely on it

1. `npm test` (about 350 tests, no model needed).
2. `npm run eval` with your real model. The "must-work" part has to be 100%.
3. Read [AUDIT.md](AUDIT.md): what was checked, what was found, what is still open.
4. Look at `npm run logs` after a day of use.

## Reporting a problem

Open an issue. For something that could hurt someone (a way around the permission box or the folder limit), say so in the title and don't
paste secrets or keys.
