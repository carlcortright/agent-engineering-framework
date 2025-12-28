import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { Agent, Tool, Before, After } from "../../agent-interface";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileLog as log } from "../utils/logger";

// ============================================================================
// Self-Describing File Agent
// ============================================================================

/**
 * FileAgent is an agent that represents a single file on disk.
 * Key innovation: the file can edit *itself* and maintains a self-description
 * that updates automatically after any modification.
 * 
 * All writes persist to the actual filesystem.
 */
export class FileAgent extends Agent {
    path: string;
    content: string;
    language: string;
    
    // Self-description: updated after every modification
    summary: string = "";
    lastModified: Date;

    constructor(model: ChatOpenAI, filePath: string, content: string = "") {
        super(model);
        this.path = filePath;
        this.content = content;
        this.language = this.detectLanguage(filePath);
        this.lastModified = new Date();
        
        // Initialize self-description
        this.updateSummary();
    }

    /**
     * Create a FileAgent from an existing file on disk.
     */
    static async fromDisk(model: ChatOpenAI, filePath: string): Promise<FileAgent> {
        const content = await fs.readFile(filePath, "utf-8");
        const stats = await fs.stat(filePath);
        const agent = new FileAgent(model, filePath, content);
        agent.lastModified = stats.mtime;
        return agent;
    }

    private detectLanguage(filePath: string): string {
        const ext = path.extname(filePath).slice(1);
        const langMap: Record<string, string> = {
            ts: "typescript", tsx: "typescript",
            js: "javascript", jsx: "javascript",
            py: "python", rs: "rust", go: "go",
            md: "markdown", json: "json", yaml: "yaml",
        };
        return langMap[ext] || "plaintext";
    }

    // -------------------------------------------------------------------------
    // Self-Description System
    // -------------------------------------------------------------------------

    /**
     * Update the file's self-description.
     * Called automatically after any modification.
     */
    private async updateSummary(): Promise<void> {
        if (!this.content || this.content.length < 10) {
            this.summary = `Empty or minimal ${this.language} file`;
            return;
        }

        // For small files, just note the structure
        if (this.content.length < 500) {
            const lines = this.content.split("\n").length;
            this.summary = `${this.language} file (${lines} lines): ${this.extractFirstComment() || this.extractExports()}`;
            return;
        }

        // For larger files, use LLM to summarize
        try {
            const result = await this.agent.invoke({
                input: `Summarize this ${this.language} file in one sentence (what it does, main exports/functions):
\`\`\`${this.language}
${this.content.slice(0, 2000)}${this.content.length > 2000 ? "\n// ... truncated" : ""}
\`\`\``
            } as any);
            this.summary = String(result).slice(0, 200);
        } catch {
            this.summary = `${this.language} file (${this.content.split("\n").length} lines)`;
        }
    }

