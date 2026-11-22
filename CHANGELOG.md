# Changelog

## Unreleased - rules first, typed results, honest answers

### Fixed (each has a regression test)
- **"Last value wins".** Two reads shared one variable, so "save both files" saved the last one only. A variable used a second time now keeps the first value under a new name. The same for two written texts. Steps that mean to replace a value say so.
- **File names used as content.** A `write_file` variable is the name it saved under; a plan that uses it as text is refused before it runs.
- **Memory change.** `change/update/replace/set my X to Y` (and "change it to Y") replaces the older note (`remember` has a new optional `replaces`), alone or inside a longer job. Before, the whole sentence was stored as one note.
- **Recall scoping.** `recall` returned notes that shared only one word ("favorite fruit" brought back "favorite color"). It now needs all the words (plural forms count) for up to three words, and 75% for longer questions. Nothing found means nothing saved.
- **Execute or explain.** A request to do something with files or memory is never answered with instructions; the model's decisions are asked at temperature 0; if no tool ran, the answer says nothing was done. Tested 100 times with a model that changes its mind.
- **Success claims.** "Done. All N steps worked" is not used when the last check found a difference; a model-driven job with failed steps gives a "Partly done" report made of tool results.
- **Renamed files.** A name that came out of a step is the real name; only a typed name follows renames. `report.txt` written twice is `report.txt` and `report-2.txt`, and "read both" reads each.
- `ai-output/x.txt` is accepted as a name by `write_file` and `append_file`; `append_file` to a missing file writes a new file instead of failing.
- The "answer was cut off" notice can no longer be saved into a file.
- A number is never opened as a file name.
- `search_files` results are saved as their text, not as JSON.
- **"Save only the largest value" / "compare the saved value with the original value".** The file now holds the value alone, and the check compares the number in the file with the number the stats tool gave (`compare_numbers`), not whole lines. `compare_numbers` takes the number from a tool answer line ("Largest: 897472 (#4). All: ...") and still refuses any other sentence. A clause that starts with verify / check / confirm / compare is never read as a request for new numbers.
- Setup: no more `DEP0190` warning (no shell for `ollama`; one command string for `npm`), it says why Ollama can't be reached, starts it with progress and a reason if it can't.

### New
- **More clause shapes in the rules:** save with no file name ("save the count"), read both/all files, create a file twice, "a.txt with A and b.txt with B", "three files named ... each containing ...", add the numbers of two files, verify a count is N, verify words are in a file, list the files, compare a summary with its report and list/verify what is missing.
- **Typed results** for number_stats, text_stats, random_numbers, write_file, append_file, weather, convert, compare_numbers, compare_text, remember, recall, forget, search_files and datetime (the old string functions still exist). Plans are checked for the fields they read.
- **compare_text** tool: exact text check, which file of a list changed, contains-a-word, and what a summary leaves out.
- **Model profile:** small models (8B and under) are not asked to plan, get a smaller material budget and shorter history. Cut-off history is kept as one short line made by code.
- **Speed:** independent research / search / page / weather steps run together; pages and weather are remembered; a report is shown a fixed amount of material.
- Up to 50 files in one job (was 20) and 1000 random numbers (was 100); said in the plan when you ask for more.

### Known gaps
See "Not done yet / known limits" in the README. The main one: after these changes I tested with fake models only, not with real qwen/gpt-oss/other models.

## v2.0.0 - one command, steadier search, PDFs and pictures

### New
- **One command does everything: `npm start`.** First run: installs what it needs (you never type `npm install`), finds or asks for
  your model, asks if you want PDF reading, sends a test message, opens the chat. Later runs just open the chat. After an update it
  installs new libraries by itself. An interrupted install (empty or half-written library folders) is noticed and redone. Needs Node 18+
  and says so plainly if it's older. `npm run ui` and `npm run setup` do the same checks first.
- **Better web search.**
  - Brave, Tavily or your own SearXNG first (set a key or URL); DuckDuckGo as the spare, now through two doors (normal and lite).
  - An engine that fails or finds nothing relevant hands over to the next; one that just failed rests for a minute.
  - The same question within ten minutes is answered from memory.
  - "latest ..." with no year gets this year added.
  - `research` replaces a page that fails or shows nothing (JavaScript-only sites) with the next result, falls back to snippets only when it
    must (marked `snippetOnly`), and searches again with just the key words when there are few results.
- **PDFs:** `read_file`, `text_stats`, summaries and every plan can read PDFs. Setup asks once ("Read PDF files too?"), `npm start` adds the
  small reader library. Scans and protected files say so plainly.
