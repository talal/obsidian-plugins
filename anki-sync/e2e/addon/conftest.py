import pytest
import subprocess
import requests
import time
import shutil
import os
from pathlib import Path


# Session-scoped: runs exactly once for the entire test run
@pytest.fixture(scope="session", autouse=True)
def anki_process():
    repo_root = Path(__file__).parent.parent.parent
    golden_base = repo_root / "e2e" / "fixtures" / "golden-base"
    temp_base = Path("/tmp/anki-e2e-base")

    if not golden_base.exists() or not (golden_base / "Test").exists():
        raise RuntimeError(
            f"Golden base not found or missing 'Test' profile at {golden_base}.\n"
            f"Please run: anki -b {golden_base} and create a profile named 'Test', then close Anki."
        )

    # 1. Copy the "golden" base directory to a temp folder
    if temp_base.exists():
        shutil.rmtree(temp_base)
    shutil.copytree(golden_base, temp_base)

    # Install the addon into the temp base
    addon_dir = temp_base / "addons21" / "obsidian_anki_sync"
    addon_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(
        repo_root / "anki-addon" / "src" / "obsidian_anki_sync",
        addon_dir,
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__"),
    )

    # 2. Launch Anki headlessly, pointing to our temp base and test profile
    env = os.environ.copy()
    env["QT_QPA_PLATFORM"] = "offscreen"
    env["ANKI_SYNC_TEST_MODE"] = "1"
    # Use 8767 for tests to prevent colliding with a user's running Anki instance on the default 8766
    env["ANKI_SYNC_PORT"] = "8767"
    env["ANKI_SYNC_API_KEY"] = "test-key"
    env["ANKI_SINGLE_INSTANCE_KEY"] = "anki_test_harness_instance"
    # Isolate from existing Anki instances
    env["XDG_RUNTIME_DIR"] = "/tmp/anki-test-runtime"
    os.makedirs(env["XDG_RUNTIME_DIR"], exist_ok=True)

    process = subprocess.Popen(
        ["anki", "-b", str(temp_base), "-p", "Test"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    # 3. Poll the health endpoint until Anki is fully booted
    ready = False
    for _ in range(50):
        try:
            res = requests.get(
                "http://127.0.0.1:8767/health",
                headers={"Authorization": "Bearer test-key"},
            )
            if res.status_code == 200 and res.json().get("profileLoaded"):
                ready = True
                break
        except requests.ConnectionError:
            time.sleep(0.2)

    if not ready:
        process.terminate()
        stderr_out = process.stdout.read()
        raise RuntimeError(
            f"Anki failed to start or load profile within timeout. Stderr:\n{stderr_out}"
        )

    yield process  # Tests run here

    # 4. Teardown: kill Anki and wipe the temp directory
    process.terminate()
    process.wait(timeout=5)
    shutil.rmtree(temp_base)


# Function-scoped: runs before every individual test
@pytest.fixture(autouse=True)
def reset_anki():
    # Hits the secret backdoor endpoint
    # This deletes all notes and decks created by the previous test
    requests.post(
        "http://127.0.0.1:8767/__test__/reset",
        headers={"Authorization": "Bearer test-key"},
    )


@pytest.fixture
def client():
    # A reusable HTTP session
    session = requests.Session()
    session.headers.update({"Authorization": "Bearer test-key"})
    return session
