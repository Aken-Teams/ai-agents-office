# Design System Specification: The Sovereign Observer

## 1. Overview & Creative North Star
The Creative North Star for this design system is **"The Sovereign Observer."** 

In the world of AI automation and enterprise security, the UI must move beyond being a mere tool; it must feel like a high-precision instrument panel—authoritative, watchful, and undeniably elite. We avoid the "template" look of standard SaaS dashboards by embracing **Intentional Asymmetry** and **Tonal Depth**. 

While traditional enterprise software relies on rigid grids and heavy borders to imply organization, this system communicates security through architectural layering. We use high-contrast typography scales—pairing technical, geometric headlines with Swiss-style functional body copy—to create an editorial feel that suggests every data point has been curated and verified.

---

## 2. Colors & Environmental Atmosphere
Our palette is rooted in the depth of space and the precision of a laser.

### The "No-Line" Rule
**Strict Directive:** 1px solid borders are prohibited for sectioning or layout containment. Structural boundaries must be defined solely through:
1. **Background Shifts:** Placing a `surface-container-low` (`#131b2e`) element against a `surface` (`#0b1326`) background.
2. **Subtle Tonal Transitions:** Using the hierarchy of container tokens to imply "wells" or "plateaus" of information.

### Surface Hierarchy & Nesting
Treat the UI as a series of physical layers. 
- Use `surface-container-lowest` (`#060e20`) for the "void" (the base canvas).
- Use `surface-container` (`#171f33`) for primary content blocks.
- Use `surface-container-highest` (`#2d3449`) for interactive elements or active agent modules.
This "nested" depth creates an environment where data feels "sandboxed" within its own physical layer.

### The "Glass & Gradient" Rule
To elevate the "high-tech" feel, floating elements (modals, dropdowns, AI activity popovers) must use **Glassmorphism**: 
- Background: `surface-variant` (`#2d3449`) at 60-80% opacity.
- Effect: `backdrop-blur` (minimum 12px).
- CTA Polish: Primary buttons should not be flat. Use a subtle linear gradient from `primary` (`#00dbe9`) to `on-primary-container` (`#009099`) at a 135-degree angle to provide a "glowing" energy that flat colors lack.

---

## 3. Typography: Technical Authority
We pair **Space Grotesk** (Display/Headlines) with **Inter** (Body/Labels) to balance futuristic precision with extreme readability.

*   **The Display Scale:** Use `display-lg` (3.5rem) sparingly for high-level agent status or document generation counts. Its geometric nature suggests a "built" environment.
*   **The Contrast Play:** Headlines should be high-contrast against the deep navy backgrounds. Use `on-surface` (`#dae2fd`) for primary titles and `on-surface-variant` (`#c5c6cd`) for secondary descriptions.
*   **Data Density:** For automated logs and document generation metadata, rely on `label-sm` (0.6875rem) and `body-sm` (0.75rem). The small, sharp type mimics technical blueprints and adds to the "enterprise-grade" feel.

---

## 4. Elevation & Depth: Tonal Layering
Traditional shadows are too "web 2.0." This system uses light and material density to show importance.

*   **Layering Principle:** Stack `surface-container` tiers. A `surface-container-highest` card placed on a `surface-container-low` section creates a natural lift.
*   **Ambient Shadows:** If an element must float (e.g., a critical AI alert), use a diffused shadow: 
    - Blur: `24px` to `40px`.
    - Color: `on-secondary-fixed` (`#111c2d`) at 8% opacity. 
    - *Note:* The shadow is a tinted navy, not black, ensuring it feels like a part of the atmosphere.
*   **The Ghost Border Fallback:** If a border is required for accessibility in input fields, use the `outline-variant` (`#44474d`) at 20% opacity. This creates a "memory" of a border without breaking the No-Line Rule.

---

## 5. Components & Interface Primitives

### AI Agent Status Indicators
Instead of a simple green dot, use `tertiary` (`#7bd0ff`) for AI activity. 
- **Active State:** A slow, 2px-wide pulse using `tertiary_fixed_dim`.
- **Sandboxed State:** A container with a `surface_variant` glass effect and a subtle `outline` (`#8f9097`) at 10% opacity.

### Buttons (The Interaction Points)
- **Primary:** Gradient (`primary` to `on-primary-container`), `round-sm` (0.125rem) for a sharp, industrial feel.
- **Secondary:** Transparent background with `primary` text. No border. On hover, the background shifts to `primary_container` (`#001d1f`).
- **Tertiary:** `on-surface-variant` text. High-density, for utility actions like "Copy Log."

### Inputs & Document Fields
- **Container:** `surface-container-highest`. 
- **Active State:** A 1px "Ghost Border" of `primary` at 40% opacity. 
- **Typography:** Placeholder text should use `label-md` in `on-secondary-container`.

### Cards & Data Lists
- **Rule:** Absolute prohibition of divider lines. 
- **Separation:** Use `spacing-6` (1.3rem) of vertical whitespace or a background shift to `surface-container-low`.
- **Data Tables:** For document generation logs, use alternating background shades between `surface-container` and `surface-container-high` to define rows.

---

## 6. Do's and Don'ts

### Do
*   **Use Asymmetry:** Place a large `headline-lg` title on the left, but keep the data density high on the right. This "editorial" layout feels more premium than a centered grid.
*   **Embrace the Dark:** Allow the `surface` (`#0b1326`) to breathe. Large areas of deep navy emphasize the "Security" and "Sandboxing" aspect of the platform.
*   **Use the Spacing Scale:** Stick strictly to the defined scale (e.g., `spacing-10` for section gaps) to ensure the precision of the document generation UI.

### Don't
*   **Don't use "Full" Roundedness:** Avoid `round-full` for anything other than status chips. We want the system to feel architectural and engineered; use `round-sm` or `round-md`.
*   **Don't use Pure White:** Never use `#ffffff`. Use `on-surface` (`#dae2fd`) for "white" text to maintain the cool, slate-blue chromatic harmony.
*   **Don't use Standard Shadows:** Never use high-opacity black shadows. They muddy the deep navy palette. If it doesn't look like light passing through glass, don't use it.