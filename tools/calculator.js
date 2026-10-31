import { Parser } from "expr-eval";

const parser = new Parser();

// expr-eval quietly returns Infinity/NaN for x/0, so catch it ourselves.
const safeDivide = (a, b) => {
    if (b === 0) throw new Error("Cannot divide by zero.");
    return a / b;
};
parser.binaryOps["/"] = safeDivide;
parser.binaryOps["%"] = (a, b) => {
    if (b === 0) throw new Error("Cannot divide by zero.");
    return a % b;
};

export function calculate(expression) {
    if (typeof expression !== "string" || !expression.trim()) {
        throw new Error("A mathematical expression is required.");
    }
    if (expression.length > 200) {
        throw new Error("That expression is too long.");
    }

    const normalized = expression
        .replace(/×/g, "*")
        .replace(/÷/g, "/")
        .replace(/\*\*/g, "^")
        .replace(/(?<=\d),(?=\d{3}\b)/g, "") // 1,000 -> 1000
        // "20%" means 20/100, but "10%3" is still a remainder.
        .replace(/(\d+(?:\.\d+)?)%(?!\s*[\d(])/g, "($1/100)");

    let result;
    try {
        result = parser.evaluate(normalized);
    } catch (error) {
        if (/divide by zero/i.test(error.message)) throw error;
        throw new Error("Invalid mathematical expression.");
    }

    if (typeof result !== "number" || !Number.isFinite(result)) {
        throw new Error("Invalid mathematical expression.");
    }

    // 0.1 + 0.2 should give 0.3, not 0.30000000000000004.
    return Number.isInteger(result) ? result : Number(result.toPrecision(15));
}
