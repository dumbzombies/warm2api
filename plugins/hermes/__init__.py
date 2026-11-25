"""Hermes model-provider plugin: the local warm2api proxy as a provider.

Self-contained: ``dist/warm2api.mjs`` beside this file is the whole proxy. On
import the plugin reuses a proxy that is already listening, or starts the
bundled one in the background (detached, logging to ``<data dir>/plugin.log``),
then registers a ``ProviderProfile`` so the models show up in Hermes itself.

Install: copy this directory to ``$HERMES_HOME/plugins/model-providers/warm/``
(or install it as a pip package with a ``hermes_agent.plugins`` entry point
pointing at ``warm_plugin:register``).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from providers import register_provider
from providers.base import ProviderProfile

NAME = "warm"
DISPLAY_NAME = "Warm (local proxy)"
PORT = int(os.environ.get("WARM2API_PORT", "41673") or 41673)
BASE_URL = f"http://127.0.0.1:{PORT}"
API_BASE = f"{BASE_URL}/v1"

# Advertised until the gateway catalog is reachable; Hermes refreshes models
# through its own model discovery once an account exists.
FALLBACK_MODELS = [
    "gpt-5.6-luna",
    "deepseek-v4-pro",
    "deepseek-v4-pro-0813",
    "deepseek-v4-flash",
    "deepseek-v4-flash-0731",
    "glm-5.2",
    "glm-5.3",
    "glm-5.3-flash",
]


def _data_dir() -> Path:
    configured = os.environ.get("WARM2API_DATA", "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".warm2api"


def _bundle() -> Path:
    return Path(__file__).resolve().parent / "dist" / "warm2api.mjs"


def _healthy(timeout: float = 0.6) -> bool:
    try:
        with urllib.request.urlopen(f"{BASE_URL}/healthz", timeout=timeout) as res:
            return res.status == 200 and json.loads(res.read().decode("utf-8")).get("ok") is True
    except (urllib.error.URLError, OSError, ValueError):
        return False


def _spawn() -> None:
    """Start the bundled proxy once; reuse whatever already listens."""
    if _healthy():
        return
    bun = shutil.which("bun")
    bundle = _bundle()
    if not bun or not bundle.is_file():
        return  # registration still happens; the provider reports the missing proxy
    data = _data_dir()
    data.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "WARM2API_PORT": str(PORT)}
    with open(data / "plugin.log", "ab") as log:
        subprocess.Popen(
            [bun, str(bundle), "serve"],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            start_new_session=True,
            close_fds=True,
        )
    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        if _healthy():
            return
        time.sleep(0.12)


def _ensure_running() -> None:
    """Bring the proxy up without blocking provider discovery for long."""
    if _healthy():
        return
    thread = threading.Thread(target=_spawn, name="warm2api-start", daemon=True)
    thread.start()
    thread.join(timeout=1.5)


def _api_key() -> str | None:
    path = _data_dir() / "api-key"
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if value:
        os.environ.setdefault("WARM2API_API_KEY", value)
        return value
    return None


_ensure_running()

# A loopback proxy runs open by default, so the key is optional: declare the env
# var only when one actually exists, otherwise Hermes refuses to start the
# provider for a credential nobody needs.
_KEY = _api_key()


def _state(api_key: str | None = None, base_url: str | None = None) -> dict:
    """`/api/state` from the proxy, or an empty dict when it is unreachable."""
    key = api_key or _KEY
    base = (base_url or BASE_URL).rstrip("/")
    if base.endswith("/v1"):
        base = base[: -len("/v1")]
    headers = {"accept": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    request = urllib.request.Request(f"{base}/api/state", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=5.0) as res:
            body = json.loads(res.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return {}
    return body if isinstance(body, dict) else {}


class WarmProfile(ProviderProfile):
    def fetch_account_usage(self, *, api_key: str | None = None, base_url: str | None = None):
        """Report the pool budget, so `hermes usage` and `/usage` show it.

        Imported inside the method: `agent.account_usage` pulls in
        `hermes_cli.runtime_provider`, and a module-level import makes provider
        discovery hit a circular import and silently drop this plugin.
        """
        from datetime import datetime, timezone

        from agent.account_usage import AccountUsageSnapshot, AccountUsageWindow

        state = _state(api_key, base_url)
        pool = state.get("pool") or {}
        used = pool.get("used_percent")
        limit = pool.get("limit_usd")
        if not isinstance(used, (int, float)):
            # No snapshot yet: the proxy has not polled the gateway, so there is
            # nothing honest to report. Zero would claim a fully unspent pool.
            return None
        reset_at = None
        if isinstance(pool.get("resets_at"), str):
            try:
                reset_at = datetime.fromisoformat(pool["resets_at"].replace("Z", "+00:00"))
            except ValueError:
                reset_at = None
        accounts = (state.get("accounts") or {}).get("total")
        if isinstance(accounts, int) and isinstance(limit, (int, float)):
            detail = f"{accounts} account(s), ${limit:.2f} pool"
        elif isinstance(accounts, int):
            detail = f"{accounts} account(s)"
        else:
            detail = None
        window = AccountUsageWindow(
            label="Warm pool",
            used_percent=round(float(used), 2),
            reset_at=reset_at,
            detail=detail if isinstance(limit, (int, float)) and detail else (
                f"${limit:.2f} allowance" if isinstance(limit, (int, float)) else None
            ),
        )
        return AccountUsageSnapshot(
            provider=self.name,
            source="warm2api_proxy",
            fetched_at=datetime.now(timezone.utc),
            windows=(window,),
        )


PROFILE = WarmProfile(
    name=NAME,
    display_name=DISPLAY_NAME,
    base_url=API_BASE,
    env_vars=("WARM2API_API_KEY",) if _KEY else (),
    auth_type="api_key",
    fallback_models=list(FALLBACK_MODELS),
)


def register() -> None:
    """Register the profile with the Hermes provider registry."""
    register_provider(PROFILE)


register()
