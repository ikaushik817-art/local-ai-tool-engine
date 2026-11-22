# L.A.T.E.

**Local AI Tool Engine**

L.A.T.E. takes a local model (or an API model) and turns it into an agent. You give it a goal, and it works through it: it picks a tool, runs it, reads what came back, and keeps going until the job is done. Search the web, read pages and files, do exact maths, save files, remember things between chats.

I built it because models on their own are bad at the boring parts. They get maths wrong, forget everything when the chat ends, and make things up instead of looking them up. Small models are worse: they skip steps, count letters in their head and lose track halfway through a job. So here the tools do the exact work, plain code handles the order of the steps, and the model mostly writes the answer.

It runs with Ollama, LM Studio, or an API key (Groq, OpenAI, OpenRouter, Gemini, anything OpenAI-compatible). No LangChain, no paid API needed, two dependencies.

## What it does

- **Exact answers.** Maths, dates, unit conversion, counting, random numbers and weather come from real tools, not from the model's memory.
- **Multi-step jobs.** "Create a file, read it back, count the characters, save the count, read that file too" runs as exact steps, in order, and the answer lists what really happened. Works even when the model is tiny.
- **Research with sources.** It searches, opens the best pages, answers from what it read, and links them.
- **Your files.** Read a file, search a folder, copy, merge, sort the lines, change case, append text.
- **Memory.** Tell it something once, it remembers in later chats. `forget` really removes it.
- **Saving files.** Only after you say yes, and only into an `ai-output` folder.
- **Terminal or browser.** A terminal chat, or a small web page on your own computer.
- **Rules first, model last.** The plan for a job is made by plain code (the same words give the same plan every time). The model only writes text. A job is never answered with "here's how you could do it": it runs, or it says plainly that it couldn't.
- **It says what really happened.** The answer lists the steps that ran and what the tools returned. If a step failed it says "Partly done" or "I stopped at step N because...". If the last check found a difference it says "NOT a success". It never says "Done" for work that wasn't done.

## Getting started

