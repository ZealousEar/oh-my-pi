import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	collectTaskContext,
	hasRetentionRequirement,
	requirementSentences,
} from "@oh-my-pi/pi-coding-agent/reduction/task-context";

let nextId = 1;
function user(text: string): SessionEntry {
	return {
		type: "message",
		id: `u${nextId++}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
	} as unknown as SessionEntry;
}
function assistant(text: string): SessionEntry {
	return {
		type: "message",
		id: `a${nextId++}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text },
			],
			timestamp: Date.now(),
		},
	} as unknown as SessionEntry;
}

describe("collectTaskContext", () => {
	it("reads only the permitted fields, bounded, and never a requirement-free private turn", () => {
		const original = `Fix the TLS listener so the health check passes. ${"x".repeat(100)}`;
		const secret = "By the way my VPN password is hunter2, keep it to yourself.";
		const entries = [
			user(original),
			assistant("Reading the config."),
			user("Keep every Installing line — I need the exact count of packages installed."),
			assistant("Installed dependencies."),
			user("Also: never change config.yml."),
			user(secret.replace("keep it to yourself", "that is all")),
			assistant(`Progress ${"y".repeat(100)} END`),
			user("Run the install now."),
			assistant("Older reply that predates the latest request must not count as latest progress."),
		];
		// The last assistant text is newer than the latest request here, so it counts; reorder to test the guard below.
		const context = collectTaskContext(entries, { maxChars: 40 });
		expect(context.coverage).toBe("full");
		expect(context.originalRequest).toBe(original.slice(0, 40));
		expect(context.latestRequest).toBe("Run the install now.");
		expect(context.requirements).toEqual([
			"Keep every Installing line — I need the exact count of packages installed.".slice(0, 40),
		]);
		const serialized = JSON.stringify(context);
		expect(serialized).not.toContain("hunter2");
		expect(serialized).not.toContain("private reasoning");
		// Bound applies to the requirements as a whole: a second sentence that would exceed it is dropped.
		const wide = collectTaskContext(entries, { maxChars: 200 });
		expect(wide.requirements).toEqual([
			"Keep every Installing line — I need the exact count of packages installed.",
			"Also: never change config.yml.",
		]);
		expect(hasRetentionRequirement(wide)).toBeTrue();
	});

	it("keeps the latest reply only when it follows the latest request, and reports no coverage without a user turn", () => {
		const stale = [user("first"), assistant("reply to first"), user("second")];
		expect(collectTaskContext(stale, { maxChars: 100 }).latestReply).toBe("");
		const fresh = [user("first"), assistant("reply to first"), user("second"), assistant("reply to second")];
		expect(collectTaskContext(fresh, { maxChars: 100 }).latestReply).toBe("reply to second");
		const none = collectTaskContext([assistant("only me")], { maxChars: 100 });
		expect(none.coverage).toBe("none");
		expect(none.requirements).toEqual([]);
	});

	it("starts at the latest compaction boundary", () => {
		const entries = [
			user("ancient request: count everything"),
			assistant("ok"),
			user("current request"),
			assistant("working"),
		];
		const context = collectTaskContext(entries, { maxChars: 100, boundaryId: entries[2].id });
		expect(context.originalRequest).toBe("current request");
		expect(context.requirements).toEqual([]);
	});

	it("extracts retention, counting, and standing-constraint sentences only", () => {
		expect(
			requirementSentences(
				"Please run the tests. How many failed? Then list every warning verbatim.\nNever touch prod. The weather is nice today!",
			),
		).toEqual(["How many failed?", "Then list every warning verbatim.", "Never touch prod."]);
		expect(requirementSentences("Just run it and tell me if it worked.")).toEqual([]);
	});
});
