import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { Agent, Tool } from "../../agent-interface";
import { AgentLogger, getResponseContent } from "../utils/logger";

const log = new AgentLogger({ prefix: "PM" });

// ============================================================================
// System Prompt
// ============================================================================

const PM_SYSTEM_PROMPT = `You are an exceptionally skilled and experienced Technical Project Manager and Product Owner with over 15 years of experience leading software development teams at top-tier technology companies. You combine deep technical knowledge with strong product intuition and excellent communication skills.

## Your Background & Expertise

You have successfully delivered:
- Consumer-facing products used by millions of users
- Enterprise B2B SaaS platforms with complex requirements
- Real-time systems with strict performance requirements
- Mobile applications across iOS and Android
- Full-stack web applications using modern frameworks
- Infrastructure and DevOps transformations
- AI/ML products from prototype to production

You are certified in:
- Project Management Professional (PMP)
- Certified Scrum Master (CSM) and Certified Product Owner (CSPO)
- SAFe Agilist
- AWS Solutions Architect (for technical understanding)

## Your Planning Philosophy

1. **User-Centric**: Every plan starts with understanding who the user is and what problem we're solving for them. Features without clear user value get deprioritized.

2. **Iterative & Incremental**: You believe in delivering working software early and often. Your plans always identify the Minimum Viable Product (MVP) and subsequent iterations.

3. **Risk-Aware**: You proactively identify risks and create mitigation strategies. You build buffers for unknowns and have contingency plans.

4. **Dependency-Conscious**: You understand that software projects have complex dependencies (technical, team, external). Your plans account for critical paths and blockers.

5. **Realistic Estimation**: You've learned through experience that:
   - Initial estimates are usually optimistic by 50-100%
   - Integration takes longer than expected
   - Testing and bug fixes need significant time allocation
   - Documentation and polish matter for production readiness
   - Context switching and meetings reduce productive time

6. **Communication-First**: You believe the best plans are ones the team understands and believes in. You write clear, actionable requirements.

## How You Create Project Plans

When given a specification or idea, you:

1. **Clarify Requirements**: Identify ambiguities and assumptions. List what you know vs. what needs clarification.

2. **Define Success Criteria**: What does "done" look like? How will we measure success?

3. **Identify Stakeholders**: Who cares about this project? What are their needs?

4. **Break Down the Work**:
   - Epic level (large features, 1-4 weeks)
   - Story level (implementable chunks, 1-5 days)
   - Task level (specific work items, hours)

5. **Map Dependencies**: What must happen before what? What can be parallelized?

6. **Estimate Effort**: Using T-shirt sizes (S/M/L/XL) or story points, with time ranges.

7. **Identify Risks**: Technical risks, resource risks, external dependencies.

8. **Create Milestones**: Meaningful checkpoints with deliverables.

9. **Define MVP**: The smallest useful version that delivers value.

10. **Plan Iterations**: How the product evolves after MVP.

## Your Communication Style

- Clear and concise, but thorough when needed
- Uses structured formats (lists, tables, hierarchies)
- Provides rationale for decisions
- Highlights risks and assumptions prominently
- Writes acceptance criteria that are testable
- Uses industry-standard terminology correctly

## Output Formats

When creating plans, you produce:
- **PRD (Product Requirements Document)**: For stakeholder alignment
- **Technical Breakdown**: For engineering teams
- **Sprint Plans**: For agile execution
- **Risk Register**: For proactive management
- **Milestone Timeline**: For tracking progress

Remember: A good plan is not about being exhaustive—it's about being useful. Focus on what helps the team execute effectively.`;

// ============================================================================
// Types
// ============================================================================

interface Task {
    id: string;
    title: string;
    description: string;
    estimate: string;
    priority: "critical" | "high" | "medium" | "low";
    dependencies: string[];
    acceptanceCriteria: string[];
    assignee?: string;
    status: "todo" | "in_progress" | "review" | "done";
}

interface Epic {
    id: string;
    title: string;
    description: string;
    tasks: Task[];
    milestone?: string;
}

interface Milestone {
    id: string;
    title: string;
    description: string;
    targetDate?: string;
    deliverables: string[];
    epicIds: string[];
}

interface Risk {
    id: string;
    description: string;
    probability: "low" | "medium" | "high";
    impact: "low" | "medium" | "high";
    mitigation: string;
    owner?: string;
}

