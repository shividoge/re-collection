// Checks that Spark's own decoder (the web's @sparkjsdev/spark, its worker code and WASM, unmodified)
// reads tools/video2capture/spz.py's SPZ files, and that they decode to the same Gaussians as the
// INRIA PLY path the web used before (Spark's PLY reader is the reference: no axis flip, same SH layout).
//
// Run (from the repo root):
//   mkdir -p /tmp/spark-check && cd /tmp/spark-check && echo '{"type":"module"}' > package.json \
//     && bun add @sparkjsdev/spark@2.4.0 three && cd -
//   (cd tools/video2capture && uv run --python 3.12 --with numpy python test_spz.py --fixture /tmp/spz-fixtures)
//   bun workers/gpu/tests/spark_spz_check.mjs /tmp/spz-fixtures /tmp/spark-check/node_modules/@sparkjsdev/spark
//
// Spark decodes in a Web Worker, which Bun can't host for it (it posts a WebAssembly.Module), so this
// runs the worker's script in-process with a minimal `self` and sends it the same RPCs SplatLoader does.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const [fixtures, sparkDir] = process.argv.slice(2);
if (!fixtures || !sparkDir) throw new Error("usage: spark_spz_check.mjs <fixture dir> <spark package dir>");
const dist = join(sparkDir, "dist", "spark.module.js");
const { utils } = await import(dist);
const source = readFileSync(dist, "utf8");
const pkg = JSON.parse(readFileSync(join(sparkDir, "package.json"), "utf8"));

function sparkWorker() {
  const workerCode = new Function(`return ${source.match(/^var jsContent = (".*");$/m)[1]}`)();
  const wasm = Uint8Array.from(atob(source.match(/spark_rs_bg_default = .*?\("([A-Za-z0-9+/=]+)"\)/)[1]), (c) => c.charCodeAt(0));
  const listeners = new Set();
  const pending = new Map();
  const self = {
    addEventListener: (_, f) => listeners.add(f),
    removeEventListener: (_, f) => listeners.delete(f),
    postMessage: ({ id, result, error, status }) => {
      const p = pending.get(id);
      if (!p || status !== undefined) return;
      pending.delete(id);
      error !== undefined ? p.reject(error) : p.resolve(result);
    },
  };
  new Function("self", workerCode)(self);
  const send = (data) => [...listeners].forEach((f) => f({ data }));
  send({ name: "init-wasm", module: new WebAssembly.Module(wasm) });
  let id = 0;
  return (name, args) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    send({ id, name, args });
  });
}

const call = sparkWorker();
const load = (rpc, file) => call(rpc, { fileBytes: new Uint8Array(readFileSync(join(fixtures, file))), pathName: file });

// Per splat: center, ln scales, unit quaternion (xyzw), opacity, rgb, and SH rest as [coef][rgb].
function extSplats(r, degree) {
  const shWords = [[r.extra.sh1, 0], [r.extra.sh1, 1], [r.extra.sh1, 2], [r.extra.sh1, 3], [r.extra.sh2, 0],
    [r.extra.sh2, 1], [r.extra.sh2, 2], [r.extra.sh2, 3], [r.extra.sh3a, 0], [r.extra.sh3a, 1], [r.extra.sh3a, 2],
    [r.extra.sh3a, 3], [r.extra.sh3b, 0], [r.extra.sh3b, 1], [r.extra.sh3b, 2]].slice(0, (degree + 1) ** 2 - 1);
  return Array.from({ length: r.numSplats }, (_, i) => {
    const s = utils.decodeExtSplat(r.extArrays, i);
    return {
      center: [s.center.x, s.center.y, s.center.z], lnScale: [s.scales.x, s.scales.y, s.scales.z].map(Math.log),
      quat: [s.quaternion.x, s.quaternion.y, s.quaternion.z, s.quaternion.w], opacity: s.opacity, rgb: [s.color.r, s.color.g, s.color.b],
      sh: shWords.map(([arr, k]) => { const c = utils.decodeExtRgb(arr[i * 4 + k]); return [c.r, c.g, c.b]; }),
    };
  });
}

const original = (o, i) => ({ center: o.means[i], lnScale: o.scales_log[i], quat: o.quats_xyzw[i],
  opacity: o.opacity[i], rgb: o.rgb[i], sh: o.sh_rest[i] });

const flat = (v) => (Array.isArray(v) ? v.flat(2) : [v]);
const diff = (x, y, sign = 1) => Math.max(...x.map((v, j) => Math.abs(v - sign * y[j])));
function maxDiff(a, b, key) {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const x = flat(a[i][key]), y = flat(b[i][key]);
    m = Math.max(m, key === "quat" ? Math.min(diff(x, y), diff(x, y, -1)) : diff(x, y));  // q and -q: same rotation
  }
  return m;
}

// Allowed differences: SPZ quantization, plus Spark's own in-memory encoding (half floats, oct quats),
// which the SPZ-vs-PLY comparison pays twice. A layout or axis mistake shows up as an error near 1.
const tolerance = { center: 0.5 / 4096 + 1e-6, lnScale: 1 / 32 + 0.005, quat: 0.006, opacity: 0.5 / 255 + 0.001,
  rgb: (0.5 / 255) * (0.28209479 / 0.15) + 0.002, sh: 8.5 / 128 + 0.005 };

let failed = 0;
console.log(`Spark ${pkg.version}: ${dist}`);
for (let degree = 0; degree <= 3; degree++) {
  const o = JSON.parse(readFileSync(join(fixtures, `d${degree}.json`), "utf8"));
  const n = o.means.length;
  const spz = extSplats(await load("loadExtSplats", `d${degree}.spz`), degree);
  const ply = extSplats(await load("loadExtSplats", `d${degree}.ply`), degree);
  const orig = Array.from({ length: n }, (_, i) => original(o, i));
  const packed = await load("loadPackedSplats", `d${degree}.spz`);  // SplatMesh's default path
  const lines = [];
  let ok = spz.length === n && ply.length === n && packed.numSplats === n;
  for (const key of Object.keys(tolerance)) {
    if (key === "sh" && degree === 0) continue;
    const vsPly = maxDiff(spz, ply, key), vsOrig = maxDiff(spz, orig, key);
    const pass = vsPly <= tolerance[key] && vsOrig <= tolerance[key];
    ok &&= pass;
    lines.push(`  ${pass ? "ok  " : "FAIL"} ${key.padEnd(8)} max |spz - ply| ${vsPly.toExponential(2)}  |spz - original| ${vsOrig.toExponential(2)}  (allowed ${tolerance[key].toExponential(2)})`);
  }
  console.log(`SH degree ${degree}: ${spz.length}/${n} splats (ext), ${packed.numSplats} (packed) ${ok ? "OK" : "FAILED"}`);
  console.log(lines.join("\n"));
  if (!ok) failed++;
}
console.log(failed ? `${failed} degree(s) FAILED` : "Spark reads every SPZ like the PLY: OK");
process.exit(failed ? 1 : 0);
