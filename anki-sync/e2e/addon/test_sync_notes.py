def test_sync_new_basic_note(client):
    payload = [
        {
            "uuid": "test-uuid-1",
            "deckName": "Default",
            "modelName": "Basic (optional reversed card)",
            "fields": {"Front": "Hello", "Back": "World"},
            "tags": ["obsidian"],
        }
    ]

    response = client.post("http://127.0.0.1:8767/syncNotes", json=payload)

    assert response.status_code == 200
    assert response.json()["test-uuid-1"] == "success"

    # Verify the tag is added
    res_tags = client.post(
        "http://127.0.0.1:8767/__test__/tags", json={"uuid": "test-uuid-1"}
    )
    tags = res_tags.json()["tags"]
    assert "obsidian" in tags


def test_sync_update_existing_note(client):
    # 1. Create a note
    payload = [
        {
            "uuid": "update-test",
            "deckName": "Default",
            "modelName": "Basic (optional reversed card)",
            "fields": {"Front": "Initial Front", "Back": "Initial Back"},
            "tags": ["Tag1"],
        }
    ]
    client.post("http://127.0.0.1:8767/syncNotes", json=payload)

    # 2. Update it: move deck, change fields, append tag
    update_payload = [
        {
            "uuid": "update-test",
            "deckName": "New Deck",
            "modelName": "Basic (optional reversed card)",
            "fields": {"Back": "Updated Back"},
            "tags": ["Tag2", "Tag1"],  # Tag1 already exists, shouldn't duplicate
        }
    ]
    res = client.post("http://127.0.0.1:8767/syncNotes", json=update_payload)
    assert res.json()["update-test"] == "success"

    # 3. We can't directly read SQLite here easily, but the success implies it updated correctly
    # Use the /__test__/fields endpoint to verify fields were retained and updated
    res_fields = client.post(
        "http://127.0.0.1:8767/__test__/fields", json={"uuid": "update-test"}
    )
    assert res_fields.json()["fields"]["Front"] == "Initial Front"
    assert res_fields.json()["fields"]["Back"] == "Updated Back"


def test_sync_invalid_model(client):
    payload = [
        {
            "uuid": "bad-model",
            "deckName": "Default",
            "modelName": "NonExistentModel",
            "fields": {"Front": "A"},
            "tags": [],
        }
    ]
    res = client.post("http://127.0.0.1:8767/syncNotes", json=payload)
    assert "error: model 'NonExistentModel' does not exist" in res.json()["bad-model"]


def test_sync_model_mismatch_on_update(client):
    # Create with Basic
    client.post(
        "http://127.0.0.1:8767/syncNotes",
        json=[
            {
                "uuid": "mismatch-test",
                "deckName": "Default",
                "modelName": "Basic",
                "fields": {"Front": "A", "Back": "B"},
                "tags": [],
            }
        ],
    )

    # Try updating with Basic (optional reversed card)
    res = client.post(
        "http://127.0.0.1:8767/syncNotes",
        json=[
            {
                "uuid": "mismatch-test",
                "deckName": "Default",
                "modelName": "Basic (optional reversed card)",
                "fields": {"Front": "A", "Back": "B"},
                "tags": [],
            }
        ],
    )
    assert (
        "error: note mismatch-test has model 'Basic', expected 'Basic (optional reversed card)'"
        in res.json()["mismatch-test"]
    )


def test_sync_missing_required_fields(client):
    payload = [
        {
            "deckName": "Default",
            "modelName": "Basic (optional reversed card)",
            "fields": {},
        },  # Missing uuid
        {
            "uuid": "missing-model",
            "deckName": "Default",
            "fields": {},
        },  # Missing modelName
    ]
    res = client.post("http://127.0.0.1:8767/syncNotes", json=payload)
    data = res.json()
    assert "error: missing uuid at index 0" in data["_index_0"]
    assert "error: missing modelName for uuid missing-model" in data["missing-model"]


def test_sync_partial_failure(client):
    # Testing that a bad card doesn't crash the good cards in a batch
    payload = [
        {
            "uuid": "good-card",
            "deckName": "Default",
            "modelName": "Basic (optional reversed card)",
            "fields": {"Front": "A", "Back": "B"},
            "tags": [],
        },
        {
            "uuid": "bad-card",
            "deckName": "Default",
            "modelName": "Basic (optional reversed card)",
            # Invalid field name intentionally causes Anki to reject it
            "fields": {"FakeField": "A"},
            "tags": [],
        },
    ]

    response = client.post("http://127.0.0.1:8767/syncNotes", json=payload)
    data = response.json()

    # Verify the good card succeeded
    assert data["good-card"] == "success"
    # Verify the bad card gracefully returned a granular error string
    assert (
        "error: model 'Basic (optional reversed card)' has no field 'FakeField'"
        in data["bad-card"]
    )
