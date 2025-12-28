import "dotenv/config";
import * as readline from "readline";
import { ChatOpenAI } from "@langchain/openai";
import { SeniorEngineerAgent } from "./coding-agent/senior-engineer";
import { Agent } from "../agent-interface";

// ============================================================================
// Agent Registry
// ============================================================================

interface AgentArg {
    name: string;
    description: string;
    default?: string;
}

interface AgentEntry {
    name: string;
    description: string;
    args: AgentArg[];
    create: (model: ChatOpenAI, args: Record<string, string>) => Agent;
}

const agents: AgentEntry[] = [
    {
        name: "Senior Engineer",
        description: "Orchestrates file and directory operations to implement features, refactor code, and debug issues",
        args: [
            { name: "rootPath", description: "Root directory to operate on", default: process.cwd() },
        ],
        create: (model, args) => new SeniorEngineerAgent(model, args.rootPath),
    },
    // Add more agents here as they're implemented
];

// ============================================================================
// Terminal UI Helpers
// ============================================================================

const COLORS = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    magenta: "\x1b[35m",
    red: "\x1b[31m",
};

const c = (color: keyof typeof COLORS, text: string) => `${COLORS[color]}${text}${COLORS.reset}`;

function printHeader() {
    console.clear();
    console.log(c("cyan", "\n  ╭─────────────────────────────────────────╮"));
    console.log(c("cyan", "  │") + c("bright", "          🤖 Agent OOP CLI              ") + c("cyan", "│"));
    console.log(c("cyan", "  ╰─────────────────────────────────────────╯\n"));
}

function printAgentList() {
    console.log(c("dim", "  Available agents:\n"));
    agents.forEach((agent, i) => {
        console.log(`  ${c("yellow", `[${i + 1}]`)} ${c("bright", agent.name)}`);
        console.log(`      ${c("dim", agent.description)}\n`);
    });
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
    return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer.trim()));
    });
}

function prettyPrint(data: any, indent: number = 4) {
    const spaces = " ".repeat(indent);
    if (typeof data === "string") {
        try {
            const parsed = JSON.parse(data);
            console.log(spaces + JSON.stringify(parsed, null, 2).split("\n").join("\n" + spaces));
        } catch {
            data.split("\n").forEach((line: string) => console.log(spaces + line));
        }
    } else if (typeof data === "object" && data !== null) {
        const json = JSON.stringify(data, null, 2);
        json.split("\n").forEach((line) => console.log(spaces + line));
    } else {
        console.log(spaces + String(data));
    }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    // Check for API key
    if (!process.env.OPENAI_API_KEY) {
        console.log(c("red", "\n  ✗ OPENAI_API_KEY environment variable not set.\n"));
        console.log(c("dim", "  Export it before running:\n"));
        console.log(c("yellow", "    export OPENAI_API_KEY=sk-...\n"));
        process.exit(1);
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const model = new ChatOpenAI({ modelName: "gpt-5.2" });

    printHeader();
    printAgentList();

    // 1. Select agent
    const choice = await prompt(rl, c("green", "  Select an agent (number): "));
    const index = parseInt(choice, 10) - 1;

    if (isNaN(index) || index < 0 || index >= agents.length) {
        console.log(c("red", "\n  ✗ Invalid selection.\n"));
        rl.close();
        process.exit(1);
    }

    const selected = agents[index];

    // Collect agent arguments
    const collectedArgs: Record<string, string> = {};
    
    if (selected.args.length > 0) {
        console.log(c("dim", "\n  Configure agent:\n"));
        
        for (const arg of selected.args) {
            const defaultHint = arg.default ? c("dim", ` (default: ${arg.default})`) : "";
            const value = await prompt(rl, `  ${c("yellow", arg.name)}${defaultHint}: `);
            collectedArgs[arg.name] = value || arg.default || "";
        }
    }

    console.log(c("green", `\n  ✓ Initializing ${selected.name}...`));

    const agent = selected.create(model, collectedArgs);
    console.log(c("green", `  ✓ ${selected.name} ready!\n`));

    // 2. Get input
    console.log(c("dim", "  ─────────────────────────────────────────\n"));
    const input = await prompt(rl, c("cyan", "  Enter your request: "));

    if (!input) {
        console.log(c("red", "\n  ✗ No input provided.\n"));
        rl.close();
        process.exit(1);
    }

    // 3. Execute
    console.log(c("dim", "\n  ⏳ Executing...\n"));

    try {
        const result = await agent.execute(input);
        console.log(c("green", "  ✓ Result:\n"));
        prettyPrint(result);
        console.log();
    } catch (error: any) {
        console.log(c("red", `\n  ✗ Error: ${error.message}\n`));
        rl.close();
        process.exit(1);
    }

    rl.close();
}

main().catch((error) => {
    console.error(c("red", `\n  Fatal error: ${error.message}\n`));
    process.exit(1);
});
