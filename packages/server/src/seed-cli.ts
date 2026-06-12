import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./db.js";
import { seed } from "./seed.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.SPECREG_DB ?? path.resolve(here, "../../..", "specregistry.db");
const db = createDb(dbPath);
console.log(seed(db) ? `Seeded ${dbPath}` : `Database already seeded: ${dbPath}`);
