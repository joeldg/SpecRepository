import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import { buildApp } from "./app.js";
import { createDb } from "./db.js";
import { loadServerEnv } from "./env.js";
import { assertSecurePosture } from "./lib/auth.js";
import { seed } from "./seed.js";

loadServerEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.SPECREG_DB ?? path.resolve(here, "../../..", "specregistry.db");
const port = Number(process.env.PORT ?? 4000);

const db = createDb(dbPath);
if (seed(db)) {
  console.log("Seeded database with Acme demo configuration");
}

// Secured deployments must not run with the default admin password.
const authRequired = process.env.SPECREG_AUTH === "required";
try {
  assertSecurePosture(db, { authRequired });
} catch (err) {
  console.error(`\nFATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
if (authRequired) {
  console.log("SpecRegistry running in secured mode (SPECREG_AUTH=required).");
}

const app = await buildApp(db, { logger: true });

// Serve the built web UI when it exists (production mode); Vite dev server proxies otherwise.
const webDist = path.resolve(here, "../../web/dist");
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      reply.code(404).send({ error: "Not found" });
    } else {
      reply.sendFile("index.html");
    }
  });
}

await app.listen({ port, host: "0.0.0.0" });
console.log(`SpecRegistry API listening on http://localhost:${port}`);
