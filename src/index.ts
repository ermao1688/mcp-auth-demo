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
	"hubiao1688",
	"ermao1688",
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
		const listData = await this.KV.get(`project:user-${this.props!.login}:list`);
		// const listData = await (this.env as Env).PROJECT_PLANNER_STORE.get("project:list");
		return listData ? JSON.parse(listData) : [];
		// Only get the whole string value of the json object, still need to extract each one individually.
	}

	private async getTodoList(projectId: string): Promise<string[]> {
		const listData = await this.KV.get(`project:${projectId}:user-${this.props!.login}:todos`);
		// const listData = await (this.env as Env).PROJECT_PLANNER_STORE.get(`project:${projectId}:todo:list`);
		return listData ? JSON.parse(listData) : [];
	}

	private async getTodosByProject(projectId: string): Promise<Todo[]> {	
		const todoList = await this.getTodoList(projectId);
		const todos: Todo[] = [];
		for (const todoId of todoList) {
			const todoData = await this.KV.get(`todo:user-${this.props!.login}:${todoId}`);
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
		await this.KV.put(`project:${projectId}:user-${this.props!.login}:todos`, JSON.stringify(todoList));
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

			// Create a new project
			this.server.tool(
				"createProject",
				"Create a new project",
				{
					name: z.string(),
					description: z.string().optional().describe("Project description"),
				},
				async ({ name, description }) => {
					const projectId = crypto.randomUUID();

					const project: Project = {
						id: projectId,
						name,
						description: description ?? "",
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					};

					await this.KV.put(`project:${project.id}:user-${this.props!.login}`, JSON.stringify(project));

					// await (this.env as Env).PROJECT_PLANNER_STORE.put(
					// 	`project:${project.id}`, 
					// 	JSON.stringify(project)
					// );

					const projectList = await this.getProjectList();
					projectList.push(projectId);
					await this.KV.put("project:user-${this.props!.login}:list", JSON.stringify(projectList));

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(project, null, 2),
							},
						],
					};
				},
			);

			// Get the list of all projects
			this.server.tool(
				"get_project_list",
				"Get the list of all projects",
				{},
				async () => {
					const projectList = await this.getProjectList();
					const projects: Project[] = [];
					for (const projectId of projectList) {
						const projectData = await this.KV.get(`project:${projectId}:user-${this.props!.login}`);
						if (projectData) {
							projects.push(JSON.parse(projectData));
						}
					}
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(projects, null, 2),
							},
						],
					};
				},
			);

			// Get a project by its ID
			this.server.tool(
				"get_project",
				"Get a project by its ID",
				{
					projectId: z.string().describe("The ID of the project to get"),
				},
				async ({ projectId }) => {
					const projectData = await this.KV.get(`project:${projectId}:user-${this.props!.login}`);
					if (!projectData) {
						return {
							content: [
								{
									type: "text",
									text: `Project with ID ${projectId} not found`,
								},
							],
						};
					}
					const project: Project = JSON.parse(projectData);
					const todos = await this.getTodosByProject(projectId);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({project, todos}, null, 2), // JSON.stringify(value, replacer, space)
							},
						],
					};
				},
			);

			this.server.tool(
				"delete_project",
				"Delete a project by its ID and all its todos",
				{
					projectId: z.string().describe("The ID of the project to delete"),
				},
				async ({ projectId }) => {
					const projectData = await this.KV.get(`project:${projectId}:user-${this.props!.login}`);
					if (!projectData) {
						return {
							content: [
								{
									type: "text",
									text: `Project with ID ${projectId} not found`,
								},
							],
						};
					}

					// Delete the project and all its todos
					const todos = await this.getTodosByProject(projectId);

					for (const todo of todos) {
						await this.deleteTodo(projectId, todo.id);
					}
					await this.KV.delete(`project:${projectId}:user-${this.props!.login}`);
					const projectList = await this.getProjectList();
					// Delete the project from the project list
					// const updatedList = projectList.filter((id) => id !== projectId);

					// Use splice(start, deleteCount) to delete the project from the project list
					const index = projectList.indexOf(projectId);
					if (index !== -1) {
						projectList.splice(index, 1); // splice(start, deleteCount)
					}
					await this.KV.put("project:user-${this.props!.login}:list", JSON.stringify(projectList)); // Put the updated project list back to the KV

					return {
						content: [
							{
								type: "text",
								text: `Project with ID ${projectId} and all its todos deleted`,
							},
						],
					};
				},
			);

			this.server.tool(
				"create_todo",
				"Create a new todo item for a project",
				{
					projectId: z.string().describe("The ID of the project to create the todo for"),
					title: z.string().describe("The title of the todo").min(1),
					description: z.string().optional().describe("Todo description"),
					priority: z.enum(["low", "medium", "high"]).optional().describe("Todo priority"),
				},
				async ({ projectId, title, description, priority }) => {
					const projectData = await this.KV.get(`project:${projectId}:user-${this.props!.login}`);
					if (!projectData) {
						return {
							content: [
								{
									type: "text",
									text: `Project with ID ${projectId} not found`,
								},
							],
						};
					}
					const todoId = crypto.randomUUID();
					const todo: Todo = {
						id: todoId,
						projectId: projectId,
						title,
						description: description ?? "",
						priority: priority ?? "medium",
						status: "pending",
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					};

					// await this.addTodo(projectId, todo);
					await this.KV.put(`todo:user-${this.props!.login}:${todoId}`, JSON.stringify(todo));
					const todoList = await this.getTodoList(projectId);
					todoList.push(todoId);
					await this.KV.put(`project:${projectId}:user-${this.props!.login}:todos`, JSON.stringify(todoList));	

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(todo, null, 2),
							},
						],
					};
				},
			);

			this.server.tool(
				"update_todo",
				"Update a todo's properties",
				{
					todoId: z.string().describe("The ID of the todo to update for"),
					title: z.string().describe("New title of the todo").min(1),
					description: z.string().optional().describe("New todo description"),
					status: z.enum(["pending", "in_progress", "completed"]).optional().describe("Todo status"),
					priority: z.enum(["low", "medium", "high"]).optional().describe("New todo priority"),
				},
				async ({ todoId, title, description, status, priority }) => {
					const todoData = await this.KV.get(`todo:user-${this.props!.login}:${todoId}`);
					if (!todoData) {
						return {
							content: [
								{
									type: "text",
									text: `Todo with ID ${todoId} not found`,
								},
							],
						};
					}
					const todo: Todo = JSON.parse(todoData);
					todo.title = title;
					todo.description = description ?? todo.description;
					todo.status = status ?? todo.status;
					todo.priority = priority ?? todo.priority;
					todo.updatedAt = new Date().toISOString();
					await this.KV.put(`todo:user-${this.props!.login}:${todoId}`, JSON.stringify(todo));

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(todo, null, 2),
							},
						],
					};
				},
			);

			this.server.tool(
				"delete_todo",
				"Delete a todo from a project",
				{
					todoId: z.string().describe("Todo ID"),
				},
				async ({ todoId }) => {
					const todoData = await this.KV.get(`todo:user-${this.props!.login}:${todoId}`);
					if (!todoData) {
						// Use throw new Error(...) to throw an error instead of returning a response
						throw new Error(`Todo with ID ${todoId} not found`);

						// return {
						// 	content: [
						// 		{
						// 			type: "text",
						// 			text: `Todo with ID ${todoId} not found`,
						// 		},
						// 	],
						// };
					}
					// Remove from the project's todo list
					const todo: Todo = JSON.parse(todoData);
					const todoList = await this.getTodoList(todo.projectId);
					const updatedTodoList = todoList.filter((id) => id !== todoId);
					// Put the updated todo list back to the KV
					await this.KV.put(`project:${todo.projectId}:user-${this.props!.login}:todos`, JSON.stringify(updatedTodoList));

					// Delete the todo from the KV
					await this.KV.delete(`todo:user-${this.props!.login}:${todoId}`);

					return {
						content: [
							{
								type: "text",
								text: `Todo with ID ${todoId} deleted`,
							},
						],
					};
				},
			);

			this.server.tool(
				"get_todo",
				"Get a todo by its ID",
				{
					todoId: z.string().describe("Todo ID"),
				},
				async ({ todoId }) => {
					const todoData = await this.KV.get(`todo:user-${this.props!.login}:${todoId}`);
					if (!todoData) {
						throw new Error(`Todo with ID ${todoId} not found`);
					}
					const todo: Todo = JSON.parse(todoData);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(todo, null, 2),
							},
						],
					};
				},
			);

			this.server.tool(
				"list_todos",
				"Get all todos by a project ID",
				{
					projectId: z.string().describe("Project ID"),
					status: z.enum(["pending", "in_progress", "completed", "all"])
					.optional()
					.describe("Filter todos by status"),
				},
				async ({ projectId, status }) => {
					const projectData = await this.KV.get(`project:${projectId}:user-${this.props!.login}`);
					if (!projectData) {
						throw new Error(`Project with ID ${projectId} not found`);
					}
					let todos: Todo[] = await this.getTodosByProject(projectId);
					if (status && status !== "all") {
						todos = todos.filter((todo) => todo.status === status);
					}
					return {
						content: [	
							{
								type: "text",
								text: JSON.stringify(todos, null, 2)
							},
						],
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
