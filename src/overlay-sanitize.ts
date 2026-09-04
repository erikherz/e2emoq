// The broadcaster's overlay markup, made safe to put in a viewer's document.
//
// One module, used twice: the viewer renders through it, and the broadcaster's editor previews
// through the SAME call. That is deliberate — an allowlist the author cannot see the effect of
// is indistinguishable from a bug, which is exactly how the first version of this was
// experienced: headings and lists came out as unstyled text with no explanation.
//
// WHAT THIS IS DEFENDING
//
// Not the page. The content key. The viewer's document derives a media key from the share link
// and holds it in memory, so ANY script running in that document can read it and hand the
// plaintext to someone the broadcaster never shared it with. Every rule below exists to keep
// attacker-controlled script out of this origin; nothing else here is load-bearing.
//
// `<script>` was never the interesting payload — innerHTML does not execute script tags. The
// real vector is event-handler attributes, which it does honour, so `<img src=x onerror=…>`
// runs. That is why this uses a real sanitiser and not tag filtering.
//
// WHAT IS ALLOWED, AND WHY THAT IS SAFE
//
// Structure and text — headings, lists, tables, rules, quotes, media — carry no scripting
// capability at all. Their absence from the first allowlist bought nothing; a page cannot be
// attacked with an `<h1>`. They are all back.
//
// IFRAMES, WHICH ARE THE ONE REAL TRADE
//
// An embed is a third party's page inside ours, and the rule that makes it survivable is
// simple: it must not be OUR origin. A cross-origin frame cannot touch `window.parent` — the
// same-origin policy stops it — so pollev.com, YouTube or a map can run all the script they
// like and never reach the key. Two shapes break that and are refused:
//
//   - a same-host src (`/`, `https://e2emoq.com/…`), which IS this origin and can walk
//     straight up to the parent document;
//   - `srcdoc`, which inherits the embedding origin and is the same hole wearing a hat.
//
// Anything non-https is refused too, so an embed cannot downgrade the page.
//
// Three attributes are then forced rather than trusted, because each is a way for the frame to
// climb back out:
//
//   - `sandbox` — set by us, and notably WITHOUT allow-top-navigation, so an embed cannot
//     navigate the viewer away from the broadcast they are watching. allow-same-origin is
//     present and is safe precisely because we forced the src cross-origin: it gives the frame
//     its OWN origin (pollev.com), not ours, which is what its cookies and storage need.
//   - `allow` — permissions delegation. Left alone, an embed could ask for `camera; microphone;
//     geolocation` and be handed the viewer's devices by a page they trusted for a broadcast.
//     Overwritten with a media-only set.
//   - `referrerpolicy` — the share link lives in the URL. Not sending it to a third party.
//
// The remaining hole in that story is a frame navigating ITSELF to this origin after load,
// which allow-same-origin would then make same-origin. The Worker closes it from the other
// side by serving `frame-ancestors 'none'`, so no e2emoq.com document can be framed at all.
// Both halves are required; do not remove one because the other looks sufficient.

import DOMPurify from "dompurify";

/** Tags with no scripting capability: text, structure, media. */
const ALLOWED_TAGS = [
  // inline text
  "b", "strong", "i", "em", "u", "s", "span", "small", "mark", "sub", "sup",
  "del", "ins", "abbr", "cite", "q", "time", "code", "kbd", "samp", "var", "br", "wbr",
  // blocks
  "p", "div", "hr", "pre", "blockquote", "address",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "section", "article", "header", "footer", "aside", "figure", "figcaption",
  "details", "summary",
  // lists
  "ul", "ol", "li", "dl", "dt", "dd",
  // tables
  "table", "caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "th", "td",
  // media
  "a", "img", "picture", "source", "video", "audio", "track",
  // third-party embeds, heavily constrained below
  "iframe",
];

const ALLOWED_ATTR = [
  "class", "style", "title", "dir", "lang",
  "href", "target", "rel",
  "src", "alt", "width", "height", "loading",
  // tables and lists
  "colspan", "rowspan", "span", "scope", "start", "reversed", "value",
  // media
  "controls", "loop", "muted", "playsinline", "poster", "preload", "autoplay",
  "kind", "srclang", "label", "type", "media",
  // misc
  "datetime", "open", "allowfullscreen",
];

// `id` and `name` are deliberately absent. Both create named properties on `window` and
// `document`, which is the DOM-clobbering class of bug — markup that quietly replaces a global
// the application is relying on. An overlay has no need for either.
//
// `srcdoc` gets its own line because it is the iframe hole described above; `srcset` and
// `xlink:href` are URL-bearing attributes that route around ALLOWED_URI_REGEXP.
const FORBID_ATTR = ["srcdoc", "srcset", "formaction", "xlink:href", "ping"];

