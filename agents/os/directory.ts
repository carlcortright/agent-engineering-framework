import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import * as fs from "fs";
import * as nodePath from "path";
import { Agent, Tool, After } from "../../agent-interface";
import { FileAgent } from "./file";
import { directoryLog as log } from "../utils/logger";

// ============================================================================
// Types
// ============================================================================

interface DirectoryEntry {
    type: "file" | "directory";
    name: string;
    path: string;
    summary: string;
    contents?: DirectoryEntry[];
}

interface DirectoryListing {
    path: string;
    summary: string;
    contents: DirectoryEntry[];
}

// ============================================================================
// Self-Describing Directory Agent
// ============================================================================

/**
 * DirectoryAgent is an agent that represents a directory.
 * It contains files (FileAgents) and subdirectories (DirectoryAgents).
 * Like files, directories maintain a self-description that updates when contents change.
 */
export class DirectoryAgent extends Agent {
    path: string;
    files: Map<string, FileAgent> = new Map();
    directories: Map<string, DirectoryAgent> = new Map();
    
    // Self-description: updated when contents change
    summary: string = "";
    private model: ChatOpenAI;

    constructor(model: ChatOpenAI, dirPath: string, autoLoad: boolean = true) {
        super(model);
        this.model = model;
        this.path = dirPath.endsWith("/") ? dirPath : dirPath + "/";
        
        if (autoLoad) {
            this.loadFromFilesystem();
        }
        this.updateSummary();
    }

    /**
     * Load files and directories from the actual filesystem.
     */
    private loadFromFilesystem(): void {
        const absolutePath = nodePath.resolve(this.path);
        
        if (!fs.existsSync(absolutePath)) {
            log.error("loadFromFilesystem", `Directory does not exist: ${absolutePath}`);
            return;
        }

        const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
        log.step(`Loading ${entries.length} entries from ${absolutePath}`);

        for (const entry of entries) {
            // Skip hidden files and common ignore patterns
            if (entry.name.startsWith(".") || entry.name === "node_modules") {
                continue;
            }

            const fullPath = nodePath.join(absolutePath, entry.name);

            if (entry.isDirectory()) {
                const subDir = new DirectoryAgent(this.model, fullPath, true);
                this.directories.set(entry.name, subDir);
            } else if (entry.isFile()) {
                try {
                    const content = fs.readFileSync(fullPath, "utf-8");
                    const file = new FileAgent(this.model, fullPath, content);
                    this.files.set(entry.name, file);
                } catch (err) {
                    // Skip files that can't be read (binary, etc.)
                }
            }
        }
        
        log.success("loadFromFilesystem", `Loaded ${this.files.size} files, ${this.directories.size} dirs`);
    }

    // -------------------------------------------------------------------------
    // Self-Description System
    // -------------------------------------------------------------------------

    /**
     * Update the directory's self-description based on its contents.
     */
    private async updateSummary(): Promise<void> {
        const fileCount = this.files.size;
        const dirCount = this.directories.size;

        if (fileCount === 0 && dirCount === 0) {
            this.summary = "Empty directory";
            return;
        }

        // Build summary from children's summaries
        const fileSummaries = Array.from(this.files.entries())
            .map(([name, file]) => `  ${name}: ${file.summary}`)
            .join("\n");

        const dirSummaries = Array.from(this.directories.entries())
            .map(([name, dir]) => `  ${name}/: ${dir.summary}`)
            .join("\n");

        this.summary = `${fileCount} files, ${dirCount} subdirs`;
        
        // For small directories, include more detail
        if (fileCount + dirCount <= 5) {
            const details = [fileSummaries, dirSummaries].filter(Boolean).join("\n");
            if (details) {
                this.summary += `\n${details}`;
            }
        }
    }

    /**
     * Get a hierarchical description of this directory and all contents.
     */
    getTree(indent: string = ""): string {
        const lines: string[] = [`${indent}${this.path}`];
        
        for (const [name, file] of this.files) {
            lines.push(`${indent}  📄 ${name} - ${file.summary}`);
        }
        
        for (const [name, dir] of this.directories) {
            lines.push(dir.getTree(indent + "  "));
        }
        
        return lines.join("\n");
    }

