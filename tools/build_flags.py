#!/usr/bin/env python3
"""Build flag decks (national, historical, subnational) from Wikidata + Wikimedia Commons.

  * Wikidata  - which countries / former countries / first-level divisions exist and their
                flag image (P41), with continent, country and dates.
  * Commons   - licence and author of each flag image (recorded on every card).

Usage:  python3 tools/build_flags.py [--out data/packs]
"""
import argparse
import hashlib
import json
import os
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fgnet import get_json  # noqa: E402

SPARQL = "https://query.wikidata.org/sparql"
COMMONS = "https://commons.wikimedia.org/w/api.php"

PREFIX = """
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX wikibase: <http://wikiba.se/ontology#>
"""

Q_NATIONAL = """
SELECT ?item ?label ?flag ?sl ?contLabel WHERE {
  ?item wdt:P31 wd:Q3624078 ; wdt:P41 ?flag ; wikibase:sitelinks ?sl ; rdfs:label ?label .
  FILTER(lang(?label) = "en")
  FILTER NOT EXISTS { ?item wdt:P576 ?end }
  OPTIONAL { ?item wdt:P30 ?cont . ?cont rdfs:label ?contLabel . FILTER(lang(?contLabel) = "en") }
}"""

Q_HISTORICAL = """
SELECT ?item ?label ?flag ?sl WHERE {
  ?item wdt:P31 wd:Q3024240 ; wdt:P41 ?flag ; wikibase:sitelinks ?sl ; rdfs:label ?label .
  FILTER(lang(?label) = "en")
  FILTER(?sl >= 12)
}"""

Q_HISTORICAL_DATES = """
SELECT ?item ?start ?end WHERE {
  ?item wdt:P31 wd:Q3024240 ; wdt:P41 ?flag ; wikibase:sitelinks ?sl .
  FILTER(?sl >= 12)
  OPTIONAL { ?item wdt:P571 ?start } OPTIONAL { ?item wdt:P576 ?end }
}"""

Q_SUBNATIONAL_IDS = """
SELECT DISTINCT ?item WHERE { ?item wdt:P300 ?code ; wdt:P41 ?flag . }"""

Q_SUBNATIONAL_DETAIL = """
SELECT ?item ?label ?flag ?sl ?countryLabel WHERE {
  VALUES ?item { %s }
  ?item wdt:P41 ?flag ; wikibase:sitelinks ?sl ; rdfs:label ?label ; wdt:P17 ?country .
  ?country rdfs:label ?countryLabel .
  FILTER(lang(?label) = "en" && lang(?countryLabel) = "en")
  FILTER(?sl >= 10)
  FILTER NOT EXISTS { ?item wdt:P576 ?end }
}"""


def sparql(query):
    r = get_json(SPARQL, {"query": PREFIX + query, "format": "json"}, gap=62, tries=15)
    return r["results"]["bindings"]


def val(b, k):
    return b.get(k, {}).get("value")


def file_title(url):
    return urllib.parse.unquote(url.rsplit("/", 1)[1]).replace("_", " ")


def thumb_url(title, width=960):
    name = title.replace(" ", "_")
    h = hashlib.md5(name.encode()).hexdigest()
    base = f"https://upload.wikimedia.org/wikipedia/commons/thumb/{h[0]}/{h[:2]}/{urllib.parse.quote(name)}/{width}px-{urllib.parse.quote(name)}"
    return base + (".png" if name.lower().endswith(".svg") else "")


