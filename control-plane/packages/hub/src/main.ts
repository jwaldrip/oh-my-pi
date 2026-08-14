/**
 * The hub's entry point.
 *
 * Everything it needs comes from the environment, because the thing that runs
 * it is a container with no command line worth speaking of. Two of the three
 * are required and the process refuses to start without them rather than
 * falling back to something quieter and worse.
 */

import { RedisClient } from "bun";
import { randomBytes } from "node:crypto";
import { consoleAudit } from "./audit.ts";
import { Hub } from "./hub.ts";
import { RedisBackplane } from "./redis-backplane.ts";
import { MemoryBackplane, MemoryBus } from "./backplane.ts";
import { MemoryRegistry, StoredRegistry, type RegistryStore } from "./registry.ts";

const redisUrl = process.env.OMPD_HUB_REDIS_URL;
const operatorToken = process.env.OMPD_HUB_OPERATOR_TOKEN;
const port = Number(process.env.PORT ?? 8080);

if (operatorToken === undefined || operatorToken.length === 0) {
  // Without it the enrollment routes are closed and no daemon can ever join,
  // which is a hub that looks healthy and does nothing. Better to say so now.
  console.error("OMPD_HUB_OPERATOR_TOKEN is required; without it no daemon can enroll");
  process.exit(2);
}

/**
 * Stable for the life of the process and unique across instances.
 *
 * Cloud Run offers no instance id to the container, and two instances sharing
 * one would each receive the other's envelopes.
 */
const instanceId = `inst_${randomBytes(8).toString("hex")}`;

const { backplane, registry } = await (async () => {
  if (redisUrl === undefined || redisUrl.length === 0) {
    // Single process, nothing shared. Correct only when exactly one instance
    // ever runs, so it is a development convenience and says so out loud.
    console.warn("OMPD_HUB_REDIS_URL is unset: running single-instance with in-memory routing");
    return { backplane: new MemoryBackplane(new MemoryBus(), instanceId), registry: new MemoryRegistry() };
  }
  const redis = await RedisBackplane.connect({ url: redisUrl, instanceId });
  const client = new RedisClient(redisUrl);
  await client.connect();
  const store: RegistryStore = {
    get: (key) => client.get(key),
    set: async (key, value) => {
      await client.set(key, value);
    },
    del: (key) => client.del(key),
    keys: (pattern) => client.keys(pattern),
  };
  return { backplane: redis, registry: new StoredRegistry(store) };
})();

const hub = new Hub({ registry, backplane, operatorToken, port, audit: consoleAudit });
const bound = await hub.listen();
console.log(JSON.stringify({ severity: "INFO", message: "hub listening", port: bound, instanceId }));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void hub.stop().then(() => process.exit(0));
  });
}
