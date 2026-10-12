/**
 * Shared credential-marked settings.
 *
 * When `OMP_SHARED_SECRETS_FILE` names a config overlay (the channel launchers
 * export it and list it last in `PI_CONFIG_FILES`), every write to a
 * credential-marked setting lands in that file instead of the profile config,
 * so one `config set` / settings-panel edit is the effective value in every
 * channel that loads the same overlay. Unset when the variable is absent: the
 * write stays profile-local as upstream does.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { stringifyYamlConfig } from "@oh-my-pi/pi-utils/yaml-config";
import { YAML } from "bun";
import { replaceFileAtomically } from "../utils/atomic-file";

const HEADER = `# Shared credential-marked settings (written by omp; hand-edits are preserved on the next write).
# This file is the second PI_CONFIG_FILES overlay of every omp channel launcher: a key here is the
# effective value in omp, ompd and ompdev. Keep it 0600.
`;

type Tree = Record<string, unknown>;

export function sharedSecretsFilePath(): string | undefined {
	const value = process.env.OMP_SHARED_SECRETS_FILE?.trim();
	return value ? value : undefined;
}

function isTree(value: unknown): value is Tree {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readTree(file: string): Promise<Tree> {
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (error) {
		if (isEnoent(error)) return {};
		throw error;
	}
	const parsed: unknown = YAML.parse(text);
	if (parsed === null || parsed === undefined) return {};
	if (!isTree(parsed)) throw new Error(`Shared secrets overlay must be a YAML mapping: ${file}`);
	return parsed;
}

/** Set (or delete when `value` is undefined) one dotted key in the shared overlay, atomically, mode 0600. */
export async function writeSharedSecret(file: string, dottedKey: string, value: unknown): Promise<void> {
	const tree = await readTree(file);
	const segments = dottedKey.split(".");
	const stack: Tree[] = [tree];
	for (let i = 0; i < segments.length - 1; i++) {
		const parent = stack[stack.length - 1]!;
		const child = parent[segments[i]!];
		if (!isTree(child)) {
			if (value === undefined) break;
			const created: Tree = {};
			parent[segments[i]!] = created;
			stack.push(created);
			continue;
		}
		stack.push(child);
	}
	const leaf = segments[segments.length - 1]!;
	if (stack.length === segments.length) {
		const owner = stack[stack.length - 1]!;
		if (value === undefined) delete owner[leaf];
		else owner[leaf] = value;
		// Drop containers emptied by a delete so the overlay does not accumulate `{}` shells.
		for (let i = stack.length - 1; i > 0; i--) {
			if (Object.keys(stack[i]!).length === 0) delete stack[i - 1]![segments[i - 1]!];
			else break;
		}
	}
	const body = Object.keys(tree).length === 0 ? "" : stringifyYamlConfig(tree);
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.tmp.${process.pid}.${Date.now()}`;
	await fs.writeFile(temp, HEADER + body, { mode: 0o600 });
	await fs.chmod(temp, 0o600);
	await replaceFileAtomically(temp, file);
}
