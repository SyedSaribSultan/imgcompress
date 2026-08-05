/* SSIMULACRA 2 in JavaScript.
 *
 * A faithful port of the Python implementation the desktop app scores with
 * (the `ssimulacra2` package, itself a port of Cloudinary's reference C++).
 * Faithful means bug-for-bug: the constants, the 108-weight ordering, the
 * scale loop, and two boundary quirks that would be invisible until the
 * validation suite catches them:
 *
 *   1. The Python code transposes to (W, H) orientation before scoring
 *      (`linear.T`), so its blur zero-pads along the image's *x* axis and
 *      reflects along *y*. This port keeps row-major (H, W) planes and swaps
 *      the boundary treatment accordingly: zero boundary horizontally,
 *      symmetric reflection vertically.
 *   2. Its Gaussian is scipy's: kernel radius int(3.33 * 1.5 + 0.5) = 5,
 *      weights exp(-x²/2σ²) normalised, applied separably.
 *
 * Validated against the reference on a corpus of codec-distorted pairs; the
 * harness lives in the scratchpad (`ss2_validate.mjs`) and asserts agreement
 * to a fraction of a point on the 0-100 scale.
 *
 * Pure typed-array math - no canvas, no DOM - so the same file runs in the
 * worker (importScripts) and in Node (vm) for validation.
 */

"use strict";

/* ------------------------------------------------------------------------- *
 * constants, verbatim from the reference
 * ------------------------------------------------------------------------- */

const SS2_KC2 = 0.0009;
const SS2_NUM_SCALES = 6;

const SS2_M00 = 0.30, SS2_M02 = 0.078, SS2_M01 = 1.0 - SS2_M02 - SS2_M00;
const SS2_M10 = 0.23, SS2_M12 = 0.078, SS2_M11 = 1.0 - SS2_M12 - SS2_M10;
const SS2_M20 = 0.24342268924547819, SS2_M21 = 0.20476744424496821;
const SS2_M22 = 1.0 - SS2_M20 - SS2_M21;
const SS2_BIAS = 0.0037930732552754493;
const SS2_CBRT_BIAS = Math.cbrt(SS2_BIAS);

const SS2_WEIGHTS = new Float64Array([
  0.0, 0.0007376606707406586, 0.0, 0.0, 0.0007793481682867309, 0.0,
  0.0, 0.0004371155730107379, 0.0, 1.1041726426657346, 0.00066284834129271,
  0.00015231632783718752, 0.0, 0.0016406437456599754, 0.0, 1.8422455520539298,
  11.441172603757666, 0.0, 0.0007989109436015163, 0.000176816438078653, 0.0,
  1.8787594979546387, 10.94906990605142, 0.0, 0.0007289346991508072,
  0.9677937080626833, 0.0, 0.00014003424285435884, 0.9981766977854967,
  0.00031949755934435053, 0.0004550992113792063, 0.0, 0.0,
  0.0013648766163243398, 0.0, 0.0, 0.0, 0.0, 0.0, 7.466890328078848, 0.0,
  17.445833984131262, 0.0006235601634041466, 0.0, 0.0, 6.683678146179332,
  0.00037724407979611296, 1.027889937768264, 225.20515300849274, 0.0, 0.0,
  19.213238186143016, 0.0011401524586618361, 0.001237755635509985,
  176.39317598450694, 0.0, 0.0, 24.43300999870476, 0.28520802612117757,
  0.0004485436923833408, 0.0, 0.0, 0.0, 34.77906344483772, 44.835625328877896,
  0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0008680556573291698, 0.0, 0.0,
  0.0, 0.0, 0.0, 0.0005313191874358747, 0.0, 0.00016533814161379112, 0.0, 0.0,
  0.0, 0.0, 0.0, 0.0004179171803251336, 0.0017290828234722833, 0.0,
  0.0020827005846636437, 0.0, 0.0, 8.826982764996862, 23.19243343998926, 0.0,
  95.1080498811086, 0.9863978034400682, 0.9834382792465353,
  0.0012286405048278493, 171.2667255897307, 0.9807858872435379, 0.0, 0.0, 0.0,
  0.0005130064588990679, 0.0, 0.00010854057858411537,
]);

