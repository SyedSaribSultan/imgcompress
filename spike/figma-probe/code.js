/* The main-thread half of the Figma capability probe. See
 * docs/figma-plugin-spike.md for the question this exists to answer and
 * spike/figma-probe/README.md for how to run it.
 *
 * Nothing in the shipping product imports this file, no test runs it, and CI
 * does not know it exists. It is a spike: it either comes back with numbers
 * that make a Figma plugin worth building, or it comes back with numbers that
 * say not yet, and either answer is worth the hour.
 *
 * This file runs in Figma's plugin sandbox, which is not the browser realm.
 * There is no window, no DOM, no fetch, no Worker and - the whole reason the
 * codecs would have to live in ui.html instead - no WebAssembly guaranteed.
 * The code below deliberately stays on plain ES2017 with no optional chaining,
 * because the sandbox is a separate engine from the iframe's and has lagged the
 * browser on syntax before.
 */

"use strict";

/* Three sizes, because one number tells you nothing about where the wall is.
 * A megabyte is a small PNG export, 4 MB is a full-resolution RGBA frame of a
 * modest artboard, and 16 MB is roughly one 2000x2000 image's pixel buffer -
 * the size the port would actually push across this bridge. If the plugin dies
 * partway up this ladder, that death is the finding, which is why every line is
 * printed the moment it is measured rather than collected into a final report. */
var ECHO_SIZES = [1048576, 4194304, 16777216];

/* Figma's sandbox has no performance.now() in every version, and the copies we
 * are timing take milliseconds to hundreds of milliseconds, so Date.now()'s
 * resolution is enough. The one thing this rules out is comparing our clock to
 * the iframe's - the two realms have different time origins, so the UI reports
 * how long it held the buffer as its own number and we never subtract it. */
function now() {
  if (typeof performance !== "undefined" && performance && performance.now) {
    return performance.now();
  }
  return Date.now();
}

var lines = [];

/* Messages posted before the iframe has installed its own window.onmessage are
 * simply dropped - this bridge does not queue - and the sandbox checks below all
 * run synchronously the moment showUI returns. So every line is held until the
 * iframe says hello, then flushed in order. Without this the copyable report was
 * missing exactly the lines about the sandbox, while the console had them, which
 * is the sort of gap that gets read as "the sandbox has no WebAssembly". */
var uiReady = false;
var backlog = [];

// Printed to the developer console AND pushed to the UI, so the report is
// copyable from the plugin window without opening devtools.
function say(tag, text) {
  var line = "[" + tag + "] " + text;
  lines.push(line);
  console.log(line);
  if (uiReady) {
    figma.ui.postMessage({ type: "line", text: line });
  } else {
    backlog.push(line);
  }
}

function flushBacklog() {
  uiReady = true;
  for (var i = 0; i < backlog.length; i++) {
    figma.ui.postMessage({ type: "line", text: backlog[i] });
  }
  backlog = [];
}

// The UI's own findings arrive already rendered in its textarea, so echoing
// them back would print everything twice. The console still wants them.
function note(tag, text) {
  var line = "[" + tag + "] " + text;
  lines.push(line);
  console.log(line);
}

function describe(e) {
  if (!e) return "no error object";
  if (e.message) return e.message;
  return String(e);
}

/* ------------------------------------------------------------------------- *
 * what the sandbox itself can do
 * ------------------------------------------------------------------------- */

function probeSandbox() {
  say("main", "figma.editorType: " + figma.editorType);
  say("main", "figma.apiVersion: " +
    (typeof figma.apiVersion === "undefined" ? "absent" : figma.apiVersion));
  // typeof on a name that was never declared is the one read that cannot throw,
  // which is why every absence below is checked this way rather than with a
  // try/catch around the identifier itself.
  say("main", "typeof WebAssembly: " + typeof WebAssembly);
  say("main", "typeof Worker: " + typeof Worker);
  say("main", "typeof fetch: " + typeof fetch);
  say("main", "typeof OffscreenCanvas: " + typeof OffscreenCanvas);
  say("main", "typeof figma.createImage: " + typeof figma.createImage);
  say("main", "typeof figma.createImageAsync: " + typeof figma.createImageAsync);
}

/* The write-up claims there is no export hook, on the strength of Figma's
 * documented event list. This turns that reading into something observed: ask
 * figma.on() for each name and print whatever it says back. A name that is
 * accepted proves the call works, which is what makes a rejection mean
 * something. Be careful reading "documentchange" style refusals - under
 * dynamic-page document access some real events are refused for a reason that
 * has nothing to do with whether they exist, so the message is printed verbatim
 * rather than summarised into a yes or a no. */
function probeEventNames() {
  var names = ["run", "selectionchange", "export", "beforeexport", "exportcomplete"];
  var noop = function () {};
  for (var i = 0; i < names.length; i++) {
    try {
      figma.on(names[i], noop);
      say("main", 'figma.on("' + names[i] + '"): accepted');
      try { figma.off(names[i], noop); } catch (e) { /* nothing to undo */ }
    } catch (e) {
      say("main", 'figma.on("' + names[i] + '"): refused - ' + describe(e));
    }
  }
}

