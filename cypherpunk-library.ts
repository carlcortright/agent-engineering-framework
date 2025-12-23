import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { BaseAgent, Task, Tool, Before, After } from "./interfaces";

// ============================================================================
// Middleware Functions
// ============================================================================

const requireAuth = (input: any) => {
    if (!input.userId) throw new Error("Authentication required");
    return input;
};

const logAccess = (input: any) => {
    console.log(`[ACCESS] ${JSON.stringify(input)}`);
    return input;
};

const sanitizeContent = (output: string) => {
    return output.replace(/[^\x20-\x7E\n]/g, ""); // ASCII only
};

// ============================================================================
// Page Agent - The smallest unit, handles individual page content
// ============================================================================

class PageAgent extends BaseAgent {
    pageNumber: number;
    content: string = "";

    constructor(model: ChatOpenAI, pageNumber: number) {
        super(model);
        this.pageNumber = pageNumber;
    }

    @Tool({
        name: "getContent",
        description: "Get the current content of this page",
        parameters: z.object({}),
    })
    getContent() {
        return this.content;
    }

    @Task({
        name: "write",
        description: "Write new content to this page",
        inputSchema: z.object({ text: z.string() }),
    })
    @Before(logAccess)
    @After(sanitizeContent)
    async write({ text }: { text: string }) {
        this.content = text;
        return `Page ${this.pageNumber} updated with ${text.length} characters`;
    }

    @Task({
        name: "edit",
        description: "Edit content on this page using AI",
        inputSchema: z.object({ instruction: z.string() }),
    })
    async edit({ instruction }: { instruction: string }) {
        return this.agent.invoke({ input: `Edit this content: "${this.content}" with instruction: ${instruction}` } as any);
    }

    async execute(input: string) {
        return this.agent.invoke({ input } as any);
    }
}

// ============================================================================
// Book Agent - Contains pages, can search and edit across them
// ============================================================================

class BookAgent extends BaseAgent {
    title: string;
    pages: PageAgent[] = [];

    constructor(model: ChatOpenAI, title: string, pageCount: number = 10) {
        super(model);
        this.title = title;

        // Create page subagents
        for (let i = 1; i <= pageCount; i++) {
            this.pages.push(new PageAgent(model, i));
        }
    }

    @Tool({
        name: "getTableOfContents",
        description: "Get the table of contents for this book",
        parameters: z.object({}),
    })
    getTableOfContents() {
        return this.pages.map((p, i) => ({
            page: i + 1,
            preview: p.content.slice(0, 50) || "(empty)",
        }));
    }

    @Tool({
        name: "getPage",
        description: "Get a specific page from the book",
        parameters: z.object({ pageNumber: z.number() }),
    })
    getPage({ pageNumber }: { pageNumber: number }) {
        const page = this.pages[pageNumber - 1];
        if (!page) return { error: "Page not found" };
        return { pageNumber, content: page.content };
    }

    @Task({
        name: "search",
        description: "Search for content across all pages",
        inputSchema: z.object({ query: z.string() }),
    })
    async search({ query }: { query: string }) {
        const results = this.pages
            .filter((p) => p.content.toLowerCase().includes(query.toLowerCase()))
            .map((p) => ({ page: p.pageNumber, snippet: p.content.slice(0, 100) }));

        return results.length > 0
            ? results
            : `No results found for "${query}"`;
    }

    @Task({
        name: "summarize",
        description: "Generate a summary of the entire book",
        inputSchema: z.object({}),
    })
    async summarize() {
        const allContent = this.pages.map((p) => p.content).join("\n\n");
        return this.agent.invoke({ input: `Summarize this book titled "${this.title}":\n${allContent}` } as any);
    }

    @Task({
        name: "writePage",
        description: "Write content to a specific page",
        inputSchema: z.object({ pageNumber: z.number(), text: z.string() }),
    })
    @Before(requireAuth)
    async writePage({ pageNumber, text, userId }: { pageNumber: number; text: string; userId?: string }) {
        const page = this.pages[pageNumber - 1];
        if (!page) throw new Error("Page not found");
        return page.write({ text });
    }

    async execute(input: string) {
        return this.agent.invoke({ input } as any);
    }
}

// ============================================================================
// Librarian Agent - Helps users navigate and find information
// ============================================================================

class LibrarianAgent extends BaseAgent {
    specialty: string;
    private library?: CypherpunkLibrary;

    constructor(model: ChatOpenAI, specialty: string) {
        super(model);
        this.specialty = specialty;
    }

    setLibrary(library: CypherpunkLibrary) {
        this.library = library;
    }

