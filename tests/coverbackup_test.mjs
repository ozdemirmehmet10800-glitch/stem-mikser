// Kapak yedeği (js/coverbackup.js): biçim, doğrulama, tehlikeli girdiler.   node tests\coverbackup_test.mjs

import { encodeBackup, parseBackup, BACKUP_KIND, COVER_B64_MAX, BACKUP_MAX_COVERS } from "../frontend/js/coverbackup.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const ID = "a".repeat(64);
const text = encodeBackup([
  { id: ID, source: "user", mime: "image/jpeg", data: "QUJD" },
  { id: "b".repeat(64), source: "found", mime: "image/png", data: "REVG" },
  { id: "c".repeat(64), source: "embedded", mime: "image/jpeg", data: "QUJD" },
  { id: "../x", source: "user", mime: "image/jpeg", data: "QUJD" },
  { id: "d".repeat(64), source: "user", mime: "text/html", data: "QUJD" },
  { id: "e".repeat(64), source: "user", mime: "image/jpeg", data: "<script>" },
], 0);
const parsed = parseBackup(text);
check("encode: yalnız user/found, geçerli kimlik/mime/base64", parsed.ok && parsed.entries.length === 2 && parsed.entries.every((e) => e.source === "user" || e.source === "found"), JSON.stringify(parsed.entries.map((e) => e.id.slice(0, 2))));
check("gömülü kapak yedeğe girmez", !parsed.entries.some((e) => e.id.startsWith("c")));
check("biçim: v1 + kind", JSON.parse(text).v === 1 && JSON.parse(text).kind === BACKUP_KIND);
check("parse: bozuk JSON / yanlış biçim / çok büyük", parseBackup("{x").error === "json" && parseBackup("{\"v\":1}").error === "format" && parseBackup("[]").error === "format" && parseBackup(null).error === "size" && parseBackup("x".repeat(17 * 1024 * 1024)).error === "size");
const evil = JSON.stringify({ v: 1, kind: BACKUP_KIND, covers: {
  ok1: { source: "user", mime: "image/webp", data: "QUJD" },
  "../etc": { source: "user", mime: "image/jpeg", data: "QUJD" },
  bad1: { source: "user", mime: "image/svg+xml", data: "QUJD" },
  bad2: { source: "root", mime: "image/jpeg", data: "QUJD" },
  bad3: { source: "user", mime: "image/jpeg", data: "A".repeat(COVER_B64_MAX + 1) },
  bad4: null,
  bad5: { source: "user", mime: "image/jpeg", data: "javascript:alert(1)" },
} });
const e = parseBackup(evil);
check("parse: svg/geçersiz kaynak/aşırı büyük/yol/null/base64 değil -> atlanır, geçerli kalır", e.ok && e.entries.length === 1 && e.entries[0].id === "ok1" && e.skipped === 6, `${e.entries.length}/${e.skipped}`);
const many = JSON.stringify({ v: 1, kind: BACKUP_KIND, covers: Object.fromEntries(Array.from({ length: BACKUP_MAX_COVERS + 20 }, (_, i) => [`s${i}`, { source: "user", mime: "image/jpeg", data: "QUJD" }])) });
check(`parse: en çok ${BACKUP_MAX_COVERS} kapak`, parseBackup(many).entries.length === BACKUP_MAX_COVERS && parseBackup(many).skipped === 20);
check("__proto__ anahtarı belgeyi bozmaz", (() => { const r = parseBackup("{\"v\":1,\"kind\":\"" + BACKUP_KIND + "\",\"covers\":{\"__proto__\":{\"source\":\"user\",\"mime\":\"image/jpeg\",\"data\":\"QUJD\"}}}"); return r.ok && ({}).source === undefined; })());

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
