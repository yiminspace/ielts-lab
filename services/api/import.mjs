import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateArchive, loadLibrary, tally } from "./library.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export function importSummary(library) {
  const items = library.publicLibrary.items.filter(
    (item) => item.source === "archive",
  );
  if (!items.length) throw new Error("此目录没有可导入的学习材料");
  return {
    count: items.length,
    counts: tally(items),
    originalItems: library.publicLibrary.items.length - items.length,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const supplied = process.argv[2];
  if (!supplied || !path.isAbsolute(supplied)) {
    console.error("用法: npm run import -- /absolute/path/to/archive-root");
    process.exitCode = 1;
  } else {
    try {
      const archiveRoot = await validateArchive(supplied);
      const library = await loadLibrary({ archiveRoot });
      const summary = importSummary(library);
      const target = path.join(root, "config.local.json");
      const temporary = `${target}.${process.pid}.tmp`;
      await fs.writeFile(
        temporary,
        JSON.stringify({ archiveRoot }, null, 2) + "\n",
        { mode: 0o600 },
      );
      await fs.rename(temporary, target);
      await fs.mkdir(path.join(root, ".local"), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(
        path.join(root, ".local/import-report.json"),
        JSON.stringify(
          {
            importedAt: new Date().toISOString(),
            mode: library.mode,
            ...summary,
            issues: library.publicLibrary.issues,
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
      console.log(
        JSON.stringify(
          {
            importedItems: summary.count,
            counts: summary.counts,
            originalItems: summary.originalItems,
            issues: library.publicLibrary.issues,
            config: "config.local.json",
            contentCopied: false,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error("导入失败:", error.message);
      process.exitCode = 1;
    }
  }
}
