import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function issueFile(root, directory, number) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid issue number");
  return path.join(root, directory, number + ".json");
}

export async function readOptionalJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function writeDurableJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
}

export async function removeOptionalFile(file) {
  try { await fs.unlink(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
