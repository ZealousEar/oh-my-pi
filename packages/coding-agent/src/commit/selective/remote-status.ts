/**
 * Whether a commit made by the selective commit flow is on a remote yet.
 *
 * The flow never pushes, so a fresh commit is normally local only. Callers print this status
 * with every commit so "committed" is never mistaken for "on the remote". It reads
 * remote-tracking refs as of the last fetch and makes no network calls.
 */
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";

/** Where a commit stands against the remote-tracking refs. */
export interface RemoteStatus {
	/** The commit is reachable from {@link RemoteStatus.against}. */
	pushed: boolean;
	/** Commits reachable from the commit but not from `against`; `null` when there is nothing to compare with. */
	unpushed: number | null;
	/** Branch the commit landed on; `null` on a detached HEAD. */
	branch: string | null;
	/** The branch's configured upstream (`origin/main`), when it exists locally. */
	upstream: string | null;
	/** Remote-tracking branch the count is taken against: the upstream, else the remote's default branch. */
	against: string | null;
	/** The repository has at least one remote. */
	hasRemote: boolean;
}

const HEADS_PREFIX = "refs/heads/";

/** Configured upstream of `branch` as `<remote>/<branch>`, when its remote-tracking ref exists. */
async function upstreamOf(repo: VcsGitRepo, branch: string): Promise<string | null> {
	const [remote, merge] = await Promise.all([
		repo.configGet(`branch.${branch}.remote`),
		repo.configGet(`branch.${branch}.merge`),
	]);
	if (!remote || remote === "." || !merge?.startsWith(HEADS_PREFIX)) return null;
	const upstream = `${remote}/${merge.slice(HEADS_PREFIX.length)}`;
	return (await repo.refExists(`refs/remotes/${upstream}`)) ? upstream : null;
}

/** Compare `sha` against the branch's upstream, else the remote default branch (`origin/HEAD`). */
export async function remoteStatus(repo: VcsGitRepo, sha: string, branch: string | null): Promise<RemoteStatus> {
	const hasRemote = (await repo.remoteList()).length > 0;
	if (!hasRemote) return { pushed: false, unpushed: null, branch, upstream: null, against: null, hasRemote };
	const upstream = branch ? await upstreamOf(repo, branch) : null;
	let against = upstream;
	if (!against) {
		const fallback = await repo.defaultBranch();
		if (fallback && (await repo.refExists(`refs/remotes/origin/${fallback}`))) against = `origin/${fallback}`;
	}
	if (!against) return { pushed: false, unpushed: null, branch, upstream, against, hasRemote };
	const unpushed = (await repo.revListRange(`refs/remotes/${against}`, sha)).length;
	return { pushed: unpushed === 0, unpushed, branch, upstream, against, hasRemote };
}

/** One status line: `PUSHED: …` or `LOCAL ONLY: …`; always says nothing was pushed by this call. */
export function formatRemoteStatus(status: RemoteStatus): string {
	const where = status.branch ?? "detached HEAD";
	if (status.pushed) return `PUSHED: already on ${status.against} (as of the last fetch).`;
	const upstream = `upstream: ${status.upstream ?? "none"}`;
	if (!status.hasRemote) return `LOCAL ONLY: ${where} is in a repository with no remote. Nothing was pushed.`;
	if (status.unpushed === null) {
		return `LOCAL ONLY: ${where} has no upstream and no remote default branch to compare with. Nothing was pushed.`;
	}
	const commits = status.unpushed === 1 ? "1 commit" : `${status.unpushed} commits`;
	return `LOCAL ONLY: ${commits} on ${where} not on ${status.against} (${upstream}). Nothing was pushed.`;
}
