# Registry Backlog

This backlog captures UI and product improvements identified during the
frontend audit. Items are ordered roughly by user impact and dependency order.

## 1. Compress The Home Hero And Surface Browse Earlier

Problem: On mobile, users scroll through nav, hero copy, search, the registry
map image, and four stacked metrics before reaching packs.

Acceptance criteria:
- The first mobile viewport includes search plus at least the start of browse
  results or featured packs.
- Metrics collapse to compact inline pills or a 2x2 grid on small screens.
- The registry map is hidden, shortened, or replaced with a functional panel on
  mobile.
- Existing desktop brand feel is preserved.

## 2. Promote The CLI Registry Endpoint And Install Action

Problem: The registry TOML endpoint and pack install commands are central to
the product but are not first-class actions in the UI.

Acceptance criteria:
- The home page exposes a copyable `https://registry.gascity.com/registry.toml`
  endpoint near the top of the page.
- Pack detail pages expose the primary install command without requiring users
  to open the Install tab.
- Copy feedback remains visible and accessible.
- E2E coverage verifies endpoint and install command copy actions.

## 3. Use Real Links For Pack Cards And List Items

Problem: Pack cards and list rows are buttons that simulate navigation, which
removes native browser affordances such as open-in-new-tab and copy-link.

Acceptance criteria:
- Pack cards and list rows render as anchors with stable `href` values.
- Click behavior preserves current URL-backed filter state where appropriate.
- Keyboard and screen-reader behavior remains clear.
- E2E coverage verifies direct navigation and modifier/open-in-new-tab-safe
  link semantics where practical.

## 4. Finish Detail Tab Accessibility

Problem: Detail tabs use ARIA roles but do not implement the full keyboard
interaction pattern users expect for tabs.

Acceptance criteria:
- Tabs use roving `tabIndex`.
- ArrowLeft, ArrowRight, Home, and End move focus and selection.
- Hash-linked tabs still load correctly.
- E2E coverage verifies keyboard tab navigation.

## 5. Split The Frontend Into Focused Modules

Problem: `src/App.tsx` and `src/styles.css` are both over 1,000 lines, which
will slow down upcoming work such as reviews, auth, and richer registry states.

Acceptance criteria:
- Route-level components live under `src/routes/`.
- Shared UI components live under `src/components/`.
- Catalog and URL-state hooks are extracted from `App.tsx`.
- CSS is split by surface or component while preserving the current visual
  system.
- No behavior changes beyond import paths and component boundaries.

## 6. Implement Mobile Filters Or Remove The Placeholder

Problem: The markup includes a Filters button, but the control is hidden and
does not open a mobile filtering experience.

Acceptance criteria:
- Mobile users can open and close filters from the browse header.
- Active filters are visible as chips or concise status text.
- A clear/reset action is available.
- Focus management works when opening and closing the filter surface.

## 7. Prepare Search And Catalog UX For Growth

Problem: Search currently scans README content on every filter pass. That is
fine for a tiny catalog but will become expensive and noisy as the registry
grows.

Acceptance criteria:
- Generated `catalog.json` includes normalized `searchText` per pack.
- Category counts are generated or derived once per catalog load.
- Search result ordering remains deterministic.
- Large README bodies do not dominate simple name/source/category searches.

## 8. Add Visual Regression And Interaction Coverage

Problem: Current E2E coverage checks behavior and mobile overflow, but not
visual regressions across key breakpoints.

Acceptance criteria:
- Screenshot smoke coverage runs at 320, 390, 768, 1024, and 1440px widths.
- Tests cover home, pack detail, install action, and mobile filters once added.
- Tests fail on horizontal overflow and obvious blank-render states.
- CI artifacts make screenshot failures easy to inspect.
