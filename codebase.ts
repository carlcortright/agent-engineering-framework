import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { BaseAgent, Task, Tool, Before, After } from "./interfaces";

// ============================================================================
// Middleware Functions
// ============================================================================

const logFileAccess = (input: any) => {
    console.log(`[FILE] ${new Date().toISOString()} - ${JSON.stringify(input).slice(0, 100)}`);
    return input;
};

const validatePath = (input: any) => {
    if (input.path && input.path.includes("..")) {
        throw new Error("Path traversal not allowed");
    }
    return input;
};

const requireConfirmation = (input: any) => {
    console.log(`[CONFIRM] Destructive operation: ${JSON.stringify(input)}`);
    // In real implementation, would await user confirmation
    return input;
};

// ============================================================================
// File Extension Agent - Handles individual file operations
// ============================================================================

class FileExtensionAgent extends BaseAgent {
    path: string;
    content: string = "";
    language: string;

    constructor(model: ChatOpenAI, path: string, content: string = "") {
        super(model);
        this.path = path;
        this.content = content;
        this.language = this.detectLanguage(path);
    }

    private detectLanguage(path: string): string {
        const ext = path.split(".").pop() || "";
        const langMap: Record<string, string> = {
            ts: "typescript",
            tsx: "typescript",
            js: "javascript",
            jsx: "javascript",
            py: "python",
            rs: "rust",
            go: "go",
            md: "markdown",
        };
        return langMap[ext] || "plaintext";
    }

    @Tool({
        name: "getContent",
        description: "Get the current file content",
        parameters: z.object({}),
    })
    getContent() {
        return { path: this.path, content: this.content, language: this.language };
    }

    @Tool({
        name: "getMetadata",
        description: "Get file metadata",
        parameters: z.object({}),
    })
    getMetadata() {
        return {
            path: this.path,
            language: this.language,
            lines: this.content.split("\n").length,
            characters: this.content.length,
        };
    }

    @Task({
        name: "rewrite",
        description: "Completely rewrite the file content",
        inputSchema: z.object({ newContent: z.string() }),
    })
    @Before(logFileAccess)
    @Before(requireConfirmation)
    async rewrite({ newContent }: { newContent: string }) {
        const oldContent = this.content;
        this.content = newContent;
        return {
            path: this.path,
            oldLines: oldContent.split("\n").length,
            newLines: newContent.split("\n").length,
            status: "rewritten",
        };
    }

    @Task({
        name: "edit",
        description: "Edit the file using AI based on instructions",
        inputSchema: z.object({ instruction: z.string() }),
    })
    @Before(logFileAccess)
    async edit({ instruction }: { instruction: string }) {
        const result = await this.agent.invoke({
            input: `You are editing a ${this.language} file at ${this.path}.
Current content:
\`\`\`${this.language}
${this.content}
\`\`\`

Instruction: ${instruction}

Return ONLY the complete new file content, no explanation.`
        } as any);

        this.content = String(result);
        return { path: this.path, status: "edited", instruction };
    }

    @Task({
        name: "analyze",
        description: "Analyze the file for issues, patterns, or improvements",
        inputSchema: z.object({ focus: z.string().optional() }),
    })
    async analyze({ focus }: { focus?: string }) {
        return this.agent.invoke({
            input: `Analyze this ${this.language} file:
\`\`\`${this.language}
${this.content}
\`\`\`
${focus ? `Focus on: ${focus}` : "Provide general analysis."}`
        } as any);
    }

    async execute(input: string) {
        return this.agent.invoke({ input } as any);
    }
}

// ============================================================================
// Organizer Agent - File system operations
// ============================================================================

class OrganizerAgent extends BaseAgent {
    private files: Map<string, FileExtensionAgent>;
    private model: ChatOpenAI;

    constructor(model: ChatOpenAI, files: Map<string, FileExtensionAgent>) {
        super(model);
        this.model = model;
        this.files = files;
    }

    @Tool({
        name: "listFiles",
        description: "List all files in the codebase",
        parameters: z.object({ pattern: z.string().optional() }),
    })
    listFiles({ pattern }: { pattern?: string }) {
        const paths = Array.from(this.files.keys());
        if (pattern) {
            const regex = new RegExp(pattern);
            return paths.filter((p) => regex.test(p));
        }
        return paths;
    }

