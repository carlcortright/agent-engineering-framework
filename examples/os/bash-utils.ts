import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { Agent, Tool } from "../../agent-interface";
import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import { AgentLogger } from "../utils/logger";

const execAsync = promisify(exec);
const log = new AgentLogger({ prefix: "Bash" });

// ============================================================================
// Command Whitelist
// ============================================================================

/**
 * Whitelisted commands that are considered safe to execute.
 * Each entry can have optional flags that are allowed.
 */
const COMMAND_WHITELIST: Record<string, { description: string; allowedFlags?: string[] }> = {
    // File/Directory inspection
    ls: { description: "List directory contents", allowedFlags: ["-l", "-a", "-la", "-al", "-lh", "-alh", "-R"] },
    cat: { description: "Display file contents" },
    head: { description: "Display first lines of file", allowedFlags: ["-n"] },
    tail: { description: "Display last lines of file", allowedFlags: ["-n", "-f"] },
    wc: { description: "Word/line/character count", allowedFlags: ["-l", "-w", "-c"] },
    file: { description: "Determine file type" },
    stat: { description: "Display file status" },
    
    // Search
    grep: { description: "Search text patterns", allowedFlags: ["-r", "-i", "-n", "-l", "-c", "-v", "-E"] },
    find: { description: "Find files", allowedFlags: ["-name", "-type", "-mtime", "-size", "-maxdepth"] },
    which: { description: "Locate a command" },
    
    // Directory navigation
    pwd: { description: "Print working directory" },
    tree: { description: "Display directory tree", allowedFlags: ["-L", "-d", "-a"] },
    
    // File manipulation
    mkdir: { description: "Create directory", allowedFlags: ["-p"] },
    touch: { description: "Create empty file or update timestamp" },
    cp: { description: "Copy files", allowedFlags: ["-r", "-R", "-f"] },
    mv: { description: "Move/rename files", allowedFlags: ["-f"] },
    rm: { description: "Remove files", allowedFlags: ["-r", "-R", "-f", "-rf", "-fr"] },
    
    // Text processing
    echo: { description: "Print text" },
    sort: { description: "Sort lines", allowedFlags: ["-r", "-n", "-u"] },
    uniq: { description: "Filter duplicate lines", allowedFlags: ["-c", "-d"] },
    cut: { description: "Cut sections from lines", allowedFlags: ["-d", "-f"] },
    sed: { description: "Stream editor" },
    awk: { description: "Pattern scanning" },
    
    // Package managers (read-only operations)
    npm: { description: "Node package manager", allowedFlags: ["list", "ls", "outdated", "view"] },
    yarn: { description: "Yarn package manager", allowedFlags: ["list", "info", "why"] },
    
    // Git (read-only operations)
    git: { 
        description: "Git version control", 
        allowedFlags: ["status", "log", "diff", "branch", "show", "ls-files", "remote", "-v"] 
    },
    
    // Development tools
    node: { description: "Run Node.js", allowedFlags: ["-v", "--version", "-e"] },
    npx: { description: "Execute npm packages" },
    tsc: { description: "TypeScript compiler", allowedFlags: ["--version", "--noEmit", "--listFiles"] },
};

// Commands that should NEVER be allowed regardless of whitelist
const BLACKLISTED_PATTERNS = [
    /sudo/i,
    /su\s/i,
    /chmod\s+[0-7]*[67]/i,  // Dangerous permission changes
    /chown/i,
    /curl.*\|.*sh/i,        // Piping curl to shell
    /wget.*\|.*sh/i,
    /eval\s/i,
    /rm\s+-rf\s+\/(?!\w)/i, // rm -rf / or rm -rf /*
    />\s*\/dev\//i,         // Writing to devices
    /mkfs/i,
    /dd\s+if=/i,
    /:(){ :|:& };:/,        // Fork bomb
];

// ============================================================================
// Bash Utils Agent
// ============================================================================

export class BashAgent extends Agent {
    workingDirectory: string;
    private model: ChatOpenAI;
    private timeout: number;

