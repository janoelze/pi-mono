/**
 * Checkpoint Extension - Save and restore session context
 *
 * Allows saving the current conversation context to disk and restoring it
 * in new sessions. Useful for:
 * - Building up context (reading files, understanding a problem)
 * - Running multiple agents from the same starting point
 * - Sharing context setups across sessions
 *
 * Commands:
 *   /checkpoint save [description] - Save current context (auto-generates short ID)
 *   /checkpoint load <id>          - Load checkpoint into current session
 *   /checkpoint list               - List all saved checkpoints
 *   /checkpoint delete <id>        - Delete a checkpoint
 *   /checkpoint show <id>          - Preview checkpoint content
 *
 * CLI flag:
 *   pi --restore <id>              - Start with restored checkpoint context
 *
 * Checkpoints are stored in ~/.pi/agent/checkpoints/<id>.json
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";

// Checkpoint storage location
const CHECKPOINTS_DIR = join(homedir(), ".pi", "agent", "checkpoints");

// Characters for short ID generation (alphanumeric, no ambiguous chars like 0/O, 1/l/I)
const ID_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";

/** Generate a short 6-character ID that's easy to copy */
function generateShortId(): string {
	let id = "";
	for (let i = 0; i < 6; i++) {
		id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
	}
	return id;
}

interface Checkpoint {
	id: string;
	description?: string;
	cwd: string;
	timestamp: string;
	/** Serialized conversation text for LLM context injection */
	serializedContext: string;
	/** Summary statistics */
	stats: {
		messageCount: number;
		userMessages: number;
		assistantMessages: number;
		toolCalls: number;
	};
}

function ensureCheckpointsDir(): void {
	if (!existsSync(CHECKPOINTS_DIR)) {
		mkdirSync(CHECKPOINTS_DIR, { recursive: true });
	}
}

function getCheckpointPath(id: string): string {
	// Sanitize ID to be filesystem-safe
	const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	return join(CHECKPOINTS_DIR, `${safeId}.json`);
}

function loadCheckpoint(id: string): Checkpoint | null {
	const path = getCheckpointPath(id);
	if (!existsSync(path)) {
		return null;
	}
	try {
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content) as Checkpoint;
	} catch {
		return null;
	}
}

function saveCheckpoint(checkpoint: Checkpoint): void {
	ensureCheckpointsDir();
	const path = getCheckpointPath(checkpoint.id);
	writeFileSync(path, JSON.stringify(checkpoint, null, 2));
}

function listCheckpoints(): Array<{ id: string; timestamp: string; description?: string; messageCount: number }> {
	ensureCheckpointsDir();
	const files = readdirSync(CHECKPOINTS_DIR).filter((f) => f.endsWith(".json"));
	const checkpoints: Array<{ id: string; timestamp: string; description?: string; messageCount: number }> = [];

	for (const file of files) {
		try {
			const content = readFileSync(join(CHECKPOINTS_DIR, file), "utf-8");
			const checkpoint = JSON.parse(content) as Checkpoint;
			checkpoints.push({
				id: checkpoint.id,
				timestamp: checkpoint.timestamp,
				description: checkpoint.description,
				messageCount: checkpoint.stats.messageCount,
			});
		} catch {
			// Skip invalid files
		}
	}

	// Sort by timestamp, newest first
	checkpoints.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
	return checkpoints;
}

function deleteCheckpoint(id: string): boolean {
	const path = getCheckpointPath(id);
	if (!existsSync(path)) {
		return false;
	}
	rmSync(path);
	return true;
}

