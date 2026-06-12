import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import { buildApp } from "./app.js";
import { createDb } from "./db.js";
import { seed } from "./seed.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.SPECREG_DB ?? path.resolve(here, "../../..", "specregistry.db");
const port = Number(process.env.PORT ?? 4000);

const db = createDb(dbPath);
if (seed(db)) {
  console.log("Seeded database with Thinkom demo configuration");
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
