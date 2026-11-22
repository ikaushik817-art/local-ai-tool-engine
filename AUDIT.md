# Security audit (self-audit)

This is an audit I did on my own code with tests, not an independent review. It says what was checked, what turned up, and what is still open.
Dated with v2.0.0. It covers the single-user app (the only mode there is).

## Method
I read each place where outside input meets something powerful (the message, a file, a web page, a picture, a PDF, the web server, the
sign-in) and wrote an attack for it. Every row below with "test" has an automated test in `tests/`.

## Found and fixed
| # | Problem | Fix | Test |
|---|---|---|---|
| 1 | **A message of a few thousand spaces froze the planner** (a regex that took longer the more spaces: minutes, one request was enough to stall the server). | The patterns are now linear, runs of 20+ blanks are squeezed, and every message is length-limited. | `security.test.js` (15 slow-down inputs, each under 1.5 s) |
| 2 | "Describe/summarize <file>" could be steered by text inside the file or picture. | That text goes to the model as quoted data with a rule saying it is never instructions, and reading local files/notes is blocked after untrusted content in the same task. | `security.test.js`, `media.test.js` |
| 3 | A symlink inside the folder could point at a file outside. | Paths are resolved with `realpath` before the folder check; `append_file` refuses anything that isn't a plain file. | `security.test.js` |
| 4 | Keys and tokens could end up in logs or alerts. | Everything written to the log or sent to a webhook is redacted first (Groq, OpenAI, Google keys, bearer headers, `password=`). | `hardening.test.js`, `monitoring.test.js` |
| 5 | `.env` / path tricks (`../`, absolute paths, `~`) through the file-writing rules. | Names with folders are refused; nothing appeared outside `ai-output` in any of 7 tricks. | `security.test.js` |

## Checked, nothing found
Path traversal on read and write, secrets files (`.env`, keys), SSRF through `read_webpage` (private addresses, bad redirects), DNS rebinding,
cross-site requests to the local UI, oversize request bodies, log injection (newlines in messages are escaped by JSON), notes holding secrets,
number and file-count floods.

## Still open (honest list)
- **No independent review, no penetration test.** Treat this as a careful self-check.
- **Prompt injection is reduced, not solved.** A model can still be talked into *writing* a misleading summary from a hostile page. It
  can't make the app read your files, change your notes or save without your yes in the same task, but it can mislead the reader.
- **The Docker files are untested** here (no Docker in my test setup).
- **Real PDFs and real vision models are untested.** The code is tested with fakes shaped like the real thing.
- **Brave, Tavily and SearXNG are tested against fake servers** built from their documented formats, not against the live services.
- **Dependencies** (`cheerio`, `expr-eval`) are not audited by me. Run `npm audit` yourself before deploying.
- **Not for other people:** no logins, one chat. It is not hardened for a network (see SECURITY.md).

## Reliability audit (a later round, same caveat: my own audit, not independent)

Not about attacks: about answers that were wrong or that claimed too much. Each row has a test in `tests/planner.test.js` or `tests/contracts.test.js`.

| Problem found | Cause | Status |
|---|---|---|
| "Save both files" saved only the last one | Two steps used one variable name; the later value replaced the earlier | Fixed: a name used again keeps the first value under a new name |
| A file name was saved as the content | A `write_file` variable is the saved name; a step could use it as text | Fixed, and a plan that does it is refused before it runs |
| "Change my favorite fruit to apple" added a note | The change clause was not recognised and went into the remember clause | Fixed: `remember` can replace the older note |
| `recall` brought back unrelated notes | A note matched when it shared half of the words | Fixed: all words (up to 3), 75% (longer) |
| A request to do something was sometimes answered with instructions | Single-sentence work was not classified as work; model decisions used the default temperature | Fixed (routing guard, temperature 0). Tested 100 times with a model that changes its mind |
| "Done" with a failed check or failed steps | The report only looked at whether steps ran | Fixed: "NOT a success", "Partly done" |
| `report.txt` written twice read as the same file | Names from steps were passed through the "follow renames" rule | Fixed |

Still open: the rules cover shapes of requests, not all language; model-driven fallbacks are only as good as the model; none of this was run against a real model after the last changes. See "Not done yet / known limits" in the README.
