import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresStore } from "../postgres.mjs";

export async function importLegacyProgress({
  file,
  mode,
  userId,
  connectionString,
} = {}) {
  if (!file || !path.isAbsolute(file))
    throw new Error("Use an absolute path to a legacy progress JSON file");
  if (!["archive", "demo"].includes(mode))
    throw new Error("Explicitly choose archive or demo mode");
  const stat = await fs.stat(file);
  if (stat.size > 5 * 1024 * 1024)
    throw new Error("Legacy progress file exceeds 5 MiB");
  const progress = JSON.parse(await fs.readFile(file, "utf8"));
  const store = new PostgresStore({ connectionString, ownerUserId: userId });
  await store.init();
  try {
    return await store.importProgress(userId, mode, progress);
  } finally {
    await store.close();
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await importLegacyProgress({
      file: process.argv[2],
      mode: process.argv[3],
      userId: process.env.OWNER_USER_ID,
      connectionString: process.env.DATABASE_URL,
    });
    console.log(JSON.stringify(result));
  } catch {
    console.error(
      "Progress import failed. Check input format, explicit mode, owner identity and database configuration.",
    );
    process.exitCode = 1;
  }
}
