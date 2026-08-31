# AGENTS

Context for AI agents and contributors working on the `anki-uk-geography` repo.

## Documentation
- Documentation for mapshaper can be found at: mapshaper.org/llms.txt
- Documentation for anki can be found at: anki.mintlify.app/llms.txt

## Testing
- Build the deck using `make`
- Generate screenshots using puppeteer via `make screenshots` for some visual feedback
- For live inspection in Anki, launch Anki with `QTWEBENGINE_REMOTE_DEBUGGING=9292` and connect to `localhost:9292` via CDP.
  - A human must be in the loop: they need to import the rebuilt CrowdAnki deck into Anki (`make` does not update a running Anki), navigate to the relevant cards, and switch between fronts/backs as needed.
  - CDP gives access to the real Qt WebEngine renderer, so it can catch issues that puppeteer can not.
- Tradeoffs vs screenshots:
  - Screenshots are fast, scriptable, deterministic, and good for regression checks and docs, but they render in puppeteer rather than Anki's real runtime, so they can miss Anki/AnkiMobile-specific issues (e.g. external script loading races, `<use>` shadow-tree CSS quirks).
  - CDP in Anki is the source of truth for actual behaviour, but requires human involvement for import/navigation, is slower, and is harder to repeat deterministically.
