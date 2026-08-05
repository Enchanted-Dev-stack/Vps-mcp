import { hash } from "@node-rs/argon2";
import { Database, migrate } from "@vps-mcp/db";
import { createApi } from "./app.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const db = new Database(databaseUrl);
await migrate(db.pool);

const adminUsername = process.env.PORTAL_ADMIN_USERNAME;
const adminPassword = process.env.PORTAL_ADMIN_PASSWORD;
if (adminUsername && adminPassword && !(await db.getPortalUserByUsername(adminUsername))) {
  await db.createPortalUser(adminUsername, await hash(adminPassword));
  console.log(`created portal admin ${adminUsername}`);
}

const app = createApi({ db, secureCookies: process.env.SECURE_COOKIES !== "false" });
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "3100");
await app.listen({ host, port });
console.log(`portal-api listening on ${host}:${port}`);

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
