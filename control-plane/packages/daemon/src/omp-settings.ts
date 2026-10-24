/**
 * The daemon's one safe boundary around OMP's user configuration.
 *
 * It uses OMP's own Settings API for lock-aware, atomic configuration writes.
 * A gateway never reads or writes YAML itself, and credentials never cross this
 * boundary. Role assignments additionally resolve against the local OMP model
 * catalog before they are persisted, so an arbitrary string cannot make a role
 * fail only when an agent later needs it.
 */

import { Database } from "bun:sqlite";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { parseModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { getModelDbPath } from "@oh-my-pi/pi-utils";
import {
  getEnumValues,
  getType,
  isCredential,
  SETTINGS_SCHEMA,
  type SettingPath,
  type SettingValue,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import {
  OMP_MODEL_ROLES,
  type OmpModelRole,
  type OmpModelRoles,
  type OmpModelRolesResponse,
  type OmpModelRolesUpdate,
  type OmpSettingValue,
  type OmpSettingsResponse,
  type OmpSettingsUpdate,
  type OmpSettingsValues,
} from "@ompd/core";

const MANAGED_ROLE_SETTINGS: Partial<Record<SettingPath, true>> = { cycleOrder: true, modelRoles: true };

/** The gateway's dependency, kept structural so route tests never touch a real OMP home. */
export interface OmpSettingsController {
  readSettings(): Promise<OmpSettingsResponse>;
  updateSettings(update: OmpSettingsUpdate): Promise<OmpSettingsResponse>;
  readRoles(): Promise<OmpModelRolesResponse>;
  updateRoles(update: OmpModelRolesUpdate): Promise<OmpModelRolesResponse>;
}

export interface OmpSettingsOptions {
  /** OMP's agent configuration root. Defaults to the normal OMP user home. */
  agentDir?: string;
}

/** A per-request Settings instance prevents stale process caches from overwriting an external OMP edit. */
export class OmpSettings implements OmpSettingsController {
  readonly #agentDir: string | undefined;

  constructor(options: OmpSettingsOptions = {}) {
    this.#agentDir = options.agentDir;
  }

  async readSettings(): Promise<OmpSettingsResponse> {
    return { settings: settingsValues(await this.#readOnly()) };
  }

  async updateSettings(update: OmpSettingsUpdate): Promise<OmpSettingsResponse> {
    const entries = checkedSettingsEntries(update.settings);
    const settings = await this.#writable();
    for (const [path, value] of entries) {
      settings.set(path, value as SettingValue<typeof path>);
    }
    await settings.flush();
    return { settings: settingsValues(settings) };
  }

  async readRoles(): Promise<OmpModelRolesResponse> {
    return rolesResponse(await this.#readOnly());
  }

  async updateRoles(update: OmpModelRolesUpdate): Promise<OmpModelRolesResponse> {
    const roleEntries = checkedRoleEntries(update.roles);
    const cycleOrder = checkedCycleOrder(update.cycleOrder);
    const catalog = roleEntries.length === 0 ? null : this.#modelCatalog();
    for (const [, value] of roleEntries) {
      if (value !== null) validateModelRoleValue(value, catalog as ModelCatalog);
    }

    const settings = await this.#writable();
    for (const [role, value] of roleEntries) {
      settings.setModelRole(role, value ?? undefined);
    }
    if (cycleOrder !== undefined) {
      settings.set("cycleOrder", cycleOrder);
    }
    await settings.flush();
    return rolesResponse(settings);
  }

  #readOnly(): Promise<Settings> {
    return Settings.loadReadOnly({ agentDir: this.#agentDir });
  }

  #writable(): Promise<Settings> {
    return Settings.loadIsolated({ agentDir: this.#agentDir });
  }

  #modelCatalog(): ModelCatalog {
    const path = getModelDbPath(this.#agentDir);

    let database: Database | undefined;
    try {
      database = new Database(path, { readonly: true });
      const rows = database.query<{ provider_id: string; models: string }, []>("SELECT provider_id, models FROM model_cache").all();
      const models = new Set<string>();
      for (const row of rows) {
        const parsed: unknown = JSON.parse(row.models);
        if (!Array.isArray(parsed)) continue;
        for (const candidate of parsed) {
          if (!isModelRecord(candidate)) continue;
          models.add(`${row.provider_id}/${candidate.id}`);
        }
      }
      if (models.size === 0) {
        throw new Error("OMP model catalog contains no models; refresh it before changing role overrides");
      }
      return models;
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith("OMP model catalog")) throw cause;
      throw new Error(
        `OMP model catalog is unavailable; refresh OMP's model catalog before changing role overrides: ${describe(cause)}`,
      );
    } finally {
      database?.close();
    }
  }
}

type ModelCatalog = ReadonlySet<string>;

function isModelRecord(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value.id === "string";
}


function settingsValues(settings: Settings): OmpSettingsValues {
  const values: OmpSettingsValues = {};
  for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
    if (isCredential(path) || MANAGED_ROLE_SETTINGS[path] === true) continue;
    const value = toSettingValue(settings.get(path));
    if (value !== undefined) values[path] = value;
  }
  return values;
}

function checkedSettingsEntries(values: OmpSettingsValues): Array<[SettingPath, OmpSettingValue]> {
  if (!isRecord(values) || Object.keys(values).length === 0) {
    throw new Error("settings must be a non-empty object");
  }

  const entries: Array<[SettingPath, OmpSettingValue]> = [];
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(SETTINGS_SCHEMA, key)) throw new Error(`unknown OMP setting: ${key}`);
    const path = key as SettingPath;
    if (isCredential(path)) throw new Error(`credential setting ${key} cannot be read or changed through ompd`);
    if (MANAGED_ROLE_SETTINGS[path] === true) {
      throw new Error(`${key} is managed by the OMP roles endpoint`);
    }
    validateSettingValue(path, value);
    entries.push([path, value]);
  }
  return entries;
}

function validateSettingValue(path: SettingPath, value: OmpSettingValue): void {
  switch (getType(path)) {
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
      return;
    case "string":
      if (typeof value !== "string") throw new Error(`${path} must be a string`);
      return;
    case "enum": {
      const values = getEnumValues(path);
      if (typeof value !== "string" || values === undefined || !values.includes(value)) {
        throw new Error(`${path} must be one of ${values?.join(", ") ?? "the configured values"}`);
      }
      return;
    }
    case "array":
      if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
      return;
    case "record":
      if (!isRecord(value)) throw new Error(`${path} must be an object`);
      return;
    default:
      throw new Error(`OMP setting ${path} has an unsupported schema type`);
  }
}

function rolesResponse(settings: Settings): OmpModelRolesResponse {
  const roles = Object.fromEntries(
    OMP_MODEL_ROLES.map((role) => [role, settings.getModelRole(role) ?? null]),
  ) as OmpModelRoles;
  const cycleOrder = settings
    .get("cycleOrder")
    .filter(isOmpModelRole)
    .filter((role, index, all) => all.indexOf(role) === index);
  return { roles, cycleOrder };
}

function checkedRoleEntries(roles: OmpModelRolesUpdate["roles"]): Array<[OmpModelRole, string | null]> {
  if (roles === undefined) return [];
  if (!isRecord(roles) || Object.keys(roles).length === 0) {
    throw new Error("roles must be a non-empty object when supplied");
  }

  const entries: Array<[OmpModelRole, string | null]> = [];
  for (const [role, value] of Object.entries(roles)) {
    if (!isOmpModelRole(role)) throw new Error(`unknown OMP model role: ${role}`);
    if (value !== null && (typeof value !== "string" || value.trim().length === 0)) {
      throw new Error(`model override for ${role} must be a non-empty string or null`);
    }
    entries.push([role, value]);
  }
  return entries;
}

function checkedCycleOrder(cycleOrder: OmpModelRolesUpdate["cycleOrder"]): OmpModelRole[] | undefined {
  if (cycleOrder === undefined) return undefined;
  if (!Array.isArray(cycleOrder) || cycleOrder.length === 0 || !cycleOrder.every(isOmpModelRole)) {
    throw new Error("cycleOrder must be a non-empty list of supported OMP model roles");
  }
  if (new Set(cycleOrder).size !== cycleOrder.length) throw new Error("cycleOrder must not repeat a model role");
  return [...cycleOrder];
}

function validateModelRoleValue(value: string, catalog: ModelCatalog): void {
  for (const selector of value.split(",").map((entry) => entry.trim())) {
    if (catalog.has(selector)) continue;
    const parsed = parseModelString(selector, {
      isLiteralModelId: (provider, id) => catalog.has(`${provider}/${id}`),
    });
    if (parsed === undefined || !catalog.has(`${parsed.provider}/${parsed.id}`)) {
      throw new Error(`model override ${JSON.stringify(selector)} is not in the local OMP model catalog`);
    }
  }
}

function toSettingValue(value: unknown): OmpSettingValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items = value.map(toSettingValue);
    return items.every((item): item is OmpSettingValue => item !== undefined) ? items : undefined;
  }
  if (!isRecord(value)) return undefined;
  const record: Record<string, OmpSettingValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const serialized = toSettingValue(item);
    if (serialized !== undefined) record[key] = serialized;
  }
  return record;
}

function isOmpModelRole(value: unknown): value is OmpModelRole {
  return typeof value === "string" && (OMP_MODEL_ROLES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, OmpSettingValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
