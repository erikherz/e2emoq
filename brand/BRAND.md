# e2eMoQ brand kit

Extracted from the v1 site (git tag `e2emoq-v1-archive`) so the new build keeps the same identity.

## Assets
- `favicon.svg` — gold sunflower mark (also the logo motif). Link as `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`.
- `tokens.css` — CSS custom properties + base component classes (`.wf-*`).

## Identity
- **Name:** e2eMoQ
- **Product line:** "The Synchronized Fan Contribution Engine"
- **Logo lockup:** 🌻 emoji + **e2eMoQ** wordmark (gold), product mark below in teal.
- **Voice:** technical, provenance-focused (TAMS / WPL / C2PA).

## Color
| Role | Hex | Use |
|---|---|---|
| Background | `#0a0a0a` | page |
| Panel | `#1a1a1a` | cards |
| Border | `#333` / `#2a2a2a` | card edges / dividers |
| Text | `#e0e0e0` | primary |
| Muted / dim | `#888` / `#666` | secondary / meta |
| **Gold** | `#f5c842` | brand — headings, clock, logo (deep `#e5b832`, dim `#a89840`) |
| **Teal/mint** | `#00d4aa` | accent — buttons, links, interactive (hover `#00ffcc`) |
| Warning | `#ffaa00` | |
| Error | `#ff4444` | |
| Purple (TAMS) | `#8888ff` | secondary accent |

## Type
- Body: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`
- Mono (values, clock, IDs): `'Monaco', 'Menlo', monospace`

## Layout
- Centered column, `max-width: 900px`, `padding: 20px`, `line-height: 1.6`.
- Cards: panel bg + `1px solid #333` + `border-radius: 8px` + `padding: 16px`.
- Buttons: teal bg, dark text, `4px` radius, weight 600.

## Header snippet
```html
<header class="wf-brand-header">
  <div class="wf-brand-logo">
    <span class="wf-sunflower">🌻</span>
    <h1>e2eMoQ</h1>
  </div>
  <div class="wf-product-mark">The Synchronized Fan Contribution Engine</div>
</header>
```
