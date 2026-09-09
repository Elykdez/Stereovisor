from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any

logger = logging.getLogger(__name__)


# A slow or stalled client must never throttle the inference pipeline, so each
# subscriber gets a bounded mailbox and is dropped once it overflows. Dropping
# is safe: every consumer re-reads authoritative state over HTTP after a gap.
MAX_PENDING_EVENTS = 256
_OVERFLOW_FRAME = {"topic": "_control", "seq": 0, "code": "overflow"}


class EventHub:
    """Fan-out of service state changes to subscribed WebSocket clients.

    Producers are ordinary worker threads - FastAPI background jobs run off the
    event loop - so :meth:`publish` is synchronous and thread-safe while the
    actual delivery is marshalled onto the loop that owns the sockets.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._sequence: dict[str, int] = {}

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        with self._lock:
            self._loop = loop

    def reset(self) -> None:
        with self._lock:
            self._loop = None
            self._subscribers.clear()
            self._sequence.clear()

    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)

    def register(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=MAX_PENDING_EVENTS)
        with self._lock:
            self._subscribers.add(queue)
        return queue

    def unregister(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        with self._lock:
            self._subscribers.discard(queue)

    def publish(self, topic: str, payload: dict[str, Any]) -> None:
        """Queue one frame for delivery. Safe to call from any thread."""
        with self._lock:
            loop = self._loop
            has_subscribers = bool(self._subscribers)
        if loop is None or not has_subscribers:
            return
        try:
            loop.call_soon_threadsafe(self._dispatch, topic, payload)
        except RuntimeError:
            # The loop is already closing during shutdown. Dropping the frame is
            # correct: nothing can consume it, and HTTP remains authoritative.
            logger.debug("event dropped after loop shutdown: topic=%s", topic)

    def _dispatch(self, topic: str, payload: dict[str, Any]) -> None:
        # Sequencing is per topic so a client can discard frames older than the
        # state it has already applied without coordinating across topics.
        self._sequence[topic] = self._sequence.get(topic, 0) + 1
        message = {**payload, "topic": topic, "seq": self._sequence[topic]}
        with self._lock:
            subscribers = list(self._subscribers)
        for queue in subscribers:
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                logger.warning("event subscriber dropped: topic=%s reason=backlog", topic)
                # Wake the sender before removing the queue. Without a
                # terminal frame, the sender would wait forever on a queue that
                # is no longer reachable from the hub.
                while True:
                    try:
                        queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                queue.put_nowait(dict(_OVERFLOW_FRAME))
                with self._lock:
                    self._subscribers.discard(queue)


events = EventHub()
