# Documentation

Keep the docs as short and clear as they are now. Help someone use the app without making them learn its internal vocabulary.

## Keep pages current

- Compare documentation claims against the current implementation. Check the relevant code and tests before changing a claim. Document working features only.
- Update existing pages when controls, defaults, limits, or saved data change. Use the exact button names and status labels shown in the app.
- Write for Linux SSH hosts in general. A home server, work machine, or cloud VM are all valid examples.
- Keep existing page URLs and the compact sidebar. Content lives in `src/content/docs/`; navigation lives in `astro.config.mjs`.
- Do not introduce documentation for releases older than v0.7.0 unless historical context is explicitly needed.

## Writing

- Start with what the reader can do and how to do it. Use short sentences and one idea per paragraph.
- Prefer "host", "tab", "terminal", and "read" where they explain the action. Use app-specific names when they identify a control or a concept the reader needs. Explain unfamiliar terms on first use.
- Keep technical details that affect setup or results, such as SSH authentication, permissions, command names, and data storage.
- Add a heading only when it helps someone find a task. Keep small topics together. Avoid repeated introductions, summaries, and lists of everything the app cannot do.
- Cut marketing language, filler, and vague jargon. Say "the app saved these values" instead of "persisted normalized facts", or "some information is missing" instead of "bounded evidence is unavailable".
- Fix layout in styles or components. Never add prose just to make a page longer.

## Screenshots

- Add a screenshot when it helps locate controls or understand a result. Refresh it when the pictured UI changes.
- Capture the current app. Use fictional hosts and sample data, mark them as examples, and keep personal host details out of images.
- Store images in `src/assets/screenshots/`. Give each image useful alt text and a short caption. Keep the image clickable so readers can enlarge it.

## Before handoff

- Review the diff and rendered pages.
- For page changes, run `npm run check` and `npm run build` from `docs/`.
- For layout or navigation changes, also run `npm run test:ui` and inspect desktop and phone widths. Check tables, images, links, and section selection.
- Report the changes and validation plainly. Follow the root `AGENTS.md` for Git actions and application checks.
