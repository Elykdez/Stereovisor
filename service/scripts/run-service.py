from __future__ import annotations

import os
import sys
from pathlib import Path


# Packaged Electron stores the service beside app.asar under resources. The
# explicit root keeps imports and vendor paths stable in both modes.
PROJECT_ROOT = Path(os.environ.get("STEREOVISOR_APP_ROOT", Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(PROJECT_ROOT))

try:
    import uvicorn
except ModuleNotFoundError:
    # A user-supplied CUDA Python may own the AI stack while uvicorn remains in
    # the managed core environment. Append, rather than prepend, so that the
    # selected Python's Torch and model packages remain authoritative.
    managed_site = PROJECT_ROOT / ".venv" / "Lib" / "site-packages"
    if managed_site.is_dir():
        sys.path.append(str(managed_site))
    import uvicorn


if __name__ == "__main__":
    # Bind address is configuration, not a constant. Non-loopback hosting is
    # permitted only when the shared token required by HTTP and events is set.
    from service.src.config import SERVICE_HOST, SERVICE_PORT, ensure_bind_allowed

    ensure_bind_allowed()
    # Routine 200 access lines obscure useful startup, warning, and failure
    # output in the launcher, and job progress now arrives over the event socket.
    uvicorn.run(
        "service.src.app:app",
        host=SERVICE_HOST,
        port=SERVICE_PORT,
        access_log=False,
    )
