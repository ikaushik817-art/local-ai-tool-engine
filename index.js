import readline from "node:readline/promises";
import { createModelAdapter } from "./model.js";
import { createToolEngine } from "./engine/toolEngine.js";
import { config } from "./config.js";

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

async function startChat() {
    console.log("Local AI Tool Engine");
    console.log(`Provider: ${config.provider}`);
    console.log("Type 'exit' to quit.\n");

    try {
        const model = createModelAdapter();
        const engine = createToolEngine(model);

        while (true) {
            const input = await rl.question("You: ");
            const question = input.trim();

            if (!question) continue;
            if (question.toLowerCase() === "exit") {
                console.log("Goodbye!");
                break;
            }

            try {
                const answer = await engine.run(question);
                console.log("AI:", answer);
            } catch (error) {
                console.error("Request failed:", error.message);
            }

            console.log("");
        }
    } finally {
        rl.close();
    }
}

startChat().catch((error) => {
    console.error("Could not start the engine:", error.message);
    rl.close();
});
