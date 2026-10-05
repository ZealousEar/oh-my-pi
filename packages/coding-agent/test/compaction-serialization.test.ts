import { describe, expect, it } from "bun:test";
import { serializeConversation } from "@oh-my-pi/pi-agent-core/compaction/utils";
import type { Message } from "@oh-my-pi/pi-ai";

describe("serializeConversation", () => {
	it("keeps both edges of a long tool result so a trailing error reaches the summarizer", () => {
		// Test runners and shells print the verdict last; a head-only cut used to
		// hand the summarizer only the passing prefix and lose the exact error.
		const passingPrefix = "✓ case passed\n".repeat(400);
		const trailingError =
			"error: TypeError: Cannot read properties of undefined (reading 'schema') at parser.ts:42:17\n1 fail";
		const longContent = `${passingPrefix}${trailingError}`;
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "bash",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool Result]:");
		expect(result).toContain(`[... ${longContent.length - 2000} characters truncated from the middle ...]`);
		expect(result).toContain(trailingError);
		expect(result.startsWith("[Tool Result]: ✓ case passed\n")).toBe(true);
		expect(result.length).toBeLessThan(2200);
	});

	it("never splits a surrogate pair at either cut point and keeps the retained budget", () => {
		// An emoji straddling the head or tail boundary used to leave a lone
		// surrogate in the summarizer input, which encoders turn into U+FFFD;
		// shrinking both edges independently then over-trimmed by two units.
		const emoji = "😀"; // two UTF-16 code units
		const head = `${"a".repeat(1199)}${emoji}`; // high surrogate sits at index 1199
		const middle = "m".repeat(3000);
		const tail = `${emoji}${"z".repeat(799)}`; // 801 units: the 800-unit tail cut would start on the low surrogate
		const source = `${head}${middle}${tail}`;
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "bash",
				content: [{ type: "text", text: source }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
		const marker = result.match(/\[\.\.\. (\d+) characters truncated from the middle \.\.\.\]/);
		expect(marker).not.toBeNull();
		expect(source.length - Number(marker?.[1])).toBe(2000);
		expect(result.replace(/\n$/, "").endsWith(`${emoji}${"z".repeat(799)}`)).toBe(true);
		expect(result.startsWith(`[Tool Result]: ${"a".repeat(1199)}\n`)).toBe(true);
	});

	it("does not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool Result]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("does not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});
});