export default function (pi: ExtensionAPI) {
	// Track if we've restored a checkpoint this session
	let restoredCheckpoint: Checkpoint | null = null;
	let pendingRestore: string | null = null;

	// Register --restore CLI flag
	pi.registerFlag("restore", {
		description: "Restore checkpoint context on startup (checkpoint ID)",
		type: "string",
	});

	// Check for --restore flag on session start
	pi.on("session_start", async (_event, ctx) => {
		const restoreId = pi.getFlag("restore") as string | undefined;
		if (restoreId) {
			const checkpoint = loadCheckpoint(restoreId);
			if (checkpoint) {
				restoredCheckpoint = checkpoint;
				ctx.ui.notify(`Checkpoint "${restoreId}" will be restored on first prompt`, "info");
			} else {
				ctx.ui.notify(`Checkpoint "${restoreId}" not found`, "error");
			}
		}
	});

	// Inject restored checkpoint context before first agent turn
	pi.on("before_agent_start", async (event) => {
		// Handle pending restore from /checkpoint load command
		if (pendingRestore) {
			const checkpoint = loadCheckpoint(pendingRestore);
			pendingRestore = null;
			if (checkpoint) {
				restoredCheckpoint = checkpoint;
			}
		}

		if (!restoredCheckpoint) {
			return;
		}

		const checkpoint = restoredCheckpoint;
		restoredCheckpoint = null; // Only inject once

		// Inject the checkpoint context into the system prompt
		const contextInjection = `
## Restored Context

The following is context from a previous session (checkpoint: "${checkpoint.id}"):

<restored-context>
${checkpoint.serializedContext}
</restored-context>

This context was built up in a previous session. Use it to understand the problem, files, and decisions already made. Continue from where this context left off.
`;

		return {
			systemPrompt: event.systemPrompt + contextInjection,
		};
	});

	// Register /checkpoint command
	pi.registerCommand("checkpoint", {
		description: "Save/restore session checkpoints",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase();
			const id = parts.slice(1).join(" ");

			switch (subcommand) {
				case "save": {
					// Auto-generate short ID, use remaining args as description
					const checkpointId = generateShortId();
					const description = id || undefined; // id here is actually the rest of the args

					// Get current branch messages
					const branch = ctx.sessionManager.getBranch();
					const messageEntries = branch.filter((e): e is SessionMessageEntry => e.type === "message");

					if (messageEntries.length === 0) {
						ctx.ui.notify("No messages to checkpoint", "warning");
						return;
					}

					// Extract messages and convert to LLM format
					const messages = messageEntries.map((e) => e.message);
					const llmMessages = convertToLlm(messages);
					const serializedContext = serializeConversation(llmMessages);

					// Compute stats
					let userMessages = 0;
					let assistantMessages = 0;
					let toolCalls = 0;

					for (const msg of messages) {
						if (msg.role === "user") userMessages++;
						if (msg.role === "assistant") {
							assistantMessages++;
							if ("content" in msg && Array.isArray(msg.content)) {
								for (const block of msg.content) {
									if (
										typeof block === "object" &&
										block !== null &&
										"type" in block &&
										block.type === "toolCall"
									) {
										toolCalls++;
									}
								}
							}
						}
					}

					const checkpoint: Checkpoint = {
						id: checkpointId,
						description,
						cwd: ctx.cwd,
						timestamp: new Date().toISOString(),
						serializedContext,
						stats: {
							messageCount: messageEntries.length,
							userMessages,
							assistantMessages,
							toolCalls,
						},
					};

					saveCheckpoint(checkpoint);
					ctx.ui.notify(
						`Checkpoint "${checkpointId}" saved (${messageEntries.length} messages, ${toolCalls} tool calls)`,
						"info",
					);
					break;
				}

				case "load": {
					if (!id) {
						ctx.ui.notify("Usage: /checkpoint load <id>", "warning");
						return;
					}

					const checkpoint = loadCheckpoint(id);
					if (!checkpoint) {
						ctx.ui.notify(`Checkpoint "${id}" not found`, "error");
						return;
					}

					// Set pending restore - will be injected on next prompt
					pendingRestore = id;
					ctx.ui.notify(
						`Checkpoint "${id}" queued for restore. Context will be injected on your next prompt.`,
						"info",
					);
					break;
				}

				case "list": {
					const checkpoints = listCheckpoints();
					if (checkpoints.length === 0) {
						ctx.ui.notify("No checkpoints saved", "info");
						return;
					}

					const lines = checkpoints.map((cp) => {
						const date = new Date(cp.timestamp).toLocaleDateString();
						const desc = cp.description ? ` - ${cp.description}` : "";
						return `  ${cp.id} (${cp.messageCount} msgs, ${date})${desc}`;
					});

					ctx.ui.notify(`Checkpoints:\n${lines.join("\n")}`, "info");
					break;
				}

				case "delete": {
					if (!id) {
						ctx.ui.notify("Usage: /checkpoint delete <id>", "warning");
						return;
					}

					if (deleteCheckpoint(id)) {
						ctx.ui.notify(`Checkpoint "${id}" deleted`, "info");
					} else {
						ctx.ui.notify(`Checkpoint "${id}" not found`, "error");
					}
					break;
				}

				case "show": {
					if (!id) {
						ctx.ui.notify("Usage: /checkpoint show <id>", "warning");
						return;
					}

					const checkpoint = loadCheckpoint(id);
					if (!checkpoint) {
						ctx.ui.notify(`Checkpoint "${id}" not found`, "error");
						return;
					}

					// Show checkpoint preview
					const preview = checkpoint.serializedContext.slice(0, 500);
					const truncated = checkpoint.serializedContext.length > 500 ? "..." : "";
					const stats = checkpoint.stats;

					ctx.ui.notify(
						`Checkpoint: ${checkpoint.id}\n` +
							`Created: ${checkpoint.timestamp}\n` +
							`CWD: ${checkpoint.cwd}\n` +
							`Stats: ${stats.messageCount} messages, ${stats.userMessages} user, ${stats.assistantMessages} assistant, ${stats.toolCalls} tool calls\n` +
							`${checkpoint.description ? `Description: ${checkpoint.description}\n` : ""}` +
							`\nPreview:\n${preview}${truncated}`,
						"info",
					);
					break;
				}

				default:
					ctx.ui.notify(
						"Usage:\n" +
							"  /checkpoint save [description] - Save current context (auto-generates ID)\n" +
							"  /checkpoint load <id> - Load checkpoint into session\n" +
							"  /checkpoint list - List all checkpoints\n" +
							"  /checkpoint show <id> - Preview checkpoint\n" +
							"  /checkpoint delete <id> - Delete checkpoint",
						"info",
					);
			}
		},
	});
}