    @Tool({
        name: "getFileTree",
        description: "Get the file tree structure",
        parameters: z.object({}),
    })
    getFileTree() {
        const tree: Record<string, any> = {};
        for (const path of this.files.keys()) {
            const parts = path.split("/");
            let current = tree;
            for (let i = 0; i < parts.length - 1; i++) {
                current[parts[i]] = current[parts[i]] || {};
                current = current[parts[i]];
            }
            current[parts[parts.length - 1]] = "file";
        }
        return tree;
    }

    @Task({
        name: "createFile",
        description: "Create a new file in the codebase",
        inputSchema: z.object({
            path: z.string(),
            content: z.string().optional(),
        }),
    })
    @Before(validatePath)
    @Before(logFileAccess)
    async createFile({ path, content = "" }: { path: string; content?: string }) {
        if (this.files.has(path)) {
            return { error: "File already exists", path };
        }

        const file = new FileExtensionAgent(this.model, path, content);
        this.files.set(path, file);

        return { status: "created", path, lines: content.split("\n").length };
    }

    @Task({
        name: "moveFile",
        description: "Move/rename a file",
        inputSchema: z.object({
            from: z.string(),
            to: z.string(),
        }),
    })
    @Before(validatePath)
    @Before(requireConfirmation)
    async moveFile({ from, to }: { from: string; to: string }) {
        const file = this.files.get(from);
        if (!file) {
            return { error: "Source file not found", from };
        }
        if (this.files.has(to)) {
            return { error: "Destination already exists", to };
        }

        // Create new file at destination with same content
        const newFile = new FileExtensionAgent(this.model, to, file.content);
        this.files.set(to, newFile);
        this.files.delete(from);

        return { status: "moved", from, to };
    }

    @Task({
        name: "deleteFile",
        description: "Delete a file from the codebase",
        inputSchema: z.object({ path: z.string() }),
    })
    @Before(validatePath)
    @Before(requireConfirmation)
    async deleteFile({ path }: { path: string }) {
        if (!this.files.has(path)) {
            return { error: "File not found", path };
        }

        this.files.delete(path);
        return { status: "deleted", path };
    }

    @Task({
        name: "scaffold",
        description: "Generate a file structure based on description",
        inputSchema: z.object({ description: z.string() }),
    })
    async scaffold({ description }: { description: string }) {
        const result = await this.agent.invoke({
            input: `Generate a file structure for: ${description}
Return as JSON array of { path: string, content: string } objects.`
        } as any);

        // Parse and create files
        try {
            const files = JSON.parse(String(result));
            for (const { path, content } of files) {
                await this.createFile({ path, content });
            }
            return { status: "scaffolded", filesCreated: files.length };
        } catch {
            return { error: "Failed to parse scaffold output" };
        }
    }

    async execute(input: string) {
        return this.agent.invoke({ input } as any);
    }
}

// ============================================================================
// Quality Agent - Linting, Testing, Building
// ============================================================================

class QualityAgent extends BaseAgent {
    private files: Map<string, FileExtensionAgent>;

    constructor(model: ChatOpenAI, files: Map<string, FileExtensionAgent>) {
        super(model);
        this.files = files;
    }

    @Task({
        name: "lint",
        description: "Lint files for code quality issues",
        inputSchema: z.object({
            paths: z.array(z.string()).optional(),
            fix: z.boolean().optional(),
        }),
    })
    async lint({ paths, fix = false }: { paths?: string[]; fix?: boolean }) {
        const targetPaths = paths || Array.from(this.files.keys());
        const issues: { path: string; issues: any }[] = [];

        for (const path of targetPaths) {
            const file = this.files.get(path);
            if (!file) continue;

            const result = await this.agent.invoke({
                input: `Lint this ${file.language} code and return issues as JSON array:
\`\`\`${file.language}
${file.content}
\`\`\`
Return: [{ line: number, severity: "error"|"warning", message: string }]`
            } as any);

            try {
                const fileIssues = JSON.parse(String(result));
                if (fileIssues.length > 0) {
                    issues.push({ path, issues: fileIssues });

                    if (fix) {
                        await file.edit({ instruction: "Fix all linting issues" });
                    }
                }
            } catch {
                // AI didn't return valid JSON, skip
            }
        }

        return { totalFiles: targetPaths.length, filesWithIssues: issues.length, issues };
    }

