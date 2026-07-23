def test_mark_orphaned(client):
    # First, create a note
    payload = [
        {
            "uuid": "orphan-test-1",
            "deckName": "Default",
            "modelName": "Basic (optional reversed card)",
            "fields": {"Front": "Front", "Back": "Back"},
            "tags": [],
        }
    ]

    res1 = client.post("http://127.0.0.1:8767/syncNotes", json=payload)
    assert res1.status_code == 200

    # Now mark it orphaned
    res2 = client.post("http://127.0.0.1:8767/markOrphaned", json=["orphan-test-1"])
    assert res2.status_code == 200
    assert res2.json()["orphan-test-1"] == "success"

    # Verify the tag is added
    res_tags = client.post(
        "http://127.0.0.1:8767/__test__/tags", json={"uuid": "orphan-test-1"}
    )
    tags = res_tags.json()["tags"]
    assert "orphan" in tags


def test_mark_orphaned_not_found(client):
    res = client.post("http://127.0.0.1:8767/markOrphaned", json=["does-not-exist"])
    assert res.status_code == 200
    assert res.json()["does-not-exist"] == "not_found"
