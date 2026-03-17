# YouTube Low View Filter

A Tampermonkey userscript to filter low-view videos on YouTube.

## What it does

- Filters videos below a configurable minimum view count.
- Supports two modes:
  - `hide`: remove matching video cards.
  - `highlight`: keep cards visible and highlight them for testing.
- Optional debug panel with live counters.

## Setup

1. Install Tampermonkey in your browser.
2. Create a new script.
3. Paste the content of `yt-low-view-filter.user.js`.
4. Save and open YouTube.

## Main settings

Edit the `CONFIG` object in the script:

- `minViews`: minimum views required.
- `filterActionMode`: `hide` or `highlight`.
- `showDebugPanel`: show/hide on-page debug panel.
- `hideShortsShelves` / `hideShortsCards`: shorts filtering behavior.
- `hideLiveAndUpcoming`: include live/upcoming cards.

## Notes

- YouTube changes its layout often, so selectors may need updates over time.
- For final use, lower debug noise by setting `debug: false`.
