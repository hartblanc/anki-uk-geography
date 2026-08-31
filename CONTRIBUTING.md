# Contributing

Hey, interested in contributing? or just curious about the project structure?
You're in the right place.

## Set-up

1. Install the CrowdAnki add-on in Anki.
2. Fork and clone this repository on your machine.
3. Install Node.js (see `.nvmrc` for version). Run `npm install` to install everything, including Puppeteer for screenshots. If you only want to build the deck (no screenshots), `npm install --omit=dev` is enough — mapshaper and svgo are regular dependencies, Puppeteer is dev-only.
4. install python and pipenv.
5. In the root of the directory, run `pipenv install --dev` to install the python project env.
6. optionally run `pipenv shell` to activate a new shell in the python environment.

Additional dependencies include:
1. jq
2. bsdtar
3. curl

Note that this repo uses git pre-commit hooks to maintain code style and to type
lint (using flake8, black, isort, and mypy). These hooks are set up already so
you don't need to do anything - they will be run automatically before each commit.

## Building the deck
Just run `make` in the root of the repo to build the deck.
To import the deck into anki, you will need the CrowdAnki add-on installed.
1. Click through the menus 'File > CrowdAnki: Import from disk'
2. select build/United Kingdom Geography - Regions Counties and Cities

## Generating screenshots

`make screenshots` renders the stitched dark-mode example grid (City - Map and City - County for Gloucester, BoW - Map for Bristol Channel) to `build/screenshots/dark-mode-grid.png`:

```bash
make screenshots
```

To render every card type instead, run the script directly:

```bash
node utils/uk_geog/capture_screenshots.js
```

For more control (dark mode, specific cards/sample notes, or a stitched grid), use the script directly:

```bash
node utils/uk_geog/capture_screenshots.js \
  --dark \
  --only "City - Map,City - County,BoW - Map" \
  --sample "City - Map:City=Gloucester" \
  --sample "City - County:City=Gloucester" \
  --sample "BoW - Map:BoW=Bristol Channel" \
  --stitch build/screenshots/dark-mode-grid.png
```

Additional dependencies beyond the normal build:

- **Puppeteer's bundled Chromium** – installed as a dev dependency by `npm install`; required for `make screenshots`
- **ImageMagick** (`montage`) – only required for `--stitch` grids

Note: `make screenshots` needs the dev dependencies, so run `npm install` (not `npm install --omit=dev`) before generating screenshots.

## SVG IDs and anki templates
So how does Anki know which region to highlight on each card? and which colour to
highlight it? and which cards to generate?

This behaviour is specified in the templates in `src/note_models/**/templates` using
[conditional replacement](https://docs.ankiweb.net/#/templates/generation?id=conditional-replacement)
and [template variables](https://docs.ankiweb.net/#/templates/intro?id=card-templates).

Note that the element ids in the SVG typically align with the wikipedia url for counties
(with "_" replaced with space and quotes removed). This ensures unqiueness, for
example West Midlands is both a county and a region, and also ensures a reliable
predictable mapping from cities to counties. For example, the West Midlands county
has ID **West Midlands (county)** in each svg file in `build/maps/*.svg` because it's
Wikipedia URL is **https://en.wikipedia.org/wiki/West_Midlands_(county)**

## Adding and removing notes - Anki GUIDs

src/data/uk_geog.csv contains all of the notes in the current version of the deck.
Each note has a unique identifier ('guid').

aggregate_csvs.py generates the next set of notes.
It ensures that all of the old notes are present in the new set with the same GUIDs.
Any new notes are included with no GUID. This delegates generating the GUIDs to brainbrew.

These GUIDs are generated in the deck.json when the deck is built via the source_to_crowdanki.yaml recipe.
These need to be synced back to src/data/uk_geog.csv so that the new notes are preserved next time.

The addition or removal of any notes must be synced back into src/data/uk_geog.csv afer generating
the deck.json via a call to:
```
brainbrew run recipes/UK_Geog/source_from_crowdanki.yaml
```
