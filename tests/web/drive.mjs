/* Drive the app the way a person does. A drop starts the work immediately —
 * there is no step in between and nothing to press — so uploading IS starting.
 * The helpers stay, because every harness calls them and the shape of "get a
 * run under way" is the thing worth naming, not the button it used to need. */

/** Upload files and get the run under way. Returns once work has started. */
export async function uploadAndStart(pg, files) {
  const input = await pg.$("#file-input");
  await input.uploadFile(...files);
  await pg.waitForFunction(
    (n) => typeof state !== "undefined" && state.items.length >= n,
    { timeout: 120_000, polling: 100 }, files.length);
  /* Dispatch is deliberately held until the frame after the original is
     painted, so "the items exist" is one frame too early to call the run
     started. Waiting on the frames themselves is exact; waiting on a status is
     not, because a small file can be finished before the first poll and a busy
     pool can leave a new item queued while work is very much under way. */
  await pg.evaluate(() => new Promise((res) =>
    requestAnimationFrame(() => requestAnimationFrame(res))));
}

/** Upload, start, and wait for every image to settle. */
export async function uploadAndFinish(pg, files, timeout = 1_800_000) {
  await uploadAndStart(pg, files);
  await pg.waitForFunction(
    (n) => state.items.length >= n &&
           state.items.every((i) => ["done", "failed", "saved"].includes(i.status)),
    { timeout, polling: 300 }, files.length);
}
