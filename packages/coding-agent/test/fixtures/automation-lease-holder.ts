import { withAutomationLease } from "@oh-my-pi/pi-coding-agent/tools/automation-policy";

const leaseFile = Bun.argv[2];
const readyFile = Bun.argv[3];
if (!leaseFile || !readyFile) throw new Error("expected lease and ready paths");

await withAutomationLease(
	{},
	async () => {
		await Bun.write(readyFile, String(process.pid));
		await new Promise<never>(() => undefined);
	},
	undefined,
	leaseFile,
);
