/**
 * The skills catalogue.
 *
 * Discovery is not reimplemented here. `discoverSkills` and
 * `discoverSlashCommands` are upstream's own resolution of every plugin,
 * marketplace cache entry, and project- or user-level file that can supply a
 * `/name`-invoked workflow; this module only reshapes their result into the
 * wire-safe `SkillSummary` and reports where each one came from, since a user
 * with dozens of plugins needs to know which one owns which skill.
 */

import { discoverSkills, discoverSlashCommands, type FileSlashCommand, type Skill } from "@oh-my-pi/pi-coding-agent";
import type { SkillSummary, WorkspaceSourceLevel } from "@ompd/core";

/**
 * A marketplace cache entry (`.../plugins/cache/<marketplace>/<pluginName>/...`)
 * or an installed plugin root (`.../plugins/<pluginName>/...`) names the
 * plugin in its path. `providerName` on the upstream source names the loading
 * *mechanism* (e.g. "Claude Code Marketplace"), not the plugin, so a client
 * grouping skills by plugin has nothing else to key on. Returns `undefined`
 * rather than a guess when the path does not match either shape -- a bare
 * project- or user-level skill file genuinely has no plugin.
 */
function pluginNameFromPath(path: string | undefined): string | undefined {
	if (path === undefined) return undefined;
	const cacheMatch = /[/\\]plugins[/\\]cache[/\\][^/\\]+[/\\]([^/\\]+)[/\\]/.exec(path);
	if (cacheMatch?.[1] !== undefined) return cacheMatch[1];
	const pluginMatch = /[/\\]plugins[/\\]([^/\\]+)[/\\]/.exec(path);
	return pluginMatch?.[1];
}

function skillLevel(value: string | undefined): WorkspaceSourceLevel | undefined {
	return value === "user" || value === "project" || value === "native" ? value : undefined;
}

function summarizeSkill(skill: Skill): SkillSummary {
	const source = skill._source;
	const pluginName = pluginNameFromPath(source?.path);
	return {
		name: skill.name,
		description: skill.description,
		kind: "skill",
		source: skill.source,
		...(source?.providerName === undefined ? {} : { providerName: source.providerName }),
		...(skillLevel(source?.level) === undefined ? {} : { level: skillLevel(source?.level) }),
		...(pluginName === undefined ? {} : { pluginName }),
	};
}

/**
 * `FileSlashCommand._source` carries no path (unlike `Skill._source`), so
 * there is no plugin-name signal available for commands at all -- `source`
 * (e.g. "via Claude Code (User)") names the loading mechanism, same as
 * `providerName` does for a skill, and nothing here names a specific plugin.
 */
function summarizeCommand(command: FileSlashCommand): SkillSummary {
	const source = command._source;
	return {
		name: command.name,
		description: command.description,
		kind: "command",
		source: command.source,
		...(source?.providerName === undefined ? {} : { providerName: source.providerName }),
		...(skillLevel(source?.level) === undefined ? {} : { level: skillLevel(source?.level) }),
	};
}

/**
 * Merge upstream's skills and slash commands into one catalogue, sorted by
 * name so pagination and diffing are stable across calls. `cwd` scopes
 * discovery exactly as it would for a running agent working in that
 * directory; omitted, upstream falls back to its own project-directory
 * default.
 *
 * `discoverSkillsFn`/`discoverCommandsFn` default to the real upstream calls;
 * a test supplies stand-ins, the same seam `listConnectorCatalog` and
 * `Supervisor.spawnHost` use for the same reason.
 */
export async function listSkillCatalog(
	cwd?: string,
	discoverSkillsFn: typeof discoverSkills = discoverSkills,
	discoverCommandsFn: typeof discoverSlashCommands = discoverSlashCommands,
): Promise<SkillSummary[]> {
	const [{ skills }, commands] = await Promise.all([discoverSkillsFn(cwd), discoverCommandsFn({ cwd })]);
	const summaries = [...skills.map(summarizeSkill), ...commands.map(summarizeCommand)];
	summaries.sort((a, b) => a.name.localeCompare(b.name));
	return summaries;
}
