"""Tiny cached HTTP helper shared by the deck builders (standard library only)."""
import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "FieldGuideDeckBuilder/1.0 (https://github.com/DemianCode/fieldguide; offline flashcard deck generator)"
CACHE_DIR = os.environ.get("FG_CACHE", os.path.join(os.path.dirname(__file__), ".cache"))
os.makedirs(CACHE_DIR, exist_ok=True)

_last = {}


def _throttle(host, min_gap):
    wait = _last.get(host, 0) + min_gap - time.time()
    if wait > 0:
        time.sleep(wait)
    _last[host] = time.time()


def get_json(url, params=None, headers=None, gap=0.7, tries=6):
    """GET url (+params) -> parsed JSON. Responses are cached on disk by URL."""
    if params:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params, safe="|,")
    key = hashlib.sha1(url.encode()).hexdigest()
    path = os.path.join(CACHE_DIR, key + ".json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    host = urllib.parse.urlparse(url).netloc
    hdrs = {"User-Agent": UA, "Accept": "application/json"}
    hdrs.update(headers or {})
    delay = 3
    for attempt in range(tries):
        _throttle(host, gap)
        try:
            req = urllib.request.Request(url, headers=hdrs)
            with urllib.request.urlopen(req, timeout=120) as r:
                data = json.load(r)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f)
            return data
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                retry = e.headers.get("Retry-After")
                time.sleep(min(int(retry), 90) if retry and retry.isdigit() else delay)
                delay = min(delay * 2, 60)
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt < tries - 1:
                time.sleep(delay)
                delay = min(delay * 2, 60)
                continue
            raise