- **Pictures:** `describe_image` ("describe photo.png", "read the text in scan.png") for models that can see (llava, gpt-4o, gemini...).
  png, jpg, webp, gif up to 5 MB, checked by their real first bytes. Text inside a picture is treated as data.
- **Web chat remembers** (`AI_KEEP_HISTORY=on`): `/api/history`, and the page shows earlier messages.
- **Watching it:** `/api/metrics` (Prometheus text, set `AI_METRICS_TOKEN`), `AI_ERROR_WEBHOOK` for error alerts (one a minute, redacted),
  `npm run logs` for a summary.
- **AUDIT.md**: what I checked, found and fixed, and what is still open.

- **Works inside cloud limits (found in a real Groq session).** Free cloud tiers limit tokens per minute (Groq's: 8000).
  - What is sent is now kept under a size budget (`AI_MAX_PROMPT_CHARS`): a huge file or an old long chat is cut down, oldest first; the
    rules and your newest message always stay.
  - "Request too large": cut down further and tried again once, using the limit the provider named. Still too large: a clear message
    ("try /clear...") instead of a raw error.
  - "Rate limit, try again in 32s": waited out (up to `AI_RATE_LIMIT_MAX_WAIT_MS`, 40 s) and retried once. A longer wait is explained with the
    time. Errors name who complained ("the model provider (api.groq.com)", not "the local model server").
- **"research X, then search my files for Y" now runs every step.** A plan built from your own sentence runs all its steps in order,
  web and local, with only the final answer written by the model. If the model can't (rate limit, down), nothing that ran is lost: the
  sources and the file-search results are shown as they are. Before, a rate limit after the first step stopped everything.
- **Numbers tasks that used to need the model now don't:** "create numbers.txt containing the numbers 1 through 1000, read it, calculate the sum,
  verify with the formula for the sum of 1 to 1000, save the verification report, read it back" runs as exact steps (new `compare_numbers` tool,
  `number_stats` shows ten numbers and "+990 more", not a thousand, a report collects its lines, the answer stays short).
- **Rules no longer guess what "it" means after a web page:** "research the latest Node.js version, then save it" / "remember the version
  number" need judgement (which part of the page?), so they go to the model instead of saving the whole page or a note saying "the version number".

### Fixed (found by hard tests)
- **A long file was added up wrong.** `read_file` shows only the start of a long file, and the plan used that. `number_stats` now reads the whole
  file itself (up to 200,000 numbers).
- **"sort the lines, remove the duplicates, make it uppercase" did only the first change.** Every change named in a sentence is done now,
  in the order written; "remove", "dedupe", "uppercase", "clean" also start a new step.
- **A report written after a search was written from the model's memory, with the real links attached.** A text written after a web search, a
  file search or a file read is now given that material ("use only the material below"), so the report is about what was found.

### Fixed (found by the audit)
- **A message made of thousands of spaces froze the planner.** Now linear and limited.
- Messages over the length limit are refused in agent mode and `plan()` too, not only in chat.

### Not done
- JavaScript-only websites (needs a headless browser, a bigger safety question than I wanted to ship untested). `research` skips
  their empty pages and uses the next result instead.
- Scanned PDFs (needs OCR) and PDFs over 10 MB.

## v1.2.0 - the model writes, the app does everything else

### New
- **Model-written steps inside exact plans.** "Write a poem about the sea and save it to sea.txt", "summarize notes.txt",
  "translate it to Spanish, then save it", "research react hooks, then write a short report and save it" now run as
  plans: the model writes only the text; reading, saving, order and checking stay exact. The text of a file is handed
  to the model as data (never as instructions), saves are read back, and links in a research report come from the real
  search, not from the model. A summary with nothing saved afterwards is simply the answer, streamed word by word.
- **"with a list of 3 fruits"** is understood as a description for the model to write, not the literal words
  (quoted text stays literal).
- **`plan()` dry run** (`ai.plan(goal)`, `/plan <goal>` in the terminal): shows the steps, which ones the model writes
  and whether permission will be asked, without running anything.
- **Web steps retry once** after a passing failure (slow site, dropped connection). Never after a blocked address,
  never for permission, never for file writes.
- **More phrasings understood** (found by probing 30 real-looking requests): "show me what is in it", "save to X" without
  "it", "add them up", "which is the biggest", "put it in x.txt", "write the numbers 1 to 5 into nums.txt" (exact, no
  model), "count the words in a.txt and the lines in b.txt", "search the web for X, then summarize it".