/* sRGB u8 -> linear, tabulated: only 256 possible inputs. */
const SS2_SRGB_LUT = (() => {
  const t = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    t[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return t;
})();

/* Gaussian kernel, scipy's exact construction: sigma 1.5, truncate 3.33,
 * radius int(3.33 * 1.5 + 0.5) = 5, normalised. */
const SS2_R = 5;
const SS2_KERNEL = (() => {
  const sigma = 1.5;
  const k = new Float64Array(2 * SS2_R + 1);
  let sum = 0;
  for (let i = -SS2_R; i <= SS2_R; i++) {
    const v = Math.exp(-0.5 * (i * i) / (sigma * sigma));
    k[i + SS2_R] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
})();

/* ------------------------------------------------------------------------- *
 * plane pool - one job at a time per worker, so module-level reuse is safe
 * ------------------------------------------------------------------------- */

/* Planes are Float32: validated against the float64 reference below with the
 * same tolerance as the original port (the accumulators that feed the norms
 * stay double precision, which is where the metric is actually sensitive).
 * Float64 planes on a 12MP frame needed ~1.8GB of simultaneous buffers, the
 * allocations threw inside the worker, every lossy candidate silently died,
 * and a multi-megabyte lossless file won by forfeit. */
const SS2_F = Float32Array;

const SS2_POOL = new Map();
const SS2_POOL_MAX_LEN = 3_000_000;   // never retain planes above ~12MB
function ss2Take(n) {
  const bucket = SS2_POOL.get(n);
  return bucket && bucket.length ? bucket.pop() : new SS2_F(n);
}
function ss2Give(...arrays) {
  for (const a of arrays) {
    if (!a || a.length > SS2_POOL_MAX_LEN) continue;
    let bucket = SS2_POOL.get(a.length);
    if (!bucket) SS2_POOL.set(a.length, bucket = []);
    if (bucket.length < 3) bucket.push(a);
  }
}
function ss2Drain() { SS2_POOL.clear(); }

/* ------------------------------------------------------------------------- *
 * pixel pipeline
 * ------------------------------------------------------------------------- */

/** Interleaved RGBA u8 -> three linear planes. Compositing happens in sRGB u8
 *  with rounding, exactly as PIL's alpha_composite does on the desktop. */
function ss2LinearPlanes(rgba, w, h, backdrop) {
  const n = w * h;
  const R = ss2Take(n), G = ss2Take(n), B = ss2Take(n);
  if (!backdrop) {
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      R[i] = SS2_SRGB_LUT[rgba[o]];
      G[i] = SS2_SRGB_LUT[rgba[o + 1]];
      B[i] = SS2_SRGB_LUT[rgba[o + 2]];
    }
  } else {
    const [br, bg, bb] = backdrop;
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const a = rgba[o + 3] / 255;
      R[i] = SS2_SRGB_LUT[Math.round(rgba[o] * a + br * (1 - a))];
      G[i] = SS2_SRGB_LUT[Math.round(rgba[o + 1] * a + bg * (1 - a))];
      B[i] = SS2_SRGB_LUT[Math.round(rgba[o + 2] * a + bb * (1 - a))];
    }
  }
  return { R, G, B };
}

/** Linear RGB planes -> positive XYB planes (allocates three planes). */
function ss2Xyb(R, G, B, n) {
  const X = ss2Take(n), Y = ss2Take(n), Bp = ss2Take(n);
  for (let i = 0; i < n; i++) {
    const r = R[i], g = G[i], b = B[i];
    let m0 = SS2_M00 * r + SS2_M01 * g + SS2_M02 * b + SS2_BIAS;
    let m1 = SS2_M10 * r + SS2_M11 * g + SS2_M12 * b + SS2_BIAS;
    let m2 = SS2_M20 * r + SS2_M21 * g + SS2_M22 * b + SS2_BIAS;
    if (m0 < 0) m0 = 0;
    if (m1 < 0) m1 = 0;
    if (m2 < 0) m2 = 0;
    m0 = Math.cbrt(m0) - SS2_CBRT_BIAS;
    m1 = Math.cbrt(m1) - SS2_CBRT_BIAS;
    m2 = Math.cbrt(m2) - SS2_CBRT_BIAS;
    const x = 0.5 * (m0 - m1);
    const y = 0.5 * (m0 + m1);
    // MakePositiveXYB, in the reference's exact order: B uses Y before its offset.
    Bp[i] = (m2 - y) + 0.55;
    X[i] = x * 14.0 + 0.42;
    Y[i] = y + 0.01;
  }
  return { X, Y, Bp };
}

