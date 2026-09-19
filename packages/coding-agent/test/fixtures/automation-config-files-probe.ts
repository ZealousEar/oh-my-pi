/**
 * Child-process probe for the `PI_CONFIG_FILES` provenance regression: loads
 * read-only settings for the launch cwd and prints how many automation scopes
 * the trusted capability view yields, plus the effective `browser.relay` and
 * the raw grants list.
 */
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getAutomationScopes } from "@oh-my-pi/pi-coding-agent/tools/automation-policy";

const settings = await Settings.loadReadOnly({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR });
const scopes = getAutomationScopes({ settings }, Date.now()).length;
process.stdout.write(
	`${JSON.stringify({ scopes, relay: settings.get("browser.relay"), grants: settings.get("browser.permissions.grants") })}\n`,
);