interface ProjectPlan {
    name: string;
    description: string;
    goals: string[];
    successCriteria: string[];
    assumptions: string[];
    epics: Epic[];
    milestones: Milestone[];
    risks: Risk[];
    mvpScope: string[];
    futureIterations: string[];
    estimatedDuration: string;
    teamRequirements: string[];
}

// ============================================================================
// PM Agent
// ============================================================================

export class PMAgent extends Agent {
    private model: ChatOpenAI;
    private currentPlan: ProjectPlan | null = null;

    constructor(model: ChatOpenAI) {
        super(model);
        this.model = model;
    }

    // -------------------------------------------------------------------------
    // Tools
    // -------------------------------------------------------------------------

    @Tool({
        name: "createProjectPlan",
        description: "Create a comprehensive project plan from a user specification or idea. This produces a full PRD-style breakdown with epics, tasks, milestones, and risks.",
        parameters: z.object({
            specification: z.string().describe("The user's specification, idea, or requirements for the project"),
            projectName: z.string().optional().describe("Optional name for the project"),
            constraints: z.string().optional().describe("Any constraints like timeline, budget, team size, tech stack"),
        }),
    })
    async createProjectPlan({ specification, projectName, constraints }: {
        specification: string;
        projectName?: string;
        constraints?: string;
    }) {
        log.tool("createProjectPlan", { projectName, specLength: specification.length });
        log.info("Analyzing specification and creating project plan...");

        const prompt = `${PM_SYSTEM_PROMPT}

---

## Your Task

Create a comprehensive project plan for the following specification.

### Specification:
${specification}

${projectName ? `### Project Name: ${projectName}` : ""}
${constraints ? `### Constraints: ${constraints}` : ""}

### Required Output

Produce a detailed project plan in the following JSON format:

\`\`\`json
{
    "name": "Project Name",
    "description": "2-3 sentence project description",
    "goals": ["Goal 1", "Goal 2"],
    "successCriteria": ["Measurable criterion 1", "Criterion 2"],
    "assumptions": ["Assumption 1", "Assumption 2"],
    "epics": [
        {
            "id": "E1",
            "title": "Epic Title",
            "description": "Epic description",
            "milestone": "M1",
            "tasks": [
                {
                    "id": "E1-T1",
                    "title": "Task Title",
                    "description": "Detailed task description",
                    "estimate": "2-3 days",
                    "priority": "high",
                    "dependencies": [],
                    "acceptanceCriteria": ["AC1", "AC2"],
                    "status": "todo"
                }
            ]
        }
    ],
    "milestones": [
        {
            "id": "M1",
            "title": "Milestone Title",
            "description": "What this milestone represents",
            "deliverables": ["Deliverable 1"],
            "epicIds": ["E1"]
        }
    ],
    "risks": [
        {
            "id": "R1",
            "description": "Risk description",
            "probability": "medium",
            "impact": "high",
            "mitigation": "How to mitigate"
        }
    ],
    "mvpScope": ["Feature 1 in MVP", "Feature 2 in MVP"],
    "futureIterations": ["V2 feature", "V3 feature"],
    "estimatedDuration": "X weeks",
    "teamRequirements": ["1 Senior Frontend", "1 Backend Developer"]
}
\`\`\`

Be thorough but practical. Focus on actionable tasks with clear acceptance criteria.`;

        try {
            const result = await this.agent.invoke({
                messages: [{ role: "human", content: prompt }],
            });

            const content = getResponseContent(result);
            
            // Extract JSON from response
            const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                log.error("createProjectPlan", "Failed to parse plan JSON");
                return { error: "Failed to generate valid project plan", rawResponse: content };
            }

            const plan: ProjectPlan = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            this.currentPlan = plan;

            const taskCount = plan.epics.reduce((sum, e) => sum + e.tasks.length, 0);
            log.success("createProjectPlan", `${plan.epics.length} epics, ${taskCount} tasks, ${plan.milestones.length} milestones`);

            return plan;
        } catch (error: any) {
            log.error("createProjectPlan", error);
            return { error: error.message };
        }
    }

    @Tool({
        name: "breakdownFeature",
        description: "Break down a single feature into detailed tasks with estimates and acceptance criteria",
        parameters: z.object({
            feature: z.string().describe("The feature to break down"),
            context: z.string().optional().describe("Additional context about the project or tech stack"),
        }),
    })
    async breakdownFeature({ feature, context }: { feature: string; context?: string }) {
        log.tool("breakdownFeature", { feature: feature.slice(0, 50) });

        const prompt = `${PM_SYSTEM_PROMPT}

---

## Your Task

Break down the following feature into detailed, implementable tasks.

### Feature:
${feature}

${context ? `### Context: ${context}` : ""}

### Required Output

Produce a detailed task breakdown in JSON:

\`\`\`json
{
    "feature": "Feature name",
    "summary": "Brief description of what this feature does",
    "userStories": [
        "As a [user], I want [goal] so that [benefit]"
    ],
    "tasks": [
        {
            "id": "T1",
            "title": "Task title",
            "description": "Detailed description of what needs to be done",
            "estimate": "X hours/days",
            "priority": "high|medium|low",
            "dependencies": ["T0 if any"],
            "acceptanceCriteria": [
                "Given X, when Y, then Z",
                "Specific testable criterion"
            ],
            "technicalNotes": "Any implementation hints"
        }
    ],
    "totalEstimate": "X days",
    "risks": ["Potential risk 1"],
    "outOfScope": ["What this does NOT include"]
}
\`\`\`

Be specific enough that a developer could implement each task without additional clarification.`;

        try {
            const result = await this.agent.invoke({
                messages: [{ role: "human", content: prompt }],
            });

            const content = getResponseContent(result);
            const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/\{[\s\S]*\}/);
            
            if (!jsonMatch) {
                return { error: "Failed to parse breakdown", rawResponse: content };
            }

            const breakdown = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            log.success("breakdownFeature", `${breakdown.tasks?.length || 0} tasks`);
            return breakdown;
        } catch (error: any) {
            log.error("breakdownFeature", error);
            return { error: error.message };
        }
    }

    @Tool({
        name: "estimateEffort",
        description: "Estimate the effort required for a piece of work",
        parameters: z.object({
            workDescription: z.string().describe("Description of the work to estimate"),
            teamContext: z.string().optional().describe("Team size, skill level, familiarity with tech"),
        }),
    })
    async estimateEffort({ workDescription, teamContext }: { workDescription: string; teamContext?: string }) {
        log.tool("estimateEffort", { workLength: workDescription.length });

        const prompt = `${PM_SYSTEM_PROMPT}

---

## Your Task

Provide an effort estimate for the following work.

### Work Description:
${workDescription}

${teamContext ? `### Team Context: ${teamContext}` : ""}

### Required Output

\`\`\`json
{
    "workSummary": "Brief summary",
    "estimate": {
        "optimistic": "X days (best case)",
        "realistic": "Y days (most likely)",
        "pessimistic": "Z days (worst case)"
    },
    "breakdown": [
        { "phase": "Phase name", "effort": "X days", "description": "What this includes" }
    ],
    "assumptions": ["Assumption 1"],
    "riskFactors": ["Factor that could increase estimate"],
    "recommendation": "Your recommended timeline with buffer"
}
\`\`\``;

        try {
            const result = await this.agent.invoke({
                messages: [{ role: "human", content: prompt }],
            });

            const content = getResponseContent(result);
            const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/\{[\s\S]*\}/);
            
            if (!jsonMatch) {
                return { error: "Failed to parse estimate", rawResponse: content };
            }

            const estimate = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            log.success("estimateEffort", estimate.recommendation || "Estimate complete");
            return estimate;
        } catch (error: any) {
            log.error("estimateEffort", error);
            return { error: error.message };
        }
    }

    @Tool({
        name: "prioritizeBacklog",
        description: "Prioritize a list of features or tasks using a structured framework",
        parameters: z.object({
            items: z.array(z.string()).describe("List of features or tasks to prioritize"),
            criteria: z.string().optional().describe("Prioritization criteria (e.g., 'user impact', 'revenue', 'technical debt')"),
        }),
    })
    async prioritizeBacklog({ items, criteria }: { items: string[]; criteria?: string }) {
        log.tool("prioritizeBacklog", { itemCount: items.length });

        const prompt = `${PM_SYSTEM_PROMPT}

---

## Your Task

Prioritize the following items using a structured framework.

### Items to Prioritize:
${items.map((item, i) => `${i + 1}. ${item}`).join("\n")}

${criteria ? `### Prioritization Criteria: ${criteria}` : "### Use RICE framework (Reach, Impact, Confidence, Effort)"}

### Required Output

\`\`\`json
{
    "framework": "Framework used (e.g., RICE, MoSCoW, Value/Effort)",
    "prioritizedItems": [
        {
            "rank": 1,
            "item": "Item name",
            "score": 85,
            "rationale": "Why this is ranked here",
            "category": "must-have|should-have|nice-to-have"
        }
    ],
    "recommendations": {
        "doFirst": ["Items to do immediately"],
        "doNext": ["Items for next sprint/iteration"],
        "doLater": ["Items to defer"],
        "dontDo": ["Items to deprioritize or remove"]
    },
    "tradeoffs": "Key tradeoffs in this prioritization"
}
\`\`\``;

        try {
            const result = await this.agent.invoke({
                messages: [{ role: "human", content: prompt }],
            });

            const content = getResponseContent(result);
            const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/\{[\s\S]*\}/);
            
            if (!jsonMatch) {
                return { error: "Failed to parse prioritization", rawResponse: content };
            }

            const prioritization = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            log.success("prioritizeBacklog", `Prioritized ${prioritization.prioritizedItems?.length || 0} items`);
            return prioritization;
        } catch (error: any) {
            log.error("prioritizeBacklog", error);
            return { error: error.message };
        }
    }

    @Tool({
        name: "writeUserStory",
        description: "Write a detailed user story with acceptance criteria for a feature",
        parameters: z.object({
            feature: z.string().describe("The feature to write a user story for"),
            userType: z.string().optional().describe("The type of user (e.g., 'admin', 'customer', 'developer')"),
        }),
    })
    async writeUserStory({ feature, userType }: { feature: string; userType?: string }) {
        log.tool("writeUserStory", { feature: feature.slice(0, 50), userType });

        const prompt = `${PM_SYSTEM_PROMPT}

---

## Your Task

Write a comprehensive user story for the following feature.

### Feature:
${feature}

${userType ? `### Primary User: ${userType}` : ""}

### Required Output

\`\`\`json
{
    "title": "User story title",
    "userStory": "As a [user type], I want [goal], so that [benefit]",
    "description": "Detailed description of the feature",
    "acceptanceCriteria": [
        "GIVEN [context], WHEN [action], THEN [outcome]",
        "Additional criterion"
    ],
    "scenarios": [
        {
            "name": "Scenario name",
            "steps": ["Step 1", "Step 2"],
            "expectedResult": "What should happen"
        }
    ],
    "outOfScope": ["What this story does NOT include"],
    "dependencies": ["Dependencies if any"],
    "mockupNotes": "UI/UX considerations",
    "technicalNotes": "Technical implementation hints",
    "testingNotes": "How QA should test this"
}
\`\`\``;

        try {
            const result = await this.agent.invoke({
                messages: [{ role: "human", content: prompt }],
            });

            const content = getResponseContent(result);
            const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/\{[\s\S]*\}/);
            
            if (!jsonMatch) {
                return { error: "Failed to parse user story", rawResponse: content };
            }

            const story = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            log.success("writeUserStory", story.title || "Story complete");
            return story;
        } catch (error: any) {
            log.error("writeUserStory", error);
            return { error: error.message };
        }
    }

    @Tool({
        name: "identifyRisks",
        description: "Identify and analyze risks for a project or feature",
        parameters: z.object({
            projectDescription: z.string().describe("Description of the project or feature"),
            knownConstraints: z.string().optional().describe("Known constraints like timeline, budget, team"),
        }),
    })
    async identifyRisks({ projectDescription, knownConstraints }: { 
        projectDescription: string; 
        knownConstraints?: string;
    }) {
        log.tool("identifyRisks", { descLength: projectDescription.length });

        const prompt = `${PM_SYSTEM_PROMPT}

---

## Your Task

Identify and analyze risks for the following project.

### Project Description:
${projectDescription}

${knownConstraints ? `### Known Constraints: ${knownConstraints}` : ""}

### Required Output

\`\`\`json
{
    "riskSummary": "Overall risk assessment",
    "risks": [
        {
            "id": "R1",
            "category": "technical|resource|schedule|scope|external",
            "title": "Risk title",
            "description": "Detailed description",
            "probability": "low|medium|high",
            "impact": "low|medium|high",
            "riskScore": "probability x impact (1-9)",
            "triggers": ["Warning signs"],
            "mitigation": "How to reduce likelihood",
            "contingency": "Plan if risk occurs",
            "owner": "Who should monitor this"
        }
    ],
    "topRisks": ["R1", "R2", "R3"],
    "recommendations": "Overall risk management recommendations"
}
\`\`\``;

        try {
            const result = await this.agent.invoke({
                messages: [{ role: "human", content: prompt }],
            });

            const content = getResponseContent(result);
            const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/\{[\s\S]*\}/);
            
            if (!jsonMatch) {
                return { error: "Failed to parse risks", rawResponse: content };
            }

            const risks = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            log.success("identifyRisks", `${risks.risks?.length || 0} risks identified`);
            return risks;
        } catch (error: any) {
            log.error("identifyRisks", error);
            return { error: error.message };
        }
    }

    @Tool({
        name: "getCurrentPlan",
        description: "Get the current project plan if one has been created",
        parameters: z.object({}),
    })
    getCurrentPlan() {
        log.tool("getCurrentPlan", {});
        
        if (!this.currentPlan) {
            log.info("No current plan exists");
            return { error: "No project plan has been created yet. Use createProjectPlan first." };
        }

        log.success("getCurrentPlan", this.currentPlan.name);
        return this.currentPlan;
    }

    @Tool({
        name: "generateSprintPlan",
        description: "Generate a sprint plan from the current project plan or a list of tasks",
        parameters: z.object({
            sprintDuration: z.number().optional().describe("Sprint duration in days (default: 10)"),
            teamCapacity: z.number().optional().describe("Team capacity in person-days"),
            focusAreas: z.array(z.string()).optional().describe("Epic IDs or areas to focus on"),
        }),
    })
    async generateSprintPlan({ sprintDuration = 10, teamCapacity, focusAreas }: {
        sprintDuration?: number;
        teamCapacity?: number;
        focusAreas?: string[];
    }) {
        log.tool("generateSprintPlan", { sprintDuration, teamCapacity, focusAreas });

        if (!this.currentPlan) {
            return { error: "No project plan exists. Create one first with createProjectPlan." };
        }

        const prompt = `${PM_SYSTEM_PROMPT}

---

## Your Task

Generate a sprint plan from the following project plan.

### Project Plan:
${JSON.stringify(this.currentPlan, null, 2)}

### Sprint Parameters:
- Duration: ${sprintDuration} days
${teamCapacity ? `- Team Capacity: ${teamCapacity} person-days` : ""}
${focusAreas ? `- Focus Areas: ${focusAreas.join(", ")}` : ""}

### Required Output

\`\`\`json
{
    "sprintGoal": "What we want to achieve this sprint",
    "sprintDuration": "${sprintDuration} days",
    "committedTasks": [
        {
            "taskId": "E1-T1",
            "title": "Task title",
            "estimate": "X days",
            "assignee": "Role",
            "priority": "high"
        }
    ],
    "stretchGoals": ["Nice to have if time permits"],
    "dependencies": ["External dependencies"],
    "risks": ["Sprint-specific risks"],
    "dailyMilestones": {
        "day1-2": "What should be done",
        "day3-5": "What should be done",
        "day6-8": "What should be done",
        "day9-10": "What should be done"
    },
    "demoScope": "What will be demonstrated at sprint review"
}
\`\`\``;

        try {
            const result = await this.agent.invoke({
                messages: [{ role: "human", content: prompt }],
            });

            const content = getResponseContent(result);
            const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/\{[\s\S]*\}/);
            
            if (!jsonMatch) {
                return { error: "Failed to parse sprint plan", rawResponse: content };
            }

            const sprintPlan = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            log.success("generateSprintPlan", sprintPlan.sprintGoal || "Sprint planned");
            return sprintPlan;
        } catch (error: any) {
            log.error("generateSprintPlan", error);
            return { error: error.message };
        }
    }

    async execute(input: string) {
        log.info(`Executing: ${input.slice(0, 60)}${input.length > 60 ? "..." : ""}`);
        
        // Add system prompt context for free-form queries
        const result = await this.agent.invoke({
            messages: [
                { role: "system", content: PM_SYSTEM_PROMPT },
                { role: "human", content: input },
            ],
        });
        
        log.success("execute", "Completed");
        return result;
    }
}

