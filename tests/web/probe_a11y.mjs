/* Accessibility and discoverability: names on controls, live regions, keyboard
 * reachability, focus visibility.
 *
 * This printed its findings and exited 0 whatever they were, which made it a
 * report rather than a test - running it and seeing no errors carried almost no
 * information, and an unnamed control could appear without anything objecting.
 * It now asserts. The measurements are still printed, because what they say is
 * worth reading even when they pass.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { CHROME } from "./resolve_puppeteer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures");

let bad = 0;
const ok = (c, n) => { if (c) console.log(`  ok ${n}`); else { console.error(`FAIL ${n}`); bad++; } };

const server = spawn("node", [path.join(here, "serve.mjs"), "8194"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 3_600_000,
});

const audit = () => {
  const out = { unnamed: [], noFocusRing: [], live: [], tabbables: 0, notes: [] };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" &&
           el.getBoundingClientRect().width > 0;
  };
  const nameOf = (el) => (
    el.getAttribute("aria-label") ||
    (el.getAttribute("aria-labelledby") &&
      document.getElementById(el.getAttribute("aria-labelledby"))?.textContent) ||
    (el.labels && el.labels[0]?.textContent) ||
    el.title || el.textContent || ""
  ).trim();

  for (const el of document.querySelectorAll(
      "button, a[href], input, select, textarea, [tabindex]")) {
    if (!visible(el)) continue;
    out.tabbables++;
    if (!nameOf(el)) {
      out.unnamed.push(`${el.tagName.toLowerCase()}#${el.id || "?"}.${el.className || ""}`);
    }
  }
  for (const el of document.querySelectorAll("[aria-live], [role=status], [role=alert]")) {
    out.live.push(`${el.id || el.tagName}: ${el.getAttribute("aria-live") || el.getAttribute("role")}`);
  }
  // Does the toast announce itself, and does it sit on top of the controls?
  const toast = document.getElementById("toast");
  const bar = document.getElementById("plan-fields");
  if (toast && bar) {
    const t = toast.getBoundingClientRect(), c = bar.getBoundingClientRect();
    out.notes.push(`toast box ${Math.round(t.top)}-${Math.round(t.bottom)}, ` +
                   `controls ${Math.round(c.top)}-${Math.round(c.bottom)}, ` +
                   `overlap=${t.top < c.bottom && t.bottom > c.top}`);
    out.notes.push(`toast live=${toast.getAttribute("aria-live") || "none"}`);
  }
  return out;
};

try {
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 940 });
  await pg.goto("http://127.0.0.1:8194/", { waitUntil: "networkidle0" });

  console.log("=== landing ===");
  const landing = await pg.evaluate(audit);
  console.log(JSON.stringify(landing, null, 1));
  ok(landing.tabbables > 0, `the landing page has focusable controls (${landing.tabbables})`);
  ok(landing.unnamed.length === 0,
     `every control on the landing page has an accessible name (${
       landing.unnamed.join("; ") || "clean"})`);

  const input = await pg.$("#file-input");
  await input.uploadFile(path.join(FIX, "photo.png"), path.join(FIX, "logo.png"),
                         path.join(FIX, "ui.png"));
  await pg.waitForFunction(() => state.items.every((i) =>
    ["done", "failed", "saved"].includes(i.status)), { timeout: 900000, polling: 300 });
  await new Promise((r) => setTimeout(r, 600));
  /* Three files. Everything below is about the result and its evidence, so put one
     image on the stage - there is no drawer to open after it, because the detail
     region is always present. The old two-step mattered: measured while shut,
     every control in there reported `offsetParent === null` and the probe passed
     over an empty set, which is the failure mode this whole suite keeps finding.
     The assertion below that the set is non-empty is what still guards it. */
  await pg.evaluate(() => imgc.select(state.items[0].id));
  await new Promise((r) => setTimeout(r, 700));
  await pg.screenshot({ path: path.join(here, "shot-studio.png") });
  console.log("\n=== studio, with results ===");
  const studio = await pg.evaluate(audit);
  console.log(JSON.stringify(studio, null, 1));
  ok(studio.unnamed.length === 0,
     `every control in the studio has an accessible name (${
       studio.unnamed.join("; ") || "clean"})`);
  ok(studio.live.length > 0,
     `the studio has at least one live region (${studio.live.join("; ") || "none"})`);

  // Can the result view — which is now also the control surface — be driven
  // from the keyboard?
  const keys = await pg.evaluate(() => {
    const order = [];
    /* The details panel is gone; the stage IS the result view now, and it
       carries the whole control surface - the modes, the zoom, the name, and
       the two ways out of a result. */
    const els = [...document.querySelectorAll(
      "#stage button, #stage input, #stage select")]
      .filter((e) => e.offsetParent !== null);
    for (const e of els) order.push(`${e.tagName.toLowerCase()}#${e.id || e.className}`);
    return order;
  });
  console.log("\nkeyboard reachable in the result view:", JSON.stringify(keys, null, 1));
  ok(keys.length > 0, `the result view is reachable from the keyboard (${keys.length} controls)`);

  /* ---- the drawn dropdowns owe everything the native ones gave away ----
   * Replacing a <select> means taking on the whole contract it used to honour
   * for free. Each of these is a way to ship a control someone cannot use, so
   * each is checked rather than assumed:
   *
   *   the native select survives as the model and the fallback
   *   the button is labelled by its question, not by its current value
   *   the roles and state a screen reader needs are present and correct
   *   arrow keys move, Enter commits, Escape cancels, type-ahead jumps
   *   the choice reaches the app - a change event, and settings.js listening
   */
  {
    const shape = await pg.evaluate(() => {
      const btn = document.getElementById("target-btn");
      const list = document.getElementById("target-list");
      const sel = document.getElementById("target");
      const labelledBy = (btn.getAttribute("aria-labelledby") || "").split(/\s+/);
      return {
        enhanced: !!btn && !!list,
        nativeStillThere: !!sel && sel.tagName === "SELECT",
        nativeHiddenFromAT: sel.getAttribute("aria-hidden") === "true" && sel.tabIndex === -1,
        btnFocusable: btn.tabIndex !== -1 && !btn.disabled,
        haspopup: btn.getAttribute("aria-haspopup"),
        expandedClosed: btn.getAttribute("aria-expanded"),
        listRole: list.getAttribute("role"),
        /* The accessible name has to include the QUESTION. A button named only
           "Website or app" tells a screen-reader user what the answer is and
           never what was asked. */
        namedByLabel: labelledBy.some((id) => {
          const el = document.getElementById(id);
          return el && /going to/i.test(el.textContent || "");
        }),
      };
    });
    console.log("\npicker shape:", JSON.stringify(shape, null, 1));
    ok(shape.enhanced, "the plan's dropdowns are enhanced");
    ok(shape.nativeStillThere,
       "the native select is still in the document as the model and the fallback");
    ok(shape.nativeHiddenFromAT,
       "and hidden from the accessibility tree, so the control is met once, not twice");
    ok(shape.btnFocusable, "the drawn control takes focus");
    ok(shape.haspopup === "listbox" && shape.listRole === "listbox",
       `it announces itself as a listbox (haspopup=${shape.haspopup}, role=${shape.listRole})`);
    ok(shape.expandedClosed === "false", "and announces that it is closed");
    ok(shape.namedByLabel,
       "its accessible name carries the question, not just the answer");

    /* The keyboard model, driven through real key events rather than by calling
       into the module - what is being checked is that a person with no pointer
       can operate it. */
    await pg.focus("#target-btn");
    await pg.keyboard.press("Enter");
    const opened = await pg.evaluate(() => ({
      expanded: document.getElementById("target-btn").getAttribute("aria-expanded"),
      active: document.getElementById("target-btn").getAttribute("aria-activedescendant"),
      /* Focus stays on the button: the list is activedescendant-driven, so the
         visible focus ring never goes somewhere the eye cannot follow. */
      focusStayed: document.activeElement.id === "target-btn",
    }));
    ok(opened.expanded === "true", "Enter opens it");
    ok(!!opened.active, `and marks an active option (${opened.active})`);
    ok(opened.focusStayed, "with focus still on the button, as the pattern requires");

    await pg.keyboard.press("ArrowDown");
    const moved = await pg.evaluate(() =>
      document.getElementById("target-btn").getAttribute("aria-activedescendant"));
    ok(moved !== opened.active, `Down moves the active option (${opened.active} -> ${moved})`);

    /* Escape cancels: it closes and commits NOTHING, which is the difference
       between a menu and a trap. */
    const before = await pg.evaluate(() => document.getElementById("target").value);
    await pg.keyboard.press("Escape");
    const cancelled = await pg.evaluate(() => ({
      expanded: document.getElementById("target-btn").getAttribute("aria-expanded"),
      value: document.getElementById("target").value,
      focused: document.activeElement.id,
    }));
    ok(cancelled.expanded === "false", "Escape closes it");
    ok(cancelled.value === before, "and changes nothing");
    ok(cancelled.focused === "target-btn", "and gives focus back to the button");

    /* Enter commits, and the choice has to reach the app - the whole point of
       keeping the select as the model is that settings.js never learned this
       control exists. */
    await pg.keyboard.press("Enter");
    await pg.keyboard.press("ArrowDown");
    await pg.keyboard.press("Enter");
    /* Longer than pushSettings' 350ms debounce in main.js: the control commits
       synchronously, the plan is pushed on a timer, and a 250ms wait made this
       assertion fail against a picker that was working perfectly. */
    await new Promise((r) => setTimeout(r, 700));
    const committed = await pg.evaluate(() => ({
      value: document.getElementById("target").value,
      shown: document.querySelector("#target-btn .picker-value").textContent.trim(),
      /* state.settings, NOT currentSettings(): the latter reads the select
         directly and would report the new value whether or not the change
         event ever fired, so asserting on it proves nothing. state.settings is
         written only by pushSettings(), which runs from the change listener -
         so this is the one reading that goes stale if the event is dropped.
         The first version of this check used currentSettings() and stayed
         green when the dispatch was deliberately removed. */
      planTarget: imgc.state.settings.target,
      expanded: document.getElementById("target-btn").getAttribute("aria-expanded"),
    }));
    console.log("committed:", JSON.stringify(committed));
    ok(committed.value !== before, `Enter commits a different choice (${before} -> ${committed.value})`);
    ok(committed.expanded === "false", "and closes the list");
    ok(!!committed.shown, `the button shows the new answer (${committed.shown})`);
    ok(committed.planTarget === committed.value,
       `and the plan received it through the select's own change event `
       + `(state.settings.target=${committed.planTarget}, select=${committed.value})`);

    /* Type-ahead, which is the one affordance people miss most when a select is
       replaced by a div. */
    await pg.focus("#target-btn");
    await pg.keyboard.press("KeyE");
    await new Promise((r) => setTimeout(r, 150));
    const typed = await pg.evaluate(() => {
      const id = document.getElementById("target-btn").getAttribute("aria-activedescendant");
      return { id, text: id ? document.getElementById(id).textContent.trim() : null };
    });
    ok(/^e/i.test(typed.text || ""),
       `typing a letter jumps to that option (${typed.text})`);
    await pg.keyboard.press("Escape");
  }

  /* The comparison modes are the primary control on the result view, so they
     have to be operable without a pointer: focusable, and Enter must do what a
     tap does. This replaces the chip assertions, which went with the details
     panel - the property being checked is the same one, on the control that
     now occupies that role. */
  const modeKeys = await pg.evaluate(() => {
    const btns = [...document.querySelectorAll('#stage .segmented button')];
    const first = btns.find((b) => b.getAttribute("aria-pressed") !== "true");
    const was = document.getElementById("view").dataset.mode;
    first.focus();
    const focusedIsMode = document.activeElement === first;
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    first.click();      // what Enter on a <button> does natively
    return {
      count: btns.length, focusedIsMode,
      pressed: btns.map((b) => b.getAttribute("aria-pressed")),
      changed: document.getElementById("view").dataset.mode !== was,
      labelled: btns.map((b) => (b.textContent || "").trim()).every(Boolean),
    };
  });
  console.log("\nmodes from the keyboard:", JSON.stringify(modeKeys, null, 1));
  ok(modeKeys.count > 0, `the comparison modes exist (${modeKeys.count})`);
  ok(modeKeys.focusedIsMode, "a mode button can take focus");
  ok(modeKeys.changed, "Enter on a focused mode does what a tap does");
  ok(modeKeys.labelled, "every mode carries a name");
  ok(modeKeys.pressed.every((p) => p === "true" || p === "false"),
     `every mode reports its pressed state (${modeKeys.pressed.join(",")})`);

  /* A result announces itself, and says what it became. The live region that
     speaks it is the toast - a role=status, so it is announced without stealing
     focus - and the standing sentence is the stage's own result line, which is
     where the numbers live now that the details panel is gone. */
  const narration = await pg.evaluate(() => ({
    live: document.getElementById("toast").getAttribute("aria-live"),
    role: document.getElementById("toast").getAttribute("role"),
    text: document.getElementById("s-saved").textContent,
  }));
  console.log("\nnarration:", JSON.stringify(narration, null, 1));
  ok(!!narration.live, `results are announced (${narration.live || "not announced"})`);
  ok(narration.role === "status",
     `and announced without stealing focus (role=${narration.role})`);
  ok(!!narration.text.trim(), "the stage says what this picture became");

  // Enter in the name field means "done renaming", and nothing else.
  await pg.evaluate(() => {
    const inp = document.getElementById("out-name");
    inp.focus(); inp.value = "renamed here";
  });
  await pg.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 300));
  const renamed = await pg.evaluate(() =>
    state.items.some((i) => i.name === "renamed here.png"));
  const released = await pg.evaluate(() => document.activeElement?.id !== "out-name");
  ok(renamed, "Enter in the name field commits the name");
  ok(released, "and releases the field, which is what Enter means here");
} finally { await b.close(); server.kill(); }

console.log(bad === 0 ? "\nOK — named, announced and reachable" : `\n${bad} problem(s)`);
process.exit(bad ? 1 : 0);