    private extractFirstComment(): string {
        const commentMatch = this.content.match(/^\/\*\*?\s*(.*?)\s*\*?\//s) 
            || this.content.match(/^\/\/\s*(.+)/m)
            || this.content.match(/^#\s*(.+)/m);
        return commentMatch ? commentMatch[1].slice(0, 100) : "";
    }

    private extractExports(): string {
        const exports = this.content.match(/export\s+(function|class|const|interface|type)\s+(\w+)/g);
        if (exports && exports.length > 0) {
            return `exports: ${exports.slice(0, 3).map(e => e.split(/\s+/).pop()).join(", ")}`;
        }
        return "";
    }

    // -------------------------------------------------------------------------
    // Filesystem Operations
    // -------------------------------------------------------------------------

    /**
     * Ensure the directory exists before writing.
     */
    private async ensureDir(): Promise<void> {
        const dir = path.dirname(this.path);
        await fs.mkdir(dir, { recursive: true });
    }

    /**
     * Write current content to disk.
     */
    private async writeToDisk(): Promise<void> {
        await this.ensureDir();
        await fs.writeFile(this.path, this.content, "utf-8");
    }

    /**
     * Reload content from disk.
     */
    async reload(): Promise<void> {
        this.content = await fs.readFile(this.path, "utf-8");
        const stats = await fs.stat(this.path);
        this.lastModified = stats.mtime;
        await this.updateSummary();
    }

    // -------------------------------------------------------------------------
    // Tools - File Operations
    // -------------------------------------------------------------------------

    @Tool({
        name: "read",
        description: "Read the file contents",
        parameters: z.object({}),
    })
    read() {
        return {
            path: this.path,
            language: this.language,
            content: this.content,
            summary: this.summary,
            lines: this.content.split("\n").length,
        };
    }

    @Tool({
        name: "describe",
        description: "Get the file's self-description without full content",
        parameters: z.object({}),
    })
    describe() {
        return {
            path: this.path,
            language: this.language,
            summary: this.summary,
            lines: this.content.split("\n").length,
            lastModified: this.lastModified.toISOString(),
        };
    }

    @Tool({
        name: "write",
        description: "Completely replace the file contents and persist to disk",
        parameters: z.object({ newContent: z.string() }),
    })
    @After(async function(this: FileAgent, result: any) {
        await this.updateSummary();
        return result;
    })
    async write({ newContent }: { newContent: string }) {
        const oldLines = this.content.split("\n").length;
        this.content = newContent;
        this.lastModified = new Date();

        // Write to filesystem
        await this.writeToDisk();

        return {
            path: this.path,
            status: "written",
            oldLines,
            newLines: newContent.split("\n").length,
        };
    }

    @Tool({
        name: "edit",
        description: "Edit the file using natural language instructions. The file edits itself and persists to disk.",
        parameters: z.object({ instruction: z.string() }),
    })
    async edit({ instruction }: { instruction: string }) {
        log.tool("edit", { path: this.path, instruction: instruction.slice(0, 50) });
        
        try {
            const result = await this.agent.invoke({
                messages: [{ role: "human", content: `You are editing the file "${this.path}" (${this.language}).

Current content:
\`\`\`${this.language}
${this.content}
\`\`\`

Instruction: ${instruction}

Return ONLY the complete new file content. No explanations, no markdown fences.` }],
            });

            // Extract the response content
            const lastMessage = result.messages[result.messages.length - 1];
            const newContent = (typeof lastMessage?.content === "string" ? lastMessage.content : "").trim();
            
            if (!newContent) {
                log.error("edit", "Empty response from LLM");
                return { error: "Empty response from LLM", path: this.path };
            }
            
            // Self-edit: update our own content
            const oldLines = this.content.split("\n").length;
            this.content = newContent;
            this.lastModified = new Date();

            // Write to filesystem
            await this.writeToDisk();
            log.step(`Wrote ${newContent.split("\n").length} lines to disk`);
            
            // Update self-description after edit
            await this.updateSummary();

            log.success("edit", this.path);
            return {
                path: this.path,
                status: "self-edited",
                instruction,
                oldLines,
                newLines: newContent.split("\n").length,
                newSummary: this.summary,
            };
        } catch (err: any) {
            log.error("edit", err);
            return { error: err.message, path: this.path };
        }
    }

    @Tool({
        name: "analyze",
        description: "Analyze the file for issues, patterns, or improvements",
        parameters: z.object({ focus: z.string().optional() }),
    })
    async analyze({ focus }: { focus?: string }) {
        const result = await this.agent.invoke({
            messages: [{ role: "human", content: `Analyze this ${this.language} file:
\`\`\`${this.language}
${this.content}
\`\`\`
${focus ? `Focus on: ${focus}` : "Provide general analysis: issues, improvements, patterns."}` }],
        });

        const lastMessage = result.messages[result.messages.length - 1];
        const analysis = typeof lastMessage?.content === "string" ? lastMessage.content : "";

        return {
            path: this.path,
            analysis,
        };
    }

    @Tool({
        name: "delete",
        description: "Delete this file from disk",
        parameters: z.object({}),
    })
    async delete() {
        await fs.unlink(this.path);
        this.content = "";
        this.summary = "Deleted";

        return {
            path: this.path,
            status: "deleted",
        };
    }

    async execute(input: string) {
        return this.agent.invoke({
            messages: [{ role: "human", content: input }],
        });
    }
}
