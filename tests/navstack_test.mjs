// Katman yiginin testi (geri tusu mantigi). DOM ve history yok, saf mantik.
//
//     node tests\navstack_test.mjs

import { NavStack, CLOSE, BLOCKED, EXIT } from "../frontend/js/navstack.js";

const passed = [];
const failed = [];

function check(name, condition, detail = "") {
  (condition ? passed : failed).push(name);
  console.log(`[${condition ? "OK  " : "HATA"}] ${name}${detail ? `  -> ${detail}` : ""}`);
}

function testEmpty() {
  const nav = new NavStack();
  check("bos yiginda derinlik 0", nav.depth === 0);
  check("bos yiginda peek null", nav.peek() === null);
  const result = nav.back();
  check("bos yiginda geri = cikis", result.action === EXIT, result.action);
  check("cikis yigini bozmuyor", nav.depth === 0);
}

function testOrder() {
  // Gercek senaryo: mikser acik, panel acik, indirme menusu acik.
  const nav = new NavStack();
  nav.push("view");
  nav.push("panel");
  nav.push("menu");
  check("derinlik 3", nav.depth === 3, String(nav.depth));
  check("once menu kapaniyor", nav.back().layer === "menu");
  check("sonra panel", nav.back().layer === "panel");
  check("sonra ekran", nav.back().layer === "view");
  check("sonra cikis", nav.back().action === EXIT);
}

function testNoDuplicate() {
  // Tempo paneli acikken metronom paneline gecmek YENI katman degil.
  const nav = new NavStack();
  check("ilk push true", nav.push("panel") === true);
  check("ayni ad ikinci kez false", nav.push("panel") === false);
  check("derinlik hala 1", nav.depth === 1, String(nav.depth));
  nav.push("menu");
  check("derinlik 2", nav.depth === 2);
  check("araya girmis ad da tekrar eklenmiyor", nav.push("panel") === false);
  check("derinlik yine 2", nav.depth === 2, String(nav.depth));
  check("bos ad eklenmiyor", nav.push("") === false && nav.push(null) === false);
}

function testBlocked() {
  // Yukleme ortusu acikken geri HICBIR SEY yapmamali, yukleme iptal olmamali.
  const nav = new NavStack();
  nav.push("view");
  nav.block("overlay");
  const result = nav.back();
  check("engelliyken BLOCKED", result.action === BLOCKED, result.action);
  check("engelliyken yigin bozulmuyor", nav.depth === 1, String(nav.depth));
  check("blocked bayragi", nav.blocked === true);

  // Iki engel ust uste: biri kalkinca oteki hala tutuyor.
  nav.block("align");
  nav.unblock("overlay");
  check("ikinci engel surerken hala BLOCKED", nav.back().action === BLOCKED);
  nav.unblock("align");
  check("engeller bitince blocked false", nav.blocked === false);
  check("engel kalkinca katman kapaniyor", nav.back().layer === "view");
}

function testUnknownUnblock() {
  const nav = new NavStack();
  nav.unblock("olmayan");
  check("olmayan engeli kaldirmak zararsiz", nav.blocked === false);
  nav.block("a");
  nav.block("a");
  nav.unblock("a");
  check("ayni engel iki kez eklenince tek sayiliyor", nav.blocked === false);
}

function testHasAndReset() {
  const nav = new NavStack();
  nav.push("select");
  check("has dogru", nav.has("select") && !nav.has("view"));
  check("peek dogru", nav.peek() === "select");
  nav.block("overlay");
  nav.reset();
  check("reset yigini bosaltiyor", nav.depth === 0);
  check("reset engelleri de bosaltiyor", nav.blocked === false);
  check("reset sonrasi geri = cikis", nav.back().action === EXIT);
}

function testSelectFlow() {
  // Kutuphanede secim modu: geri secimden cikariyor, ikinci geri uygulamadan.
  const nav = new NavStack();
  nav.push("select");
  const first = nav.back();
  check("geri once secimden cikariyor",
        first.action === CLOSE && first.layer === "select", first.layer);
  check("ikinci geri cikis", nav.back().action === EXIT);
}

for (const test of [testEmpty, testOrder, testNoDuplicate, testBlocked,
                    testUnknownUnblock, testHasAndReset, testSelectFlow]) {
  console.log(`\n--- ${test.name} ---`);
  test();
}

console.log(`\n${"=".repeat(60)}`);
console.log(`gecen: ${passed.length}   basarisiz: ${failed.length}`);
for (const name of failed) console.log(`  BASARISIZ: ${name}`);
process.exit(failed.length ? 1 : 0);
