// Tüm yerel testleri sırayla koşturur (node *_test.mjs + Python test_*.py). Modal'a / ağa bağlanmaz.
//   node tests\run_all.mjs            (hepsi)
//   node tests\run_all.mjs --node     (yalnız node testleri)
// Çıkış kodu: hepsi geçtiyse 0, değilse 1. Python yolu: .venv\Scripts\python.exe (yoksa `python`).

import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = path.resolve(here, "..");
const onlyNode = process.argv.includes("--node");
const venvPython = path.join(root, ".venv", "Scripts", "python.exe");
const python = existsSync(venvPython) ? venvPython : "python";

const files = readdirSync(here).sort();
const jobs = [
  ...files.filter((f) => f.endsWith("_test.mjs")).map((f) => ({ file: f, cmd: process.execPath, args: [path.join(here, f)] })),
  ...(onlyNode ? [] : files.filter((f) => /^test_.*\.py$/.test(f)).map((f) => ({ file: f, cmd: python, args: [path.join(here, f)] }))),
];

let failed = 0;
for (const job of jobs) {
  const run = spawnSync(job.cmd, job.args, {
    cwd: root, encoding: "utf8", timeout: 600000, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
  const ok = run.status === 0;
  if (!ok) failed += 1;
  const last = String(run.stdout || "").trim().split(/\r?\n/).pop() || String(run.stderr || "").trim().split(/\r?\n/).pop() || "";
  console.log(`${ok ? "ok  " : "FAIL"} ${job.file}  ${last.slice(0, 90)}`);
}
console.log(failed ? `\n${failed} / ${jobs.length} test dosyası BAŞARISIZ` : `\n${jobs.length} test dosyasının hepsi geçti`);
process.exit(failed ? 1 : 0);
