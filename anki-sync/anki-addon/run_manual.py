import requests

print(
    requests.post(
        "http://127.0.0.1:8767/syncNotes",
        json=[
            {
                "uuid": "test-uuid-99",
                "deckName": "Default",
                "modelName": "Basic",
                "fields": {"Front": "Hello", "Back": "World"},
                "tags": ["obsidian"],
            }
        ],
    ).json()
)
