"""Generate the use-case pages: one app, many front doors.

Each page IS web/index.html - same engine, same shell, same design system -
with five things swapped: the <html> preset attributes the app reads at boot,
the title/description/canonical/social URLs, the about strip's prose (unique
per page, written to the copy rules), a visible FAQ that a FAQPage JSON-LD
block mirrors word for word, and nothing else. The homepage is the template,
so a page can never drift from the app it fronts.

Run it after any change to web/index.html and commit the result:

    python tools/gen_seo_pages.py            # writes web/<slug>.html + sitemap.xml
    python tools/gen_seo_pages.py --check    # exit 1 if anything is stale

tests/test_seo_pages.py gates the --check in CI.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
BASE_URL = "https://pocketsize.syedsarib.com"
LASTMOD = "2026-08-14"

PRIVACY = (
    'Your pictures never leave your computer: the compression runs in your '
    'browser, on your own device, and <a href="/nothing-is-uploaded">you can '
    'verify that yourself in about a minute</a>. After one visit it even '
    'works with no internet at all.'
)

BACK = ('This page is <a href="/">Pocketsize</a> with the plan pre-set for '
        'one job. Nothing is locked — change any control once it is open.')


def page(slug, title, desc, h1, paras, faqs, preset=None):
    return {
        "slug": slug, "title": title, "desc": desc, "h1": h1,
        "paras": paras, "faqs": faqs, "preset": preset or {},
    }


PAGES = [
    page(
        "compress-to-200kb",
        "Compress an image to 200 KB in your browser — Pocketsize",
        "Set a 200 KB limit and get the best-looking file that fits. Several "
        "formats tried, every attempt measured against your original. Free, "
        "and nothing is uploaded.",
        "Compress an image to 200 KB",
        [
            "This page opens Pocketsize with the size limit already set to "
            "200 KB. Add a picture and the engine saves it several ways — "
            "JPEG, PNG, WebP and AVIF — measures every attempt against your "
            "original, and keeps the smallest version that fits under the "
            "limit and still looks right.",
            "A 200 KB cap usually comes from a form or an upload field that "
            "refuses anything bigger. Most tools hit the number by shrinking "
            "the pixels and hoping. Pocketsize works to the byte budget "
            "directly: it searches quality levels for the best-looking file "
            "that fits, shows you the visual-match score it measured, and "
            "says so plainly if the only way under the cap would wreck the "
            "picture.",
            PRIVACY, BACK,
        ],
        [
            ("What if my image cannot fit under 200 KB?",
             "Pocketsize keeps the smallest version that is still worth "
             "looking at and tells you the limit was missed, instead of "
             "handing you a ruined picture that technically fits."),
            ("Will it shrink my image's pixels to hit the limit?",
             "Only if the plan allows shrinking — and whenever pixels were "
             "removed, the same line that shows your saving says so. Set "
             "“Shrink big photos” to “never” and the pixel "
             "count is untouched."),
            ("Is anything uploaded?",
             "No. The compression runs in your browser, and the page's own "
             "security policy makes a network upload impossible — there are "
             "instructions for checking that yourself, in the link above."),
        ],
        {"size": "200 KB"},
    ),
    page(
        "compress-to-100kb",
        "Compress an image to 100 KB in your browser — Pocketsize",
        "Get an image under 100 KB without guessing: formats and quality "
        "levels are tried and measured until the best-looking file fits. "
        "Free, private, works offline.",
        "Compress an image to 100 KB",
        [
            "This page opens Pocketsize with the size limit already set to "
            "100 KB — the ceiling that profile photos, avatars and a lot of "
            "application portals ask for. Add your picture and the engine "
            "tries several formats and quality levels, measures each attempt "
            "against the original, and keeps the smallest one under the "
            "limit that still looks right.",
            "100 KB is tight for a big photograph, so honesty matters more "
            "here, not less: every kept file carries a measured visual-match "
            "score, you can flick between before and after to judge it with "
            "your own eyes, and if the limit simply cannot be met without "
            "ruining the image, Pocketsize says exactly that.",
            PRIVACY, BACK,
        ],
        [
            ("My portal says “max 100 KB” — will the result pass?",
             "Yes: the limit is applied to the real bytes of the finished "
             "file, not an estimate. What downloads is what was measured."),
            ("Can I also make it a specific width and height?",
             "Yes — the “Shrink big photos” control caps the pixel "
             "size, and under More choices you can pick which edge the cap "
             "counts. Both work together with the 100 KB limit."),
            ("Do I need an account or a payment for this?",
             "No. Pocketsize is free, has no accounts, and runs entirely on "
             "your own device."),
        ],
        {"size": "100 KB"},
    ),
    page(
        "compress-to-50kb",
        "Compress an image to 50 KB in your browser — Pocketsize",
        "A 50 KB budget, spent as well as it can be: several formats tried, "
        "every attempt measured, the best-looking fit kept — and an honest "
        "answer when 50 KB is not enough.",
        "Compress an image to 50 KB",
        [
            "This page opens Pocketsize with the size limit already set to "
            "50 KB — thumbnail and icon territory. The engine tries JPEG, "
            "PNG, WebP and AVIF at several quality levels, measures each "
            "attempt against your original, and keeps the smallest file "
            "under the limit that still looks right.",
            "50 KB is a hard budget for anything but small or simple images, "
            "and this is where most tools quietly hand back mush. Pocketsize "
            "will not: every result shows its measured visual-match score, "
            "and when the only way under 50 KB would wreck the picture, it "
            "keeps the smallest version still worth having and tells you the "
            "limit was missed.",
            PRIVACY, BACK,
        ],
        [
            ("Why does my 50 KB version look soft when I zoom in?",
             "Because 50 KB can only hold so much detail. The visual-match "
             "score under the image tells you how close it stayed; if it is "
             "not close enough, allow a smaller pixel size — fewer pixels "
             "compress better than harder-squeezed ones."),
            ("Which format wins at 50 KB?",
             "It depends on the picture, which is why Pocketsize tries "
             "several and measures instead of guessing. Photos usually land "
             "on JPEG, WebP or AVIF; flat graphics often win as PNG with "
             "fewer colors."),
            ("Is this really running on my computer?",
             "Yes — every byte of the work happens in your browser. The "
             "“nothing is uploaded” link above shows you how to "
             "watch the network panel stay silent while it runs."),
        ],
        {"size": "50 KB"},
    ),
    page(
        "compress-to-1mb",
        "Compress an image to 1 MB in your browser — Pocketsize",
        "Bring any photo under 1 MB with the least visible change: formats "
        "and quality levels tried and measured against the original. Free, "
        "private, offline-capable.",
        "Compress an image to 1 MB",
        [
            "This page opens Pocketsize with the size limit already set to "
            "1 MB — the ceiling for a lot of email attachments, CMS uploads "
            "and document systems. Add pictures and the engine finds the "
            "best-looking version of each that fits, measured against the "
            "original rather than guessed.",
            "The good news about a 1 MB budget: for most photographs it is "
            "roomy, so Pocketsize can usually stay at quality levels where "
            "the change is invisible to your eye — and it shows you the "
            "measured score and the side-by-side comparison so you never "
            "have to take that on faith.",
            PRIVACY, BACK,
        ],
        [
            ("I need several photos under 1 MB each — one at a time?",
             "No — drop them all at once. Every picture is compressed to the "
             "same plan in parallel, and the zip you download carries a "
             "written report of what happened to each file."),
            ("Will the image quality visibly drop?",
             "Usually not at 1 MB. Every result carries a measured "
             "visual-match score, and the comparison slider lets you check "
             "with your own eyes before you keep anything."),
            ("What if my picture is already under 1 MB?",
             "Pocketsize still tries to make it smaller — and if nothing "
             "beats the original, you keep the original. A result is never a "
             "bigger file."),
        ],
        {"size": "1 MB"},
    ),
    page(
        "compress-jpeg",
        "Compress JPEG images without guesswork — Pocketsize",
        "No quality slider to guess at: pick how close it must look, and the "
        "engine measures JPEG quality levels against your original until the "
        "smallest passing file wins. Free and private.",
        "Compress a JPEG without guessing at a quality number",
        [
            "This page opens Pocketsize with the file type pinned to JPEG. "
            "Instead of asking you to guess a quality number, it asks one "
            "question — how close must the result look? — then tests real "
            "JPEG quality levels, measures each against your original, and "
            "keeps the smallest file that clears the bar you chose.",
            "Recompressing a JPEG is where quality quietly dies in most "
            "tools, because nobody measures. Pocketsize measures: every kept "
            "file shows its visual-match score, the before/after slider and "
            "difference view show you exactly what changed, and a result "
            "that comes out bigger than your original is thrown away in "
            "favour of the original itself.",
            PRIVACY, BACK,
        ],
        [
            ("What JPEG quality setting should I use?",
             "None — that is the point. Choose words like “exactly the "
             "same to your eye” and the engine finds the lowest quality "
             "level that still measures up to them."),
            ("My picture has transparency — can it be a JPEG?",
             "JPEG cannot store transparency, so Pocketsize asks you once "
             "whether to keep those images as PNG or flatten them onto "
             "white — it never decides silently."),
            ("Would WebP or AVIF beat JPEG for my image?",
             "Often, yes. Set the file type back to automatic and Pocketsize "
             "tries them all and keeps whichever measured smallest."),
        ],
        {"format": "jpeg"},
    ),
    page(
        "compress-png",
        "Compress PNG images, every pixel kept — Pocketsize",
        "Make PNGs smaller without changing a single pixel, or go further "
        "with fewer colors — measured either way. Free, in your browser, "
        "nothing uploaded.",
        "Compress a PNG — losslessly, or further",
        [
            "This page opens Pocketsize with the file type pinned to PNG. "
            "PNG is the format of screenshots, logos and interface art, and "
            "it can be compressed two honest ways: losslessly, where every "
            "pixel stays exactly as it was and only the byte count drops, or "
            "as “PNG — fewer colors”, which trades a reduced "
            "palette for a much smaller file.",
            "Pick “identical — every pixel kept” and that promise "
            "is literal: the pixels that come out are the pixels that went "
            "in, verified, never resized. Anything less than identical is "
            "measured like every other result, with the score on screen and "
            "the difference view one key away.",
            PRIVACY, BACK,
        ],
        [
            ("Does compressing a PNG keep its transparency?",
             "Yes. PNG transparency survives both paths — lossless and "
             "fewer-colors — untouched."),
            ("How can it get smaller if every pixel is kept?",
             "PNG files carry room for smarter internal encoding. Lossless "
             "compression repacks the same pixels in fewer bytes — like "
             "folding the same clothes into a smaller case."),
            ("When should I allow “fewer colors”?",
             "Screenshots, diagrams and flat artwork often use only a "
             "handful of colors, so cutting the palette shrinks the file "
             "hard while looking the same. The comparison is on screen — "
             "judge it yourself before keeping anything."),
        ],
        {"format": "png"},
    ),
    page(
        "compress-webp",
        "Compress WebP images in your browser — Pocketsize",
        "Compress to WebP with the quality measured, not guessed — or "
        "convert JPEG and PNG to WebP and see the saving before you keep "
        "it. Free and private.",
        "Compress to WebP, measured",
        [
            "This page opens Pocketsize with the file type pinned to WebP — "
            "the format that usually beats JPEG at the same visible quality "
            "and also carries transparency. Add JPEGs, PNGs or existing "
            "WebPs; each is re-encoded at several quality levels, measured "
            "against the original, and the smallest passing file is kept.",
            "WebP also has a lossless mode, and Pocketsize uses it where it "
            "wins: choose “identical — every pixel kept” and the "
            "result stores your exact pixels in fewer bytes. Either way "
            "the measured visual-match score and the side-by-side comparison "
            "are on screen before you download anything.",
            PRIVACY, BACK,
        ],
        [
            ("Do browsers and apps accept WebP now?",
             "Every current browser displays WebP. Some older software and a "
             "few upload forms still refuse it — if a form rejects yours, "
             "the JPEG page one link away has you covered."),
            ("Does WebP keep transparency?",
             "Yes — WebP carries an alpha channel, so logos and cutouts "
             "convert from PNG without losing their transparent background."),
            ("Is converting to WebP always smaller?",
             "Usually, but not always — which is why Pocketsize measures. If "
             "nothing beats your original file, you keep the original: a "
             "result is never bigger."),
        ],
        {"format": "webp"},
    ),
    page(
        "png-to-avif",
        "Convert PNG to AVIF in your browser — Pocketsize",
        "Turn heavy PNGs into small AVIFs with the loss measured, not "
        "guessed. Transparency kept, nothing uploaded, and the before/after "
        "proof on screen.",
        "Convert PNG to AVIF",
        [
            "This page opens Pocketsize with the file type pinned to AVIF — "
            "the newest of the widely supported image formats, and routinely "
            "the smallest for photographs. Drop PNGs (or anything else) and "
            "each is encoded to AVIF at several quality levels, measured "
            "against your original, smallest passing file kept.",
            "A PNG photograph is often ten times bigger than an AVIF that "
            "looks the same, so the savings here can be dramatic — and "
            "because every result carries a measured visual-match score and "
            "a side-by-side comparison, you see precisely what the smaller "
            "file cost before you keep it. Transparency survives the "
            "conversion: AVIF has a full alpha channel.",
            PRIVACY, BACK,
        ],
        [
            ("Where is AVIF safe to use?",
             "Every current major browser displays AVIF. Older browsers and "
             "some desktop software still do not — for maximum compatibility "
             "with old systems, WebP or JPEG remain the safer handoff."),
            ("Why is AVIF encoding slower than the others?",
             "AVIF spends more computing to find more savings; that is the "
             "trade. Pocketsize runs it in parallel workers and shows the "
             "first good result in seconds while the search finishes behind "
             "it."),
            ("Does this upload my PNGs anywhere?",
             "No — the AVIF encoder itself runs inside your browser. The "
             "link above shows how to verify the network stays silent."),
        ],
        {"format": "avif"},
    ),
    page(
        "compress-for-email",
        "Compress images for email — Pocketsize",
        "Make photos email-sized in one step: the email plan picks sensible "
        "dimensions and quality, measures the result, and zips a batch with "
        "a written report. Free and private.",
        "Compress images for email",
        [
            "This page opens Pocketsize with the destination set to "
            "“email” — a plan sized for what email actually needs: "
            "pictures big enough to look right on any screen the message is "
            "read on, small enough that a few of them do not bounce off an "
            "attachment limit.",
            "Drop the photos, and each one is compressed to that plan and "
            "measured against its original. Several at once become a zip, "
            "and the zip carries a written report of what happened to every "
            "file — sizes in and out, the measured score, and whether pixels "
            "were removed — which is worth keeping when the pictures matter.",
            PRIVACY, BACK,
        ],
        [
            ("What size should photos be for email?",
             "The email plan's answer is on screen in the plan panel — a "
             "pixel cap that reads well everywhere without carrying camera "
             "resolution nobody will see. You can change it before or after "
             "compressing."),
            ("My mail provider caps attachments at 25 MB — will this help?",
             "Dramatically, in most cases: full-resolution photos are "
             "usually a few hundred kilobytes after compression. You can "
             "also set an exact per-file size cap under More choices."),
            ("Can I send the originals' quality proof along?",
             "Yes — the zip's written report lists every file's before and "
             "after size and its measured visual-match score."),
        ],
        {"target": "email"},
    ),
    page(
        "bulk-image-compressor",
        "Compress many images at once, free — Pocketsize",
        "Drop a whole folder: every picture compressed in parallel on your "
        "own device, measured against its original, zipped with a written "
        "report. No upload, no queue, no account.",
        "Compress a whole folder of images at once",
        [
            "Drop any number of pictures onto this page — or paste, or pick "
            "them — and Pocketsize compresses them in parallel, one worker "
            "per processor core your machine has. There is no per-file "
            "queueing, no “upgrade for batch” wall, and no upload "
            "wait, because there is no upload: the work happens on your own "
            "computer.",
            "Every picture in the batch is measured against its own "
            "original, the first finished result appears in seconds, and "
            "the batch footer counts progress as it runs. When it is done, "
            "one button downloads everything as a zip — with a plain-text "
            "report inside recording each file's sizes, measured score, and "
            "whether pixels were removed.",
            PRIVACY, BACK,
        ],
        [
            ("How many images can I compress at once?",
             "There is no built-in limit — batches are bounded by your "
             "machine's memory, not by a plan or a paywall. Hundreds of "
             "ordinary photos are fine on an ordinary laptop."),
            ("Do all the images get the same settings?",
             "They follow one plan, and any single image can override it — "
             "select a picture and use “Just this image” to redo "
             "it with its own format or quality."),
            ("Is a big batch uploaded somewhere to be processed?",
             "No — nothing is, ever, regardless of batch size. The work is "
             "local, which is also why a hundred images do not spend ten "
             "minutes uploading first."),
        ],
        {},
    ),
    # Video. These exist because the local-first argument is stronger for
    # video than it is for pictures: the files are large enough that
    # uploading one is a real wait and a real privacy decision, and every
    # well-known alternative uploads. The presets set a destination, which is
    # what carries a video's frame cap, quality floor and byte ceiling - the
    # same table the desktop engine reads.
    page(
        "compress-video",
        "Compress video in your browser — free, private — Pocketsize",
        "Make a video smaller without uploading it. Re-encoded on your own "
        "device, measured against the original frame by frame, and played "
        "back side by side so you can see the quality was kept.",
        "Compress video in your browser",
        [
            "Add an MP4, MOV, WebM or MKV and Pocketsize re-encodes it on "
            "your own device. It measures sample frames of the result "
            "against the same moments of your original, keeps the smallest "
            "version that still looks right, and then plays both clips side "
            "by side, in step, so you can check rather than trust.",
            "Almost every other online video compressor uploads your file to "
            "a server first. That is a real wait on a large clip, and a real "
            "decision about a video that might be of your family. This one "
            "has no server to upload to: the encoding runs in your browser, "
            "using the video engine your browser already ships.",
            "If the picture had to be made smaller on screen, or a size "
            "limit cost some sharpness, the same line that shows your saving "
            "says so. A number you cannot check is not evidence.",
            PRIVACY, BACK,
        ],
        [
            ("Which video formats can it read?",
             "MP4, MOV, WebM, MKV and most things a browser can already "
             "play, including the HEVC clips an iPhone records. Results are "
             "written as MP4 so they play everywhere."),
            ("Is my video uploaded anywhere?",
             "No. There is no server and no upload path — the whole encode "
             "runs on your device, which you can verify yourself in about a "
             "minute."),
            ("How long does a video take?",
             "Longer than a picture, because there is far more of it: expect "
             "a wait comparable to the clip's own running time. It reports "
             "what it is doing throughout, and you can stop it at any point."),
            ("Will the quality drop?",
             "Only as far as you allow. The engine searches for the smallest "
             "encode that still measures as looking right, and reports the "
             "score it measured — with a second, independent measurement "
             "alongside it."),
        ],
        {"target": "web"},
    ),
    page(
        "compress-video-for-discord",
        "Compress a video for Discord's 10 MB limit — Pocketsize",
        "Fit a video under Discord's free 10 MB limit without uploading it "
        "anywhere first. Quality searched, not guessed, and the result is "
        "measured against your original.",
        "Compress a video for Discord",
        [
            "Discord's free tier stops at 10 MB, which is the wall most "
            "phone clips hit immediately. This page opens Pocketsize with "
            "that destination already chosen, so the byte ceiling, the frame "
            "size and the quality floor are set for you.",
            "Quality comes first even under a limit. If the honest smallest "
            "encode already fits well under 10 MB, that is what you get — a "
            "limit is not an instruction to spend it. Only when the quality "
            "answer will not fit does the size cap take over, and then the "
            "result says plainly that the picture is not as sharp as the "
            "original in order to fit.",
            PRIVACY, BACK,
        ],
        [
            ("Will it definitely fit under 10 MB?",
             "It aims just under the limit to leave room for container "
             "overhead, and it tells you plainly if a clip is so long that "
             "fitting would have wrecked it, rather than handing you "
             "something ruined that technically fits."),
            ("What about Nitro's larger limits?",
             "Open the plan and set your own size limit — the destinations "
             "are a starting point, not a cage."),
            ("Does it keep the sound?",
             "Yes. Sound is copied across untouched whenever the format "
             "allows it, and when it has to be re-encoded the facts panel "
             "says so."),
        ],
        {"target": "chat"},
    ),
    page(
        "compress-video-for-email",
        "Compress a video to email it — under 25 MB — Pocketsize",
        "Get a video small enough to attach without uploading it to anyone. "
        "Runs on your own device and shows you the measured quality of what "
        "it made.",
        "Compress a video small enough to email",
        [
            "Gmail and Outlook stop at 25 MB, and attachments are encoded in "
            "a way that inflates them on the way out — so the number that "
            "actually matters is nearer 18 MB. This page opens with that "
            "target already set.",
            "The clip is re-encoded on your own device and measured against "
            "your original, so what you attach is a file whose quality has "
            "been checked rather than assumed. Nothing is uploaded to reach "
            "that answer, which for a personal video is the whole point.",
            PRIVACY, BACK,
        ],
        [
            ("Why 18 MB and not 25?",
             "Mail attachments are re-encoded for transport, which adds "
             "roughly a third to their size. Aiming at 25 MB would produce "
             "files that arrive too big."),
            ("Can I send a longer video another way?",
             "For anything long, a link from a file-sharing service beats an "
             "attachment. This is for the clip that nearly fits."),
        ],
        {"target": "email"},
    ),
]


def _about_section(spec):
    faqs_html = "\n".join(
        f"    <h2>{q}</h2>\n    <p>{a}</p>" for q, a in spec["faqs"]
    )
    paras = "\n".join(f"    <p>{p}</p>" for p in spec["paras"])
    return f'''<section id="about" aria-labelledby="about-h">
  <div class="about-inner">
    <h2 id="about-h">{spec["h1"]}</h2>
{paras}
{faqs_html}
  </div>
</section>'''


def _faq_jsonld(spec):
    data = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {
                "@type": "Question",
                "name": re.sub(r"<[^>]+>", "", q),
                "acceptedAnswer": {"@type": "Answer",
                                   "text": re.sub(r"<[^>]+>", "", a)},
            }
            for q, a in spec["faqs"]
        ],
    }
    return ('<script type="application/ld+json">\n'
            + json.dumps(data, indent=2, ensure_ascii=False)
            + "\n</script>")


PRESET_ATTRS = {"target": "data-preset-target",
                "size": "data-preset-size",
                "format": "data-preset-format"}


def render(spec, template):
    html = template
    url = f"{BASE_URL}/{spec['slug']}"

    attrs = "".join(f' {PRESET_ATTRS[k]}="{v}"' for k, v in spec["preset"].items())
    html = html.replace('<html lang="en">', f'<html lang="en"{attrs}>', 1)

    html = re.sub(r"<title>.*?</title>",
                  f"<title>{spec['title']}</title>", html, count=1, flags=re.S)
    html = re.sub(r'(<meta name="description" content=")[^"]*',
                  rf"\g<1>{spec['desc']}", html, count=1)
    html = re.sub(r'(<link rel="canonical" href=")[^"]*', rf"\g<1>{url}", html, count=1)
    for prop in ("og:url",):
        html = re.sub(rf'(<meta property="{prop}" content=")[^"]*',
                      rf"\g<1>{url}", html, count=1)
    for prop in ("og:title", "twitter:title"):
        pat = (rf'(<meta (?:property|name)="{prop}" content=")[^"]*')
        html = re.sub(pat, rf"\g<1>{spec['title']}", html, count=1)
    for prop in ("og:description", "twitter:description"):
        pat = (rf'(<meta (?:property|name)="{prop}" content=")[^"]*')
        html = re.sub(pat, rf"\g<1>{spec['desc']}", html, count=1)

    # The FAQ data block joins the WebApplication one at the end of <head>.
    # It mirrors the visible FAQ word for word - schema for content the page
    # does not show is the kind of cleverness that gets sites penalised.
    html = html.replace("</head>", _faq_jsonld(spec) + "\n</head>", 1)

    # The page's one <h1> is the hidden document title at the top of body
    # (see index.html); each use-case page gets its own phrase there, the same
    # words its visible about heading (an h2) opens with.
    html = re.sub(r'(<h1 class="vh">)[^<]*',
                  lambda m: m.group(1) + spec["h1"], html, count=1)

    html = re.sub(r'<section id="about" aria-labelledby="about-h">.*?</section>',
                  _about_section(spec), html, count=1, flags=re.S)
    return html


def sitemap():
    urls = [f"{BASE_URL}/"] + [f"{BASE_URL}/{p['slug']}" for p in PAGES]
    urls.append(f"{BASE_URL}/nothing-is-uploaded")
    entries = "\n".join(
        f"  <url>\n    <loc>{u}</loc>\n    <lastmod>{LASTMOD}</lastmod>\n"
        f"    <changefreq>monthly</changefreq>\n"
        f"    <priority>{'1.0' if u.endswith('/') else '0.8'}</priority>\n  </url>"
        for u in urls)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            "<!-- The front page, its use-case front doors (generated by\n"
            "     tools/gen_seo_pages.py), and the proof page. -->\n"
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            + entries + "\n</urlset>\n")


def service_worker():
    """`sw.js` with its use-case page list rewritten from PAGES.

    The service worker needs to know which paths are real pages so it can
    keep one a person actually visited available offline. That list is this
    table, and a second hand-maintained copy of it would drift the first time
    somebody added a page - which is the mistake every other generated file
    in this repo exists to prevent. So it is generated in place, between
    markers, and `--check` fails if it goes stale.
    """
    text = (WEB / "sw.js").read_text(encoding="utf-8")
    body = "\n".join(f'  "/{p["slug"]}",' for p in PAGES)
    return re.sub(
        r"(const USE_CASE_PAGES = new Set\(\[\n).*?(\]\);)",
        lambda m: m.group(1) + body + "\n" + m.group(2),
        text, count=1, flags=re.S,
    )


def planned():
    template = (WEB / "index.html").read_text(encoding="utf-8")
    outputs = [(WEB / f"{p['slug']}.html", render(p, template)) for p in PAGES]
    outputs.append((WEB / "sitemap.xml", sitemap()))
    outputs.append((WEB / "sw.js", service_worker()))
    return outputs


def main(argv):
    check = "--check" in argv
    stale = []
    for path, content in planned():
        current = path.read_text(encoding="utf-8") if path.is_file() else None
        if current != content:
            if check:
                stale.append(path.name)
            else:
                with path.open("w", encoding="utf-8", newline="\n") as fh:
                    fh.write(content)
                print(f"wrote web/{path.name}")
    if check:
        if stale:
            print("stale: " + ", ".join(stale)
                  + " — run `python tools/gen_seo_pages.py` and commit")
            return 1
        print("use-case pages are current")
        return 0
    print(f"{len(PAGES)} pages + sitemap")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
