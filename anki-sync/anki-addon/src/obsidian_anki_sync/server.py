import json
import logging
import os
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

# To avoid crashing if run outside Anki for tests
try:
    from aqt import mw  # type: ignore
except ImportError:
    mw = None

TEST_MODE = os.environ.get("ANKI_SYNC_TEST_MODE") == "1"

# Default port is 8766. Override (e.g. to 8767 in E2E tests) to prevent collisions.
PORT = int(os.environ.get("ANKI_SYNC_PORT", 8766))
HOST = "127.0.0.1"


def _run_in_anki_background[T](func: Callable[[Any], T]) -> T:
    if not mw:
        raise Exception("Anki not running")
    import concurrent.futures

    future: concurrent.futures.Future[T] = concurrent.futures.Future()

    def wrapped() -> None:
        try:

            def background_task() -> T:
                return func(mw.col)  # type: ignore

            def on_done(fut) -> None:
                try:
                    res = fut.result()
                    if mw:
                        try:
                            import aqt  # type: ignore

                            aqt.gui_hooks.state_did_reset()
                        except Exception:
                            pass
                    future.set_result(res)
                except Exception as e:
                    future.set_exception(e)

            mw.taskman.run_in_background(background_task, on_done)  # type: ignore
        except Exception as e:
            future.set_exception(e)

    mw.taskman.run_on_main(wrapped)
    return future.result()


def find_note_id_by_guid(col: Any, uuid: str) -> int | None:
    rows = col.db.list("select id from notes where guid = ?", uuid)
    if len(rows) > 1:
        raise Exception(f"error: duplicate guid {uuid}")
    return rows[0] if rows else None


def process_test_fields(uuid: str, col: Any) -> dict[str, str]:
    note_id = find_note_id_by_guid(col, uuid)
    if not note_id:
        return {}
    note = col.get_note(note_id)
    return dict(note.items())


type NotesPayload = list[dict[str, Any]]


def process_sync_notes(notes_payload: NotesPayload, col: Any) -> dict[str, str]:
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
            logging.exception(f"Anki sync failed for note {uuid}")
            err_msg = str(e)
            if not err_msg.startswith("error:"):
                err_msg = f"error: {err_msg}"
            key = uuid if uuid else f"_index_{i}"
            result_map[key] = err_msg

    return result_map


def process_mark_orphaned(uuids: list[str], col: Any) -> dict[str, str]:
    result_map: dict[str, str] = {}

    for i, uuid in enumerate(uuids):
        try:
            if not uuid:
                raise Exception(f"error: missing uuid at index {i}")

            note_id = find_note_id_by_guid(col, uuid)
            if note_id:
                note = col.get_note(note_id)
                if "orphan" not in note.tags:
                    col.tags.bulk_add([note_id], "orphan")
                result_map[uuid] = "success"
            else:
                result_map[uuid] = "not_found"
        except Exception as e:
            logging.exception(f"Anki sync failed for orphaned note {uuid}")
            err_msg = str(e)
            if not err_msg.startswith("error:"):
                err_msg = f"error: {err_msg}"
            key = uuid if uuid else f"_index_{i}"
            result_map[key] = err_msg

    return result_map


def process_test_tags(uuid: str, col: Any) -> list[str]:
    note_id = find_note_id_by_guid(col, uuid)
    if not note_id:
        return []
    note = col.get_note(note_id)
    return list(note.tags)


def process_test_reset(col: Any) -> dict[str, str]:

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


def get_expected_api_key() -> str:
    if env_key := os.environ.get("ANKI_SYNC_API_KEY"):
        return env_key
    if mw:
        addon_name = __name__.split(".")[0]
        config = mw.addonManager.getConfig(addon_name)
        if config and "apiKey" in config:
            return config["apiKey"]
    return ""


class SyncRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        pass

    def send_json(self, status: int, payload: Any) -> None:
        self.send_response(status)
        self.send_header("Content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode("utf-8"))

    def check_auth(self) -> bool:
        expected = get_expected_api_key()
        if not expected:
            self.send_json(401, {"error": "API key not configured in Anki addon"})
            return False
        auth_header = self.headers.get("Authorization", "")
        if auth_header != f"Bearer {expected}":
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
        if not self.check_auth():
            return
        if self.path == "/__test__/reset":
            if not TEST_MODE:
                self.send_json(404, {"error": "Not Found"})
                return
            try:
                result = _run_in_anki_background(process_test_reset)
                self.send_json(200, result)
            except Exception as e:
                self.send_json(500, {"error": str(e)})
            return

        if self.path == "/__test__/tags":
            if not TEST_MODE:
                self.send_json(404, {"error": "Not Found"})
                return

            content_length_str = self.headers.get("Content-Length", "0")
            content_length = int(content_length_str) if content_length_str else 0
            if content_length == 0:
                self.send_json(400, {"error": "Missing payload"})
                return

            body = self.rfile.read(content_length).decode("utf-8")
            payload = json.loads(body)
            uuid = payload.get("uuid")
            if not uuid:
                self.send_json(400, {"error": "Missing uuid"})
                return

            try:
                result = _run_in_anki_background(
                    lambda col: process_test_tags(uuid, col)
                )
                self.send_json(200, {"tags": result})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
            return

        if self.path == "/__test__/fields":
            if not TEST_MODE:
                self.send_json(404, {"error": "Not Found"})
                return

            content_length_str = self.headers.get("Content-Length", "0")
            content_length = int(content_length_str) if content_length_str else 0
            if content_length == 0:
                self.send_json(400, {"error": "Missing payload"})
                return

            body = self.rfile.read(content_length).decode("utf-8")
            payload = json.loads(body)
            uuid = payload.get("uuid")
            if not uuid:
                self.send_json(400, {"error": "Missing uuid"})
                return

            try:
                result = _run_in_anki_background(
                    lambda col: process_test_fields(uuid, col)
                )
                self.send_json(200, {"fields": result})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
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
                result = _run_in_anki_background(
                    lambda col: process_sync_notes(payload, col)
                )
                self.send_json(200, result)
            except Exception as e:
                self.send_json(500, {"error": str(e)})

        elif self.path == "/markOrphaned":
            if not isinstance(payload, list):
                self.send_json(400, {"error": "Expected a JSON array"})
                return

            try:
                result = _run_in_anki_background(
                    lambda col: process_mark_orphaned(payload, col)
                )
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
