import { createAgent, ReactAgent } from "langchain";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { z, ZodSchema } from "zod";

// ============================================================================
// Decorator Metadata Storage
// ============================================================================

type HookFn = (data: any) => any | Promise<any>;
type ToolMeta = { propertyKey: string; name: string; description: string; parameters: ZodSchema };

const toolRegistry = new Map<Function, ToolMeta[]>();

// Hooks stored on the method function itself
const beforeHooks = new WeakMap<Function, HookFn[]>();
const afterHooks = new WeakMap<Function, HookFn[]>();

// ============================================================================
// Decorators
// ============================================================================

/** @Tool - Function callable by the LLM */
export function Tool(config: { name: string; description: string; parameters: ZodSchema }) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const ctor = target.constructor;
        const tools = toolRegistry.get(ctor) || [];
        tools.push({ propertyKey, ...config });
        toolRegistry.set(ctor, tools);
        return descriptor;
    };
}

/** @Before - Hook that runs before a tool executes */
export function Before(fn: HookFn) {
    return function (_target: any, _propertyKey: string, descriptor: PropertyDescriptor) {
        const method = descriptor.value;
        const existing = beforeHooks.get(method) || [];
        existing.push(fn);
        beforeHooks.set(method, existing);
        return descriptor;
    };
}

/** @After - Hook that runs after a tool executes */
export function After(fn: HookFn) {
    return function (_target: any, _propertyKey: string, descriptor: PropertyDescriptor) {
        const method = descriptor.value;
        const existing = afterHooks.get(method) || [];
        existing.push(fn);
        afterHooks.set(method, existing);
        return descriptor;
    };
}

// ============================================================================
// Base Agent
// ============================================================================

export abstract class Agent {
    agent: ReactAgent;

    constructor(model: BaseChatModel) {
        const tools = this.buildTools();
        this.agent = createAgent({
            model: model,
            tools: tools,
        });
    }

    /** Build LangChain tools from @Tool decorated methods (including inherited) */
    private buildTools() {
        const toolsMeta = this.collectToolsFromPrototypeChain();

        return toolsMeta.map((meta) => {
            const method = (this as any)[meta.propertyKey];
            const beforeFns = beforeHooks.get(method) || [];
            const afterFns = afterHooks.get(method) || [];

            return tool(
                async (input: any) => {
                    // Run @Before hooks
                    let processed = input;
                    for (const fn of beforeFns) {
                        processed = await fn(processed);
                    }

                    // Run the tool
                    const result = await method.call(this, processed);

                    // Run @After hooks
                    let output = result;
                    for (const fn of afterFns) {
                        output = await fn(output);
                    }

                    return output;
                },
                {
                    name: meta.name,
                    description: meta.description,
                    schema: meta.parameters,
                }
            );
        });
    }

    /** Collect tools from this class and all parent classes */
    private collectToolsFromPrototypeChain(): ToolMeta[] {
        const allTools: ToolMeta[] = [];
        const seen = new Set<string>();  // Dedupe by tool name (child overrides parent)

        let current: Function | null = this.constructor;
        while (current && current !== Function.prototype) {
            const tools = toolRegistry.get(current) || [];
            for (const tool of tools) {
                if (!seen.has(tool.name)) {
                    seen.add(tool.name);
                    allTools.push(tool);
                }
            }
            current = Object.getPrototypeOf(current);
        }

        return allTools;
    }

    abstract execute(input: string): Promise<any>;
}

// Alias for backwards compatibility
export { Agent as BaseAgent };
