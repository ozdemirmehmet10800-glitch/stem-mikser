// Prosedürel impuls yanıtını (frontend/js/fx.js) ham float32 olarak yazar: Python portuyla (backend/app.py
// `_fx_impulse`) örnek eşitliği testi için. Kullanım: node tests\ir_dump.mjs <boyut> <süre> <çıktı.f32>
// Düzen: önce sol kanal, sonra sağ (her biri `length` örnek).
import { writeFileSync } from "node:fs";
import { makeImpulse } from "../frontend/js/fx.js";

const [size, decay, out] = process.argv.slice(2);
const ir = makeImpulse(Number(size), Number(decay));
const bytes = Buffer.alloc(8 * ir.left.length);
for (let i = 0; i < ir.left.length; i += 1) {
  bytes.writeFloatLE(ir.left[i], 4 * i);
  bytes.writeFloatLE(ir.right[i], 4 * (ir.left.length + i));
}
writeFileSync(out, bytes);
console.log(JSON.stringify({ length: ir.left.length }));
