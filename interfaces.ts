import { createAgent, ReactAgent } from "langchain";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { z, ZodSchema } from "zod";

// ============================================================================
// Decorator Metadata Storage
// ============================================================================

type MiddlewareFn = (data: any) => any | Promise<any>;
type TaskMeta = { propertyKey: string; name: string; description: string; inputSchema?: ZodSchema; outputSchema?: ZodSchema };
type ToolMeta = { propertyKey: string; name: string; description: string; parameters: ZodSchema };

const taskRegistry = new Map<Function, TaskMeta[]>();
const toolRegistry = new Map<Function, ToolMeta[]>();

// Middleware stored on the method function itself
const beforeMiddleware = new WeakMap<Function, MiddlewareFn[]>();
const afterMiddleware = new WeakMap<Function, MiddlewareFn[]>();

// ============================================================================
// Decorators
// ============================================================================

/** @Task - Agentic subroutine, auto-registered as a tool the LLM can invoke */
export function Task(config: { name: string; description: string; inputSchema?: ZodSchema; outputSchema?: ZodSchema }) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const ctor = target.constructor;
        const tasks = taskRegistry.get(ctor) || [];
        tasks.push({ propertyKey, ...config });
        taskRegistry.set(ctor, tasks);
        return descriptor;
    };
}

/** @Tool - Deterministic function callable by the LLM */
export function Tool(config: { name: string; description: string; parameters: ZodSchema }) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const ctor = target.constructor;
        const tools = toolRegistry.get(ctor) || [];
        tools.push({ propertyKey, ...config });
        toolRegistry.set(ctor, tools);
        return descriptor;
    };
}

/** @Before - Middleware that runs before a task, can only be applied to @Task methods */
export function Before(fn: MiddlewareFn) {
    return function (_target: any, _propertyKey: string, descriptor: PropertyDescriptor) {
        const method = descriptor.value;
        const existing = beforeMiddleware.get(method) || [];
        existing.push(fn);
        beforeMiddleware.set(method, existing);
        return descriptor;
    };
}

/** @After - Middleware that runs after a task, can only be applied to @Task methods */
export function After(fn: MiddlewareFn) {
    return function (_target: any, _propertyKey: string, descriptor: PropertyDescriptor) {
        const method = descriptor.value;
        const existing = afterMiddleware.get(method) || [];
        existing.push(fn);
        afterMiddleware.set(method, existing);
        return descriptor;
    };
}

// ============================================================================
// Base Agent
// ============================================================================

export abstract class BaseAgent {
    agent: ReactAgent;

    constructor(model: BaseChatModel) {
        const tools = this.buildTools();
        this.agent = createAgent({
            model: model,
            tools: tools,
        });
    }

    /** Build LangChain tools from @Tool and @Task decorated methods */
    private buildTools() {
        const toolsMeta = toolRegistry.get(this.constructor) || [];
        const tasksMeta = taskRegistry.get(this.constructor) || [];

        // Regular tools
        const tools = toolsMeta.map((meta) =>
            tool((input: any) => (this as any)[meta.propertyKey].call(this, input), {
                name: meta.name,
                description: meta.description,
                schema: meta.parameters,
            })
        );

        // Tasks as tools (wrapped with middleware)
        const taskTools = tasksMeta.map((meta) => {
            const method = (this as any)[meta.propertyKey];
            const beforeFns = beforeMiddleware.get(method) || [];
            const afterFns = afterMiddleware.get(method) || [];

            return tool(
                async (input: any) => {
                    // Run @Before middleware
                    let processed = input;
                    for (const fn of beforeFns) {
                        processed = await fn(processed);
                    }

                    // Run the task
                    const result = await method.call(this, processed);

                    // Run @After middleware
                    let output = result;
                    for (const fn of afterFns) {
                        output = await fn(output);
                    }

                    return output;
                },
                {
                    name: meta.name,
                    description: `[Task] ${meta.description}`,
                    schema: meta.inputSchema ?? z.object({ input: z.string() }),
                }
            );
        });

        return [...tools, ...taskTools];
    }

    abstract execute(input: string): Promise<any>;
}
