import os
import tempfile

# Tests get their own data directory and never call a model.
os.environ["SLICEBOT_DATA_DIR"] = tempfile.mkdtemp(prefix="slicebot-test-")
os.environ["SLICEBOT_ENGINE"] = "offline"

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_data():
    from slicebot import actions
    from slicebot.db import store
    store().reset()
    actions.clear_runs()
    yield
