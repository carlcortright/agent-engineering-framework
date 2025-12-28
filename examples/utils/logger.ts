// ============================================================================
// Agent Logging Middleware
// ============================================================================

const COLORS = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    magenta: "\x1b[35m",
    red: "\x1b[31m",
    blue: "\x1b[34m",
};

export interface LoggerOptions {
    prefix?: string;
    colors?: boolean;
}

export class AgentLogger {
    private prefix: string;
    private useColors: boolean;

    constructor(options: LoggerOptions = {}) {
        this.prefix = options.prefix || "";
        this.useColors = options.colors ?? true;
    }

    private c(color: keyof typeof COLORS, text: string): string {
        if (!this.useColors) return text;
        return `${COLORS[color]}${text}${COLORS.reset}`;
    }

    private formatPrefix(): string {
        return this.prefix ? `[${this.prefix}] ` : "";
    }

    /**
     * Log when a tool is invoked
     */
    tool(name: string, input: any): void {
        const inputStr = JSON.stringify(input);
        const truncated = inputStr.length > 80 ? inputStr.slice(0, 80) + "..." : inputStr;
        console.log(
            `${this.c("cyan", "▶")} ${this.c("bold", this.formatPrefix() + name)} ${this.c("dim", truncated)}`
        );
    }

    /**
     * Log successful completion
     */
    success(name: string, result: any): void {
        const resultStr = typeof result === "string" ? result : JSON.stringify(result);
        const truncated = resultStr.length > 100 ? resultStr.slice(0, 100) + "..." : resultStr;
        console.log(
            `${this.c("green", "✓")} ${this.c("bold", this.formatPrefix() + name)} ${this.c("dim", truncated)}\n`
        );
    }

    /**
     * Log an error
     */
    error(name: string, err: any): void {
        const message = err?.message || String(err);
        console.log(
            `${this.c("red", "✗")} ${this.c("bold", this.formatPrefix() + name)} ${this.c("red", message)}\n`
        );
    }

    /**
     * Log informational message
     */
    info(msg: string): void {
        console.log(`${this.c("yellow", "ℹ")} ${this.formatPrefix()}${msg}`);
    }

    /**
     * Log a step within a larger operation
     */
    step(msg: string): void {
        console.log(`${this.c("magenta", "  →")} ${msg}`);
    }

    /**
     * Log a debug message (more detailed)
     */
    debug(msg: string): void {
        console.log(`${this.c("dim", "    " + this.formatPrefix() + msg)}`);
    }

    /**
     * Log raw content (for file contents, etc.)
     */
    content(label: string, content: string, maxLines: number = 10): void {
        const lines = content.split("\n");
        const preview = lines.slice(0, maxLines).join("\n");
        const more = lines.length > maxLines ? `\n... (${lines.length - maxLines} more lines)` : "";
        console.log(`${this.c("blue", "┌─")} ${label}`);
        console.log(this.c("dim", preview + more));
        console.log(this.c("blue", "└─"));
    }

    /**
     * Create a child logger with a different prefix
     */
    child(prefix: string): AgentLogger {
        const fullPrefix = this.prefix ? `${this.prefix}:${prefix}` : prefix;
        return new AgentLogger({ prefix: fullPrefix, colors: this.useColors });
    }
}

// ============================================================================
// Default Logger Instances
// ============================================================================

export const engineerLog = new AgentLogger({ prefix: "Engineer" });
export const directoryLog = new AgentLogger({ prefix: "Dir" });
export const fileLog = new AgentLogger({ prefix: "File" });

// Generic logger for one-off use
export const log = new AgentLogger();

// ============================================================================
// Helper: Extract response content from agent result
// ============================================================================

export function getResponseContent(result: { messages: any[] }): string {
    const lastMessage = result.messages[result.messages.length - 1];
    return typeof lastMessage?.content === "string" ? lastMessage.content : "";
}

