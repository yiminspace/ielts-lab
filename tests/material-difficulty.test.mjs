import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadLibrary } from "../services/api/library.mjs";

test("archive difficulty preserves zero and all supported values in catalog and detail", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-difficulty-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "data/整理/听力");
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(path.join(root, "data/media"), { recursive: true });
  const values = [0, 1, 2, 3, undefined, null, "1", -1, 4, 1.5];
  for (const [index, difficulty] of values.entries()) {
    await fs.writeFile(
      path.join(directory, `${index}.json`),
      JSON.stringify({
        title: `Original difficulty fixture ${index}`,
        data: { difficulty, questions: [] },
      }),
    );
  }
  const library = await loadLibrary({ archiveRoot: root });
  for (const [index, difficulty] of values.entries()) {
    const item = library.publicLibrary.items.find(
      (item) => item.title === `Original difficulty fixture ${index}`,
    );
    const expected = index < 4 ? difficulty : undefined;
    assert.equal(item.difficulty, expected);
    assert.equal((await library.getItem(item.id)).difficulty, expected);
  }
});