def commons_info(titles):
    """File title -> {license, artist, desc_url}."""
    out = {}
    titles = sorted(set(titles))
    for i in range(0, len(titles), 40):
        chunk = titles[i:i + 40]
        r = get_json(
            COMMONS,
            {"action": "query", "prop": "imageinfo", "iiprop": "extmetadata|url", "format": "json",
             "formatversion": 2, "titles": "|".join("File:" + t for t in chunk), "redirects": 1},
            gap=1,
        )
        redirects = {x["from"][5:]: x["to"][5:] for x in r.get("query", {}).get("redirects", [])}
        pages = {p["title"][5:]: p for p in r.get("query", {}).get("pages", []) if "imageinfo" in p}
        for t in chunk:
            p = pages.get(redirects.get(t, t))
            if not p:
                continue
            ii = p["imageinfo"][0]
            md = ii.get("extmetadata", {})
            artist = re.sub(r"<[^>]+>", "", md.get("Artist", {}).get("value", "")).strip()
            out[t] = {
                "license": md.get("LicenseShortName", {}).get("value", "").strip(),
                "artist": artist[:80],
                "page": ii.get("descriptionurl", ""),
            }
    return out


def year(iso):
    m = re.match(r"^(-?\d{4})", iso or "")
    return int(m.group(1)) if m else None


def collect(rows, label_key="label"):
    """Deduplicate SPARQL rows per item (several continents / dates produce duplicates)."""
    items = {}
    for b in rows:
        q = val(b, "item").rsplit("/", 1)[1]
        it = items.setdefault(q, {"q": q, "name": val(b, label_key), "flag": val(b, "flag"),
                                  "sl": int(val(b, "sl")), "conts": set(), "country": val(b, "countryLabel"),
                                  "start": None, "end": None})
        if val(b, "contLabel"):
            it["conts"].add(val(b, "contLabel"))
        s, e = year(val(b, "start")), year(val(b, "end"))
        it["start"] = s if s is not None and (it["start"] is None or s < it["start"]) else it["start"]
        it["end"] = e if e is not None and (it["end"] is None or e > it["end"]) else it["end"]
    return list(items.values())


def card(prefix, it, badge, subtitle, features, info):
    title = file_title(it["flag"])
    meta = info.get(title)
    if not meta or not meta["license"]:
        return None
    credit = f"{meta['artist'] + ', ' if meta['artist'] else ''}{meta['license']} via Wikimedia Commons"
    return {
        "id": f"{prefix}-{it['q']}",
        "name": it["name"],
        "subtitle": subtitle,
        "badge": badge,
        "description": "",
        "keyFeatures": features,
        "imageUrl": thumb_url(title),
        "imageCredit": credit,
        "imageLicense": meta["license"],
        "imageSource": meta["page"],
        "sourceUrl": "https://www.wikidata.org/wiki/" + it["q"],
        "_sl": it["sl"],
    }


def pack(did, title, icon, color, desc, cards):
    return {
        "id": did, "title": title, "category": "Flags", "icon": icon, "color": color,
        "description": desc,
        "attribution": "Data: Wikidata (CC0). Flag images: Wikimedia Commons, each under the licence shown on its card.",
        "cards": cards,
    }


def _y(n):
    return f"{-n} BC" if n < 0 else str(n)


def fmt_years(it):
    s, e = it["start"], it["end"]
    s = _y(s) if s is not None else None
    e = _y(e) if e is not None else None
    if s and e:
        return f"{s}–{e}"
    if e:
        return f"until {e}"
    if s:
        return f"from {s}"
    return ""


MIN_HISTORICAL_SITELINKS = 50   # notable former states only
REGION_MIN_SITELINKS = 30
REGION_MAX_PER_COUNTRY = 16     # keep the best-known regions of each country
# Countries whose ISO 3166-2 codes are mostly municipalities rather than regions
REGION_SKIP_COUNTRIES = {"Malta", "North Macedonia", "Estonia", "Latvia", "Lithuania", "Moldova"}
US_SKIP = {"Johnston Atoll", "Wake Island", "United States Minor Outlying Islands"}


