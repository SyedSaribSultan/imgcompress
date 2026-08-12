/* Getting files back out: one file, or all of them as a zip.
 *
 * The zip is written here rather than by a library. Every entry is already
 * compressed - that is the entire point of the app - so the archive uses the
 * STORE method and does no second pass. A deflate over a JPEG costs time and
 * makes the file marginally bigger, and pulling in a compression library to
 * achieve that would be worse still.
 */

import { $, setText, toast } from "./dom.js";
import { state, isReady, totals } from "./state.js";
import { human, splitName } from "./format.js";
import { scheduleRender } from "./render.js";

/** The extension the output should carry: the format's own, or the original's
 *  when the file was passed through untouched. */
function outExt(it) {
  return it.ext || splitName(it.name).ext;
}

/** The name to write, de-duplicated against everything already in this archive.
 *  Two files called logo.png from different folders must not silently become one
 *  entry - a zip with a duplicate name is a zip that loses a file. */
export function outputName(it, used) {
  let base = splitName(it.name).base;
  const ext = outExt(it);
  if (state.suffix) base += "-min";
  const name = base + ext;
  if (!used) return name;

  let candidate = name, n = 1;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base} (${n})${ext}`;
    n++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

/** One file, the one on the stage. */
export function downloadOne(it) {
  if (!it || !isReady(it)) return;
  const name = outputName(it);
  downloadBlob(it.afterBlob, name);
  it.status = "saved";
  toast(`Downloaded ${name}`);
  scheduleRender();
}

/* Copy the result to the clipboard, for pasting straight into a design tool, a
 * chat or a document. Clipboards accept image/png and nothing else - writing a
 * JPEG or WebP blob is rejected outright - so the compressed result is decoded and
 * re-encoded as PNG. The pixels are exactly what was measured; the bytes are not
 * the file, and the toast says so rather than letting someone believe they pasted
 * a 400 KB JPEG. */
export async function copyImage(it) {
  if (!it || !isReady(it)) return;
  const btn = $("copy-one");
  btn.disabled = true;
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error("this browser has no clipboard image support");
    }
    const asPng = async () => {
      if (it.afterBlob.type === "image/png") return it.afterBlob;
      const bmp = await createImageBitmap(it.afterBlob);
      const c = document.createElement("canvas");
      c.width = bmp.width; c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      bmp.close?.();
      return new Promise((res) => c.toBlob(res, "image/png"));
    };
    /* The blob is handed over as a promise rather than awaited first. Awaiting the
       re-encode before calling write() spends the click's user activation, which
       Safari rejects outright and Chrome can too; the promise form is what the API
       is designed around. */
    await navigator.clipboard.write([new ClipboardItem({ "image/png": asPng() })]);
    toast(it.afterBlob.type === "image/png"
      ? "Copied — paste it anywhere"
      : "Copied as PNG — the only image format clipboards take");
  } catch (e) {
    toast(`Could not copy: ${e && e.message ? e.message : e}`);
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------- the zip --------------------------------- */

const ZCRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function zcrc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = ZCRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function zipStore(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  const datas = await Promise.all(entries.map((e) => e.blob.arrayBuffer()));
  entries.forEach((entry, i) => {
    const data = new Uint8Array(datas[i]);
    const nameBytes = encoder.encode(entry.name);
    const crc = zcrc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const cdir = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdir.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true); cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cdir.set(nameBytes, 46);

    chunks.push(local, data);
    central.push(cdir);
    offset += local.length + data.length;
  });

  let centralSize = 0;
  for (const c of central) centralSize += c.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, eocd], { type: "application/zip" });
}

/** Everything with a result. One image is a file; several are a zip, and the
 *  button says which before it is pressed. */
export async function downloadAll() {
  const done = state.items.filter(isReady);
  if (!done.length) return;
  if (done.length === 1) { downloadOne(done[0]); return; }

  setText($("save-label"), "Zipping…");
  $("save-btn").disabled = true;
  try {
    const used = new Set();
    const entries = done.map((it) => ({ name: outputName(it, used), blob: it.afterBlob }));
    const zip = await zipStore(entries);
    downloadBlob(zip, "imgcompress.zip");
    for (const it of done) it.status = "saved";
    toast(`Zipped ${done.length} images — ${human(totals().saved)} lighter than they arrived`);
  } catch {
    toast("Could not build the zip — try downloading images individually");
  }
  scheduleRender();
}
