# Agent Engineering Framework

A minimalistic, object-oriented framework for building composable, production-grade AI agents in TypeScript.

## The Problem

Existing agent frameworks like LangChain, CrewAI, and others either:
- Are too low-level (LangChain) — great primitives, but bridging the gap from demo to production requires significant boilerplate
- Are too high-level (CrewAI) — opinionated abstractions that don't fit real engineering workflows
- Lack proper boundaries — agents become spaghetti when you need 100s of them at scale

**Agent Engineering** takes an object-oriented approach: agents are classes with decorated methods that automatically wire up to the underlying LLM.

## Core Concepts

### Decorators

| Decorator | Purpose |
|-----------|---------|
| `@Tool` | Function callable by the LLM. Auto-registered and wired up. |
| `@Before` | Hook that runs before a tool executes (validation, logging, transformation). |
| `@After` | Hook that runs after a tool executes (sanitization, formatting). |

### Agent

All agents extend `Agent`, which:
1. Takes a model in the constructor
2. Auto-discovers `@Tool` decorated methods
3. Wires them up as LangChain tools with hooks

## Key Patterns

### 1. Self-Editing Objects

Objects maintain their own state and can modify themselves, creating responsible boundaries and preventing spaghetti:

```typescript
class FileAgent extends Agent {
    content: string;

    async edit({ instruction }) {
        const newContent = await this.agent.invoke(...);
        this.content = newContent;        // Update self
        await fs.writeFile(this.path, this.content);  // Persist
    }
}
```

### 2. Self-Describing State

Objects summarize themselves so orchestrators don't need full context:

```typescript
class FileAgent extends Agent {
    summary: string;  // "typescript file (45 lines): exports UserService, validateUser"

    private async updateSummary() {
        this.summary = await this.agent.invoke({
            input: `Summarize: ${this.content.slice(0, 500)}`
        });
    }
}
```

### 3. Hook Chains

Cross-cutting concerns without polluting tool logic:

```typescript
const logAccess = (input: any) => {
    console.log(`[FILE] ${JSON.stringify(input)}`);
    return input;
};

@Tool({ name: "write", ... })
@Before(logAccess)
@After(updateSummary)
async write({ content }) { ... }
```

### 4. Composition Over Configuration

Build complex systems from simple agents:

```typescript
class SeniorEngineerAgent extends Agent {
    root: DirectoryAgent;  // Has FileAgents, has more DirectoryAgents...

    constructor(model: ChatOpenAI) {
        super(model);
        this.root = new DirectoryAgent(model, "src/");
    }
}
```

### 5. Subagents as Members

Subagents are just properties on the parent agent—no special registration or configuration:

```typescript
class EngineeringTeam extends Agent {
    // Subagents are member variables
    seniorEngineer: SeniorEngineerAgent;
    qaEngineer: QAEngineerAgent;
    designer: DesignAgent;

    constructor(model: ChatOpenAI) {
        super(model);
        this.seniorEngineer = new SeniorEngineerAgent(model);
        this.qaEngineer = new QAEngineerAgent(model);
        this.designer = new DesignAgent(model);
    }

    @Tool({
        name: "buildFeature",
        description: "Build a complete feature with design, implementation, and QA",
        parameters: z.object({ spec: z.string() }),
    })
    async buildFeature({ spec }) {
        const design = await this.designer.createDesign({ spec });
        const code = await this.seniorEngineer.implement({ feature: spec, design });
        const tests = await this.qaEngineer.writeTests({ code });
        return { design, code, tests };
    }
}
```

This makes agent hierarchies explicit and inspectable—no magic, just objects.

### 6. Tool Inheritance via Extension

Extend agents to compose capabilities. Children inherit all `@Tool` methods from parents:

```typescript
// Base agent with search capability
class SearchableAgent extends Agent {
    @Tool({
        name: "search",
        description: "Search for information",
        parameters: z.object({ query: z.string() }),
    })
    async search({ query }: { query: string }) {
        return this.searchIndex.query(query);
    }
}

// Research agent inherits search, adds its own tools
class ResearchAgent extends SearchableAgent {
    @Tool({
        name: "synthesize",
        description: "Synthesize findings into a report",
        parameters: z.object({ topic: z.string() }),
    })
    async synthesize({ topic }) {
        const results = await this.search({ query: topic });  // Use inherited tool
        return this.agent.invoke({ input: `Synthesize: ${results}` } as any);
    }
}

// Documentation agent also inherits search
class DocumentationAgent extends SearchableAgent {
    @Tool({
        name: "generateDocs",
        description: "Generate documentation for code",
        parameters: z.object({ code: z.string() }),
    })
    async generateDocs({ code }) {
        const examples = await this.search({ query: `examples ${code}` });
        return this.agent.invoke({ input: `Document with examples: ${examples}` } as any);
    }
}
```