    @Task({
        name: "test",
        description: "Analyze code and suggest/generate tests",
        inputSchema: z.object({ path: z.string() }),
    })
    async test({ path }: { path: string }) {
        const file = this.files.get(path);
        if (!file) {
            return { error: "File not found", path };
        }

        return this.agent.invoke({
            input: `Generate unit tests for this ${file.language} code:
\`\`\`${file.language}
${file.content}
\`\`\`
Return complete test file content.`
        } as any);
    }

    @Task({
        name: "typecheck",
        description: "Check for type errors in TypeScript files",
        inputSchema: z.object({ paths: z.array(z.string()).optional() }),
    })
    async typecheck({ paths }: { paths?: string[] }) {
        const targetPaths = (paths || Array.from(this.files.keys()))
            .filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"));

        const errors: { path: string; errors: any }[] = [];

        for (const path of targetPaths) {
            const file = this.files.get(path);
            if (!file) continue;

            const result = await this.agent.invoke({
                input: `Check this TypeScript code for type errors:
\`\`\`typescript
${file.content}
\`\`\`
Return: [{ line: number, message: string }] or [] if no errors.`
            } as any);

            try {
                const fileErrors = JSON.parse(String(result));
                if (fileErrors.length > 0) {
                    errors.push({ path, errors: fileErrors });
                }
            } catch {
                // Skip
            }
        }

        return { totalFiles: targetPaths.length, filesWithErrors: errors.length, errors };
    }

    @Task({
        name: "review",
        description: "Perform a code review on files",
        inputSchema: z.object({
            paths: z.array(z.string()).optional(),
            focus: z.string().optional(),
        }),
    })
    async review({ paths, focus }: { paths?: string[]; focus?: string }) {
        const targetPaths = paths || Array.from(this.files.keys());
        const reviews: { path: string; review: any }[] = [];

        for (const path of targetPaths) {
            const file = this.files.get(path);
            if (!file) continue;

            const result = await this.agent.invoke({
                input: `Code review for ${path}:
\`\`\`${file.language}
${file.content}
\`\`\`
${focus ? `Focus on: ${focus}` : ""}
Provide: summary, issues, suggestions, score (1-10)`
            } as any);

            reviews.push({ path, review: result });
        }

        return reviews;
    }

    async execute(input: string) {
        return this.agent.invoke({ input } as any);
    }
}

// ============================================================================
// SuperCoding Agent - The orchestrator
// ============================================================================

export class SuperCodingAgent extends BaseAgent {
    files: Map<string, FileExtensionAgent> = new Map();
    organizer: OrganizerAgent;
    quality: QualityAgent;

    constructor(model: ChatOpenAI) {
        super(model);

        // Initialize subagents with shared file map
        this.organizer = new OrganizerAgent(model, this.files);
        this.quality = new QualityAgent(model, this.files);
    }

    @Tool({
        name: "getFile",
        description: "Get a file agent by path",
        parameters: z.object({ path: z.string() }),
    })
    getFile({ path }: { path: string }) {
        const file = this.files.get(path);
        if (!file) return { error: "File not found" };
        return file.getContent();
    }

    @Tool({
        name: "listFiles",
        description: "List all files",
        parameters: z.object({}),
    })
    listFiles() {
        return this.organizer.listFiles({});
    }

    @Task({
        name: "implement",
        description: "Implement a feature across the codebase",
        inputSchema: z.object({
            description: z.string(),
            files: z.array(z.string()).optional(),
        }),
    })
    async implement({ description, files }: { description: string; files?: string[] }) {
        const targetFiles = files || Array.from(this.files.keys());
        const changes: { path: string; status: string }[] = [];

        // First, understand what needs to be done
        const plan = await this.agent.invoke({
            input: `Plan implementation of: "${description}"
Available files: ${JSON.stringify(targetFiles)}
Return a step-by-step plan.`
        } as any);

        // Edit each relevant file
        for (const path of targetFiles) {
            const file = this.files.get(path);
            if (!file) continue;

            await file.edit({
                instruction: `Implement: ${description}\n\nPlan context:\n${plan}`,
            });

            changes.push({ path, status: "modified" });
        }

        return { plan, changes };
    }