    // -------------------------------------------------------------------------
    // Tools - Directory Operations
    // -------------------------------------------------------------------------

    @Tool({
        name: "reload",
        description: "Reload directory contents from the filesystem",
        parameters: z.object({}),
    })
    reload() {
        log.tool("reload", { path: this.path });
        this.files.clear();
        this.directories.clear();
        this.loadFromFilesystem();
        this.updateSummary();
        const result = {
            status: "reloaded",
            path: this.path,
            fileCount: this.files.size,
            dirCount: this.directories.size,
        };
        log.success("reload", `${result.fileCount} files, ${result.dirCount} dirs`);
        return result;
    }

    @Tool({
        name: "list",
        description: "List contents of this directory",
        parameters: z.object({ recursive: z.boolean().optional() }),
    })
    list({ recursive = false }: { recursive?: boolean }): DirectoryListing {
        const files: DirectoryEntry[] = Array.from(this.files.entries()).map(([name, file]) => ({
            type: "file" as const,
            name,
            path: this.path + name,
            summary: file.summary,
        }));

        const dirs: DirectoryEntry[] = Array.from(this.directories.entries()).map(([name, dir]) => ({
            type: "directory" as const,
            name,
            path: dir.path,
            summary: dir.summary,
            ...(recursive ? { contents: dir.list({ recursive: true }).contents } : {}),
        }));

        return {
            path: this.path,
            summary: this.summary,
            contents: [...files, ...dirs],
        };
    }

    @Tool({
        name: "describe",
        description: "Get the directory's self-description",
        parameters: z.object({}),
    })
    describe() {
        return {
            path: this.path,
            summary: this.summary,
            fileCount: this.files.size,
            dirCount: this.directories.size,
            tree: this.getTree(),
        };
    }

    @Tool({
        name: "getFile",
        description: "Get a file from this directory by name or path",
        parameters: z.object({ name: z.string().describe("File name or relative path") }),
    })
    getFile({ name }: { name: string }): FileAgent | { error: string } {
        log.tool("getFile", { name });
        
        // Try direct lookup first, then path-based lookup
        let file = this.files.get(name);
        if (!file) {
            file = this.findFileByPath(name);
        }
        
        if (!file) {
            log.error("getFile", `File not found: ${name}`);
            return { error: `File not found: ${name}` };
        }
        
        log.success("getFile", file.path);
        return file;
    }

    @Tool({
        name: "getDirectory",
        description: "Get a subdirectory by name",
        parameters: z.object({ name: z.string() }),
    })
    getDirectory({ name }: { name: string }): DirectoryAgent | { error: string } {
        const dir = this.directories.get(name);
        if (!dir) {
            return { error: `Directory not found: ${name}` };
        }
        return dir;
    }

    @Tool({
        name: "createFile",
        description: "Create a new file in this directory",
        parameters: z.object({
            name: z.string(),
            content: z.string().optional(),
        }),
    })
    @After(async function(this: DirectoryAgent, result: any) {
        await this.updateSummary();
        return result;
    })
    async createFile({ name, content = "" }: { name: string; content?: string }) {
        log.tool("createFile", { name, contentLength: content.length });
        
        if (this.files.has(name)) {
            log.error("createFile", `File already exists: ${name}`);
            return { error: `File already exists: ${name}` };
        }

        const filePath = nodePath.join(nodePath.resolve(this.path), name);
        const file = new FileAgent(this.model, filePath, content);
        this.files.set(name, file);

        log.success("createFile", filePath);
        return {
            status: "created",
            path: filePath,
            file: file.describe(),
        };
    }

    @Tool({
        name: "createDirectory",
        description: "Create a new subdirectory",
        parameters: z.object({ name: z.string() }),
    })
    @After(async function(this: DirectoryAgent, result: any) {
        await this.updateSummary();
        return result;
    })
    async createDirectory({ name }: { name: string }) {
        if (this.directories.has(name)) {
            return { error: `Directory already exists: ${name}` };
        }

        // Create new directory without auto-loading (it's empty)
        const dir = new DirectoryAgent(this.model, this.path + name, false);
        this.directories.set(name, dir);

        return {
            status: "created",
            path: dir.path,
        };
    }

