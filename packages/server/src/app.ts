import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { Db } from "./db.js";
import { projectTypeRoutes } from "./routes/projectTypes.js";
import { specRoutes } from "./routes/specs.js";
import { reviewRoutes } from "./routes/reviews.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { stubPromptRoutes } from "./routes/stubPrompts.js";
import { adminRoutes } from "./routes/admin.js";
import { reindexAll } from "./lib/search.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
  }
}

export async function buildApp(db: Db, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  app.decorate("db", db);
  await app.register(cors, { origin: true });

  app.get("/api/v1/health", async () => ({ status: "ok" }));

  await app.register(projectTypeRoutes, { prefix: "/api/v1" });
  await app.register(specRoutes, { prefix: "/api/v1" });
  await app.register(reviewRoutes, { prefix: "/api/v1" });
  await app.register(feedbackRoutes, { prefix: "/api/v1" });
  await app.register(stubPromptRoutes, { prefix: "/api/v1" });
  await app.register(adminRoutes, { prefix: "/api/v1" });

  // Keep the FTS index in step with the database we were handed.
  reindexAll(db);

  return app;
}