/** Separable Gaussian. Zero boundary along x, symmetric reflection along y -
 *  matching the reference's transposed padding (see the header comment). */
function ss2Blur(src, w, h, tmp, dst) {
  const k = SS2_KERNEL, r = SS2_R;
  // pass 1: horizontal, zero boundary
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      const lo = Math.max(-r, -x), hi = Math.min(r, w - 1 - x);
      for (let d = lo; d <= hi; d++) acc += k[d + r] * src[row + x + d];
      tmp[row + x] = acc;   // out-of-range taps contribute zero
    }
  }
  // pass 2: vertical, symmetric reflection (d c b a | a b c d | d c b a)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let d = -r; d <= r; d++) {
        let yy = y + d;
        if (yy < 0) yy = -yy - 1;
        else if (yy >= h) yy = 2 * h - 1 - yy;
        acc += k[d + r] * tmp[yy * w + x];
      }
      dst[y * w + x] = acc;
    }
  }
  return dst;
}

/** 2x2 box downsample with ceil dimensions; edge cells average the partial
 *  block. Operates on linear RGB, as the reference does. */
function ss2Downsample(P, w, h) {
  const ow = (w + 1) >> 1, oh = (h + 1) >> 1;
  const out = ss2Take(ow * oh);
  for (let oy = 0; oy < oh; oy++) {
    const y0 = oy * 2, y1 = Math.min(y0 + 2, h);
    for (let ox = 0; ox < ow; ox++) {
      const x0 = ox * 2, x1 = Math.min(x0 + 2, w);
      let acc = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) acc += P[y * w + x];
      }
      out[oy * ow + ox] = acc / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * per-scale feature extraction
 * ------------------------------------------------------------------------- */

/** For one channel at one scale: [ssim1, ssim4, art1, art4, det1, det4]. */
function ss2ChannelFeatures(x1, x2, w, h, scratch) {
  const n = w * h;
  const { tmp, mu1, mu2, s11, s22, s12, prod } = scratch;

  ss2Blur(x1, w, h, tmp, mu1);
  ss2Blur(x2, w, h, tmp, mu2);
  for (let i = 0; i < n; i++) prod[i] = x1[i] * x1[i];
  ss2Blur(prod, w, h, tmp, s11);
  for (let i = 0; i < n; i++) prod[i] = x2[i] * x2[i];
  ss2Blur(prod, w, h, tmp, s22);
  for (let i = 0; i < n; i++) prod[i] = x1[i] * x2[i];
  ss2Blur(prod, w, h, tmp, s12);

  let d1 = 0, d4 = 0, a1 = 0, a4 = 0, l1 = 0, l4 = 0;
  for (let i = 0; i < n; i++) {
    const m1 = mu1[i], m2 = mu2[i];
    const numM = 1.0 - (m1 - m2) * (m1 - m2);
    const numS = 2.0 * (s12[i] - m1 * m2) + SS2_KC2;
    const denS = (s11[i] - m1 * m1) + (s22[i] - m2 * m2) + SS2_KC2;
    let d = 1.0 - (numM * numS / denS);
    if (d < 0) d = 0;
    d1 += d;
    const dd = d * d;
    d4 += dd * dd;

    const e = (1.0 + Math.abs(x2[i] - m2)) / (1.0 + Math.abs(x1[i] - m1)) - 1.0;
    if (e > 0) { a1 += e; const ee = e * e; a4 += ee * ee; }
    else if (e < 0) { const v = -e; l1 += v; const vv = v * v; l4 += vv * vv; }
  }
  return [
    d1 / n, Math.pow(d4 / n, 0.25),
    a1 / n, Math.pow(a4 / n, 0.25),
    l1 / n, Math.pow(l4 / n, 0.25),
  ];
}

/* ------------------------------------------------------------------------- *
 * the metric
 * ------------------------------------------------------------------------- */

/**
 * SSIMULACRA 2 between two interleaved RGBA u8 frames of equal size.
 * `backdrop` is [r, g, b] in 0-255 to composite both frames over, or null to
 * ignore alpha. Returns the score on the reference's 100-point scale.
 */
function ss2Score(rgbaRef, rgbaCand, w, h, backdrop = null) {
  let lin1 = ss2LinearPlanes(rgbaRef, w, h, backdrop);
  let lin2 = ss2LinearPlanes(rgbaCand, w, h, backdrop);
  let cw = w, ch = h;

  // features[scale][channel][6]
  const perScale = [];

  for (let scale = 0; scale < SS2_NUM_SCALES; scale++) {
    if (cw < 8 || ch < 8) break;
    const n = cw * ch;

    const xyb1 = ss2Xyb(lin1.R, lin1.G, lin1.B, n);
    const xyb2 = ss2Xyb(lin2.R, lin2.G, lin2.B, n);

    const scratch = {
      tmp: ss2Take(n), mu1: ss2Take(n), mu2: ss2Take(n),
      s11: ss2Take(n), s22: ss2Take(n), s12: ss2Take(n), prod: ss2Take(n),
    };
    const chans = [
      [xyb1.X, xyb2.X], [xyb1.Y, xyb2.Y], [xyb1.Bp, xyb2.Bp],
    ].map(([a, b]) => ss2ChannelFeatures(a, b, cw, ch, scratch));
    perScale.push(chans);

    ss2Give(scratch.tmp, scratch.mu1, scratch.mu2, scratch.s11, scratch.s22,
            scratch.s12, scratch.prod,
            xyb1.X, xyb1.Y, xyb1.Bp, xyb2.X, xyb2.Y, xyb2.Bp);

    if (scale < SS2_NUM_SCALES - 1) {
      const nlin1 = {
        R: ss2Downsample(lin1.R, cw, ch),
        G: ss2Downsample(lin1.G, cw, ch),
        B: ss2Downsample(lin1.B, cw, ch),
      };
      const nlin2 = {
        R: ss2Downsample(lin2.R, cw, ch),
        G: ss2Downsample(lin2.G, cw, ch),
        B: ss2Downsample(lin2.B, cw, ch),
      };
      ss2Give(lin1.R, lin1.G, lin1.B, lin2.R, lin2.G, lin2.B);
      lin1 = nlin1; lin2 = nlin2;
      cw = (cw + 1) >> 1; ch = (ch + 1) >> 1;
    } else {
      ss2Give(lin1.R, lin1.G, lin1.B, lin2.R, lin2.G, lin2.B);
      lin1 = lin2 = null;
    }
  }
  if (lin1) ss2Give(lin1.R, lin1.G, lin1.B, lin2.R, lin2.G, lin2.B);

  // Weight application, replicating the reference's running index exactly -
  // including its behaviour when fewer than 6 scales were computed.
  let ssim = 0, i = 0;
  for (let c = 0; c < 3; c++) {
    for (let s = 0; s < perScale.length; s++) {
      const f = perScale[s][c];
      for (let nrm = 0; nrm < 2; nrm++) {
        ssim += SS2_WEIGHTS[i++] * Math.abs(f[nrm]);        // ssim norm
        ssim += SS2_WEIGHTS[i++] * Math.abs(f[2 + nrm]);    // artifact norm
        ssim += SS2_WEIGHTS[i++] * Math.abs(f[4 + nrm]);    // detail-loss norm
      }
    }
  }

  ssim *= 0.9562382616834844;
  ssim = 2.326765642916932 * ssim
       - 0.020884521182843837 * ssim * ssim
       + 6.248496625763138e-05 * ssim * ssim * ssim;
  return ssim > 0 ? 100.0 - 10.0 * Math.pow(ssim, 0.6276336467831387) : 100.0;
}