/* ------------------------------------------------------------------------- *
 * the bridge
 * ------------------------------------------------------------------------- */

/* Uint8Array is the one binary type that crosses figma.ui.postMessage, and it
 * is copied rather than transferred - there is no transfer list on this bridge.
 * So a round trip of N bytes allocates N bytes twice more, on top of the
 * original, inside a tab that is already holding the user's document. That cost
 * is the thing this whole probe exists to measure. */
function makeBuffer(size) {
  var bytes = new Uint8Array(size);
  bytes.fill(0xa5);
  // A ramp in the first 256 bytes catches a buffer that came back as a plain
  // object with numeric keys, or with its element type quietly widened.
  for (var i = 0; i < 256 && i < size; i++) bytes[i] = i & 0xff;
  bytes[size - 1] = 0x5a;
  if (size > 2) bytes[Math.floor(size / 2)] = 0xc3;
  return bytes;
}

function checkBuffer(bytes, size) {
  if (!bytes) return "nothing came back";
  if (!(bytes instanceof Uint8Array)) {
    return "came back as " + Object.prototype.toString.call(bytes) + ", not a Uint8Array";
  }
  if (bytes.length !== size) return "came back " + bytes.length + " B, sent " + size + " B";
  // Guarded because the README invites editing ECHO_SIZES: a size under 256 has
  // no ramp to check, and reading past the end would report damage that is not
  // there, which is the worst thing a diagnostic can do.
  if (size >= 256 && (bytes[0] !== 0 || bytes[255] !== 255)) {
    return "the leading ramp came back changed";
  }
  if (bytes[size - 1] !== 0x5a) return "the last byte is " + bytes[size - 1] + ", expected 90";
  if (bytes[Math.floor(size / 2)] !== 0xc3) return "the middle byte changed";
  return null;
}

var pendingEcho = null;

function echoOnce(size) {
  return new Promise(function (resolve) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      pendingEcho = null;
      resolve(null);
    }, 20000);

    pendingEcho = function (msg) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(msg);
    };

    var t0 = now();
    var bytes = makeBuffer(size);
    var allocMs = now() - t0;
    say("bridge", size + " B allocated in " + Math.round(allocMs) + " ms");

    figma.ui.postMessage({ type: "echo", size: size, bytes: bytes });
  });
}

function rate(size, ms) {
  if (!ms || ms <= 0) return "too fast to time at this clock's resolution";
  var mib = size / 1048576;
  return (Math.round((mib / (ms / 1000)) * 10) / 10) + " MiB/s round trip";
}

async function runBridgeLadder() {
  for (var i = 0; i < ECHO_SIZES.length; i++) {
    var size = ECHO_SIZES[i];
    var start = now();
    var reply = await echoOnce(size);
    var elapsed = now() - start;

    if (!reply) {
      say("bridge", size + " B: no reply within 20 s - treat the plugin as wedged at this size");
      break;
    }
    var problem = checkBuffer(reply.bytes, size);
    if (problem) {
      say("bridge", size + " B: " + problem);
    } else {
      say("bridge", size + " B: intact, " + Math.round(elapsed) + " ms, " + rate(size, elapsed));
    }
    if (typeof reply.uiHoldMs === "number") {
      say("bridge", size + " B: the iframe held it " + Math.round(reply.uiHoldMs) +
        " ms (its own clock, not comparable to ours)");
    }
  }
  say("main", "probe finished - copy the report before closing the plugin");
  figma.notify("pocketsize probe finished. Copy the report before closing.");
}

/* ------------------------------------------------------------------------- *
 * wiring
 * ------------------------------------------------------------------------- */

figma.showUI(__html__, { width: 560, height: 620, themeColors: true });

figma.ui.onmessage = function (msg) {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "ui-ready") {
    flushBacklog();
    return;
  }
  if (msg.type === "ui-line") {
    note("ui", msg.text);
    return;
  }
  if (msg.type === "echo-back") {
    if (pendingEcho) pendingEcho(msg);
    return;
  }
  if (msg.type === "ui-done") {
    startLadderOnce("the iframe finished its own checks");
    return;
  }
};

var ladderStarted = false;
function startLadderOnce(why) {
  if (ladderStarted) return;
  ladderStarted = true;
  say("bridge", "starting the buffer round trip: " + why);
  runBridgeLadder();
}

probeSandbox();
probeEventNames();
say("main", "waiting for the iframe to report");

/* If the iframe dies during its own checks it will never send ui-done, and a
 * probe that hangs silently is worse than one that reports a gap. Fifteen
 * seconds is long enough for four wasm instantiations and two worker spawns on
 * a slow machine. */
setTimeout(function () {
  startLadderOnce("the iframe never reported done - the gap above is itself a finding");
}, 15000);
