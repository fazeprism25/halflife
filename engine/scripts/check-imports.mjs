// Imports every engine module except main.ts to catch syntax/type-stripping errors early.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const dir = path.resolve(import.meta.dirname, "../src");
let bad = 0;
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "main.ts")) {
  try { await import(pathToFileURL(path.join(dir, f)).href); }
  catch (e) { bad++; console.error(`${f}: ${e.message}`); }
}
console.log(bad ? `${bad} module(s) failed` : "all modules import cleanly");
process.exit(bad ? 1 : 0);
