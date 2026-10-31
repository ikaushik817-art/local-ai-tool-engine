import { createAI } from "./sdk.js";

const ai = createAI();

ai.registerTool({
    name: "greeting",
    description: "Returns a greeting.",
    parameters: {},
    execute: async () => "Hello, developer!"
});

const answer = await ai.chat("Run my greeting tool");
console.log(answer);