You need [Node.js](https://nodejs.org/) 18 or newer (I use 22). Then, in the project folder, one command:

```bash
npm start
```

That's all. The first time it:

1. **installs what it needs** (a minute, one time, you never type `npm install`),
2. **finds your model**: Ollama or LM Studio if one is running (it can even download a small model for you), or you choose "API key" and pick OpenAI, Groq, OpenRouter, Gemini (or any OpenAI-compatible URL) and paste the key. It checks the key and lists the models,
3. **asks if you want PDF reading** (adds one small library, about 1 MB),
4. sends a test message, and opens the chat.

After that, `npm start` just opens the chat. If an update brings a new library, it installs it by itself on the next start.

Prefer a browser? `npm run ui` and open the address it prints. Change the model later: `npm run setup`. Type `exit` to quit.
`npm test` runs the tests (no model needed). `npm run eval` tests how good your model is (see below).

No wizard? Set the variables yourself, e.g. `AI_PROVIDER=lmstudio npm start` (PowerShell: `$env:AI_PROVIDER="lmstudio"` first).

## Multi-step jobs

You don't need `/agent` for these. If one sentence asks for several things, L.A.T.E. splits it into steps by itself. Some examples that work:

```
Create a file called test.txt with "hello123", read it back, count the characters, save the count to result.txt, then read result.txt.

Remember that my favorite number is 777, tell me the number, forget it, then tell me the number again.

Create 5 text files. Each file should contain a unique random number. Then search all files and tell me which file contains the largest number.

Read notes.txt, sort the lines, then save it to sorted.txt

Merge a.txt, b.txt and c.txt into all.txt

Convert 10 km to miles, then save it to d.txt

Create a.txt with HELLO, create b.txt with WORLD, read both files, save their contents into combined.txt, then read combined.txt.

Create a.txt with AAA and b.txt with BBB and c.txt with CCC then merge them into merged.txt.

Create a.txt with 10, create b.txt with 20, add the two numbers and save the sum to sum.txt.

Create alpha.txt with FIRST, create beta.txt with SECOND, combine both contents into final.txt, then verify that FIRST and SECOND are both present in final.txt.

Remember my favorite fruit is mango. Change my favorite fruit to apple. Recall my favorite fruit.

Create s.txt with one two three, count the words, then verify the count is 3.

Create 10 files containing random numbers, find the largest value, save a report, corrupt the report, detect the corruption, repair the report, verify the repair.
```

What the rules understand is a list of shapes, not "anything you can say". See "Not done yet / known limits" below.

How it works, in order:

1. **Rules first.** The request is cut into clauses and turned into tool calls by plain code. Values move from step to step (the count from `text_stats` is what gets saved, nobody guesses it). No model needed.
2. **Model plan second.** If the rules don't understand the request, the model writes a plan as JSON. It is only used if every step is valid (real tool, right arguments, values that exist). Otherwise it's thrown away.
3. **One tool at a time last.** Anything else falls back to the model picking a tool, looking at the result, and picking the next one. It gets a second try if it breaks the JSON.

What you get back is a report built from what actually ran:

```
Done. All 5 steps worked:
1. Saved to ai-output/test.txt (8 bytes), containing: hello123
2. Read test.txt: hello123
3. Counted 8 characters in test.txt.
4. Saved to ai-output/result.txt (1 bytes), containing: 8
5. Read result.txt: 8

Checked: I read back 2 saved files and they match what I meant to write.
```

If you say no to a save, or a step fails, it stops there and tells you what was done and what wasn't. It doesn't carry on with wrong data. If `test.txt` already exists and gets saved as `test-2.txt`, the next steps use the real name.

When the job needs writing, the model writes only the text and everything around it stays exact:

```
Write a two-line poem about the sea and save it to sea.txt
Summarize notes.txt in one sentence
Translate "good morning" to Spanish and save it to es.txt
Research react hooks, then write a short report and save it to report.md
Create a file called fruits.txt with a list of 3 fruits, then read it back
```

The file text goes to the model as data, never as instructions. Every save is read back. In a research report the links come
from the real search, so the model can't make them up. Quoted text is always saved exactly as you typed it.

Want to see the steps first? `/plan <goal>` in the terminal (or `ai.plan(goal)` in code) shows them, says which ones the model
writes and whether it will ask permission, and runs nothing.

When you answer "Allow?", `y` is yes, `a` is yes to everything in this task, anything else is no.

## Tools

| Tool | What it does | Try asking |
| --- | --- | --- |
| calculator | Exact maths. Divide by zero gives a clear error. | `what is 245 * 37?` |
| text_stats | Exact characters, words and lines of a text or file. | `count the characters in hello123` |
| number_stats | Largest, smallest, sum, average, sort of a list, with labels like file names. | used in multi-step jobs |
| compare_numbers | Are these two numbers the same (an answer against a formula)? Says the difference. | `verify the sum using the formula` |
| compare_text | Is a saved text exactly what it should be? Shows the first line that differs, or which file of a list changed. Can also check that a text contains a word, or list the points of a report that a summary leaves out. | `verify the report` |
| text_transform | Uppercase, lowercase, title case, reverse, sort lines, remove duplicate lines, number lines, trim. | `read notes.txt and make it uppercase` |
| random_numbers | Real random numbers, all different. | `give me 5 random numbers between 1 and 100` |
| datetime | Date and time, days until a date, N days from today or ago, weekday of a date. | `what date is 10,000 days from today?` |
| convert | Exact unit conversion: length, weight, speed, temperature, data size and more. | `convert 5 km to miles` |
| weather | Current weather in a city (free service, no key). | `weather in Delhi` |
| wikipedia | A short summary from Wikipedia. | `wikipedia Alan Turing` |
| web_search | Searches the web, prefers official docs when you ask. | `search for the official docs on React hooks` |
| research | Searches, opens the best pages, pulls out the useful parts, answers with sources. | `research how react hooks work` |
| read_webpage | Opens a link and reads the text. | `summarize https://example.com/article` |
| read_file | Reads a text file, a PDF or lists a folder. | `read notes.txt and summarize it` |
| read_files | Reads every text file in a folder at once. | used in agent mode |
| describe_image | Looks at a picture (png, jpg, webp, gif) and describes it or reads its text. Needs a model that can see. | `describe photo.png` |
| search_files | Looks inside your files, names and contents. | `search my files for acme invoice` |
| write_file | Saves a new file, only after you say yes. | `/agent research React hooks and save a short report` |
| append_file | Adds text to a file in `ai-output`, after you say yes. If the file does not exist yet, the same text is written to a new file (and the answer says `write_file` ran). | `add " and eggs" to todo.txt` |
| remember / recall / forget | Keeps facts between chats. `remember` can replace an older note about the same thing (`change my favorite fruit to apple`). `recall` returns only the notes that are about **all** the words you asked (newest first). `forget` can remove the latest one. | `remember my sister is called Riya` |

Maths, dates, units, counting, notes and file search never depend on the model getting it right. The tool's answer is the answer. For the rest, the model writes up what the tool found.

## How it decides, and what it never does

1. **Rules plan the job.** A clause like "save the count", "read both files", "change my favorite fruit to apple" or "verify the count is 3" is turned into exact steps by code. No model is asked.
2. **The plan is checked before anything runs.** Does the tool exist? Does every variable exist? Does the field exist (`{{stat.value}}` yes, `{{stat.valu}}` no)? Is a file name being used as text (refused)?
3. **The steps run in order and keep going** until the job is finished, you say no, a step fails, or time runs out. Network steps that don't need each other (research, searches, page reads, weather) run at the same time.
4. **The answer is built from what the tools returned.** Not from the model's words.

If the rules can't plan a request, a model-driven loop may try it. In that loop:
- a request to *do* something (create, save, read, merge, remember, change...) is never answered with instructions;
- if no tool ran, the answer is "I didn't run any tools, so nothing was done";
- if some steps failed, the answer is "Partly done": what worked and what failed, from the tools, not from the model;
- the model's decisions (which tool, what plan) are asked at temperature 0, so the same question gets the same decision.

**What this does not promise.** For prompts the rules can plan, the same words give the same result every time (tested with a fake model that changes its mind on every call). For prompts the rules can't plan, a real model may still pick different tools on different days. It can't claim success or give instructions, but it may do more or less work.

## Small and large models

The engine reads the model's name. 8B or smaller (or "mini", "tiny", "nano" in the name) is treated as small; everything else, including names with no size, as large.

| | small | large |
| --- | --- | --- |
| Asked to write a plan in words | no (the rules plan) | yes |
| Material a written report is shown | 4000 characters | 8000 characters |
| Chat messages sent to the model | last 16 | last 40 |

What does not change: the steps, the checks, the files, the answers for every prompt the rules plan. Older messages that are cut off are not lost: their questions stay as one short line ("Earlier in this chat the person asked: ...") made by code.

I could not run a real 3B model in the place I built this, so "a small model completes the same jobs" is tested with fake models only (one that fails on every call, one that repeats one sentence, one that changes mood). Please try your own.

## Speed

- A job the rules plan makes **zero model calls**, except for text the model has to write (a report, a summary).
- Research, searches, page reads and weather that don't depend on each other run together. In a simulated test three 1.5 second researches took 2.3 seconds instead of 5.3. With real search engines, many requests at once can hit their rate limits (I have not seen that happen, but I could not test it).
- Pages and weather are remembered for a while (10 and 5 minutes), and two identical requests at the same moment become one.
- A report written from several searches is shown a fixed amount of them (not all of everything), so the prompt stays small.

## Typed results

Tools hand over fields as well as text, and later steps use the fields (not by reading the sentence):

| Tool | Fields (besides `text`) |
| --- | --- |
| number_stats | `value`, `where`, `summary`, `first`, `last`, `operation` |
| text_stats | `words`, `characters`, `noSpaces`, `lines` |
| random_numbers | `numbers` |
| write_file | `path` (where it was really saved: `report-2.txt` if `report.txt` existed) |
| append_file | `path`, `bytes` |
| weather | `temperature`, `unit`, `place` |
| convert | `value`, `unit` |
| compare_numbers | `equal`, `a`, `b`, `difference` |
| compare_text | `equal`, `differences`, `missing`, `count`, `total` |
| remember | `saved`, `replaced`, `note` |
| recall | `count`, `notes` |
| forget | `removed` |
| search_files | `count`, `files` |
| datetime | `date` |

`read_file`, `research`, `read_webpage` and `wikipedia` return objects of their own. `web_search` and `text_transform` still return a plain list/text, and `calculator` returns a number. In code, the old functions that return plain strings still exist.

## Which model should I use?

The bigger the model, the more it can do, but it works with any chat model. Simple jobs and the multi-step shapes above don't depend on the model much, because plain code runs them. Research answers and your own custom tools do.

| | Small (about 1B to 4B) | Bigger (7B to 8B and up, or cloud) |
| --- | --- | --- |
| Examples | `qwen2.5:3b`, `llama3.2:3b`, `phi3:mini` | `llama3.1:8b`, `qwen2.5:7b`, `mistral`, Groq, OpenRouter, OpenAI, Gemini |
| Maths, dates, units, weather, notes, file jobs | Works, the engine runs the tools itself | Works |
| Multi-step jobs written the usual way | Works, rules build the steps | Works |
| Research that sticks to the pages | Often fine, sometimes adds things from memory | Much better |
| Your own custom tools, odd requests | Hit and miss | Reliable |

I tried `qwen2.5:3b`, `dolphin-mistral` and Groq by hand. The others in the table are models that are generally good at tools, so they should be fine, but I haven't run each one.

Small models struggle because choosing a tool means answering in exact JSON, because long goals need the model to hold a plan in its head, and because they fill gaps from memory even when told not to. Check anything important. If it feels slow, raise `AI_MODEL_TIMEOUT_MS`.

## Agent mode

Normal chat answers one question. For bigger goals use `/agent`:

```
/agent research how React hooks work, then search my files for useEffect
```

In code:

```js
const result = await ai.agent("research how React hooks work, then search my files for useEffect");
console.log(result.answer);   // the final answer
console.log(result.steps);    // [{ tool, args, ok, summary }]
console.log(result.stopped);  // "finished", "max_steps", "repeat", "errors", "timeout", "model" or "blocked"
```

Options, all optional: `maxSteps`, `timeoutMs`, `allowedTools: ["research"]`, `plan: false`, `onStep(event)`, `onToken(text)`, `confirm(request)`.

It can't run away. It stops after 15 steps or 5 minutes, warns once if the model repeats a step and stops if it keeps doing it, and gives up after two failures in a row. If it stops early the answer says why. It can read, search and save new files (with your permission). It can't run commands.

## Web UI

```bash
npm run ui
```

Open `http://127.0.0.1:3737`. You see each tool while it runs, the answer types out as it's written, and there's a switch between normal chat and agent mode. When a tool wants to save a file, a card shows what it will write and you press Allow or Deny. It only listens on your own computer, and the page has a secret token so other sites you have open can't talk to it. It answers one message at a time.

## Terminal commands

| Command | What it does |
| --- | --- |
| `/agent <goal>` | Work through a bigger goal step by step |
| `/save [name]` | Save the last answer in `ai-output` |
| `/export` | Save the whole chat as a Markdown file |
| `/plan <goal>` | Show the steps for a goal without running anything |
| `/tools` | List the tools |
| `/clear` | Start a new conversation |
| `/help` | Show this list |
| `exit` | Quit |

Colours and the spinner switch off by themselves when the output isn't a terminal, or when `NO_COLOR` is set.

## Is it good enough for me? Measure it

Models differ, so don't trust anyone's claim (including mine). Run the checks on your own model:

```bash
npm run eval            # your real model: about 45 prompts, answers checked by code
npm run eval:fake       # no model at all: shows what L.A.T.E. does by itself
npm run eval -- --repeat=3 --network   # run model cases 3 times, include the ones that need internet
```

You get a score per group (files, numbers, memory, safety, model) and `evals/last-report.md` with every failure and the
answer it gave. The 35 "must-work" cases need no model and should always be 100%. The 10 model cases tell you how good
your model is at writing, summarising, creating files from loose wording, and so on. They are also a good place to add
your own prompts (`evals/cases.js`).

## Cloud models and their limits

Free cloud tiers cap how much you can send per minute (Groq's free tier: 8000 tokens). L.A.T.E. works inside that: it keeps what it
sends under a budget (a long file or old chat is cut down, oldest first; your newest message and the rules always stay), cuts further
and retries once if the provider says "too large", and waits out a short "try again in 20 seconds" instead of failing. A longer wait
is explained with the time. If a chat has grown heavy, `/clear` starts fresh. Tune with `AI_MAX_PROMPT_CHARS` (default 20000, about 4
characters per token) and `AI_RATE_LIMIT_MAX_WAIT_MS` (default 40000).

## Web search

Works with no key at all (DuckDuckGo, through its two doors: if one is rate-limited, the other often still answers). For steadier
results set any of these and that engine is tried first, with DuckDuckGo as the spare:

```
BRAVE_API_KEY=...                   # brave.com/search/api
TAVILY_API_KEY=...                  # tavily.com
SEARXNG_URL=http://localhost:8080   # your own SearXNG with JSON output on
AI_SEARCH_PROVIDER=auto             # or brave | tavily | searxng | duckduckgo
```

What it does to give better answers:
- **Falls through:** an engine that fails or finds nothing relevant hands over to the next. One that just failed rests for a minute,
  so the next question doesn't wait for it again.
- **Remembers for ten minutes:** the same question again is answered from memory (faster, and no more rate limits).
- **Asks for fresh pages:** "latest ..." with no year gets this year added, so old pages don't win.
- **`research` reads real pages:** it opens the best three (one per site). A page that fails or shows nothing (many JavaScript-only
  sites show an empty page) is replaced by the next result. If there still aren't three, the rest come from search snippets,
  marked as snippets. With few results it searches again with just the key words and merges.
- **Version questions** (Node.js) come from the official release list, not from a search.

Only your search words are sent to the engine. Brave and Tavily are tested against fake servers built from their documented
formats, and DuckDuckGo's lite page from its published markup, not against the live services.

## PDFs and pictures

- **PDFs:** say yes to "Read PDF files too?" in setup (or put `AI_PDF=on` in `.env`); `npm start` adds the small reader library by itself. Then `read_file`, "count the words in report.pdf", "summarize report.pdf" all work. Scans
  (pictures of pages) and files over 10 MB say so plainly. A long PDF is read in full for counting but only its first 8000
  characters go into a summary.
- **Pictures:** `describe photo.png`, "what is in photo.png", "read the text in receipt.png". Needs a model that can see: `llava` or
  `llama3.2-vision` on Ollama, `gpt-4o`, gemini and others on an API. png, jpg, webp, gif up to 5 MB, checked by their real first bytes.
  Text inside a picture is treated as data, never as orders. Without a model that can see, you get a message saying so.

## Watching it

- `npm run logs`: what ran, what failed, how slow (from `logs/late.log`).
- `AI_ERROR_WEBHOOK=<a Slack-style URL>`: a short, redacted message when something fails, at most one a minute.
- `AI_METRICS_TOKEN=<secret>` turns on `GET /api/metrics` (Prometheus text, with `Authorization: Bearer <secret>`): requests, chats, tools,
  errors, active chats. No names or message text.
- `GET /api/health` answers without a token, for uptime checks.

## Running it for real

- **Logs:** `logs/late.log`, one JSON line per event (tool, timing, errors). API keys and passwords are hidden. `AI_LOG=off` turns it off.
- **Web UI limits:** `AI_RATE_LIMIT` messages per minute (default 30), 20 KB per request, stalled connections are dropped. `GET /api/health` answers without a token, for uptime checks.
- **History:** `AI_KEEP_HISTORY=on` makes the terminal chat continue after you quit (`.ai-history.json`, your messages and answers only).
- **Docker:** `docker compose up --build` runs it in a container (port published to 127.0.0.1 only, non-root, health check). Don't publish the port to the network.
- **CI:** `.github/workflows/ci.yml` runs the tests on Linux, Windows and macOS with Node 18, 20 and 22.
- **It's built for one person on their own computer.** Don't put it on the internet. See [SECURITY.md](SECURITY.md).

## Safety

- `read_file` and `search_files` stay inside the folder you started from (change it with `AI_FILES_DIR`) and skip `.env`, key files and `node_modules`.
- `read_webpage` won't open localhost or anything on your local network.
- After the model has read a web page, it can't touch your files or notes in that same question, so a bad page can't tell it to go digging.
- `write_file` and `append_file` always ask first and show what they'll write. They only touch plain names (`.md`, `.txt`, `.json`, `.csv`) inside `ai-output`. `write_file` never overwrites an old file, it saves `name-2.txt` instead. `append_file` only adds to a file that's already there. Only a clear yes counts. Silence, an error or anything unclear is a no, and the answer says so.
- `remember` saves to `.ai-memory.json` as plain text, and the model sees your notes in every chat, so don't save private things. It refuses passwords and API keys. `forget everything` wipes it.

## Settings

All optional. Environment variables, or let `npm run setup` write them to `.env`.

| Variable | Default | What it does |
| --- | --- | --- |
| `AI_PROVIDER` | `ollama` | `ollama`, `lmstudio`, `openai`, or your own adapter name |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Where Ollama runs |
| `OLLAMA_MODEL` | `qwen2.5:3b` | Which Ollama model |
| `OPENAI_BASE_URL` | `http://localhost:1234/v1` | LM Studio or any OpenAI-style server |
| `OPENAI_MODEL` | empty | Model name. Empty means whatever is loaded |
| `OPENAI_API_KEY` | empty | Only if the server wants one |
| `AI_AUTO_AGENT` | on | Several steps in one sentence switch to agent mode by themselves. `off` turns that off |
| `AI_MAX_AGENT_STEPS` | `15` | Max steps in agent mode |
| `AI_AGENT_TIMEOUT_MS` | `300000` | Max time for one agent goal |
| `AI_MAX_TOOL_CALLS` | `5` | Max tools per question in normal chat |
| `AI_MAX_TOKENS` | `1024` | Max length of a reply |
| `AI_MODEL_TIMEOUT_MS` | `120000` | How long to wait for the model |
| `AI_TIMEOUT_MS` | `60000` | How long a tool can run |
| `AI_UI_PORT` | `3737` | Port for the web UI |
| `AI_UI_HOST` | `127.0.0.1` | Only change this inside Docker (see SECURITY.md) |
| `AI_METRICS_TOKEN` | empty | Turns on `/api/metrics` |
| `AI_ERROR_WEBHOOK` | empty | A URL that hears about errors |
| `AI_SEARCH_PROVIDER`, `BRAVE_API_KEY`, `TAVILY_API_KEY`, `SEARXNG_URL` | auto, empty | See Web search |
| `AI_PDF` | off | `on` adds the PDF reader (setup asks) |
| `AI_MAX_PROMPT_CHARS` | `20000` | Most characters sent to the model at once (cloud limits) |
| `AI_RATE_LIMIT_MAX_WAIT_MS` | `40000` | Longest "try again in..." it waits out by itself |
| `AI_RATE_LIMIT` | `30` | Web UI: chat messages per minute (`0` = no limit) |
| `AI_MAX_QUESTION_CHARS` | `8000` | Longest message accepted |
| `AI_LOG` | `info` | `off`, `error`, `info` or `debug` |
| `AI_LOG_FILE` | `logs/late.log` | Where the log goes |
| `AI_KEEP_HISTORY` | off | `on` keeps the terminal chat after you quit |
| `AI_HISTORY_FILE` | `.ai-history.json` | Where that history goes |
| `AI_FILES_DIR` | current folder | The only folder the file tools can see (and where `ai-output` goes) |
| `AI_NOTES_FILE` | `.ai-memory.json` | Where `remember` saves |

## Using it in your own code

```js
import { createAI } from "./sdk.js";

const ai = createAI();                          // or createAI({ provider: "lmstudio" })
console.log(await ai.chat("What is 245 * 37?"));

// word by word, and see which tools run:
await ai.chat("Explain closures in one paragraph", {
  onToken: (text) => process.stdout.write(text),
  onStep: (event) => console.log(event)
});

const result = await ai.agent("research how React hooks work");
console.log(result.answer);

// Dry run: what would it do? Nothing runs.
console.log(ai.plan('Summarize notes.txt and save it to s.txt'));
// { complete: true, steps: [{ label, tool, byModel }...], unmapped: [], needsPermission: true }
```

Tools that change things need permission. In code you decide how to ask:

```js
const ai = createAI({
  confirm: async ({ tool, args, preview }) => {
    // show it however you like, return true only if they said yes
    return false;
  }
});
```

Without `confirm`, those tools just refuse. Nothing is written without a clear `true`.

## Adding your own tool

```js
ai.registerTool({
  name: "coin_flip",                // lowercase letters, numbers, underscores
  description: "Flips a coin and returns heads or tails.",
  parameters: {},                   // like { city: "string" }, add "(optional)" for optional ones
  execute: async () => (Math.random() < 0.5 ? "heads" : "tails")
});

console.log(await ai.chat("Flip a coin for me"));
```

Two flags: `returnDirect: true` returns your output as the answer without the model rewriting it. `needsApproval: true` asks the user first (add `preview: (args) => ...` to show what will happen). Use it for anything that changes something. To run a tool no matter what: `await ai.executeTool("coin_flip")`.

## Adding a model adapter

An adapter gives back two methods. Timeouts, JSON parsing and tool picking live in `adapters/shared.js`, so it stays short:

```js
import { registerAdapter, createAI } from "./sdk.js";
import { postJson, selectToolWith } from "./adapters/shared.js";

registerAdapter("myserver", () => {
  const ask = async (messages) => {
    const data = await postJson("http://localhost:8000/chat", { messages }, { name: "my server" });
    return data.reply;
  };
  return {
    generate: async (messages) => ({ type: "text", content: await ask(messages) }),
    selectTool: (messages, tools) => selectToolWith(ask, messages, tools)
  };
});

const ai = createAI({ provider: "myserver" });
```

Or pass one in directly: `createAI({ model: myAdapter })`. Streaming is optional: accept `{ onToken }` as a second argument to `generate` and call it with each piece of text. Without it the answer just arrives all at once.

## When something breaks

- **"The server rejected the API key"**: wrong or expired. Run `npm run setup`.
- **"Can't reach Ollama" / local model server**: it isn't running or the URL is wrong. Check `OLLAMA_BASE_URL` or `OPENAI_BASE_URL`.
- **"Ollama doesn't have the model"**: run the `ollama pull` command it shows.
- **"didn't answer within..."**: model is big, laptop is slow, or it's still loading. Raise `AI_MODEL_TIMEOUT_MS` or use a smaller model.
- **Answer stops mid-sentence**: raise `AI_MAX_TOKENS`.
- **"rate-limiting requests"**: DuckDuckGo is throttling you. Wait a minute.
- **"needs your permission, and this app can't ask"**: you're using the code API without `confirm`.
- **A multi-step job stops with "the model stopped giving usable answers"**: the request wasn't one the rules understand and the model couldn't pick tools either. Split it into simpler sentences, or try a bigger model.
- **Model ignores your custom tool**: write a clearer `description`, or call `executeTool()` yourself.
- **Port busy**: `AI_UI_PORT=4000 npm run ui`.
- **LM Studio 400 error**: load a model and switch the server on.
- **Start over**: `npm run setup`, or delete `.env`.

## What I tested

About 470 automated tests, running against fake servers and fake models, so you don't need a real model. Among them:
- every tool on its own, and 21 pairs of tools that belong together (weather then convert, research then remember, ...);
- the multi-file, "it", memory-update and verification jobs from my bug reports, run end to end, with a model that cannot do anything;
- the same prompt 100 times with a model that changes its mind every call: for prompts the rules plan, one outcome; for the others, never instructions and never a made-up "done";
- speed of the parallel steps, and that nothing is fetched twice.

By hand I ran it with Ollama (`qwen2.5:3b`, `dolphin-mistral`) and Groq earlier on. **After the latest round of changes (typed results, model profiles, memory replace, new clause rules) I tested only with the fake models above, not with a real model.** LM Studio, Jan, OpenRouter, OpenAI and Gemini should work since they use the same format, but I haven't tried them.

**Things that may still be wrong.** This was built and audited with a lot of AI help and many rounds of bug reports. Every bug fixed has a test, but a test only proves the cases I thought of. Treat the answers as "what the tools returned", read the step list, and check files that matter. If you find a prompt that behaves wrongly, please open an issue with the exact words, what you expected and what you got.

## Not done yet / known limits

- **The rules cover shapes, not all language.** Unusual wording falls back to the model, and small models are unreliable there. Things like "delete", "rename" or "replace X with Y in a.txt" have no tool (nothing is ever overwritten or deleted), and say so.
- **Memory.** "Change it to red" only works when something was just remembered in the same message. A change needs the thing to start with "my" ("change my pet to dog"). A memory note is a sentence (`my favorite fruit is apple`); "save the result" after a recall saves that note, not just the word `apple`. Old notes written in another style (`favorite_color=red`) are found by their words, nothing more.
- **Recall is strict on purpose.** A question with up to three words needs all of them in the note (plural forms count). Ask "favorite" if you want every favorite.
- **Summary vs report ("what is missing").** A point of the report counts as covered when most of its longer words appear in the summary. That is a word-overlap check, not understanding: it can miss a point that was reworded, or flag one that was covered.
- **Verification** is done by tools (`compare_numbers`, `compare_text`). A check that ends on a difference makes the answer say it is not a success; a difference that a later check clears (detect corruption, repair, verify) is fine.
- **Variable names.** If a step reuses a name an earlier step made, the earlier value is kept under a new name. Steps that mean to replace a value (recomputing stats after a file changed) say so.
- **Typed results are not everywhere** (see the table above).
- **Parallel research** can hit search rate limits. If so, you get the error at that step and everything finished before it is kept.
- I haven't run the model-quality eval on real models myself. That's what `npm run eval` is for. Run it on yours before trusting it with anything important.
- Production hosting (many users, logins, HTTPS) isn't what this is. See SECURITY.md.
- Chat history is gone when you quit, unless you turn on `AI_KEEP_HISTORY` (the web UI doesn't keep it).
- Sites that need JavaScript (needs a headless browser), scanned PDFs (needs OCR), PDFs over 10 MB.
- Weather is current conditions only, no forecast.
- Without a search key, search scrapes DuckDuckGo's plain HTML page, which can break. Set a Brave, Tavily or SearXNG key to be steadier.
- I haven't run Docker, real PDFs, real vision models or the live search services myself (all tested with fakes). See AUDIT.md.
- Research and anything the model has to write itself (summaries, stories) is only as good as the model.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are in [CHANGELOG.md](CHANGELOG.md). MIT license.