- **Says plainly what it can't do**: delete, rename and move files are refused with an explanation.
- **CI** (`.github/workflows/ci.yml`): tests on Linux, Windows and macOS with Node 18, 20 and 22, plus the no-model eval.
- **Docker** (`Dockerfile`, `docker-compose.yml`): one instance for one person, port published to 127.0.0.1 only,
  runs as a non-root user, health check built in. `AI_UI_HOST` exists for this and warns when it isn't loopback.

### Fixed
- "summarize http://localhost:3000" was read as a file with a colon in it. Links always go to the web reader.

## v1.1.0 - ready to be measured and run for real

### New
- **Eval harness** (`npm run eval`): about 45 test prompts with answers checked by code. 35 must work with no
  model at all (they also run inside `npm test`, several times each for the random ones). 10 measure how good
  YOUR model is. Flags: `--fake` (no model), `--network`, `--only=id`, `--repeat=3`. Writes `evals/last-report.md`.
- **Log file** (`logs/late.log`, `AI_LOG=off|error|info|debug`): tool names, timings, errors. Keys, bearer tokens
  and passwords are hidden. Rotates at 1 MB. A log problem never breaks the app.
- **Web UI limits**: messages per minute (`AI_RATE_LIMIT`, default 30, answers 429 with a wait time), request
  timeouts for stalled clients, and `/api/health` for uptime checks (no token, no private data).
- **Chat history on disk** (`AI_KEEP_HISTORY=on`): terminal chat continues after you quit. Only your messages and the
  answers, never tool results or web pages. Atomic writes, private file, damaged file ignored. Off by default.
- **Message length limit** (`AI_MAX_QUESTION_CHARS`, default 8000).
- **SECURITY.md** and `.env.example`.

### Fixed
- "The average is 5." when the average was 5.5 (the eval caught it).
- "Merge a.txt and list.txt into all.txt" was cut in half at "and list".
- "count the words" with nothing to count now asks what to count, instead of letting the model guess.
- Paths show as `ai-output/name.txt` on Windows too. Tests no longer pick up the model or API key from your `.env`.

## v3 - reliable multi-step agent

### The problem
Small models (about 3B) failed on multi-step requests: they skipped steps, counted in their head, mixed up
file names, stopped early, and the final answer was a raw JSON dump or an invented story.

### New
- **Planner** (`engine/planner.js`): a multi-step request is split into clauses and turned into exact tool
  calls by rules, with no model needed. Results pass from one step to the next (`{{last}}`, `{{item}}`,
  `{{reads.content}}`). A plan written by the model is used only if every step passes validation.
- **Honest final report**: the answer is built from what really happened ("Done. All 5 steps worked: ..."),
  or says what stopped it and what was not done (denied permission, failed step, timeout).
- **Read-back check**: every saved file is read back and compared. The report says "Checked: ..." or warns.
- **Renamed files are followed**: if `test.txt` is saved as `test-2.txt`, later steps use the real name.
- **New tools**
  - `number_stats`: largest, smallest, sum, average, count, sort of a list, with file names.
  - `text_transform`: uppercase, lowercase, title, reverse, reverse_words, sort_lines, unique_lines,
    number_lines, trim, remove_spaces.
  - `append_file`: add text to a file already in `ai-output` (asks permission first).
- **Request shapes the rules understand**: create file with text, read it back, count characters/words/lines,
  save the count or any result, copy, merge, list files, random numbers in files, sum/average/largest/smallest,
  remember / recall / forget (including "forget it"), calculator, convert, date/time, typed `\n` as a new line.
- **Short local jobs** ("copy a.txt to b.txt", "make it uppercase") also run as plans.

### Fixed
- `remember` saved the whole instruction ("..., tell me the number, forget it"); now only the fact.
- `recall` returned every note; now only the best matches, with "I don't have anything saved about ..." otherwise.
- `forget` removes the exact note; key words are enough; "forget it" means the fact just remembered.
- The model loop used to end silently after one bad answer: it now retries once, warns on repeats, and says
  so when it gives up. Wrong arguments get a hint with the expected arguments.
- "count the words" no longer triggers on a file called `words.txt`.
- "What is 12*12, then save it" and "remember A, remember B, then tell me" count as multi-step.

### Known limits
- Web research and anything the model must write itself (stories, summaries) still depend on the model.
- Prompts the rules don't understand fall back to the model plan, then to the one-tool-at-a-time loop.

### Tests
`npm test` runs everything. New: `tests/planner.test.js` (uses a model that always fails, to prove the app
finishes the job on its own).
