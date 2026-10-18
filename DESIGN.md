---
version: alpha
name: PixelPTX
description: A readable compiler workbench for a live technical explanation.
colors:
  background: "#edf1f5"
  surface: "#ffffff"
  ink: "#192d40"
  muted: "#536779"
  border: "#d7e0e8"
  primary: "#08766d"
  primary-soft: "#e5f4ef"
  comparison: "#a0522d"
  editor: "#182b3b"
  editor-ink: "#e4eff7"
  error: "#b42336"
  scrollbar: "#8195a6"
typography:
  sans:
    fontFamily: "Segoe UI, sans-serif"
  heading:
    fontFamily: "Bahnschrift, Segoe UI, sans-serif"
  mono:
    fontFamily: "Cascadia Code, Consolas, monospace"
rounded:
  DEFAULT: "12px"
  control: "6px"
spacing:
  page-max: "1560px"
  panel: "24px"
components:
  button: {}
  source: {}
  stage-navigation: {}
  diagram: {}
---

# PixelPTX Design System

## Overview

Product register: a local engineering workbench for exploring image filters and compiler stages. Its reference is a digital imaging test instrument: calibrated input and output, a visible signal path, and a probe that traces one value. English technical vocabulary follows the compiler. The memorable interaction is selecting a compiler node or instruction and tracing it back to the source and through float32 registers.

Assumed visual direction, chosen for legibility while presenting: pale slate workspace, white instrument surfaces, a navy source well, teal for active execution, and rust for before/after comparison. Avoid marketing hero layouts, invented benchmarks, neon GPU branding, and decorative charts.

Runtime ownership: Model A. This frontmatter is the canonical token source. `scripts/tokens.mjs` generates `web/tokens.css`; components consume its variables. `node scripts/tokens.mjs --check` checks drift. No external fonts or resources are required.

## Colors

Frontmatter keys map directly to `--color-{key}`. Surface and ink establish reading contrast; primary marks selected stages and actions. Comparison labels the original program. Errors use both text and error color. The source well uses editor and editor-ink. Global scrollbar tokens remain visible. Forced-colors mode respects system colors.

## Typography

Typography entries map to `--font-{key}`. Heading uses Bahnschrift when installed, body uses Segoe UI, and code uses Cascadia Code or Consolas. These are deliberate local Windows typography choices for an offline engineering tool. Source and numeric data use tabular numerals. Page title scales from 25–34px (27px on narrow screens), panel title 16–17px, body 14–15px, code/source 11–14px with generous line-height. Functional labels are at least 11px. Labels remain plain English; no decorative all-caps eyebrows.

## Layout

Max width 1560px; panel padding varies from 18–24px. Source column 340px (300px at smaller desktop widths, 370px on wide screens), remaining width for image and compiler views. Below 1050px, source moves above the visual region. Below 620px, image comparisons stack. Document scrolling owns page length; code and diagram panels own bounded overflow. Reserve image aspect ratios and status lines. The source never disappears when switching compiler stages.

## Elevation & Depth

White panels use a single thin border without decorative shadows. The source well is a tonal inset. Stage selection uses a subtle fill. No blur, glass, or background grid.

## Shapes

Panels use the DEFAULT radius; controls use control radius. Do not wrap every data item in a separate card. Diagrams use compact rounded nodes connected by real AST edges.

## Components

Shared actions use native buttons: primary fill for compile, outline for exports, quiet surface for inspection. All have hover, focus-visible, disabled, busy and active states. Source errors are inline and associated with the textarea. Native image input is hidden behind an explicitly labeled button; no custom select or modal is needed. Stages use buttons with aria-pressed. AST nodes are keyboard-operable buttons. PTX lines are buttons linking back to source. The status live region owns transient feedback. Copy and export require a successful compilation of the current source. The on-demand GPU panel uses these same controls and a native acknowledgement checkbox, a scoped persistent status region, named lifecycle steps, and a separate GPU result canvas. Cleanup errors remain visible until resolved. No new visual tokens are introduced.

Motion only illustrates program flow through the active trace row. Reduced motion removes transitions. Charts include labels and text equivalents. Procedural image content is labeled synthetic. CPU timing includes the subprocess and IPC; it is never called GPU time.

## Do's and Don'ts

- Show actual C++ compilation output and actual instruction counts.
- Keep execution backend and verification scope visible.
- Preserve entered source on errors and ignore stale async results.
- Do not imply NVIDIA execution from a successful offline assembly.
- Do not claim fewer PTX instructions automatically improve GPU performance.
