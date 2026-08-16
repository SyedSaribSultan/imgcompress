/* GENERATED FILE - DO NOT EDIT.
 *
 * Written by tools/gen_destinations.py from pocketsize/destinations.py, which
 * is the reference for every value here. Edit that file and re-run the
 * generator; CI regenerates this one and fails if it differs from what is
 * committed.
 *
 * Loaded by both engines: worker.js pulls it in with importScripts, and
 * index.html loads it before app.js. Both share one global scope per context,
 * so these bindings are visible to whichever file needs them.
 */

"use strict";

const DEFAULT_DESTINATION = "web";

/* The order the control offers them in. */
const DESTINATION_ORDER = [
  "web",
  "documents",
  "email",
  "chat",
  "social",
  "thumbnail",
  "original"
];

/* Which formats each destination may write. Includes the hidden ones. */
const DESTINATION_FORMATS = {
  "web": [
    "jpeg",
    "png8",
    "png",
    "webp",
    "webp-lossless",
    "avif"
  ],
  "documents": [
    "jpeg",
    "png8",
    "png"
  ],
  "email": [
    "jpeg",
    "png8",
    "png"
  ],
  "chat": [
    "jpeg",
    "png8",
    "png"
  ],
  "social": [
    "jpeg",
    "png8",
    "png"
  ],
  "thumbnail": [
    "jpeg",
    "png8",
    "png",
    "webp",
    "webp-lossless",
    "avif"
  ],
  "original": [
    "jpeg",
    "png8",
    "png",
    "webp",
    "webp-lossless",
    "avif"
  ],
  "lossless": [
    "png",
    "webp-lossless",
    "png8x"
  ]
};

/* Frame size and minimum visual match. Offered destinations only. */
const DESTINATION_NUMBERS = {
  "web": {
    "label": "Website or app",
    "maxDimension": 2560,
    "qualityTarget": 90.0,
    "help": "Smallest possible files using modern formats. Best for anything that loads in a browser."
  },
  "documents": {
    "label": "Design tool or document",
    "maxDimension": 2560,
    "qualityTarget": 90.0,
    "help": "Only formats these tools store as-is. Prevents files getting bigger when you import them."
  },
  "email": {
    "label": "Email",
    "maxDimension": 1920,
    "qualityTarget": 88.0,
    "help": "Small enough to attach, and opens everywhere."
  },
  "chat": {
    "label": "Discord or group chat",
    "maxDimension": 1920,
    "qualityTarget": 88.0,
    "help": "Fits Discord's free 10 MB limit, and plays everywhere."
  },
  "social": {
    "label": "Social media post",
    "maxDimension": 2048,
    "qualityTarget": 88.0,
    "help": "Sized and saved so Instagram, X and Facebook won't shrink it again themselves."
  },
  "thumbnail": {
    "label": "Thumbnail or avatar",
    "maxDimension": 512,
    "qualityTarget": 80.0,
    "help": "For small display sizes - profile pictures, list icons, previews."
  },
  "original": {
    "label": "Keep full quality",
    "maxDimension": 0,
    "qualityTarget": 95.0,
    "help": "No resizing, highest fidelity. For print and originals."
  }
};

/* Which video formats each destination may write, as codec+container
 * pairs. A destination missing from this map takes no video. */
const DESTINATION_VIDEO_FORMATS = {
  "web": [
    "av1-mp4",
    "h264-mp4"
  ],
  "documents": [
    "h264-mp4"
  ],
  "email": [
    "h264-mp4"
  ],
  "chat": [
    "h264-mp4",
    "av1-mp4"
  ],
  "social": [
    "h264-mp4"
  ],
  "original": [
    "av1-mp4",
    "h264-mp4"
  ]
};

/* Video's own frame size, visual match, byte ceiling and sound rule. */
const DESTINATION_VIDEO_NUMBERS = {
  "web": {
    "maxDimension": 1920,
    "qualityTarget": 92.0,
    "sizeCapMb": 0.0,
    "audio": "copy"
  },
  "documents": {
    "maxDimension": 1920,
    "qualityTarget": 90.0,
    "sizeCapMb": 0.0,
    "audio": "aac"
  },
  "email": {
    "maxDimension": 1920,
    "qualityTarget": 90.0,
    "sizeCapMb": 18.0,
    "audio": "copy"
  },
  "chat": {
    "maxDimension": 1280,
    "qualityTarget": 88.0,
    "sizeCapMb": 10.0,
    "audio": "aac"
  },
  "social": {
    "maxDimension": 1920,
    "qualityTarget": 90.0,
    "sizeCapMb": 500.0,
    "audio": "aac"
  },
  "original": {
    "maxDimension": 0,
    "qualityTarget": 96.0,
    "sizeCapMb": 0.0,
    "audio": "copy"
  }
};

/* Pre-2.7 names, so a saved setting still lands somewhere real. */
const OLD_TARGET_NAMES = {
  "figma": "documents",
  "archive": "original",
  "lossless": "original"
};

/* A ceiling, not a setting: it clamps even an explicit larger request,
 * because design tools rescale above it destructively on import. */
const DOCUMENTS_MAX_DIMENSION = 4096;

/* Resolve a possibly-old, possibly-unknown name to a real destination. */
function destinationOf(name) {
  const resolved = OLD_TARGET_NAMES[name] || name;
  return DESTINATION_FORMATS[resolved] ? resolved : DEFAULT_DESTINATION;
}
