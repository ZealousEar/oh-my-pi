/**
 * Deterministic evidence classifier shared by both reduction features: lines
 * that carry a diagnostic, a verification receipt (test/check counts, exit
 * status), or a reference the person may need to act on. Span-level pruning
 * keeps such lines verbatim; region-level shake keeps the whole result that
 * contains them without asking a judge.
 */

/** Lower-case diagnostic keywords and runtime failure markers. */
export const DIAGNOSTIC_RE = /(?:\berror\b|ERR!|\bfail(?:ed|ure)?\b|\bpanic\b|Traceback|Exception|warning:|warn:)/iu;
/** `TypeError:`, `AssertionError`, `DeprecationWarning` — class names without a lower-case keyword. */
export const CLASS_DIAGNOSTIC_RE = /\b[A-Z][A-Za-z]*(?:Error|Exception|Warning)\b/u;
/** Log-level tags (`[WARN]`, `ERROR:`, `FATAL`). */
export const LEVEL_TAG_RE =
	/(?:\[(?:WARN|WARNING|ERROR|FATAL|CRITICAL|SEVERE)\]|\b(?:WARN|ERROR|FATAL|CRITICAL|SEVERE)\b(?=[:\s]))/u;
/** Test/check receipts: `12 pass`, `1 fail`, `3 errors`, `Command exited with code 2`, TAP/`PASS`/`FAIL` markers. */
export const VERIFICATION_RECEIPT_RE =
	/(?:\b\d+\s+(?:pass(?:ed|ing)?|fail(?:ed|ing|ures?)?|tests?|errors?|warnings?)\b|\bexit(?:ed)?\s+(?:code|status|with)\b|Command exited|^\s*(?:PASS|FAIL|ok|not ok)\b)/imu;

export function isDiagnosticLine(line: string): boolean {
	return DIAGNOSTIC_RE.test(line) || CLASS_DIAGNOSTIC_RE.test(line) || LEVEL_TAG_RE.test(line);
}

export function isVerificationReceiptLine(line: string): boolean {
	return VERIFICATION_RECEIPT_RE.test(line);
}

/** Whether any line of `text` is a diagnostic or a verification receipt. */
export function hasProtectedEvidence(text: string): boolean {
	let start = 0;
	while (start < text.length) {
		let end = text.indexOf("\n", start);
		if (end < 0) end = text.length;
		const line = text.slice(start, end);
		if (isDiagnosticLine(line) || isVerificationReceiptLine(line)) return true;
		start = end + 1;
	}
	return false;
}
