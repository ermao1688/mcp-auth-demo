import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { Octokit } from "octokit";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";

// Context from the auth process, encrypted & stored in the auth token
// and provided to the DurableMCP as this.props
type Props = {
	login: string;
	name: string;
	email: string;
	accessToken: string;
};

interface Project {
	id: string;
	name: string;
	description: string;
	createdAt: string;
	updatedAt: string;
}

interface Todo {
	id: string;
	projectId: string;
	title: string;
	description: string;
	status: "pending" | "in_progress" | "completed";
	priority: "low" | "medium" | "high";
	createdAt: string;
	updatedAt: string;
}

const ALLOWED_USERNAMES = new Set<string>([
	// Add GitHub usernames of users who should have access to the image generation tool
	// For example: 'yourusername', 'coworkerusername'
]);

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Project Planner With Auth",
		version: "1.0.0",
	});

	private get KV(): KVNamespace {
		return (this.env as Env).PROJECT_PLANNER_STORE_WITH_AUTH;
	}

	private async getProjectList(): Promise<string[]> {
		const listData = await this.KV.get("project:list");
		// const listData = await (this.env as Env).PROJECT_PLANNER_STORE.get("project:list");
		return listData ? JSON.parse(listData) : [];
		// Only get the whole string value of the json object, still need to extract each one individually.
	}

	private async getTodoList(projectId: string): Promise<string[]> {
		const listData = await this.KV.get(`project:${projectId}:todos`);
		// const listData = await (this.env as Env).PROJECT_PLANNER_STORE.get(`project:${projectId}:todo:list`);
		return listData ? JSON.parse(listData) : [];
	}

	private async getTodosByProject(projectId: string): Promise<Todo[]> {	
		const todoList = await this.getTodoList(projectId);
		const todos: Todo[] = [];
		for (const todoId of todoList) {
			const todoData = await this.KV.get(`todo:${todoId}`);
			if (todoData) {
				todos.push(JSON.parse(todoData));
			}
		}
		return todos;
	}

	// private async addTodo(projectId: string, todo: Todo): Promise<void> {
	// 	const todoList = await this.getTodoList(projectId);
	// 	todoList.push(todo.id);
	// 	await this.KV.put(`project:${projectId}:todos`, JSON.stringify(todoList));
	// }

	// private async updateTodo(projectId: string, todoId: string, todo: Todo): Promise<void> {
	// 	const todoList = await this.getTodoList(projectId);
	// 	const index = todoList.indexOf(todoId);
	// 	if (index !== -1) {
	// 		todoList[index] = todo.id;
	// 	}
	// }

	private async deleteTodo(projectId: string, todoId: string): Promise<void> {
		const todoList = await this.getTodoList(projectId);
		const index = todoList.indexOf(todoId);
		if (index !== -1) {
			todoList.splice(index, 1);
		}
		await this.KV.put(`project:${projectId}:todos`, JSON.stringify(todoList));
	}

	async init() {
		// Hello, world!
		this.server.tool(
			"add",
			"Add two numbers the way only MCP can",
			{ a: z.number(), b: z.number() },
			async ({ a, b }) => ({
				content: [{ text: String(a + b), type: "text" }],
			}),
		);

		// Use the upstream access token to facilitate tools
		this.server.tool(
			"userInfoOctokit",
			"Get user info from GitHub, via Octokit",
			{},
			async () => {
				const octokit = new Octokit({ auth: this.props!.accessToken });
				return {
					content: [
						{
							text: JSON.stringify(await octokit.rest.users.getAuthenticated()),
							type: "text",
						},
					],
				};
			},
		);

		// Dynamically add tools based on the user's login. In this case, I want to limit
		// access to my Image Generation tool to just me
		if (ALLOWED_USERNAMES.has(this.props!.login)) {
			this.server.tool(
				"generateImage",
				"Generate an image using the `flux-1-schnell` model. Works best with 8 steps.",
				{
					prompt: z
						.string()
						.describe("A text description of the image you want to generate."),
					steps: z
						.number()
						.min(4)
						.max(8)
						.default(4)
						.describe(
							"The number of diffusion steps; higher values can improve quality but take longer. Must be between 4 and 8, inclusive.",
						),
				},
				async ({ prompt, steps }) => {
					const response = await this.env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
						prompt,
						steps,
					});

					return {
						content: [{ data: response.image!, mimeType: "image/jpeg", type: "image" }],
					};
				},
			);


		}
	}
}

export default new OAuthProvider({
	// NOTE - during the summer 2025, the SSE protocol was deprecated and replaced by the Streamable-HTTP protocol
	// https://developers.cloudflare.com/agents/model-context-protocol/transport/#mcp-server-with-authentication
	apiHandlers: {
		"/sse": MyMCP.serveSSE("/sse"), // deprecated SSE protocol - use /mcp instead
		"/mcp": MyMCP.serve("/mcp"), // Streamable-HTTP protocol
	},
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});
