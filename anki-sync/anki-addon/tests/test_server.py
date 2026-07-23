import os
import sys
from unittest.mock import MagicMock

# Mock the Anki 'aqt' module and the 'mw' global before importing server
mock_mw = MagicMock()
sys.modules["aqt"] = MagicMock(mw=mock_mw)

os.environ["ANKI_SYNC_PORT"] = "0"
from obsidian_anki_sync import server  # noqa: E402


def test_sync_keeps_existing_tags():
    # Setup mock collection
    server.mw = mock_mw
    mock_col = MagicMock()
    mock_mw.col = mock_col

    # Mock model
    mock_model = {"id": 1, "name": "Basic"}
    mock_col.models.by_name.return_value = mock_model

    # Mock finding an existing note
    mock_col.db.list.return_value = [123]  # note_id = 123

    # Mock the note object returned by get_note
    mock_note = MagicMock()
    mock_note.note_type.return_value = {"id": 1, "name": "Basic"}
    mock_note.__contains__.return_value = True  # Pretend it has all fields
    mock_note.tags = ["ExistingTag", "AnotherTag"]
    mock_col.get_note.return_value = mock_note

    # Mock deck id
    mock_col.decks.id.return_value = 1

    # The payload from Obsidian
    payload = [
        {
            "uuid": "test-uuid",
            "deckName": "Default",
            "modelName": "Basic",
            "fields": {"Front": "Question", "Back": "Answer"},
            "tags": ["obsidian"],
        }
    ]

    # Run the sync process
    res = server.process_sync_notes(payload, mock_col)

    # Assert success
    assert res["test-uuid"] == "success"

    # Assert tags were correctly merged, not overwritten
    assert "ExistingTag" in mock_note.tags
    assert "AnotherTag" in mock_note.tags
    assert "obsidian" in mock_note.tags

    # The new tag should be appended exactly once
    assert mock_note.tags == ["ExistingTag", "AnotherTag", "obsidian"]


def test_sync_new_note_adds_tag():
    # Setup mock collection
    server.mw = mock_mw
    mock_col = MagicMock()
    mock_mw.col = mock_col

    # Mock model
    mock_model = {"id": 1, "name": "Basic"}
    mock_col.models.by_name.return_value = mock_model

    # Mock NO existing note found
    mock_col.db.list.return_value = []

    # Mock the creation of a new note
    mock_note = MagicMock()
    mock_note.__contains__.return_value = True
    mock_note.tags = []
    mock_col.new_note.return_value = mock_note

    payload = [
        {
            "uuid": "test-uuid-2",
            "deckName": "Default",
            "modelName": "Basic",
            "fields": {"Front": "Q", "Back": "A"},
            "tags": ["obsidian"],
        }
    ]

    res = server.process_sync_notes(payload, mock_col)

    assert res["test-uuid-2"] == "success"
    assert mock_note.tags == ["obsidian"]
