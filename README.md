# Agent Engineering Framework

A polymorphic framework for building production-grade AI agents in TypeScript.

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

### BaseAgent

All agents extend `BaseAgent`, which:
1. Takes a model in the constructor
2. Auto-discovers `@Tool` decorated methods
3. Wires them up as LangChain tools with hooks

```typescript
class MyAgent extends Agent {
    @Tool({ name: "search", description: "Search docs", parameters: z.object({ q: z.string() }) })
    @Before(validateInput)
    @After(sanitizeOutput)
    search({ q }: { q: string }) {
        return db.search(q);
    }

    @Tool({ name: "analyze", description: "Analyze data", parameters: z.object({ data: z.string() }) })
    async analyze({ data }: { data: string }) {
        return this.agent.invoke({ input: `Analyze: ${data}` } as any);
    }

    async execute(input: string) {
        return this.agent.invoke({ input } as any);
    }
}
```

## File Structure

```
agent-oop/
├── agent-interface.ts         # Core framework: BaseAgent, @Tool, @Before, @After
├── examples/
│   ├── cypherpunk-library.ts  # Example: hierarchical agents (Library → Books → Pages)
│   └── codebase.ts            # Example: coding agents (Files, Organizer, Quality, SuperCoder)
├── tsconfig.json              # TypeScript config (experimentalDecorators enabled)
└── package.json
```

## Examples

### Cypherpunk Library (`examples/cypherpunk-library.ts`)

A hierarchical agent system modeling a library:

```
CypherpunkLibrary (orchestrator)
├── LibrarianAgent[] (specialists with different focuses)
└── BookAgent (Map<string, Book>)
    └── PageAgent[] (individual pages)
```

**Capabilities:**
- `searchAll` — Search across all books
- `askLibrarian` — Route questions to specialist librarians
- `addBook` — Create new books (with auth hooks)
- Books can `summarize`, `search`, `writePage`
- Pages can `write`, `edit`, `getContent`

### Codebase (`examples/codebase.ts`)

A coding agent system:

```
SuperCodingAgent (orchestrator)
├── OrganizerAgent (file system operations)
├── QualityAgent (linting, testing, type checking)
└── FileExtensionAgent (Map<string, File>)
```

**Capabilities:**
- `implement` — Implement features across multiple files
- `refactor` — Refactor with automatic linting
- `debug` — Analyze and fix issues
- `createFeature` — Scaffold → lint → typecheck pipeline
- `codeReview` — Comprehensive quality analysis

## Key Patterns

### 1. Subagents via Composition

```typescript
class OrchestratorAgent extends BaseAgent {
    researcher: ResearchAgent;
    writer: WriterAgent;

    constructor(model: ChatOpenAI) {
        super(model);
        this.researcher = new ResearchAgent(model);
        this.writer = new WriterAgent(model);
    }
}
```

### 2. Shared State

```typescript
class ParentAgent extends BaseAgent {
    files: Map<string, FileAgent> = new Map();
    organizer: OrganizerAgent;

    constructor(model: ChatOpenAI) {
        super(model);
        // Pass shared state to subagents
        this.organizer = new OrganizerAgent(model, this.files);
    }
}
```

### 3. Hook Chains

```typescript
const validateInput = (input: any) => {
    if (!input.query) throw new Error("Query required");
    return input;
};

const logAccess = (input: any) => {
    console.log(`[ACCESS] ${JSON.stringify(input)}`);
    return input;
};

@Tool({ name: "search", description: "Search the database", parameters: z.object({ query: z.string() }) })
@Before(validateInput)
@Before(logAccess)  // Runs after validateInput
@After(sanitizeOutput)
search({ query }) { ... }
```

## Philosophy

1. **Agents are objects** — State, methods, inheritance, composition all work naturally
2. **Tools are the unit of work** — Every capability is a tool the LLM can invoke
3. **Hooks for cross-cutting concerns** — Auth, logging, validation without polluting tool logic
4. **Subagents via composition** — Build complex systems from simple, testable pieces
5. **TypeScript-first** — Full type safety with Zod schemas for LLM I/O

## Getting Started

```bash
npm install langchain @langchain/openai zod
```

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { BaseAgent, Tool, Before } from "./agent-interface";
import { z } from "zod";

class MyAgent extends BaseAgent {
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

## License

MIT
