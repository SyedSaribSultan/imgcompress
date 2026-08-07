/* Drive the app the way a person does. Since v2.5.0 a drop into an empty
 * queue lands on the set-up step and waits to be told to start, so every
 * harness that uploads files has to press the button too. */

/** Upload files and get the run under way. Returns once work has started. */
export async function uploadAndStart(pg, files) {
  const input = await pg.$("#file-input");
  await input.uploadFile(...files);
  await pg.waitForFunction(
    (n) => typeof state !== "undefined" && state.items.length >= n,
    { timeout: 120_000, polling: 100 }, files.length);
  if (!(await pg.evaluate(() => state.staging))) return;   // joined a live run
  await pg.waitForFunction(() => {
    const b = document.getElementById("setup-go");
    return b && !b.disabled && !document.getElementById("app-stage").hidden;
  }, { timeout: 60_000, polling: 100 });
  await pg.click("#setup-go");
  await pg.waitForFunction(() => !state.staging, { timeout: 60_000, polling: 100 });
}

/** Upload, start, and wait for every image to settle. */
export async function uploadAndFinish(pg, files, timeout = 1_800_000) {
  await uploadAndStart(pg, files);
  await pg.waitForFunction(
    (n) => state.items.length >= n &&
           state.items.every((i) => ["done", "failed", "saved"].includes(i.status)),
    { timeout, polling: 300 }, files.length);
}
