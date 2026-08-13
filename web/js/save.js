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
import { human, splitName, fmtLabel, scoreText } from "./format.js";
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

/* ------------------------------ the report ------------------------------- */

/** The written record of what happened to each picture: what changed, what was
 *  measured, and every version that was tried. It rides in the zip because the
 *  people who need it - records, legal, archives - need it next to the files,
 *  not on a screen they have already closed. Plain text on purpose. */
function buildReport(done, names) {
  const lines = [];
  const t = totals();
  lines.push(`imgcompress report — ${done.length} picture${done.length === 1 ? "" : "s"}`);
  lines.push(`${human(t.before)} in, ${human(t.after)} out, ${human(t.saved)} saved.`);
  lines.push("Everything ran in this browser. Nothing was uploaded.");
  lines.push("");
  lines.push("Visual match is SSIMULACRA 2, 0-100, measured against the original;");
  lines.push('"identical" means the pixels are exactly the same, not merely close.');

  done.forEach((it, i) => {
    const resized = it.outW && (it.outW !== it.width || it.outH !== it.height);
    lines.push("");
    lines.push(`${i + 1}. ${it.name} → ${names[i]}`);
    lines.push(`   kept:          ${fmtLabel(it.fmt)}`);
    lines.push(`   size:          ${human(it.originalBytes)} → ${human(it.newBytes)}`);
    lines.push(`   pixels:        ${it.width}×${it.height}`
      + (resized ? ` → ${it.outW}×${it.outH} (shrunk)` : " (unchanged)"));
    lines.push(`   visual match:  ${scoreText(it.score, it.lossless)}`);
    lines.push(`   pixel-exact:   ${it.lossless ? "yes" : "no"}`);
    if (it.hardCapped) {
      lines.push("   note:          shrunk by the design-tool ceiling, which applies");
      lines.push("                  even when no shrinking was asked for");
    }
    for (const w of it.warnings || []) lines.push(`   warning:       ${w}`);
    if (it.candidates?.length) {
      lines.push("   versions tried:");
      const rows = [...it.candidates].sort((a, b) => a.bytes - b.bytes);
      for (const c of rows) {
        const win = !it.auto?.passthrough && c.format === (it.pick || it.auto?.fmt);
        lines.push(`     ${fmtLabel(c.format).padEnd(24)}`
          + `${human(c.bytes).padStart(10)}   ${scoreText(c.score, c.lossless)}`
          + (win ? "   <- kept" : ""));
      }
      lines.push(`     ${"Original".padEnd(24)}${human(it.originalBytes).padStart(10)}`
        + `   identical${it.auto?.passthrough ? "   <- kept" : ""}`);
    }
  });
  lines.push("");
  return lines.join("\n");
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
    const names = done.map((it) => outputName(it, used));
    const entries = done.map((it, i) => ({ name: names[i], blob: it.afterBlob }));
    /* The written record rides along, always. It is the one artefact the
       records/legal/archive personas asked for, and one text file in a zip
       costs everyone else nothing. */
    entries.push({
      name: "imgcompress-report.txt",
      blob: new Blob([buildReport(done, names)], { type: "text/plain" }),
    });
    const zip = await zipStore(entries);
    downloadBlob(zip, "imgcompress.zip");
    for (const it of done) it.status = "saved";
    /* If pixels were removed anywhere, the toast that announces the saving
       says so - the number never travels without that fact. And the written
       report is mentioned, because an artefact nobody knows exists builds no
       trust. */
    const shrunk = done.filter(
      (it) => it.outW && (it.outW !== it.width || it.outH !== it.height)).length;
    toast(`Zipped ${done.length} pictures — saved you ${human(totals().saved)}.`
      + (shrunk ? ` ${shrunk} of them ${shrunk === 1 ? "was" : "were"} shrunk in pixels, `
        + "not just compressed." : "")
      + " A written report of everything is inside.");
    /* Closure on the button itself: the last moment of the flow says it
       worked, then hands the slot back. Written a beat AFTER the render below
       repaints the rows, so the renderer does not immediately overwrite it. */
    setTimeout(() => setText($("save-label"), "Saved ✓"), 80);
    setTimeout(() => scheduleRender(), 2200);
  } catch {
    toast("Could not build the zip — try downloading pictures one at a time");
  }
  scheduleRender();
}
