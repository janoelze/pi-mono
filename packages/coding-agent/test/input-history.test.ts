import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InputHistoryManager } from "../src/core/input-history.js";

describe("InputHistoryManager", () => {
	const testDir = join(process.cwd(), "test-input-history-tmp");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("in-memory mode works without file I/O", () => {
		const history = InputHistoryManager.inMemory();

		history.add("first");
		history.add("second");

		expect(history.length).toBe(2);
		expect(history.get(0)).toBe("second");
		expect(history.get(1)).toBe("first");
	});

	it("trims whitespace from entries", () => {
		const history = InputHistoryManager.inMemory();

		history.add("  hello world  ");

		expect(history.get(0)).toBe("hello world");
	});

	it("skips empty entries", () => {
		const history = InputHistoryManager.inMemory();

		history.add("");
		history.add("   ");
		history.add("\n\t");

		expect(history.length).toBe(0);
	});

	it("prevents consecutive duplicates", () => {
		const history = InputHistoryManager.inMemory();

		history.add("hello");
		history.add("hello");
		history.add("hello");

		expect(history.length).toBe(1);
	});

	it("allows non-consecutive duplicates", () => {
		const history = InputHistoryManager.inMemory();

		history.add("hello");
		history.add("world");
		history.add("hello");

		expect(history.length).toBe(3);
		expect(history.getAll()).toEqual(["hello", "world", "hello"]);
	});

	it("limits history to 150 entries", () => {
		const history = InputHistoryManager.inMemory();

		for (let i = 0; i < 200; i++) {
			history.add(`entry-${i}`);
		}

		expect(history.length).toBe(150);
		expect(history.get(0)).toBe("entry-199");
		expect(history.get(149)).toBe("entry-50");
	});

	it("persists to file", () => {
		const history = InputHistoryManager.create(testDir);

		history.add("persistent entry");

		const filePath = join(testDir, "input-history.json");
		expect(existsSync(filePath)).toBe(true);

		const content = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(content).toEqual(["persistent entry"]);
	});

	it("loads from file on creation", () => {
		// Create history and add entries
		const history1 = InputHistoryManager.create(testDir);
		history1.add("first");
		history1.add("second");

		// Create new instance - should load from file
		const history2 = InputHistoryManager.create(testDir);

		expect(history2.length).toBe(2);
		expect(history2.get(0)).toBe("second");
		expect(history2.get(1)).toBe("first");
	});

	it("clear removes all entries", () => {
		const history = InputHistoryManager.create(testDir);

		history.add("entry1");
		history.add("entry2");
		expect(history.length).toBe(2);

		history.clear();
		expect(history.length).toBe(0);

		// Verify file is updated
		const filePath = join(testDir, "input-history.json");
		const content = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(content).toEqual([]);
	});

	it("handles corrupted file gracefully", () => {
		const filePath = join(testDir, "input-history.json");

		// Write corrupted JSON
		writeFileSync(filePath, "not valid json");

		// Should not throw, starts with empty history
		const history = InputHistoryManager.create(testDir);
		expect(history.length).toBe(0);
	});

	it("handles non-array JSON gracefully", () => {
		const filePath = join(testDir, "input-history.json");

		// Write non-array JSON
		writeFileSync(filePath, '{"foo": "bar"}');

		const history = InputHistoryManager.create(testDir);
		expect(history.length).toBe(0);
	});

	it("filters out non-string entries from file", () => {
		const filePath = join(testDir, "input-history.json");

		// Write array with mixed types
		writeFileSync(filePath, '["valid", 123, null, "also valid", {"obj": true}]');

		const history = InputHistoryManager.create(testDir);
		expect(history.length).toBe(2);
		expect(history.getAll()).toEqual(["valid", "also valid"]);
	});
});