    @Task({
        name: "recommend",
        description: "Recommend books based on user interest",
        inputSchema: z.object({ interest: z.string() }),
    })
    async recommend({ interest }: { interest: string }) {
        if (!this.library) return "No library assigned";

        const catalog = this.library.getCatalog();
        return this.agent.invoke({
            input: `As a librarian specializing in ${this.specialty}, recommend books from this catalog for someone interested in "${interest}": ${JSON.stringify(catalog)}`
        } as any);
    }

    @Task({
        name: "research",
        description: "Research a topic across all library books",
        inputSchema: z.object({ topic: z.string() }),
    })
    @Before(logAccess)
    async research({ topic }: { topic: string }) {
        if (!this.library) return "No library assigned";

        const results = await this.library.searchAll({ query: topic });
        return this.agent.invoke({
            input: `Synthesize research on "${topic}" from these findings: ${JSON.stringify(results)}`
        } as any);
    }

    @Task({
        name: "answer",
        description: "Answer a question using library resources",
        inputSchema: z.object({ question: z.string() }),
    })
    async answer({ question }: { question: string }) {
        return this.agent.invoke({
            input: `As a librarian specializing in ${this.specialty}, answer: ${question}`
        } as any);
    }

    async execute(input: string) {
        return this.agent.invoke({ input } as any);
    }
}

// ============================================================================
// Cypherpunk Library - The top-level orchestrator
// ============================================================================

export class CypherpunkLibrary extends BaseAgent {
    books: Map<string, BookAgent> = new Map();
    librarians: LibrarianAgent[] = [];

    constructor(model: ChatOpenAI) {
        super(model);

        // Initialize librarians with specialties
        const cryptoLibrarian = new LibrarianAgent(model, "cryptography and privacy");
        const historyLibrarian = new LibrarianAgent(model, "cypherpunk history and manifestos");

        cryptoLibrarian.setLibrary(this);
        historyLibrarian.setLibrary(this);

        this.librarians = [cryptoLibrarian, historyLibrarian];

        // Initialize some default books
        this.books.set("cypherpunk-manifesto", new BookAgent(model, "A Cypherpunk's Manifesto", 5));
        this.books.set("crypto-anarchy", new BookAgent(model, "The Crypto Anarchist Manifesto", 3));
        this.books.set("privacy-handbook", new BookAgent(model, "Digital Privacy Handbook", 20));
    }

    @Tool({
        name: "getCatalog",
        description: "Get the library catalog",
        parameters: z.object({}),
    })
    getCatalog() {
        return Array.from(this.books.entries()).map(([id, book]) => ({
            id,
            title: book.title,
            pages: book.pages.length,
        }));
    }

    @Tool({
        name: "getBook",
        description: "Get a book by ID",
        parameters: z.object({ bookId: z.string() }),
    })
    getBook({ bookId }: { bookId: string }) {
        const book = this.books.get(bookId);
        if (!book) return { error: "Book not found" };
        return { title: book.title, toc: book.getTableOfContents() };
    }

    @Task({
        name: "searchAll",
        description: "Search across all books in the library",
        inputSchema: z.object({ query: z.string() }),
    })
    async searchAll({ query }: { query: string }) {
        const results: { bookId: string; title: string; matches: any }[] = [];

        for (const [bookId, book] of this.books) {
            const matches = await book.search({ query });
            if (Array.isArray(matches) && matches.length > 0) {
                results.push({ bookId, title: book.title, matches });
            }
        }

        return results;
    }

    @Task({
        name: "askLibrarian",
        description: "Ask a librarian for help",
        inputSchema: z.object({ question: z.string() }),
    })
    async askLibrarian({ question }: { question: string }) {
        // Route to the best librarian based on question
        const librarian = this.librarians[0]; // Could add routing logic here
        return librarian.answer({ question });
    }

    @Task({
        name: "addBook",
        description: "Add a new book to the library",
        inputSchema: z.object({ id: z.string(), title: z.string(), pages: z.number().optional() }),
    })
    @Before(requireAuth)
    async addBook({ id, title, pages = 10 }: { id: string; title: string; pages?: number }) {
        if (this.books.has(id)) {
            return { error: "Book ID already exists" };
        }

        const model = new ChatOpenAI({ modelName: "gpt-4o" });
        this.books.set(id, new BookAgent(model, title, pages));

        return { success: true, message: `Added "${title}" with ${pages} pages` };
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
    const library = new CypherpunkLibrary(model);

    // Explore the library
    console.log("📚 Catalog:", library.getCatalog());

    // Ask a librarian
    const answer = await library.askLibrarian({
        question: "What is the significance of the cypherpunk movement?",
    });
    console.log("🧑‍🏫 Librarian:", answer);

    // Search across all books
    const results = await library.searchAll({ query: "privacy" });
    console.log("🔍 Search results:", results);
}

// main();