const FORBID_TAGS = ["script", "style", "object", "embed", "form", "input", "textarea", "select", "button"];

// https, or an inline image. Not javascript:, not data: anything-else, not http.
const ALLOWED_URI_REGEXP = /^(?:https?:|data:image\/)/i;

// Attributes that do not hold URLs, declared inert.
//
// This is not a nicety, it is required by the line above. DOMPurify tests an attribute's VALUE
// against ALLOWED_URI_REGEXP unless the attribute is known to be URI-safe, and the default
// regexp tolerates relative URLs so ordinary values slip through. Ours does not — it exists to
// refuse anything that is not https — so with no exemptions `target="_blank"`, `width="560"`,
// `colspan="2"` and `controls` are all judged as malformed URLs and silently deleted. That is
// how the missing rel=noopener showed up: not a broken hook, a `target` that never survived to
// reach it.
//
// src, href, poster and srcset are deliberately NOT here. They are the ones that must be
// checked.
const URI_SAFE_ATTR = [
  "target", "rel", "colspan", "rowspan", "span", "scope", "start", "reversed",
  "controls", "loop", "muted", "playsinline", "preload", "autoplay",
  "kind", "srclang", "type", "media", "datetime", "open", "allowfullscreen",
  "width", "height", "loading", "dir", "lang",
];

// No allow-top-navigation: an embed must not be able to navigate the viewer off the broadcast.
const IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-forms allow-presentation";
// Media only. Never camera, microphone, geolocation or display-capture.
const IFRAME_ALLOW = "autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write";

let hooksInstalled = false;

function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    const tag = el.tagName;

    // target="_blank" hands the opened page a live handle on ours via window.opener, which is
    // enough to navigate this tab somewhere else while the viewer is looking at the new one.
    if (tag === "A" && el.hasAttribute("target")) {
      el.setAttribute("rel", "noopener noreferrer");
    }

    if (tag === "IFRAME") {
      const raw = el.getAttribute("src") || "";
      let sameOrigin = true;
      let https = false;
      try {
        // Resolved against this document, so a bare "/" or "//host" is judged as the browser
        // would load it rather than as the string it looks like.
        const u = new URL(raw, window.location.href);
        https = u.protocol === "https:";
        sameOrigin = u.host === window.location.host;
      } catch {
        https = false;
      }
      if (!https || sameOrigin) {
        el.remove();
        return;
      }
      el.setAttribute("sandbox", IFRAME_SANDBOX);
      el.setAttribute("allow", IFRAME_ALLOW);
      el.setAttribute("referrerpolicy", "no-referrer");
      el.removeAttribute("srcdoc");
    }
  });
}

export interface OverlayRender {
  /** Sanitised markup, safe to assign to innerHTML. */
  html: string;
  /** Human-readable list of what was dropped, for the author's preview. Empty when nothing was. */
  removed: string[];
}

/**
 * Sanitise overlay markup and report what was taken out.
 *
 * The report is the part that makes the allowlist honest: a broadcaster who pastes an embed
 * that gets refused should be told so while they are still looking at the editor, not left to
 * discover it from a viewer.
 */
export function renderOverlay(dirty: string): OverlayRender {
  installHooks();
  const html = DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    ADD_URI_SAFE_ATTR: URI_SAFE_ATTR,
    FORBID_TAGS,
    FORBID_ATTR,
  });

  // DOMPurify.removed is populated per call. Turn it into names an author can act on.
  //
  // The document wrapper is in there on every single call — sanitize() parses into a document
  // and unwraps it, which it records as a removal. Reporting it would put a permanent
  // "removed: <body>" under an author's perfectly good snippet, so the structural tags are
  // filtered out and only things the author actually wrote are named.
  const STRUCTURAL = new Set(["html", "head", "body"]);
  const removed = new Set<string>();
  for (const item of DOMPurify.removed as Array<{ element?: Node; attribute?: { name?: string }; from?: Node }>) {
    const el = item.element as Element | undefined;
    if (el?.tagName) {
      const tag = el.tagName.toLowerCase();
      if (!STRUCTURAL.has(tag)) removed.add(`<${tag}>`);
    } else if (item.attribute?.name) {
      const owner = item.from as Element | undefined;
      removed.add(owner?.tagName ? `${owner.tagName.toLowerCase()}[${item.attribute.name}]` : item.attribute.name);
    }
  }

  // An iframe refused by the hook above is removed after DOMPurify has finished counting, so
  // it never lands in `removed`. Say so explicitly rather than reporting nothing.
  if (/<iframe/i.test(dirty) && !/<iframe/i.test(html)) {
    removed.add("<iframe> (embeds must be https and on another site)");
  }

  return { html, removed: [...removed] };
}
