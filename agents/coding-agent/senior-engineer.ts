import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { BaseAgent, Tool } from "../../agent-interface";
import { DirectoryAgent } from "../os/directory";
import { FileAgent } from "../os/file";
import { engineerLog as log, getResponseContent } from "../utils/logger";

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
            messages: [{ role: "human", content: `Given this task: "${taskDescription}"

Which files are relevant? Here are the files with their descriptions:
${fileList}

Return ONLY a JSON array of file paths that are relevant, e.g. ["src/utils.ts", "src/index.ts"]` }],
        });

        try {
            const paths = JSON.parse(getResponseContent(result));
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
        log.tool("understand", {});
        const result = {
            structure: this.getCodebaseContext(),
            summary: this.root.summary,
        };
        log.success("understand", `Found ${result.structure.split("\n").length} items`);
        return result;
    }

    @Tool({
        name: "createFile",
        description: "Create a new file at a path",
        parameters: z.object({
            path: z.string().describe("Full path like 'src/utils/helpers.ts'"),
            content: z.string().optional(),
        }),
    })
    async createFile({ path, content = "" }: { path: string; content?: string }) {
        log.tool("createFile", { path, contentLength: content.length });
        
        // Parse path into directory and filename
        const parts = path.split("/");
        const fileName = parts.pop()!;
        
        // Navigate/create directories
        let currentDir = this.root;
        for (const dirName of parts) {
            if (dirName === this.root.path.replace(/\/$/, "").split("/").pop()) continue;
            
            let subdir = currentDir.directories.get(dirName);
            if (!subdir) {
                log.step(`Creating directory: ${dirName}`);
                await currentDir.createDirectory({ name: dirName });
                subdir = currentDir.directories.get(dirName)!;
            }
            currentDir = subdir;
        }

        // Create file
        const result = await currentDir.createFile({ name: fileName, content });
        log.success("createFile", path);
        return result;
    }

    @Tool({
        name: "readFile",
        description: "Read a file's contents",
        parameters: z.object({ path: z.string() }),
    })
    async readFile({ path }: { path: string }) {
        log.tool("readFile", { path });
        const file = this.findFile(path);
        if (!file) {
            log.error("readFile", `File not found: ${path}`);
            return { error: `File not found: ${path}` };
        }
        const result = file.read();
        log.success("readFile", `${path} (${result.content?.length || 0} chars)`);
        return result;
    }

    @Tool({
        name: "editFile",
        description: "Edit a file using natural language instructions",
        parameters: z.object({
            path: z.string(),
            instruction: z.string(),
        }),
    })
    async editFile({ path, instruction }: { path: string; instruction: string }) {
        log.tool("editFile", { path, instruction: instruction.slice(0, 50) });
        const file = this.findFile(path);
        if (!file) {
            log.error("editFile", `File not found: ${path}`);
            return { error: `File not found: ${path}` };
        }
        
        // Delegate to the file's self-edit capability
        const result = await file.edit({ instruction });
        log.success("editFile", path);
        return result;
    }

    private findFile(filePath: string): FileAgent | null {
        // Normalize the path - strip root path prefix if present
        let normalizedPath = filePath;
        const rootPath = this.root.path.replace(/\/$/, "");
        
        if (filePath.startsWith(rootPath)) {
            normalizedPath = filePath.slice(rootPath.length).replace(/^\//, "");
        }
        
        // Also try stripping any leading path components that match the root
        if (filePath.startsWith("/")) {
            // Absolute path - try to find the relative portion
            const rootName = rootPath.split("/").pop() || "";
            const pathParts = filePath.split("/");
            const rootIndex = pathParts.indexOf(rootName);
            if (rootIndex !== -1) {
                normalizedPath = pathParts.slice(rootIndex + 1).join("/");
            }
        }

        log.step(`Looking for file: "${normalizedPath}" (original: "${filePath}")`);

        const parts = normalizedPath.split("/").filter(Boolean);
        const fileName = parts.pop();
        
        if (!fileName) {
            log.step(`  No filename in path`);
            return null;
        }

        let currentDir = this.root;
        for (const dirName of parts) {
            const subdir = currentDir.directories.get(dirName);
            if (!subdir) {
                log.step(`  Directory not found: "${dirName}" in ${currentDir.path}`);
                log.step(`  Available dirs: ${Array.from(currentDir.directories.keys()).join(", ") || "(none)"}`);
                return null;
            }
            currentDir = subdir;
        }

        const file = currentDir.files.get(fileName);
        if (!file) {
            log.step(`  File not found: "${fileName}" in ${currentDir.path}`);
            log.step(`  Available files: ${Array.from(currentDir.files.keys()).join(", ") || "(none)"}`);
        }
        
        return file || null;
    }

    @Tool({
        name: "implement",
        description: "Implement a feature across the codebase",
        parameters: z.object({
            feature: z.string().describe("Description of the feature to implement"),
        }),
    })
    async implement({ feature }: { feature: string }) {
        log.tool("implement", { feature });
        log.info(`Implementing: ${feature}`);

        // 1. Understand current codebase via self-descriptions
        const context = this.getCodebaseContext();
        log.step("Analyzed codebase structure");

        // 2. Plan the implementation
        log.step("Planning implementation...");
        const planResult = await this.agent.invoke({
            messages: [{ role: "human", content: `You are implementing: "${feature}"

Current codebase:
${context}

Create a step-by-step plan. For each step, specify:
- Action: "create" | "edit" | "delete"
- Path: file path
- Description: what to do

Return as JSON array: [{ action, path, description }]` }],
        });

        // 3. Execute the plan
        let steps: { action: string; path: string; description: string }[];
        try {
            steps = JSON.parse(getResponseContent(planResult));
            log.step(`Plan has ${steps.length} steps`);
        } catch {
            log.error("implement", "Failed to parse implementation plan");
            return { error: "Failed to parse implementation plan" };
        }

        const results: any[] = [];

        for (const step of steps) {
            log.step(`${step.action}: ${step.path}`);
            
            if (step.action === "create") {
                // Generate content for new file
                const contentResult = await this.agent.invoke({
                    messages: [{ role: "human", content: `Generate the content for a new file at "${step.path}".
Purpose: ${step.description}
Feature: ${feature}

Return ONLY the file content, no explanations.` }],
                });

                const fileContent = getResponseContent(contentResult);
                const result = await this.createFile({ path: step.path, content: fileContent });
                results.push({ step, result });
            } else if (step.action === "edit") {
                const result = await this.editFile({ path: step.path, instruction: step.description });
                results.push({ step, result });
            }
        }

        // 4. Return summary
        log.success("implement", `Completed ${results.length} steps`);
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
    async refactor({ instruction, paths }: { instruction: string; paths?: string[] }) {
        log.tool("refactor", { instruction: instruction.slice(0, 50), paths });
        
        // Find relevant files
        const relevantFiles = paths 
            ? paths.map(p => this.findFile(p)).filter(Boolean) as FileAgent[]
            : await this.findRelevantFiles(instruction);

        log.info(`Refactoring ${relevantFiles.length} files`);

        const results: any[] = [];

        for (const file of relevantFiles) {
            log.step(`Editing ${file.path}`);
            const result = await file.edit({ instruction });
            results.push(result);
        }

        log.success("refactor", `Refactored ${results.length} files`);
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
    async debug({ issue, errorMessage }: { issue: string; errorMessage?: string }) {
        log.tool("debug", { issue: issue.slice(0, 50), errorMessage });
        log.info(`Debugging: ${issue}`);

        // Find relevant files based on the issue
        log.step("Finding relevant files...");
        const relevantFiles = await this.findRelevantFiles(issue);
        log.step(`Found ${relevantFiles.length} relevant files`);

        // Gather content from relevant files
        const fileContents = relevantFiles.map(f => 
            `// ${f.path}\n${f.content}`
        ).join("\n\n");

        // Analyze the issue
        log.step("Analyzing issue...");
        const analysisResult = await this.agent.invoke({
            messages: [{ role: "human", content: `Debug this issue: "${issue}"
${errorMessage ? `Error: ${errorMessage}` : ""}

Relevant code:
${fileContents}

Identify:
1. Root cause
2. Which files need changes
3. The fix

Return as JSON: { rootCause, filesToFix: [{ path, fix }] }` }],
        });

        // Apply fixes
        let fixes: { rootCause: string; filesToFix: { path: string; fix: string }[] };
        try {
            fixes = JSON.parse(getResponseContent(analysisResult));
            log.step(`Root cause: ${fixes.rootCause}`);
        } catch {
            log.error("debug", "Failed to parse debug analysis");
            return { error: "Failed to parse debug analysis", analysisResult };
        }

        const results: any[] = [];

        for (const { path, fix } of fixes.filesToFix) {
            log.step(`Fixing: ${path}`);
            const result = await this.editFile({ path, instruction: fix });
            results.push(result);
        }

        log.success("debug", `Fixed ${results.length} files`);
        return {
            issue,
            rootCause: fixes.rootCause,
            filesFixed: results.length,
            results,
        };
    }

    async execute(input: string) {
        log.info(`Executing: ${input.slice(0, 60)}${input.length > 60 ? "..." : ""}`);
        const result = await this.agent.invoke({
            messages: [{ role: "human", content: input }],
        });
        log.success("execute", "Completed");
        return result;
    }
}

