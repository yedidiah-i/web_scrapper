"""Headless rendering service.

Provides the browser half of the hybrid fetcher. The Rust core worker does the
fast HTTP path and only asks for a rendered page when the cheap response looks
like it needs JavaScript, when a request explicitly demands rendering, or when
the page presents a challenge that only a real browser can clear.

Two backends are supported:

* **local** - Playwright driving a locally installed Chromium. Free, keeps the
  traffic on the machine, and inherits the host's TLS stack.
* **cloud** - a remote browser service reached over its HTTP API. Used when a
  URL is mapped to a cloud renderer in the configuration, or as a fallback when
  the local browser is unavailable.

Both backends return the same :class:`RenderResult`, so the caller never has to
know which one answered.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any

LOGGER = logging.getLogger("data-processor.render")

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# Markers that identify a challenge page rather than the real content.
CHALLENGE_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"cf-browser-verification|cf_chl_opt|challenge-platform", "cloudflare"),
    (r"/cdn-cgi/challenge-platform", "cloudflare"),
    (r"g-recaptcha|grecaptcha", "recaptcha"),
    (r"hcaptcha\.com|h-captcha", "hcaptcha"),
    (r"data-sitekey.*recaptcha|turnstile", "turnstile"),
    (r"Pardon Our Interruption|unusual traffic|verify you are human", "bot_wall"),
)

# Heuristics that suggest a page renders its content with JavaScript.
JS_APP_MARKERS: tuple[str, ...] = (
    "id=\"root\"",
    "id='root'",
    "id=\"app\"",
    "id='app'",
    "__NEXT_DATA__",
    "__NUXT__",
    "ng-version",
    "data-reactroot",
    "window.__INITIAL_STATE__",
    "window.__APOLLO_STATE__",
)


def _env_int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        LOGGER.warning("invalid integer for %s: %r, using default", key, raw)
        return default


def _env_float(key: str, default: float) -> float:
    raw = os.environ.get(key)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        LOGGER.warning("invalid float for %s: %r, using default", key, raw)
        return default


@dataclass
class RenderConfig:
    """Everything the renderer needs, resolved from the environment."""

    backend: str = "local"
    cloud_endpoint: str = ""
    cloud_api_key: str = ""
    browser_channel: str = ""
    navigation_timeout_ms: int = 30_000
    settle_timeout_ms: int = 8_000
    wait_for_selector: str = ""
    block_resources: bool = True
    block_types: tuple[str, ...] = ("image", "media", "font")
    screenshot: bool = False
    user_agent: str = DEFAULT_USER_AGENT
    viewport_width: int = 1440
    viewport_height: int = 900
    locale: str = "en-US"
    timezone: str = "UTC"
    extra_headers: dict[str, str] = field(default_factory=dict)
    proxy_url: str = ""

    @classmethod
    def from_env(cls) -> "RenderConfig":
        raw_headers = os.environ.get("PY_RENDER_HEADERS", "").strip()
        headers: dict[str, str] = {}
        if raw_headers:
            try:
                parsed = json.loads(raw_headers)
                if isinstance(parsed, dict):
                    headers = {str(k): str(v) for k, v in parsed.items()}
            except json.JSONDecodeError:
                LOGGER.warning("PY_RENDER_HEADERS is not valid JSON, ignoring")

        block_types = tuple(
            part.strip()
            for part in os.environ.get("PY_RENDER_BLOCK_TYPES", "image,media,font").split(",")
            if part.strip()
        )

        return cls(
            backend=os.environ.get("PY_RENDER_BACKEND", "local").strip().lower() or "local",
            cloud_endpoint=os.environ.get("PY_RENDER_CLOUD_ENDPOINT", "").strip(),
            cloud_api_key=os.environ.get("PY_RENDER_CLOUD_API_KEY", "").strip(),
            browser_channel=os.environ.get("PY_RENDER_BROWSER_CHANNEL", "").strip(),
            navigation_timeout_ms=_env_int("PY_RENDER_NAV_TIMEOUT_MS", 30_000),
            settle_timeout_ms=_env_int("PY_RENDER_SETTLE_TIMEOUT_MS", 8_000),
            wait_for_selector=os.environ.get("PY_RENDER_WAIT_SELECTOR", "").strip(),
            block_resources=os.environ.get("PY_RENDER_BLOCK_RESOURCES", "1") != "0",
            block_types=block_types,
            screenshot=os.environ.get("PY_RENDER_SCREENSHOT", "0") == "1",
            user_agent=os.environ.get("PY_RENDER_USER_AGENT", DEFAULT_USER_AGENT),
            viewport_width=_env_int("PY_RENDER_VIEWPORT_WIDTH", 1440),
            viewport_height=_env_int("PY_RENDER_VIEWPORT_HEIGHT", 900),
            locale=os.environ.get("PY_RENDER_LOCALE", "en-US"),
            timezone=os.environ.get("PY_RENDER_TIMEZONE", "UTC"),
            extra_headers=headers,
            proxy_url=os.environ.get("PY_RENDER_PROXY", "").strip(),
        )


# --------------------------------------------------------------------------- #
# Results
# --------------------------------------------------------------------------- #


@dataclass
class RenderResult:
    """Outcome of one rendering attempt."""

    ok: bool
    html: str = ""
    status_code: int | None = None
    final_url: str = ""
    backend: str = "none"
    error: str | None = None
    challenge: str | None = None
    elapsed_ms: int = 0
    console_errors: list[str] = field(default_factory=list)
    cookies: list[dict[str, Any]] = field(default_factory=list)
    screenshot_b64: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "html": self.html,
            "status_code": self.status_code,
            "final_url": self.final_url,
            "backend": self.backend,
            "error": self.error,
            "challenge": self.challenge,
            "elapsed_ms": self.elapsed_ms,
            "console_errors": self.console_errors,
            "cookies": self.cookies,
            "screenshot_b64": self.screenshot_b64,
            "meta": self.meta,
        }


# --------------------------------------------------------------------------- #
# Detection helpers
# --------------------------------------------------------------------------- #


def detect_challenge(html: str) -> str | None:
    """Return the name of the challenge shown, or ``None`` for a normal page."""
    if not html:
        return None
    lowered = html[:200_000].lower()
    for pattern, name in CHALLENGE_PATTERNS:
        if re.search(pattern, lowered):
            return name
    return None


def looks_like_js_app(html: str) -> bool:
    """True when the markup looks like a shell that JavaScript fills in.

    The check is intentionally conservative: a page is only flagged when it
    carries a known SPA mount point *and* has little server-rendered text.
    Flagging too eagerly would send every page through the slow browser path.
    """
    if not html:
        return False

    lowered = html.lower()
    has_marker = any(marker in lowered for marker in JS_APP_MARKERS)
    if not has_marker:
        return False

    # Rough amount of visible text in the body.
    body = lowered.split("<body", 1)[-1]
    text = re.sub(r"<[^>]+>", " ", body)
    text = re.sub(r"\s+", " ", text).strip()
    return len(text) < 1_200


# --------------------------------------------------------------------------- #
# Local Playwright backend
# --------------------------------------------------------------------------- #


class LocalPlaywrightRenderer:
    """Renders pages with a locally installed Chromium via Playwright.

    The browser is launched lazily and reused across requests, because paying
    the launch cost per page would dominate the render time.
    """

    def __init__(self, config: RenderConfig) -> None:
        self._config = config
        self._lock = threading.Lock()
        self._playwright: Any = None
        self._browser: Any = None
        self._started = False

    # -- lifecycle -------------------------------------------------------- #

    def _ensure_browser(self) -> None:
        """Launch the browser if it is not running yet."""
        with self._lock:
            if self._browser is not None:
                return

            try:
                from playwright.sync_api import sync_playwright
            except ImportError:
                raise RuntimeError(
                    "playwright is not installed; run "
                    "`pip install playwright && playwright install chromium`"
                )

            self._playwright = sync_playwright().start()
            launch_kwargs: dict[str, Any] = {
                "headless": True,
                "args": [
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                ],
            }
            if self._config.browser_channel:
                launch_kwargs["channel"] = self._config.browser_channel
            if self._config.proxy_url:
                launch_kwargs["proxy"] = {"server": self._config.proxy_url}

            self._browser = self._playwright.chromium.launch(**launch_kwargs)
            self._started = True
            LOGGER.info("local playwright browser started")

    def close(self) -> None:
        """Shut the browser down and release the driver."""
        with self._lock:
            if self._browser is not None:
                try:
                    self._browser.close()
                except Exception:
                    LOGGER.debug("browser close failed", exc_info=True)
                self._browser = None
            if self._playwright is not None:
                try:
                    self._playwright.stop()
                except Exception:
                    LOGGER.debug("playwright stop failed", exc_info=True)
                self._playwright = None
            self._started = False

    # -- rendering -------------------------------------------------------- #

    def render(
        self,
        url: str,
        *,
        wait_for_selector: str = "",
        scroll: bool = False,
        click_selectors: tuple[str, ...] = (),
        wait_after_ms: int = 0,
        extra_headers: dict[str, str] | None = None,
    ) -> RenderResult:
        """Render one URL and return the resulting DOM."""
        started = time.perf_counter()
        try:
            self._ensure_browser()
        except Exception as exc:
            LOGGER.warning("local browser unavailable: %s", exc)
            return RenderResult(
                ok=False,
                error=f"local browser unavailable: {exc}",
                backend="local",
                elapsed_ms=int((time.perf_counter() - started) * 1000),
            )

        console_errors: list[str] = []
        context = None
        try:
            context_kwargs: dict[str, Any] = {
                "user_agent": self._config.user_agent,
                "locale": self._config.locale,
                "timezone_id": self._config.timezone,
                "viewport": {
                    "width": self._config.viewport_width,
                    "height": self._config.viewport_height,
                },
                "ignore_https_errors": True,
            }
            headers = dict(self._config.extra_headers)
            headers.update(extra_headers or {})
            if headers:
                context_kwargs["extra_http_headers"] = headers

            context = self._browser.new_context(**context_kwargs)

            # Hide the most obvious automation tell before any script runs.
            context.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});"
            )

            if self._config.block_resources and self._config.block_types:
                blocked = set(self._config.block_types)

                def _route_handler(route: Any) -> None:
                    if route.request.resource_type in blocked:
                        route.abort()
                    else:
                        route.continue_()

                context.route("**/*", _route_handler)

            page = context.new_page()
            page.on(
                "console",
                lambda msg: console_errors.append(msg.text)
                if msg.type == "error"
                else None,
            )

            response = page.goto(
                url,
                wait_until="domcontentloaded",
                timeout=self._config.navigation_timeout_ms,
            )
            status_code = response.status if response is not None else None

            selector = wait_for_selector or self._config.wait_for_selector
            if selector:
                try:
                    page.wait_for_selector(
                        selector,
                        timeout=self._config.settle_timeout_ms,
                        state="attached",
                    )
                except Exception:
                    # A missing selector is not fatal: the page may simply not
                    # have it, and the rest of the DOM is still worth keeping.
                    LOGGER.debug("wait_for_selector %r did not match", selector)

            for click_selector in click_selectors:
                try:
                    page.click(click_selector, timeout=self._config.settle_timeout_ms)
                    page.wait_for_timeout(400)
                except Exception:
                    LOGGER.debug("click on %r failed", click_selector)

            if scroll:
                await_scroll(page)

            if wait_after_ms > 0:
                page.wait_for_timeout(wait_after_ms)
            else:
                # Give client-side hydration a brief moment to finish.
                page.wait_for_timeout(min(self._config.settle_timeout_ms, 2_000))

            html = page.content()
            final_url = page.url
            cookies = context.cookies()
            screenshot_b64 = None
            if self._config.screenshot:
                try:
                    raw = page.screenshot(full_page=False, type="png")
                    screenshot_b64 = base64.b64encode(raw).decode("ascii")
                except Exception:
                    LOGGER.debug("screenshot failed", exc_info=True)

            challenge = detect_challenge(html)
            return RenderResult(
                ok=True,
                html=html,
                status_code=status_code,
                final_url=final_url,
                backend="local",
                challenge=challenge,
                elapsed_ms=int((time.perf_counter() - started) * 1000),
                console_errors=console_errors[:20],
                cookies=[
                    {
                        "name": c.get("name"),
                        "value": c.get("value"),
                        "domain": c.get("domain"),
                        "path": c.get("path"),
                        "expires": c.get("expires"),
                    }
                    for c in cookies
                ],
                screenshot_b64=screenshot_b64,
                meta={"viewport": context_kwargs["viewport"]},
            )
        except Exception as exc:
            LOGGER.warning("local render failed for %s: %s", url, exc)
            return RenderResult(
                ok=False,
                error=f"local render failed: {exc}",
                backend="local",
                elapsed_ms=int((time.perf_counter() - started) * 1000),
            )
        finally:
            if context is not None:
                try:
                    context.close()
                except Exception:
                    LOGGER.debug("context close failed", exc_info=True)


def await_scroll(page: Any) -> None:
    """Scroll to the bottom of the page to trigger lazy loading."""
    try:
        page.evaluate(
            """
            async () => {
                const step = window.innerHeight * 0.8;
                const limit = 60;
                for (let i = 0; i < limit; i++) {
                    window.scrollBy(0, step);
                    await new Promise(r => setTimeout(r, 120));
                    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) {
                        break;
                    }
                }
                window.scrollTo(0, 0);
            }
            """
        )
    except Exception:
        LOGGER.debug("scroll script failed", exc_info=True)


# --------------------------------------------------------------------------- #
# Cloud browser backend
# --------------------------------------------------------------------------- #


class CloudBrowserRenderer:
    """Renders pages through a remote browser service over HTTP.

    The service is expected to accept a JSON body with the target URL and
    return a JSON body holding the rendered HTML. That covers the common
    hosted-browser APIs and keeps the integration provider neutral.
    """

    def __init__(self, config: RenderConfig) -> None:
        self._config = config

    def render(
        self,
        url: str,
        *,
        wait_for_selector: str = "",
        scroll: bool = False,
        click_selectors: tuple[str, ...] = (),
        wait_after_ms: int = 0,
        extra_headers: dict[str, str] | None = None,
    ) -> RenderResult:
        started = time.perf_counter()
        if not self._config.cloud_endpoint:
            return RenderResult(
                ok=False,
                error="cloud renderer is not configured (PY_RENDER_CLOUD_ENDPOINT is empty)",
                backend="cloud",
            )

        payload: dict[str, Any] = {
            "url": url,
            "wait_for_selector": wait_for_selector or self._config.wait_for_selector,
            "scroll": scroll,
            "click_selectors": list(click_selectors),
            "wait_after_ms": wait_after_ms,
            "user_agent": self._config.user_agent,
            "viewport": {
                "width": self._config.viewport_width,
                "height": self._config.viewport_height,
            },
            "proxy": self._config.proxy_url,
        }
        headers = dict(self._config.extra_headers)
        headers.update(extra_headers or {})
        headers["Content-Type"] = "application/json"
        if self._config.cloud_api_key:
            headers["Authorization"] = f"Bearer {self._config.cloud_api_key}"

        try:
            body = _http_post_json(
                self._config.cloud_endpoint,
                payload,
                headers=headers,
                timeout_s=self._config.navigation_timeout_ms / 1000 + 15,
            )
        except Exception as exc:
            LOGGER.warning("cloud render failed for %s: %s", url, exc)
            return RenderResult(
                ok=False,
                error=f"cloud render failed: {exc}",
                backend="cloud",
                elapsed_ms=int((time.perf_counter() - started) * 1000),
            )

        html = str(body.get("html") or body.get("content") or "")
        challenge = detect_challenge(html)
        return RenderResult(
            ok=True,
            html=html,
            status_code=_as_int(body.get("status_code") or body.get("status")),
            final_url=str(body.get("url") or body.get("final_url") or url),
            backend="cloud",
            challenge=challenge,
            elapsed_ms=int((time.perf_counter() - started) * 1000),
            cookies=body.get("cookies") or [],
            meta={"provider": "cloud"},
        )


def _as_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _http_post_json(
    url: str,
    payload: dict[str, Any],
    *,
    headers: dict[str, str] | None = None,
    timeout_s: float = 30.0,
) -> dict[str, Any]:
    """POST JSON and decode a JSON response using the standard library."""
    import urllib.error
    import urllib.request

    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="POST")
    request.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        if key.lower() == "content-type":
            continue
        request.add_header(key, value)

    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        raw = response.read().decode("utf-8", errors="replace")

    try:
        decoded = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"cloud renderer returned non-JSON body: {exc}") from exc

    if not isinstance(decoded, dict):
        raise ValueError("cloud renderer returned a non-object JSON body")
    return decoded


# --------------------------------------------------------------------------- #
# Facade
# --------------------------------------------------------------------------- #


class RenderService:
    """Chooses a backend and renders pages.

    The service prefers the local browser because it is free and fast. It
    falls back to the cloud renderer when the local one is unavailable or when
    the requested URL is pinned to the cloud backend by configuration.
    """

    def __init__(self, config: RenderConfig | None = None) -> None:
        self._config = config or RenderConfig.from_env()
        self._local = LocalPlaywrightRenderer(self._config)
        self._cloud = CloudBrowserRenderer(self._config)

    @property
    def config(self) -> RenderConfig:
        return self._config

    def available(self) -> bool:
        """True when at least one backend is configured."""
        if self._config.backend == "cloud":
            return bool(self._config.cloud_endpoint)
        return True

    def render(
        self,
        url: str,
        *,
        wait_for_selector: str = "",
        scroll: bool = False,
        click_selectors: tuple[str, ...] = (),
        wait_after_ms: int = 0,
        extra_headers: dict[str, str] | None = None,
        prefer_cloud: bool = False,
    ) -> RenderResult:
        """Render a URL, falling back to the other backend on failure."""
        use_cloud_first = prefer_cloud or self._config.backend == "cloud"

        order = (
            (self._cloud, self._local)
            if use_cloud_first
            else (self._local, self._cloud)
        )

        last_error = ""
        for backend in order:
            if isinstance(backend, CloudBrowserRenderer) and not self._config.cloud_endpoint:
                continue
            result = backend.render(
                url,
                wait_for_selector=wait_for_selector,
                scroll=scroll,
                click_selectors=click_selectors,
                wait_after_ms=wait_after_ms,
                extra_headers=extra_headers,
            )
            if result.ok:
                return result
            last_error = result.error or "render failed"

        return RenderResult(ok=False, error=last_error or "no renderer available")

    def close(self) -> None:
        """Release the browser held by the local backend."""
        self._local.close()


# --------------------------------------------------------------------------- #
# Async wrapper
# --------------------------------------------------------------------------- #


async def render_async(service: RenderService, url: str, **kwargs: Any) -> RenderResult:
    """Run :meth:`RenderService.render` off the event loop.

    The Playwright backend is synchronous, so calling it directly from an
    async server would block the loop for the whole render.
    """
    return await asyncio.to_thread(service.render, url, **kwargs)
