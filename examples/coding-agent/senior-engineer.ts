import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { BaseAgent, Tool, Before } from "../../agent-interface";
import { DirectoryAgent } from "../os/directory";
import { FileAgent } from "../os/file";

// ============================================================================
// Hooks
// ============================================================================

const logTask = (input: any) => {
    console.log(`\n🔧 [Engineer] Task: ${JSON.stringify(input).slice(0, 100)}...`);
    return input;
};

// ============================================================================
// Senior Engineer Agent
// ============================================================================

/**
 * SeniorEngineerAgent is the entry point for the coding system.
 * It orchestrates file and directory agents to implement features,
 * refactor code, and debug issues.
 * 
 * Key capability: Uses the self-describing nature of files/directories
 * to understand the codebase without reading everything.
 */
export class SeniorEngineerAgent extends BaseAgent {
    root: DirectoryAgent;
    private model: ChatOpenAI;

    constructor(model: ChatOpenAI, rootPath: string = "src/") {
        super(model);
        this.model = model;
        this.root = new DirectoryAgent(model, rootPath);
    }

    // -------------------------------------------------------------------------
    // Context Building - Uses self-descriptions
    // -------------------------------------------------------------------------

    /**
     * Build context about the codebase from self-descriptions.
     * This is the key innovation: we don't need to read every file,
     * we use the summaries that files maintain about themselves.
     */
    private getCodebaseContext(): string {
        return this.root.getTree();
    }

    /**
     * Find relevant files for a task based on descriptions.
     */
    private async findRelevantFiles(taskDescription: string): Promise<FileAgent[]> {
        const allFiles = this.collectAllFiles(this.root);
        
        // Use LLM to determine which files are relevant
        const fileList = allFiles.map(f => `${f.path}: ${f.summary}`).join("\n");
        
        const result = await this.agent.invoke({
            input: `Given this task: "${taskDescription}"

Which files are relevant? Here are the files with their descriptions:
${fileList}

Return ONLY a JSON array of file paths that are relevant, e.g. ["src/utils.ts", "src/index.ts"]`
        } as any);

        try {
            const paths = JSON.parse(String(result));
            return allFiles.filter(f => paths.includes(f.path));
        } catch {
            return allFiles; // Fallback to all files
        }
    }

    private collectAllFiles(dir: DirectoryAgent): FileAgent[] {
        const files: FileAgent[] = Array.from(dir.files.values());
        for (const subdir of dir.directories.values()) {
            files.push(...this.collectAllFiles(subdir));
        }
        return files;
    }

    // -------------------------------------------------------------------------
    // Tools - High-Level Engineering Tasks
    // -------------------------------------------------------------------------

    @Tool({
        name: "understand",
        description: "Understand the current codebase structure using self-descriptions",
        parameters: z.object({}),
    })
    understand() {
        return {
            structure: this.getCodebaseContext(),
            summary: this.root.summary,
        };
    }

    @Tool({
        name: "createFile",
        description: "Create a new file at a path",
        parameters: z.object({
            path: z.string().describe("Full path like 'src/utils/helpers.ts'"),
            content: z.string().optional(),
        }),
    })
    @Before(logTask)
    async createFile({ path, content = "" }: { path: string; content?: string }) {
        // Parse path into directory and filename
        const parts = path.split("/");
        const fileName = parts.pop()!;
        
        // Navigate/create directories
        let currentDir = this.root;
        for (const dirName of parts) {
            if (dirName === this.root.path.replace(/\/$/, "").split("/").pop()) continue;
            
            let subdir = currentDir.directories.get(dirName);
            if (!subdir) {
                await currentDir.createDirectory({ name: dirName });
                subdir = currentDir.directories.get(dirName)!;
            }
            currentDir = subdir;
        }

        // Create file
        return currentDir.createFile({ name: fileName, content });
    }

    @Tool({
        name: "readFile",
        description: "Read a file's contents",
        parameters: z.object({ path: z.string() }),
    })
    async readFile({ path }: { path: string }) {
        const file = this.findFile(path);
        if (!file) {
            return { error: `File not found: ${path}` };
        }
        return file.read();
    }

    @Tool({
        name: "editFile",
        description: "Edit a file using natural language instructions",
        parameters: z.object({
            path: z.string(),
            instruction: z.string(),
        }),
    })
    @Before(logTask)
    async editFile({ path, instruction }: { path: string; instruction: string }) {
        const file = this.findFile(path);
        if (!file) {
            return { error: `File not found: ${path}` };
        }
        
        // Delegate to the file's self-edit capability
        return file.edit({ instruction });
    }

    private findFile(path: string): FileAgent | null {
        const parts = path.split("/");
        const fileName = parts.pop()!;
        
        let currentDir = this.root;
        for (const dirName of parts) {
            if (dirName === this.root.path.replace(/\/$/, "").split("/").pop()) continue;
            
            const subdir = currentDir.directories.get(dirName);
            if (!subdir) return null;
            currentDir = subdir;
        }

        return currentDir.files.get(fileName) || null;
    }

