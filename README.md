# L.A.T.E.

**Local AI Tool Engine**

Small Node.js toolkit that lets a model (local with Ollama or LM Studio, or an API like Groq) use real tools: exact math, web research, your files, memory, and anything you write yourself. No LangChain, no paid API needed, just two small dependencies.

## Setup

You need [Node.js](https://nodejs.org/) 18 or newer (developed and tested on Node 22). Then, in the project folder:

```bash
npm start
```

That's it. The first time, it installs everything, looks for a model on your laptop, and asks how you want to connect:

- **Ollama running?** It picks it up and uses your model (or downloads a small one if you have none).
- **LM Studio server running?** It picks that up too.
- **No local model / want a cloud one?** Choose "API key", pick OpenAI, Groq, OpenRouter, Gemini (or any OpenAI-compatible URL), paste your key, done. It checks the key and lists models for you.

It saves your choice in a private `.env` file, sends a test message, and from then on `npm start` just starts chatting. Want to change the setup later? `npm run setup`.

Type `exit` to quit. `npm test` runs the tests (no model needed).

Don't want the wizard? Set the variables below yourself, for example `AI_PROVIDER=lmstudio npm start` (PowerShell: `$env:AI_PROVIDER="lmstudio"`).

## Settings

All optional, set them as environment variables.

| Variable | Default | What it does |
| --- | --- | --- |
| `AI_PROVIDER` | `ollama` | `ollama`, `lmstudio`, `openai` or your own adapter name |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Where Ollama is running |
| `OLLAMA_MODEL` | `qwen2.5:3b` | Ollama model tag |
| `OPENAI_BASE_URL` | `http://localhost:1234/v1` | LM Studio / compatible server URL |
| `OPENAI_MODEL` | *(empty)* | Model name. Empty means "whatever is loaded" |
| `OPENAI_API_KEY` | *(empty)* | Only if your server wants one |
| `AI_MAX_TOKENS` | `1024` | Max length of a reply |
| `AI_MODEL_TIMEOUT_MS` | `120000` | How long to wait for the model |
| `AI_TIMEOUT_MS` | `60000` | How long a tool may run |
| `AI_MAX_TOOL_CALLS` | `5` | Max tools per question (stops loops) |
| `AI_FILES_DIR` | current folder | The only folder `read_file` and `search_files` may look in |
| `AI_NOTES_FILE` | `.ai-memory.json` | Where `remember` saves notes |

## Using it in code

```js
import { createAI } from "./sdk.js";

const ai = createAI();                         // or createAI({ provider: "lmstudio" })
console.log(await ai.chat("What is 245 * 37?"));
console.log(await ai.chat("Search for the official React docs on hooks"));
```

All the tools below work out of the box. Math goes to the calculator (so the model can't guess), and search results are summarised by the model with a few source links at the end. If you ask for "official docs", official sites get ranked first.

## Built-in tools

| Tool | What it does | Try asking |
| --- | --- | --- |
| calculator | Exact math, handles divide by zero | `what is 245 * 37?` |
| web_search | Searches the web, prefers official docs when you ask | `search for the official docs on React hooks` |
| research | Searches, opens the best 2-3 pages, pulls out the parts that matter, answers with sources | `research how react hooks work` |
| read_webpage | Opens a link and reads the page | `summarize https://example.com/article` |
| read_file | Reads a text file or lists a folder | `read notes.txt and summarize it` |
| search_files | Searches inside your files (names and contents) | `search my files for acme invoice` |
| remember / recall / forget | Keeps facts between chats, in a local file | `remember my sister is called Riya` / `what do you remember?` / `forget Riya` |
| datetime | Exact date and time, days until a date (small models get this wrong) | `what time is it?` / `how many days until 25 December?` |

Calculator, date/time, memory and file search answer exactly, they don't depend on the model getting it right.

**Memory:** saved notes live in `.ai-memory.json` next to the project (change with `AI_NOTES_FILE`). They are plain text on your computer, and the model sees them in every chat, so don't save anything private. It refuses passwords and API keys. `forget everything` wipes it.

**Safety:** `read_file` and `search_files` only look inside the folder you started in (change with `AI_FILES_DIR`) and skip `.env`, keys and `node_modules`. `read_webpage` refuses localhost and private network addresses. After the model has read a web page, it can't use your files or memory in that same question, so a sneaky page can't push it around. No PDF or image reading yet.

## How it works

When you send a message, the engine decides what to do:

1. **Obvious stuff runs directly.** Math, a link, a file name, "remember ...", "what time is it" go straight to the right tool. It's fast and exact, no model guessing.
2. **Everything else, the model picks.** If you added custom tools, the model chooses one (as a tiny JSON answer) and the engine runs it. Max 5 tools per question, and the same call never runs twice, so it can't loop.
3. **The model writes the answer** using what the tool found. Tools like datetime, memory and file search skip this step because their result is already the answer.

How each tool does its job:

- **calculator**: a real math parser, not the model. Divide by zero gives a clear error, and `0.1 + 0.2` is `0.3`.
- **web_search**: asks DuckDuckGo, keeps only results that match your question (official sites first if you say "official docs"), then the model answers and up to 3 source links are added.
- **research**: web_search, then opens the top 3 pages (one per site), picks the part of each page that matches your question, and the model answers from that with sources.
- **read_webpage**: downloads the page, drops menus and scripts, keeps the text.
- **read_file / search_files**: look only inside your folder and skip secrets.
- **remember**: saves to `.ai-memory.json` and adds your notes to the model's instructions every chat.
- **datetime**: reads your computer's clock.

## Add your own tool

```js
ai.registerTool({
  name: "coin_flip",                // lowercase, numbers, underscores
  description: "Flips a coin and returns heads or tails.",
  parameters: {},                   // e.g. { city: "string" }, add "(optional)" for optional ones
  execute: async () => (Math.random() < 0.5 ? "heads" : "tails")
});

console.log(await ai.chat("Flip a coin for me"));
```

The model picks the tool, your function runs, and the model uses the result to write the answer. If you want your tool's output returned as-is, add `returnDirect: true`. Need it to run for sure? Use `await ai.executeTool("coin_flip")`.

## Add a new model adapter

An adapter is just a function that returns two methods. Anything shared (timeouts, JSON parsing, tool selection) is in `adapters/shared.js`, so it's short:

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

Or skip registering and pass it straight in: `createAI({ model: myAdapter })`.

## Troubleshooting

- **Want to redo the setup**: run `npm run setup` (or delete `.env`).
- **"The server rejected the API key"**: wrong or expired key, run `npm run setup` and paste it again.
- **"Can't reach Ollama / local model server"**: the server isn't running or the URL is wrong. Check `OLLAMA_BASE_URL` / `OPENAI_BASE_URL`.
- **"Ollama doesn't have the model"**: run the `ollama pull ...` command it prints.
- **"didn't answer within..."**: big model on a slow laptop, or it's still loading. Try again or raise `AI_MODEL_TIMEOUT_MS`. A smaller model helps too.
- **Answer ends mid-sentence**: raise `AI_MAX_TOKENS`.
- **"rate-limiting requests"** from search: DuckDuckGo is throttling you, wait a minute.
- **Model ignores your custom tool**: small models are flaky at picking tools. Make the `description` clearer, or call `executeTool()` directly.
- **LM Studio gives a 400 error**: make sure a model is loaded and the server is started.

## What's been tested

Tested for real with Ollama (2 models) and Groq. It should also work with LM Studio, Jan, OpenRouter, OpenAI, Gemini and anything else that speaks the OpenAI format, but I haven't tried those myself. If something breaks, please open an issue with the error message.

## Known limits

- Chat history lives in memory only, it resets when the program ends.
- No streaming yet.
- `read_file` and `read_webpage` only read text, no PDF or JavaScript-heavy pages.
- Search uses DuckDuckGo's HTML page, so it can break if they change it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). License: MIT.