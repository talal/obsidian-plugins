import json
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

# To avoid crashing if run outside Anki for tests
try:
    from aqt import mw  # type: ignore
except ImportError:
    mw = None

import secrets

import os

TEST_MODE = os.environ.get("ANKI_SYNC_TEST_MODE") == "1"

PORT = 8766
HOST = "127.0.0.1"


def get_api_key() -> str:
    if not mw:
        # If run outside Anki, generate a one-time random key
        # so we don't leak a static fallback.
        return secrets.token_urlsafe(32)

    config = mw.addonManager.getConfig(__name__)
    if not config:
        config = {}

    key = config.get("api_key")
    if not key:
        key = secrets.token_urlsafe(32)
        config["api_key"] = key
        mw.addonManager.writeConfig(__name__, config)

    return str(key)


def _run_on_main[T](func: Callable[[], T]) -> T:
    if not mw:
        raise Exception("Anki not running")
    import concurrent.futures

    future: concurrent.futures.Future[T] = concurrent.futures.Future()

    def wrapped() -> None:
        try:
            res = func()
            future.set_result(res)
        except Exception as e:
            future.set_exception(e)

    mw.taskman.run_on_main(wrapped)
    return future.result()


def find_note_id_by_guid(col: Any, uuid: str) -> int | None:
    rows = col.db.list("select id from notes where guid = ?", uuid)
    if len(rows) > 1:
        raise Exception(f"error: duplicate guid {uuid}")
    return rows[0] if rows else None


type NotesPayload = list[dict[str, Any]]


def process_sync_notes(notes_payload: NotesPayload) -> dict[str, str]:
    if not mw or not mw.col:
        raise Exception("Anki collection is locked or profile not loaded")

    col = mw.col
    result_map: dict[str, str] = {}

    for i, note_data in enumerate(notes_payload):
        uuid: str | None = None
        try:
            uuid = note_data.get("uuid")
            if not uuid:
                raise Exception(f"error: missing uuid at index {i}")

            deck_name: str = note_data.get("deckName", "Default")
            model_name: str | None = note_data.get("modelName")
            fields: dict[str, str] = note_data.get("fields", {})
            tags: list[str] = note_data.get("tags", [])

            if not model_name:
                raise Exception(f"error: missing modelName for uuid {uuid}")

            # 1. Model lookup
            model = col.models.by_name(model_name)
            if not model:
                raise Exception(f"error: model '{model_name}' does not exist")

            # 2. Read-only SQL query for duplicate guid checking
            note_id = find_note_id_by_guid(col, uuid)

            # 3. Create or update note
            if note_id:
                # Update existing note
                note = col.get_note(note_id)
                if str(note.note_type()["id"]) != str(model["id"]):
                    raise Exception(
                        f"error: note {uuid} has model '{note.note_type()['name']}', "
                        f"expected '{model_name}'"
                    )
            else:
                # Create new note
                note = col.new_note(model)
                note.guid = uuid

            # Set fields
            for k, v in fields.items():
                if k in note:
                    note[k] = v
                else:
                    raise Exception(f"error: model '{model_name}' has no field '{k}'")

            # Add tags without overwriting existing ones
            for tag in tags:
                if tag not in note.tags:
                    note.tags.append(tag)

            # 4. Deck lookup / creation
            deck_id = col.decks.id(deck_name, create=True)

            if note_id:
                col.update_note(note)
                col.set_deck(col.card_ids_of_note(note_id), deck_id)
            else:
                col.add_note(note, deck_id)

            result_map[uuid] = "success"
        except Exception as e:
            err_msg = str(e)
            if not err_msg.startswith("error:"):
                err_msg = f"error: {err_msg}"
            key = uuid if uuid else f"_index_{i}"
            result_map[key] = err_msg

    return result_map


def process_mark_orphaned(uuids: list[str]) -> dict[str, str]:
    if not mw or not mw.col:
        raise Exception("Anki collection is locked or profile not loaded")

    col = mw.col
    result_map: dict[str, str] = {}

    for i, uuid in enumerate(uuids):
        try:
            if not uuid:
                raise Exception(f"error: missing uuid at index {i}")

            note_id = find_note_id_by_guid(col, uuid)
            if note_id:
                note = col.get_note(note_id)
                if "Orphaned" not in note.tags:
                    note.tags.append("Orphaned")
                    col.update_note(note)
                result_map[uuid] = "success"
            else:
                result_map[uuid] = "not_found"
        except Exception as e:
            err_msg = str(e)
            if not err_msg.startswith("error:"):
                err_msg = f"error: {err_msg}"
            key = uuid if uuid else f"_index_{i}"
            result_map[key] = err_msg

    return result_map


def process_test_reset() -> dict[str, str]:
    if not mw or not mw.col:
        raise Exception("Anki collection is locked or profile not loaded")

    col = mw.col

    # 1. Delete all notes
    note_ids = col.db.list("select id from notes")
    if note_ids:
        col.remove_notes(note_ids)

    # 2. Delete all decks except Default (id=1)
    deck_ids = [
        d["id"]
        for d in col.decks.all()
        if str(d["name"]).lower() != "default" and d["id"] != 1
    ]
    for d_id in deck_ids:
        col.decks.remove([d_id])

    return {"status": "success"}


class SyncRequestHandler(BaseHTTPRequestHandler):
    def send_json(self, status: int, payload: Any) -> None:
        self.send_response(status)
        self.send_header("Content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode("utf-8"))

    def check_auth(self) -> bool:
        auth_header = self.headers.get("Authorization")
        expected_key = get_api_key()
        if not auth_header or auth_header != f"Bearer {expected_key}":
            self.send_json(401, {"error": "Unauthorized"})
            return False
        return True

    def do_GET(self) -> None:
        if not self.check_auth():
            return

        if self.path == "/health":
            self.send_json(
                200,
                {
                    "version": "0.1.0",
                    "profileLoaded": bool(mw and mw.col),
                },
            )
        else:
            self.send_json(404, {"error": "Not Found"})

    def do_POST(self) -> None:
        if self.path == "/__test__/reset":
            if not TEST_MODE:
                self.send_json(404, {"error": "Not Found"})
                return
            try:
                result = _run_on_main(process_test_reset)
                self.send_json(200, result)
            except Exception as e:
                self.send_json(500, {"error": str(e)})
            return

        if not self.check_auth():
            return

        content_length_str = self.headers.get("Content-Length", "0")
        try:
            content_length = int(content_length_str) if content_length_str else 0
        except ValueError:
            self.send_json(400, {"error": "Invalid Content-Length"})
            return
        body = self.rfile.read(content_length).decode("utf-8")

        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self.send_json(400, {"error": "Invalid JSON"})
            return

        if self.path == "/syncNotes":
            if not isinstance(payload, list):
                self.send_json(400, {"error": "Expected a JSON array"})
                return

            try:
                result = _run_on_main(lambda: process_sync_notes(payload))
                self.send_json(200, result)
            except Exception as e:
                self.send_json(500, {"error": str(e)})

        elif self.path == "/markOrphaned":
            if not isinstance(payload, list):
                self.send_json(400, {"error": "Expected a JSON array"})
                return

            try:
                result = _run_on_main(lambda: process_mark_orphaned(payload))
                self.send_json(200, result)
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        else:
            self.send_json(404, {"error": "Not Found"})


def start_server() -> HTTPServer:
    server = HTTPServer((HOST, PORT), SyncRequestHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    if mw:
        try:
            from aqt import gui_hooks  # type: ignore

            def shutdown() -> None:
                server.shutdown()

            gui_hooks.profile_will_close.append(shutdown)
        except ImportError:
            pass

    return server
