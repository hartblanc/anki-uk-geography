""" methods for converting a CrowdAnki export (deck.json + media/) into a distributable .apkg """

import argparse
import hashlib
import json
from pathlib import Path

import genanki


def stable_id(crowdanki_uuid: str) -> int:
    """Deterministic Anki-style integer id derived from a CrowdAnki uuid.

    CrowdAnki tracks deck/note-model identity via a stable uuid, but genanki
    needs an integer id. Deriving it from the uuid (rather than e.g. a random
    int) means rebuilding the apkg from unchanged source data always produces
    the same deck/model ids.
    """
    digest = hashlib.sha256(crowdanki_uuid.encode("utf-8")).hexdigest()
    return int(digest[:15], 16)


def build_model(note_model: dict) -> genanki.Model:
    return genanki.Model(
        stable_id(note_model["crowdanki_uuid"]),
        note_model["name"],
        fields=note_model["flds"],
        templates=note_model["tmpls"],
        css=note_model["css"],
        model_type=note_model["type"],
        sort_field_index=note_model["sortf"],
    )


def build_deck(deck_json: dict, models_by_uuid: dict) -> genanki.Deck:
    deck = genanki.Deck(
        stable_id(deck_json["crowdanki_uuid"]),
        deck_json["name"],
        description=deck_json.get("desc", ""),
    )

    for note in deck_json["notes"]:
        model = models_by_uuid[note["note_model_uuid"]]
        deck.add_note(
            genanki.Note(
                model=model,
                fields=note["fields"],
                tags=note.get("tags", []),
                guid=note["guid"],
            )
        )

    return deck


def build_decks(deck_json: dict, models_by_uuid: dict) -> list:
    decks = [build_deck(deck_json, models_by_uuid)]
    for child in deck_json.get("children", []):
        decks.extend(build_decks(child, models_by_uuid))
    return decks


def collect_media_paths(deck_json: dict, media_dir: Path) -> list:
    media_names = set(deck_json.get("media_files", []))
    for child in deck_json.get("children", []):
        media_names |= set(collect_media_paths(child, media_dir))
    return [str(media_dir / name) for name in media_names]


def build_apkg(crowdanki_folder: Path, outfile: Path) -> None:
    deck_json = json.loads((crowdanki_folder / "deck.json").read_text())

    models_by_uuid = {
        note_model["crowdanki_uuid"]: build_model(note_model)
        for note_model in deck_json["note_models"]
    }

    decks = build_decks(deck_json, models_by_uuid)
    media_paths = collect_media_paths(deck_json, crowdanki_folder / "media")

    outfile.parent.mkdir(parents=True, exist_ok=True)
    genanki.Package(decks, media_files=media_paths).write_to_file(str(outfile))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Convert a CrowdAnki export folder into a distributable .apkg file",
    )
    parser.add_argument(
        "crowdanki_folder",
        type=Path,
        help="Path to the CrowdAnki export folder (containing deck.json and media/)",
    )
    parser.add_argument(
        "outfile",
        type=Path,
        help="Path to write the generated .apkg file to",
    )
    args = parser.parse_args()

    build_apkg(args.crowdanki_folder, args.outfile)
