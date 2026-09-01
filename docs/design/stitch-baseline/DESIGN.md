---
name: Monochrome Harness
colors:
  surface: '#131313'
  surface-dim: '#131313'
  surface-bright: '#393939'
  surface-container-lowest: '#0e0e0e'
  surface-container-low: '#1c1b1b'
  surface-container: '#20201f'
  surface-container-high: '#2a2a2a'
  surface-container-highest: '#353535'
  on-surface: '#e5e2e1'
  on-surface-variant: '#c4c7c8'
  inverse-surface: '#e5e2e1'
  inverse-on-surface: '#313030'
  outline: '#8e9192'
  outline-variant: '#444748'
  surface-tint: '#c6c6c7'
  primary: '#ffffff'
  on-primary: '#2f3131'
  primary-container: '#e2e2e2'
  on-primary-container: '#636565'
  inverse-primary: '#5d5f5f'
  secondary: '#c6c6c6'
  on-secondary: '#303030'
  secondary-container: '#474747'
  on-secondary-container: '#b5b5b5'
  tertiary: '#ffffff'
  on-tertiary: '#2f3131'
  tertiary-container: '#e2e2e2'
  on-tertiary-container: '#636565'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#e2e2e2'
  primary-fixed-dim: '#c6c6c7'
  on-primary-fixed: '#1a1c1c'
  on-primary-fixed-variant: '#454747'
  secondary-fixed: '#e2e2e2'
  secondary-fixed-dim: '#c6c6c6'
  on-secondary-fixed: '#1b1b1b'
  on-secondary-fixed-variant: '#474747'
  tertiary-fixed: '#e2e2e2'
  tertiary-fixed-dim: '#c6c6c7'
  on-tertiary-fixed: '#1a1c1c'
  on-tertiary-fixed-variant: '#454747'
  background: '#131313'
  on-background: '#e5e2e1'
  surface-variant: '#353535'
typography:
  display:
    fontFamily: Geist
    fontSize: 48px
    fontWeight: '700'
    lineHeight: '1.1'
    letterSpacing: -0.04em
  headline-lg:
    fontFamily: Geist
    fontSize: 32px
    fontWeight: '600'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Geist
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Geist
    fontSize: 20px
    fontWeight: '600'
    lineHeight: '1.4'
  body-lg:
    fontFamily: JetBrains Mono
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  body-md:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.5'
  code-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '400'
    lineHeight: '1.5'
  label-caps:
    fontFamily: Geist
    fontSize: 11px
    fontWeight: '700'
    lineHeight: '1'
    letterSpacing: 0.1em
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 48px
  gutter: 16px
  margin: 24px
---

## Brand & Style

The design system is built for extreme focus and technical precision. It targets a developer audience that values utility over decoration, emphasizing a "heads-down" environment where the UI recedes and the data takes center stage.

The style is a fusion of **Minimalism** and **High-Contrast Brutalism**. It rejects all decorative flourishes, including shadows, gradients, and color-coded statuses. Every visual element is functional. The aesthetic is binary: either information exists (White) or it does not (Black). This creates a high-density, high-readability environment that reduces cognitive load by eliminating the "vibe" of the UI in favor of raw content.

## Colors

The palette is strictly restricted to absolute black and absolute white. 

- **Primary Background:** `#000000` (Pure Black).
- **Primary Foreground:** `#FFFFFF` (Pure White).
- **Secondary UI / Dividers:** `#1A1A1A` (Deep Gray) - used only when subtle separation is required without breaking the monochrome logic.
- **Accents:** Non-existent. Meaning is conveyed through weight, scale, and inversion rather than hue.

For states like "Success," "Warning," or "Error," use icons and explicit text labels. Do not use green, yellow, or red.

## Typography

This design system uses a dual-font approach. **Geist** provides a clean, technical Sans-Serif for high-level UI elements and navigation, while **JetBrains Mono** is the workhorse for all data, code, and body content.

Typography is the primary driver of hierarchy. Use font weight and case (uppercase for labels) to differentiate between sections. All code snippets and data-heavy tables must use monospaced fonts to ensure vertical alignment and character legibility.

## Layout & Spacing

The layout follows a **Strict Grid** model based on a 4px baseline. All components and containers must snap to this grid.

- **Desktop:** 12-column grid with 16px gutters.
- **Tablet:** 8-column grid with 16px gutters.
- **Mobile:** 4-column grid with 12px gutters.

Structure should be defined by hard lines (1px white borders) rather than soft shadows or color blocks. Use white space aggressively to separate unrelated functional areas. Dense information clusters should be contained within framed boxes to provide visual anchors.

## Elevation & Depth

This system is entirely flat. There are no Z-axis shadows or blurs. 

Depth is achieved through **Inversion** and **Borders**:
- **Level 0 (Surface):** `#000000` background.
- **Level 1 (Container):** 1px `#FFFFFF` border around a `#000000` surface.
- **Level 2 (Active/Popup):** `#FFFFFF` background with `#000000` text (Full Inversion).

When a modal or dropdown is active, it does not cast a shadow. Instead, it uses a thick 2px white border to "punch" through the background layer.

## Shapes

The shape language is **Strictly Geometric**. All corners are 0px (Sharp).

Circles are only permitted for status indicators or specific icon formats. All buttons, inputs, cards, and modal windows must be hard-edged rectangles. This reinforces the technical, engineered nature of the tool.

## Components

### Buttons
- **Primary:** Solid `#FFFFFF` fill with `#000000` text. No border.
- **Secondary:** Solid `#000000` fill with `#FFFFFF` text and a 1px `#FFFFFF` border.
- **Ghost:** Solid `#000000` fill, `#FFFFFF` text, no border. Border appears on hover.

### Input Fields
Rectangular with a 1px white border. Label sits above the field in `label-caps`. Focus state is indicated by a 2px white border.

### Chips / Tags
Small rectangular boxes with 1px white borders. For "Active" tags, invert the colors (white background, black text).

### Lists & Tables
Rows are separated by 1px white lines. Table headers use `label-caps` for clarity. Hovering over a row should trigger a full-row inversion (Black to White) to highlight the selection.

### Checkboxes & Radios
Strictly square (Checkbox) or diamond (Radio). A "checked" state is represented by a solid white fill inside the shape.

### Code Block
A contained area with a 1px white border. Code syntax highlighting is achieved solely through font weights (Bold vs. Regular) and styles (Italic vs. Roman), maintaining the monochrome constraint.