    @Task({
        name: "refactor",
        description: "Refactor code across the codebase",
        inputSchema: z.object({
            description: z.string(),
            paths: z.array(z.string()).optional(),
        }),
    })
    async refactor({ description, paths }: { description: string; paths?: string[] }) {
        const targetPaths = paths || Array.from(this.files.keys());

        // Analyze before refactor
        const beforeReview = await this.quality.review({ paths: targetPaths });

        // Perform refactor
        for (const path of targetPaths) {
            const file = this.files.get(path);
            if (!file) continue;

            await file.edit({ instruction: `Refactor: ${description}` });
        }

        // Lint after refactor
        const lintResult = await this.quality.lint({ paths: targetPaths, fix: true });

        return {
            refactored: targetPaths.length,
            lintIssuesFixed: lintResult.filesWithIssues,
        };
    }

    @Task({
        name: "debug",
        description: "Debug an issue in the codebase",
        inputSchema: z.object({
            issue: z.string(),
            errorMessage: z.string().optional(),
        }),
    })
    async debug({ issue, errorMessage }: { issue: string; errorMessage?: string }) {
        // Gather context
        const allCode = Array.from(this.files.entries())
            .map(([path, file]) => `// ${path}\n${file.content}`)
            .join("\n\n");

        const analysis = await this.agent.invoke({
            input: `Debug this issue: "${issue}"
${errorMessage ? `Error: ${errorMessage}` : ""}

Codebase:
${allCode}

Identify:
1. Root cause
2. Affected files
3. Suggested fix`
        } as any);

        return { issue, analysis };
    }

    @Task({
        name: "createFeature",
        description: "Create a new feature with all necessary files",
        inputSchema: z.object({
            name: z.string(),
            description: z.string(),
        }),
    })
    async createFeature({ name, description }: { name: string; description: string }) {
        // Generate file structure
        const scaffoldResult = await this.organizer.scaffold({
            description: `Feature: ${name}\n${description}`,
        });

        // Lint new files
        const lintResult = await this.quality.lint({ fix: true });

        // Type check
        const typeResult = await this.quality.typecheck({});

        return {
            feature: name,
            scaffold: scaffoldResult,
            lint: lintResult,
            types: typeResult,
        };
    }

    @Task({
        name: "codeReview",
        description: "Perform comprehensive code review",
        inputSchema: z.object({ focus: z.string().optional() }),
    })
    async codeReview({ focus }: { focus?: string }) {
        const lint = await this.quality.lint({});
        const types = await this.quality.typecheck({});
        const review = await this.quality.review({ focus });

        return {
            summary: {
                totalFiles: this.files.size,
                lintIssues: lint.filesWithIssues,
                typeErrors: types.filesWithErrors,
            },
            lint,
            types,
            review,
        };
    }

    async execute(input: string) {
        return this.agent.invoke({ input } as any);
    }
}

// ============================================================================
// Usage Example
// ============================================================================

async function main() {
    const model = new ChatOpenAI({ modelName: "gpt-4o" });
    const coder = new SuperCodingAgent(model);

    // Create some initial files
    await coder.organizer.createFile({
        path: "src/index.ts",
        content: `export function main() {
    console.log("Hello, world!");
}`,
    });

    await coder.organizer.createFile({
        path: "src/utils/helpers.ts",
        content: `export const add = (a: number, b: number) => a + b;
export const subtract = (a: number, b: number) => a - b;`,
    });

    // List files
    console.log("📁 Files:", coder.listFiles());

    // Implement a feature
    const result = await coder.implement({
        description: "Add a multiply function to helpers and use it in index",
        files: ["src/index.ts", "src/utils/helpers.ts"],
    });
    console.log("✨ Implementation:", result);

    // Run code review
    const review = await coder.codeReview({ focus: "best practices" });
    console.log("📋 Review:", review);
}

// main();
