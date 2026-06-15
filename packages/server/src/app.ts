import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { Db } from "./db.js";
import { projectTypeRoutes } from "./routes/projectTypes.js";
import { specRoutes } from "./routes/specs.js";
import { reviewRoutes } from "./routes/reviews.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { stubPromptRoutes } from "./routes/stubPrompts.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { integrationRoutes } from "./routes/integrations.js";
import { metricsRoutes } from "./routes/metrics.js";
import { registerAuth } from "./lib/auth.js";
import { reindexAll } from "./lib/search.js";
import { getPublicKey } from "./lib/sign.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
  }
}

export interface AppOptions {
  logger?: boolean;
  /** Require a token on every non-public route. Defaults to SPECREG_AUTH=required. */
  authRequired?: boolean;
}

export async function buildApp(db: Db, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  app.decorate("db", db);
  await app.register(cors, { origin: true });
  registerAuth(app, { authRequired: opts.authRequired ?? process.env.SPECREG_AUTH === "required" });

  app.get("/api/v1/health", async () => ({ status: "ok" }));
  app.get("/api/v1/meta/public-key", async () => ({ algorithm: "ed25519", public_key: getPublicKey(db) }));
  await app.register(metricsRoutes);

  await app.register(projectTypeRoutes, { prefix: "/api/v1" });
  await app.register(specRoutes, { prefix: "/api/v1" });
  await app.register(reviewRoutes, { prefix: "/api/v1" });
  await app.register(feedbackRoutes, { prefix: "/api/v1" });
  await app.register(stubPromptRoutes, { prefix: "/api/v1" });
  await app.register(adminRoutes, { prefix: "/api/v1" });
  await app.register(authRoutes, { prefix: "/api/v1" });
  await app.register(integrationRoutes, { prefix: "/api/v1" });

  // Keep the FTS index in step with the database we were handed.
  reindexAll(db);

  return app;
}
