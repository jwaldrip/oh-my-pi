/**
 * The Cowork wire contract.
 *
 * `SkillSummary`, `ConnectorSummary`, `Task`, `TaskState`, `ConnectorStatus`,
 * and `WorkspaceSourceLevel` are CoworkSurface's landed types in
 * `@ompd/core/contracts` (routes `GET /v1/skills`, `GET /v1/connectors`,
 * `GET|POST /v1/tasks` in control-plane/packages/daemon). This file used to
 * carry a local mirror of that contract, written while `contracts.ts` was
 * still mid-flight; now that it has landed, every type below is a re-export,
 * not a copy, so this module can never drift from the real one.
 *
 * Two provenance gaps remain, both confirmed with CoworkSurface rather than
 * guessed at:
 *
 * `pluginName` is server-derived from the marketplace cache path
 * (`…/plugins/cache/<marketplace>/<pluginName>/…`) and is `undefined` for
 * anything not installed as a plugin package — a bare project-local skill
 * file, a project `.mcp.json` entry. That absence is the honest answer.
 *
 * There is no field distinguishing "the org's own marketplace" from a public
 * one: no marketplace-allowlist concept exists anywhere in this codebase. The
 * `PluginOrigin` split `deriveOrigin` computes in `catalog.ts` is the
 * coarser, honestly grounded three-way distinction the contract *can*
 * support today: OMP itself, an installed plugin package (any marketplace),
 * or unpackaged local config.
 */

export type {
  ConnectorStatus,
  ConnectorSummary,
  SkillKind,
  SkillSummary,
  Task,
  TaskState,
  WorkspaceSourceLevel,
} from "@ompd/core/contracts";
export { TERMINAL_TASK_STATES } from "@ompd/core/contracts";
