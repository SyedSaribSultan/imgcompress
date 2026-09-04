/* The zip has to be a real zip, and it has to be built without holding the
 * whole download in memory.
 *
 * zipStore used to call arrayBuffer() on every result at once. On a
 * two-hundred image batch that is the entire output resident on the heap, on
 * top of the blobs the queue is already holding, in order to build a Blob that
 * copies it all again. It streams each entry's checksum now and pushes the
 * Blob itself into the archive rather than its bytes.
 *
 * That rewrite is exactly the kind that produces an archive which downloads
 * happily, looks the right size, and fails to extract - so this does not check
 * that a file appeared. It runs Python's zipfile.testzip(), which verifies
 * every stored CRC against the bytes, and compares each entry's size to what
 * the app said it produced. Watched failing on the classic version of the bug:
 * dropping the final xor from the running checksum, which yields a
 * well-formed archive whose first entry reports corrupt.
 *
 *   node tests/web/probe_zip.mjs
 */
import { spawn } from "node:child_process";
import { readdirSync, mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";
import { uploadAndFinish } from "./drive.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "downloads", "__ziptest");
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = spawn("node",[path.join(here,"serve.mjs"),"8315"],{stdio:"ignore"});
await new Promise(r=>setTimeout(r,900));
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 3600000 });
let bad=0; const ok=(c,n)=>{ if(c) console.log("  ok  "+n); else { console.error("  FAIL "+n); bad++; } };
try {
  const pg = await b.newPage();
  const cdp = await pg.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: OUT, eventsEnabled: true });
  await pg.setViewport({ width: 1440, height: 940 });
  await pg.goto("http://127.0.0.1:8315/", { waitUntil: "networkidle0" });
  const files = ["photo.png","logo.png","ui.png","chromanoise.png"].map(n=>path.join(here,"fixtures",n));
  await uploadAndFinish(pg, files, 900000);
  await new Promise(r=>setTimeout(r,500));
  await pg.click("#save-btn");
  // wait for the file to appear and settle
  let zip=null;
  for (let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,250));
    const f=readdirSync(OUT).filter(n=>n.endsWith(".zip"));
    if (f.length) { zip=path.join(OUT,f[0]); break; } }
  ok(!!zip, `a zip was produced (${zip ? path.basename(zip) : "none"})`);
  if (zip) {
    await new Promise(r=>setTimeout(r,1200));
    const expect = await pg.evaluate(() => state.items.map(i => ({ n: i.newBytes })));
    console.log("expected entry sizes:", JSON.stringify(expect.map(e=>e.n)));
    // Verify with a REAL unzip - python's zipfile checks every CRC.
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("python", ["-c", `
import zipfile,sys,json
z=zipfile.ZipFile(sys.argv[1])
bad=z.testzip()
print(json.dumps({"bad":bad,"names":z.namelist(),"sizes":[i.file_size for i in z.infolist()]}))
`, zip], { encoding: "utf8" });
    const r = JSON.parse(out.trim());
    console.log("unzip says:", JSON.stringify(r));
    ok(r.bad === null, `every CRC in the archive checks out (${r.bad ?? "all good"})`);
    /* The archive also carries a plain-text report - that is a feature, not a
       stray entry - so the images are the entries that are not it. */
    const imgs = r.names.map((n, i) => ({ n, size: r.sizes[i] }))
                        .filter((e) => !/report\.txt$/.test(e.n));
    ok(imgs.length === files.length,
       `all ${files.length} images are in the archive (${imgs.length}, plus the report)`);
    const want = expect.map(e=>e.n).sort((a,b)=>a-b);
    const got = imgs.map(e=>e.size).sort((a,b)=>a-b);
    ok(JSON.stringify(want)===JSON.stringify(got),
       `and every image is byte-for-byte the size the app reported (${got.join(",")})`);
  }
} finally { await b.close(); server.kill(); }
console.log(bad===0?"\nOK":`\n${bad} problem(s)`);
process.exit(bad?1:0);
