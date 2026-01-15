import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "../config.js";

const MAX_HISTORY_SIZE = 150;

/**
 * Manages persistent input history for the editor.
 * Stores up to 150 messages that persist across sessions.
 */
export class InputHistoryManager {
	private historyPath: string;
	private history: string[] = [];
	private persist: boolean;

	private constructor(historyPath: string, persist: boolean) {
		this.historyPath = historyPath;
		this.persist = persist;
		this.load();
	}

	/** Create an InputHistoryManager that loads from and saves to file */
	static create(agentDir: string = getAgentDir()): InputHistoryManager {
		const historyPath = join(agentDir, "input-history.json");
		return new InputHistoryManager(historyPath, true);
	}

	/** Create an in-memory InputHistoryManager (no file I/O, for testing) */
	static inMemory(): InputHistoryManager {
		return new InputHistoryManager("", false);
	}

	private load(): void {
		if (!this.persist || !existsSync(this.historyPath)) {
			return;
		}

		try {
			const content = readFileSync(this.historyPath, "utf-8");
			const data = JSON.parse(content);
			if (Array.isArray(data)) {
				// Ensure all entries are strings and limit to max size
				this.history = data.filter((item): item is string => typeof item === "string").slice(0, MAX_HISTORY_SIZE);
			}
		} catch {
			// Ignore errors - start with empty history
			this.history = [];
		}
	}

	private save(): void {
		if (!this.persist) {
			return;
		}

		try {
			const dir = dirname(this.historyPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(this.historyPath, JSON.stringify(this.history, null, 2), "utf-8");
		} catch {
			// Ignore save errors - history is not critical
		}
	}

	/**
	 * Add a new entry to the history.
	 * - Skips empty/whitespace-only entries
	 * - Prevents consecutive duplicates
	 * - Maintains max size of 150 entries
	 */
	add(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;

		// Don't add consecutive duplicates
		if (this.history.length > 0 && this.history[0] === trimmed) {
			return;
		}

		// Add to front
		this.history.unshift(trimmed);

		// Limit size
		if (this.history.length > MAX_HISTORY_SIZE) {
			this.history = this.history.slice(0, MAX_HISTORY_SIZE);
		}

		this.save();
	}

	/**
	 * Get all history entries (most recent first).
	 */
	getAll(): string[] {
		return [...this.history];
	}

	/**
	 * Get a specific history entry by index (0 = most recent).
	 */
	get(index: number): string | undefined {
		return this.history[index];
	}

	/**
	 * Get the total number of history entries.
	 */
	get length(): number {
		return this.history.length;
	}

	/**
	 * Clear all history entries.
	 */
	clear(): void {
		this.history = [];
		this.save();
	}
}