    @Tool({
        name: "implement",
        description: "Implement a feature across the codebase",
        parameters: z.object({
            feature: z.string().describe("Description of the feature to implement"),
        }),
    })
    @Before(logTask)
    async implement({ feature }: { feature: string }) {
        console.log(`\n📝 Implementing: ${feature}\n`);

        // 1. Understand current codebase via self-descriptions
        const context = this.getCodebaseContext();
        console.log("📂 Current structure:\n" + context);

        // 2. Plan the implementation
        const plan = await this.agent.invoke({
            input: `You are implementing: "${feature}"

Current codebase:
${context}

Create a step-by-step plan. For each step, specify:
- Action: "create" | "edit" | "delete"
- Path: file path
- Description: what to do

Return as JSON array: [{ action, path, description }]`
        } as any);

        console.log("\n📋 Plan:", plan);

        // 3. Execute the plan
        let steps: { action: string; path: string; description: string }[];
        try {
            steps = JSON.parse(String(plan));
        } catch {
            return { error: "Failed to parse implementation plan" };
        }

        const results: any[] = [];

        for (const step of steps) {
            console.log(`\n⚡ ${step.action}: ${step.path}`);
            
            if (step.action === "create") {
                // Generate content for new file
                const content = await this.agent.invoke({
                    input: `Generate the content for a new file at "${step.path}".
Purpose: ${step.description}
Feature: ${feature}

Return ONLY the file content, no explanations.`
                } as any);

                const result = await this.createFile({ path: step.path, content: String(content) });
                results.push({ step, result });
            } else if (step.action === "edit") {
                const result = await this.editFile({ path: step.path, instruction: step.description });
                results.push({ step, result });
            }
        }

        // 4. Return summary
        return {
            feature,
            stepsExecuted: results.length,
            results,
            newStructure: this.getCodebaseContext(),
        };
    }

    @Tool({
        name: "refactor",
        description: "Refactor code based on instructions",
        parameters: z.object({
            instruction: z.string(),
            paths: z.array(z.string()).optional().describe("Specific files to refactor, or all if not specified"),
        }),
    })
    @Before(logTask)
    async refactor({ instruction, paths }: { instruction: string; paths?: string[] }) {
        // Find relevant files
        const relevantFiles = paths 
            ? paths.map(p => this.findFile(p)).filter(Boolean) as FileAgent[]
            : await this.findRelevantFiles(instruction);

        console.log(`\n🔄 Refactoring ${relevantFiles.length} files...`);

        const results: any[] = [];

        for (const file of relevantFiles) {
            console.log(`  📄 ${file.path}`);
            const result = await file.edit({ instruction });
            results.push(result);
        }

        return {
            instruction,
            filesRefactored: results.length,
            results,
        };
    }

    @Tool({
        name: "debug",
        description: "Debug an issue in the codebase",
        parameters: z.object({
            issue: z.string(),
            errorMessage: z.string().optional(),
        }),
    })
    @Before(logTask)
    async debug({ issue, errorMessage }: { issue: string; errorMessage?: string }) {
        console.log(`\n🐛 Debugging: ${issue}`);

        // Find relevant files based on the issue
        const relevantFiles = await this.findRelevantFiles(issue);

        // Gather content from relevant files
        const fileContents = relevantFiles.map(f => 
            `// ${f.path}\n${f.content}`
        ).join("\n\n");

        // Analyze the issue
        const analysis = await this.agent.invoke({
            input: `Debug this issue: "${issue}"
${errorMessage ? `Error: ${errorMessage}` : ""}

Relevant code:
${fileContents}

Identify:
1. Root cause
2. Which files need changes
3. The fix

Return as JSON: { rootCause, filesToFix: [{ path, fix }] }`
        } as any);

        console.log("\n🔍 Analysis:", analysis);

        // Apply fixes
        let fixes: { rootCause: string; filesToFix: { path: string; fix: string }[] };
        try {
            fixes = JSON.parse(String(analysis));
        } catch {
            return { error: "Failed to parse debug analysis", analysis };
        }

        const results: any[] = [];

        for (const { path, fix } of fixes.filesToFix) {
            console.log(`\n🔧 Fixing: ${path}`);
            const result = await this.editFile({ path, instruction: fix });
            results.push(result);
        }

        return {
            issue,
            rootCause: fixes.rootCause,
            filesFixed: results.length,
            results,
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
    const engineer = new SeniorEngineerAgent(model, "src/");

    // Create initial structure
    await engineer.createFile({ 
        path: "src/index.ts", 
        content: `export function main() {\n    console.log("Hello");\n}` 
    });

    await engineer.createFile({ 
        path: "src/utils/helpers.ts", 
        content: `export const add = (a: number, b: number) => a + b;` 
    });

    // Understand the codebase
    console.log(engineer.understand());

    // Implement a feature
    await engineer.implement({
        feature: "Add a multiply function to helpers and use it in index.ts"
    });

    // Check the result
    console.log("\n📊 Final structure:");
    console.log(engineer.understand());
}

// main();