def build(outdir):
    os.makedirs(outdir, exist_ok=True)
    print("National...")
    national = collect(sparql(Q_NATIONAL))
    print("Historical...")
    historical = collect(sparql(Q_HISTORICAL))
    dates = {}
    for b in sparql(Q_HISTORICAL_DATES):
        d = dates.setdefault(val(b, "item"), {})
        d.setdefault("start", val(b, "start"))
        d.setdefault("end", val(b, "end"))
    for it in historical:
        d = dates.get("http://www.wikidata.org/entity/" + it["q"], {})
        it["start"], it["end"] = year(d.get("start")), year(d.get("end"))
    print("Subnational...")
    ids = [val(b, "item").rsplit("/", 1)[1] for b in sparql(Q_SUBNATIONAL_IDS)]
    rows = []
    for i in range(0, len(ids), 120):
        rows += sparql(Q_SUBNATIONAL_DETAIL % " ".join("wd:" + q for q in ids[i:i + 120]))
    subnational = collect(rows)
    print(len(national), len(historical), len(subnational))

    files = [file_title(i["flag"]) for i in national + historical + subnational]
    info = commons_info(files)

    decks = []
    nat = []
    for it in sorted(national, key=lambda i: i["name"]):
        conts = sorted(it["conts"])
        c = card("flag-nat", it, conts[0] if conts else "", "National flag", "", info)
        if c:
            nat.append(c)
    decks.append(pack("deck-flags-national", "Flags of the World", "🏳️", "#2563eb",
                      "The national flags of every sovereign state.", nat))

    hist = []
    for it in sorted((i for i in historical if i["sl"] >= MIN_HISTORICAL_SITELINKS), key=lambda i: -i["sl"]):
        yrs = fmt_years(it)
        c = card("flag-hist", it, "Historical", yrs and f"Historical flag, {yrs}" or "Historical flag", "", info)
        if c:
            hist.append(c)
    decks.append(pack("deck-flags-historical", "Historical Flags", "🏴", "#78350f",
                      "Flags of states, empires and unions that no longer exist.", hist))

    by_country = {}
    for it in subnational:
        by_country.setdefault(it["country"], []).append(it)
    special = {
        "Australia": ("deck-flags-australia", "Australian State & Territory Flags", "🇦🇺", "#0f766e"),
        "United States": ("deck-flags-us", "US State Flags", "🇺🇸", "#1d4ed8"),
        "Canada": ("deck-flags-canada", "Canadian Province & Territory Flags", "🇨🇦", "#dc2626"),
    }
    rest = []
    for country, items in sorted(by_country.items()):
        if country in special:
            did, title, icon, color = special[country]
            if country == "United States":
                items = [i for i in items if i["name"] not in US_SKIP]
            cards = [c for c in (card("flag-sub", i, country, f"Flag of {i['name']}", "", info)
                                 for i in sorted(items, key=lambda i: i["name"])) if c]
            decks.append(pack(did, title, icon, color, f"Flags of {country}'s states, provinces and territories.", cards))
        elif country not in REGION_SKIP_COUNTRIES:
            items = sorted((i for i in items if i["sl"] >= REGION_MIN_SITELINKS), key=lambda i: -i["sl"])
            for i in items[:REGION_MAX_PER_COUNTRY]:
                c = card("flag-sub", i, country, f"Region of {country}", "", info)
                if c:
                    rest.append(c)
    rest.sort(key=lambda c: (c["badge"], -c["_sl"]))
    decks.append(pack("deck-flags-regions", "World Regional Flags", "🗺️", "#7c3aed",
                      "Flags of states, provinces, prefectures and other first-level regions around the world.", rest))

    index = []
    for d in decks:
        if not d["cards"]:
            continue
        for c in d["cards"]:
            c.pop("_sl", None)
        with open(os.path.join(outdir, d["id"] + ".json"), "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=1)
        index.append({k: d[k] for k in ("id", "title", "icon", "color", "category", "description")}
                     | {"count": len(d["cards"]), "file": d["id"] + ".json"})
        print(f"{d['title']}: {len(d['cards'])} cards")
    return index


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "packs"))
    args = ap.parse_args()
    idx = build(args.out)
    with open(os.path.join(args.out, "_flags_index.json"), "w") as f:
        json.dump(idx, f, indent=1)