    constructor(model: ChatOpenAI, workingDirectory: string, options: { timeout?: number } = {}) {
        super(model);
        this.model = model;
        this.workingDirectory = path.resolve(workingDirectory);
        this.timeout = options.timeout || 30000; // 30 second default timeout
    }

    // -------------------------------------------------------------------------
    // Command Validation
    // -------------------------------------------------------------------------

    private validateCommand(command: string): { valid: boolean; error?: string } {
        // Check blacklist patterns
        for (const pattern of BLACKLISTED_PATTERNS) {
            if (pattern.test(command)) {
                return { valid: false, error: `Command matches blacklisted pattern: ${pattern}` };
            }
        }

        // Extract base command
        const parts = command.trim().split(/\s+/);
        const baseCommand = parts[0];

        // Check if command is whitelisted
        if (!COMMAND_WHITELIST[baseCommand]) {
            return { 
                valid: false, 
                error: `Command '${baseCommand}' is not whitelisted. Allowed: ${Object.keys(COMMAND_WHITELIST).join(", ")}` 
            };
        }

        return { valid: true };
    }

    private async runCommand(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
        const validation = this.validateCommand(command);
        if (!validation.valid) {
            throw new Error(validation.error);
        }

        log.step(`Running: ${command}`);

        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd: this.workingDirectory,
                timeout: this.timeout,
                maxBuffer: 1024 * 1024 * 10, // 10MB buffer
                env: { ...process.env, FORCE_COLOR: "0" }, // Disable colors for cleaner output
            });

            return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
        } catch (error: any) {
            return {
                stdout: error.stdout?.trim() || "",
                stderr: error.stderr?.trim() || error.message,
                code: error.code || 1,
            };
        }
    }

    // -------------------------------------------------------------------------
    // Tools
    // -------------------------------------------------------------------------

    @Tool({
        name: "bash",
        description: "Execute a whitelisted bash command in the working directory. Safe commands include: ls, cat, grep, find, mkdir, touch, cp, mv, rm, git status/log/diff, npm list, etc.",
        parameters: z.object({
            command: z.string().describe("The bash command to execute"),
        }),
    })
    async bash({ command }: { command: string }) {
        log.tool("bash", { command: command.slice(0, 60) });

        try {
            const result = await this.runCommand(command);
            
            if (result.code === 0) {
                log.success("bash", `Exit 0, ${result.stdout.split("\n").length} lines`);
            } else {
                log.error("bash", `Exit ${result.code}`);
            }

            return {
                command,
                cwd: this.workingDirectory,
                exitCode: result.code,
                stdout: result.stdout,
                stderr: result.stderr,
            };
        } catch (error: any) {
            log.error("bash", error.message);
            return {
                command,
                cwd: this.workingDirectory,
                error: error.message,
            };
        }
    }

    @Tool({
        name: "listFiles",
        description: "List files in the working directory or a subdirectory",
        parameters: z.object({
            subpath: z.string().optional().describe("Optional subdirectory to list"),
            showHidden: z.boolean().optional().describe("Include hidden files"),
            detailed: z.boolean().optional().describe("Show detailed listing"),
        }),
    })
    async listFiles({ subpath = "", showHidden = false, detailed = false }: { 
        subpath?: string; 
        showHidden?: boolean; 
        detailed?: boolean;
    }) {
        log.tool("listFiles", { subpath, showHidden, detailed });

        const flags = [detailed ? "-l" : "", showHidden ? "-a" : ""].filter(Boolean).join("");
        const flagStr = flags ? `-${flags}` : "";
        const targetPath = subpath || ".";
        
        const result = await this.runCommand(`ls ${flagStr} ${targetPath}`.trim());
        
        log.success("listFiles", `${result.stdout.split("\n").length} items`);
        return {
            path: path.join(this.workingDirectory, subpath),
            files: result.stdout.split("\n").filter(Boolean),
            raw: result.stdout,
        };
    }

    @Tool({
        name: "search",
        description: "Search for text patterns in files using grep",
        parameters: z.object({
            pattern: z.string().describe("The text pattern to search for"),
            path: z.string().optional().describe("Path to search in (default: current directory)"),
            recursive: z.boolean().optional().describe("Search recursively"),
            caseInsensitive: z.boolean().optional().describe("Case insensitive search"),
        }),
    })
    async search({ pattern, path: searchPath = ".", recursive = true, caseInsensitive = true }: {
        pattern: string;
        path?: string;
        recursive?: boolean;
        caseInsensitive?: boolean;
    }) {
        log.tool("search", { pattern, path: searchPath, recursive });

        const flags = [recursive ? "-r" : "", caseInsensitive ? "-i" : "", "-n"].filter(Boolean).join("");
        const result = await this.runCommand(`grep -${flags} "${pattern}" ${searchPath}`);

        const matches = result.stdout.split("\n").filter(Boolean).map(line => {
            const match = line.match(/^(.+?):(\d+):(.*)$/);
            if (match) {
                return { file: match[1], line: parseInt(match[2]), content: match[3] };
            }
            return { raw: line };
        });

        log.success("search", `${matches.length} matches`);
        return {
            pattern,
            searchPath,
            matchCount: matches.length,
            matches,
        };
    }

    @Tool({
        name: "findFiles",
        description: "Find files by name pattern",
        parameters: z.object({
            name: z.string().describe("File name pattern (supports wildcards like *.ts)"),
            path: z.string().optional().describe("Starting path"),
            type: z.enum(["f", "d"]).optional().describe("f=files only, d=directories only"),
            maxDepth: z.number().optional().describe("Maximum directory depth"),
        }),
    })
    async findFiles({ name, path: searchPath = ".", type, maxDepth }: {
        name: string;
        path?: string;
        type?: "f" | "d";
        maxDepth?: number;
    }) {
        log.tool("findFiles", { name, path: searchPath, type });

        let cmd = `find ${searchPath} -name "${name}"`;
        if (type) cmd += ` -type ${type}`;
        if (maxDepth) cmd += ` -maxdepth ${maxDepth}`;

        const result = await this.runCommand(cmd);
        const files = result.stdout.split("\n").filter(Boolean);

        log.success("findFiles", `${files.length} found`);
        return {
            pattern: name,
            files,
            count: files.length,
        };
    }

    @Tool({
        name: "gitStatus",
        description: "Get git status of the repository",
        parameters: z.object({}),
    })
    async gitStatus() {
        log.tool("gitStatus", {});

        const status = await this.runCommand("git status --porcelain");
        const branch = await this.runCommand("git branch --show-current");

        const changes = status.stdout.split("\n").filter(Boolean).map(line => ({
            status: line.slice(0, 2).trim(),
            file: line.slice(3),
        }));

        log.success("gitStatus", `${changes.length} changes on ${branch.stdout}`);
        return {
            branch: branch.stdout,
            changes,
            clean: changes.length === 0,
        };
    }

    @Tool({
        name: "readFileContent",
        description: "Read the content of a file using cat",
        parameters: z.object({
            filePath: z.string().describe("Path to the file"),
            lines: z.number().optional().describe("Limit to first N lines"),
        }),
    })
    async readFileContent({ filePath, lines }: { filePath: string; lines?: number }) {
        log.tool("readFileContent", { filePath, lines });

        const cmd = lines ? `head -n ${lines} "${filePath}"` : `cat "${filePath}"`;
        const result = await this.runCommand(cmd);

        if (result.code !== 0) {
            log.error("readFileContent", result.stderr);
            return { error: result.stderr, filePath };
        }

        log.success("readFileContent", `${result.stdout.split("\n").length} lines`);
        return {
            filePath,
            content: result.stdout,
            lines: result.stdout.split("\n").length,
        };
    }

    @Tool({
        name: "getWhitelistedCommands",
        description: "Get list of all whitelisted commands that can be executed",
        parameters: z.object({}),
    })
    getWhitelistedCommands() {
        log.tool("getWhitelistedCommands", {});
        
        const commands = Object.entries(COMMAND_WHITELIST).map(([cmd, info]) => ({
            command: cmd,
            description: info.description,
            allowedFlags: info.allowedFlags || [],
        }));

        log.success("getWhitelistedCommands", `${commands.length} commands`);
        return { commands };
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