    @Tool({
        name: "deleteFile",
        description: "Delete a file from this directory",
        parameters: z.object({ name: z.string() }),
    })
    @After(async function(this: DirectoryAgent, result: any) {
        await this.updateSummary();
        return result;
    })
    async deleteFile({ name }: { name: string }) {
        if (!this.files.has(name)) {
            return { error: `File not found: ${name}` };
        }

        this.files.delete(name);

        return {
            status: "deleted",
            path: this.path + name,
        };
    }

    @Tool({
        name: "findFiles",
        description: "Find files matching a pattern or description",
        parameters: z.object({
            pattern: z.string().optional(),
            description: z.string().optional(),
        }),
    })
    async findFiles({ pattern, description }: { pattern?: string; description?: string }) {
        const results: { path: string; summary: string }[] = [];

        // Search in current directory
        for (const [name, file] of this.files) {
            const matchesPattern = !pattern || new RegExp(pattern, "i").test(name);
            const matchesDesc = !description || file.summary.toLowerCase().includes(description.toLowerCase());

            if (matchesPattern && matchesDesc) {
                results.push({ path: file.path, summary: file.summary });
            }
        }

        // Search in subdirectories
        for (const dir of this.directories.values()) {
            const subResults = await dir.findFiles({ pattern, description });
            results.push(...(subResults as any).results || []);
        }

        return { results };
    }

    /**
     * Find a file by path, handling both simple names and paths with subdirectories.
     */
    findFileByPath(filePath: string): FileAgent | undefined {
        // Normalize the path
        let normalizedPath = filePath;
        
        // Strip this directory's path prefix if present
        if (filePath.startsWith(this.path)) {
            normalizedPath = filePath.slice(this.path.length);
        }
        
        // Handle absolute paths
        if (filePath.startsWith("/")) {
            const thisAbsPath = nodePath.resolve(this.path);
            if (filePath.startsWith(thisAbsPath)) {
                normalizedPath = filePath.slice(thisAbsPath.length).replace(/^\//, "");
            }
        }
        
        const parts = normalizedPath.split("/").filter(Boolean);
        
        log.step(`findFileByPath: "${filePath}" -> normalized: "${normalizedPath}" -> parts: [${parts.join(", ")}]`);
        
        // If it's just a filename, look in current directory
        if (parts.length === 1) {
            const file = this.files.get(parts[0]);
            if (file) {
                log.step(`  Found file directly: ${file.path}`);
                return file;
            }
            log.step(`  File not found in current dir. Available: ${Array.from(this.files.keys()).join(", ") || "(none)"}`);
            return undefined;
        }
        
        // Otherwise, navigate to subdirectory
        const dirName = parts[0];
        const remainingPath = parts.slice(1).join("/");
        
        const subDir = this.directories.get(dirName);
        if (!subDir) {
            log.step(`  Subdirectory not found: "${dirName}". Available: ${Array.from(this.directories.keys()).join(", ") || "(none)"}`);
            return undefined;
        }
        
        return subDir.findFileByPath(remainingPath);
    }

    @Tool({
        name: "editFile",
        description: "Edit a file in this directory by name or path",
        parameters: z.object({
            name: z.string().describe("File name or relative path like 'app/page.tsx'"),
            instruction: z.string(),
        }),
    })
    @After(async function(this: DirectoryAgent, result: any) {
        await this.updateSummary();
        return result;
    })
    async editFile({ name, instruction }: { name: string; instruction: string }) {
        log.tool("editFile", { name, instruction: instruction.slice(0, 50) });
        
        // Try direct lookup first, then path-based lookup
        let file = this.files.get(name);
        if (!file) {
            file = this.findFileByPath(name);
        }
        
        if (!file) {
            log.error("editFile", `File not found: ${name}`);
            return { error: `File not found: ${name}` };
        }

        // Delegate to the file's self-edit capability
        const result = await file.edit({ instruction });
        log.success("editFile", file.path);
        return result;
    }

    async execute(input: string) {
        return this.agent.invoke({
            messages: [{ role: "human", content: input }],
        });
    }
}