Build capability mixins through inheritance—search, persistence, logging, etc.

## Example: Self-Editing Codebase

The key innovation in this framework is that **objects can edit themselves**. A file agent doesn't just represent a file—it *is* an agent that can rewrite its own content.

```
SeniorEngineerAgent (orchestrator)
├── DirectoryAgent (root/)
│   ├── FileAgent (index.ts) ← can edit itself
│   ├── FileAgent (utils.ts) ← can edit itself
│   └── DirectoryAgent (components/)
│       └── FileAgent (Button.tsx) ← can edit itself
```

### FileAgent — Self-Editing Files

```typescript
export class FileAgent extends Agent {
    path: string;
    content: string;
    summary: string = "";  // Self-description, auto-updated

    @Tool({
        name: "edit",
        description: "Edit the file using natural language instructions",
        parameters: z.object({ instruction: z.string() }),
    })
    async edit({ instruction }: { instruction: string }) {
        // Ask LLM to generate new content
        const result = await this.agent.invoke({
            input: `Edit "${this.path}": ${instruction}\n\nCurrent:\n${this.content}`
        } as any);

        // Self-edit: update own content and persist to disk
        this.content = String(result);
        await fs.writeFile(this.path, this.content);
        await this.updateSummary();

        return { status: "self-edited", path: this.path };
    }
}
```

### DirectoryAgent — Self-Describing Directories

Directories maintain summaries of their contents, so the orchestrator doesn't need to read every file:

```typescript
export class DirectoryAgent extends Agent {
    files: Map<string, FileAgent> = new Map();
    directories: Map<string, DirectoryAgent> = new Map();
    summary: string = "";  // Aggregated from children

    @Tool({
        name: "editFile",
        description: "Edit a file by name",
        parameters: z.object({ name: z.string(), instruction: z.string() }),
    })
    async editFile({ name, instruction }) {
        const file = this.files.get(name);
        return file.edit({ instruction });  // Delegate to file's self-edit
    }
}
```

### SeniorEngineerAgent — The Orchestrator

Uses self-descriptions to understand the codebase without reading everything:

```typescript
export class SeniorEngineerAgent extends Agent {
    root: DirectoryAgent;

    @Tool({
        name: "implement",
        description: "Implement a feature across the codebase",
        parameters: z.object({ feature: z.string() }),
    })
    async implement({ feature }) {
        // 1. Understand codebase via self-descriptions (not full content)
        const context = this.root.getTree();

        // 2. Plan which files to create/edit
        const plan = await this.agent.invoke({
            input: `Implement "${feature}"\n\nCodebase:\n${context}`
        } as any);

        // 3. Execute: files edit themselves
        for (const step of plan.steps) {
            if (step.action === "edit") {
                await this.editFile({ path: step.path, instruction: step.description });
            }
        }
    }
}
```

## File Structure

```
agent-engineering-framework/
├── agent-interface.ts              # Core: Agent, @Tool, @Before, @After
├── examples/
│   ├── coding-agent/
│   │   └── senior-engineer.ts      # SeniorEngineerAgent — orchestrator
│   ├── os/
│   │   ├── file.ts                 # FileAgent — self-editing files
│   │   └── directory.ts            # DirectoryAgent — self-describing dirs
│   ├── scraping-agent/
│   │   ├── scraping-agent.ts
│   │   └── webpage.ts
│   ├── design-agent/
│   └── pm-agent/
├── tsconfig.json
└── package.json
```

## Getting Started

```bash
npm install langchain @langchain/openai zod
```

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { Agent, Tool } from "./agent-interface";
import { z } from "zod";

class MyAgent extends Agent {
    @Tool({ name: "greet", description: "Greet a user", parameters: z.object({ name: z.string() }) })
    greet({ name }: { name: string }) {
        return `Hello, ${name}!`;
    }

    async execute(input: string) {
        return this.agent.invoke({ input } as any);
    }
}

const model = new ChatOpenAI({ modelName: "gpt-4o" });
const agent = new MyAgent(model);
```

## TODO

- [ ] Agent state persistence layer
- [ ] Human-in-the-loop tooling
- [ ] Evals

## License

MIT
