#!/usr/bin/env python3
"""Build aircraft decks (airliners, military, historic, helicopters) from open data.

  * Wikidata  - which aircraft types exist, their role (via "subclass of" chains), maker,
                first flight and lead photo (P18).
  * Commons   - licence and author of each photo (recorded on every card).
  * Wikipedia - short intro and design notes (CC BY-SA 4.0), always credited.

Usage:  python3 tools/build_aircraft.py [--out data/packs]
"""
import argparse
import json
import os
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_flags import PREFIX, SPARQL, commons_info, file_title, thumb_url, val, year  # noqa: E402
from fgnet import get_json  # noqa: E402
from build_nature import sentences, wiki_extract  # noqa: E402

# Wikidata classes an aircraft *type* is an instance of (individual airframes, prototypes,
# rockets and spacecraft are deliberately left out).
TYPE_CLASSES = ["Q15056993", "Q15056995", "Q45296117", "Q473625", "Q210932", "Q4120025",
                "Q34486", "Q2735392", "Q197", "Q124054999"]

# Role roots, matched through "subclass of" (P279*). First match in this order wins the badge.
ROLES = [
    ("Helicopter", "heli", ["Q34486"]),
    ("Fighter", "mil", ["Q127771", "Q320018", "Q850403", "Q1518049"]),
    ("Bomber", "mil", ["Q170877", "Q678321", "Q753224"]),
    ("Attack", "mil", ["Q208187"]),
    ("Reconnaissance", "mil", ["Q3041792"]),
    ("Drone", "mil", ["Q484000"]),
    ("Military transport", "mil", ["Q1445518"]),
    ("Trainer", "mil", ["Q41426"]),
    ("Military", "mil", ["Q216916"]),
    ("Airliner", "civil", ["Q210932", "Q473625"]),
    ("Business jet", "civil", ["Q1062135"]),
    ("Cargo", "civil", ["Q19799"]),
    ("Utility", "civil", ["Q1130697"]),
]
EXCLUDE_ROOTS = ["Q1384417", "Q15126161", "Q207977"]  # experimental aircraft, prototypes

# Fallback when an item has no usable "subclass of": keywords in its English description.
DESC_ROLES = [
    (r"helicopter|rotorcraft", "Helicopter", "heli"),
    (r"fighter|interceptor", "Fighter", "mil"),
    (r"bomber", "Bomber", "mil"),
    (r"attack aircraft|ground-attack", "Attack", "mil"),
    (r"reconnaissance", "Reconnaissance", "mil"),
    (r"unmanned|drone", "Drone", "mil"),
    (r"military (transport|cargo)|airlifter|tanker", "Military transport", "mil"),
    (r"trainer", "Trainer", "mil"),
    (r"military|patrol aircraft|warplane", "Military", "mil"),
    (r"airliner|passenger aircraft|airliner family", "Airliner", "civil"),
    (r"business jet", "Business jet", "civil"),
    (r"cargo|freighter", "Cargo", "civil"),
    (r"light aircraft|utility aircraft|general aviation|sport aircraft|aerobatic|flying boat|seaplane|amphibi", "Utility", "civil"),
]

# Militarised airliners (AEW, patrol, VIP) are tagged as airliners on Wikidata.
MILITARY_DESC = r"early warning|command post|maritime patrol|anti-submarine|presidential|military|air force|tanker|surveillance"
# One-off research types: X-planes and Y-prefixed US prototypes (XB-70, YF-23, YAL-1).
EXPERIMENTAL_DESC = r"prototype|experimental|demonstrator|technology testbed|concept aircraft"
EXPERIMENTAL_NAME = r"\b(X[A-Z]{0,2}|YF|YB|YC|YAL)-\d"

# Same promise as the other packs: photos must be public domain, CC0, CC BY or CC BY-SA.
OK_LICENSE = r"^(public domain|pdm?|cc0|cc by(-sa)? [\d.]+|cc by(-sa)?)\b"

MIN_SITELINKS = 15
HISTORIC_BEFORE = 1946  # first flight before this -> historic deck
CAPS = {"airliners": 150, "military": 200, "historic": 200, "helicopters": 80}

Q_CANDIDATES = """
SELECT ?item ?label ?desc ?img ?sl ?ff ?makerLabel ?article WHERE {
  VALUES ?cls { %s }
  ?item wdt:P31 ?cls ; wdt:P18 ?img ; wikibase:sitelinks ?sl ; rdfs:label ?label .
  FILTER(lang(?label) = "en")
  FILTER(?sl >= %d)
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
  OPTIONAL { ?item schema:description ?desc . FILTER(lang(?desc) = "en") }
  OPTIONAL { ?item wdt:P606 ?ff }
  OPTIONAL { ?item wdt:P176 ?maker . ?maker rdfs:label ?makerLabel . FILTER(lang(?makerLabel) = "en") }
}"""

Q_UNDER_ROOT = """
SELECT DISTINCT ?item WHERE {
  VALUES ?cls { %s }
  ?item wdt:P31 ?cls ; wikibase:sitelinks ?sl ; wdt:P279/wdt:P279* wd:%s .
  FILTER(?sl >= %d)
}"""

PREFIX_EXTRA = "PREFIX schema: <http://schema.org/>\n"


def sparql(query):
    r = get_json(SPARQL, {"query": PREFIX + query, "format": "json"}, gap=6, tries=15)
    return r["results"]["bindings"]

FEATURE_SECTIONS = ("Design", "Design and development", "Design and features", "Development",
                    "Overview", "Characteristics")


def qid(uri):
    return uri.rsplit("/", 1)[1]


def under(root):
    cls = " ".join("wd:" + c for c in TYPE_CLASSES)
    return {qid(val(b, "item")) for b in sparql(Q_UNDER_ROOT % (cls, root, MIN_SITELINKS))}


def candidates():
    cls = " ".join("wd:" + c for c in TYPE_CLASSES)
    items = {}
    for b in sparql(PREFIX_EXTRA + Q_CANDIDATES % (cls, MIN_SITELINKS)):
        q = qid(val(b, "item"))
        it = items.setdefault(q, {"q": q, "name": val(b, "label"), "desc": val(b, "desc") or "",
                                  "img": val(b, "img"), "sl": int(val(b, "sl")), "ff": None,
                                  "makers": [], "article": val(b, "article")})
        ff = year(val(b, "ff"))
        if ff and (it["ff"] is None or ff < it["ff"]):
            it["ff"] = ff
        m = val(b, "makerLabel")
        if m and m not in it["makers"]:
            it["makers"].append(m)
    return items


def split_aircraft_extract(extract):
    intro = extract.split("\n==", 1)[0]
    for name in FEATURE_SECTIONS:
        m = re.search(rf"\n==+ {re.escape(name)} ==+\n(.*?)(?=\n==|\Z)", extract, re.S)
        if m:
            body = [p for p in m.group(1).strip().split("\n\n") if len(p) > 80]
            if body:
                return intro, body[0]
    return intro, ""


def classify(items):
    roles = {}
    for label, kind, roots in ROLES:
        hits = set()
        for r in roots:
            hits |= under(r)
        for q in hits:
            roles.setdefault(q, (label, kind))
    excluded = set()
    for r in EXCLUDE_ROOTS:
        excluded |= under(r)
    for it in items.values():
        it["role"] = roles.get(it["q"])
        if not it["role"]:
            d = it["desc"].lower()
            for pat, label, kind in DESC_ROLES:
                if re.search(pat, d):
                    it["role"] = (label, kind)
                    break
        if it["role"] and it["role"][1] == "civil" and re.search(MILITARY_DESC, it["desc"], re.I):
            it["role"] = ("Military", "mil")
        it["excluded"] = (it["q"] in excluded or re.search(EXPERIMENTAL_DESC, it["desc"], re.I)
                          or re.search(EXPERIMENTAL_NAME, it["name"]))


def make_card(it, info, wiki_cache):
    title = file_title(it["img"])
    meta = info.get(title)
    if not meta or not meta["license"]:
        return None
    article = urllib.parse.unquote(it["article"].rsplit("/wiki/", 1)[1]).replace("_", " ")
    got = wiki_cache.setdefault(article, wiki_extract(article))
    intro = features = ""
    if got:
        intro, features = split_aircraft_extract(got[1])
    maker = it["makers"][0] if it["makers"] else ""
    sub = " · ".join(x for x in (maker, f"first flew {it['ff']}" if it["ff"] else "") if x)
    credit = f"{meta['artist'] + ', ' if meta['artist'] else ''}{meta['license']} via Wikimedia Commons"
    return {
        "id": f"aircraft-{it['q']}",
        "name": re.sub(r" \([^)]*\)$", "", article),  # article titles beat bare Wikidata labels
        "subtitle": sub or it["role"][0],
        "badge": it["role"][0],
        "description": sentences(intro, 420) if intro else it["desc"].capitalize(),
        "keyFeatures": sentences(features, 360, 2) if features else "",
        "imageUrl": thumb_url(title),
        "imageCredit": credit,
        "imageLicense": meta["license"],
        "imageSource": meta["page"],
        "sourceUrl": it["article"],
        "textCredit": "Text: Wikipedia, CC BY-SA 4.0" if intro else "",
    }


def pack(did, title, icon, color, desc, cards):
    return {
        "id": did, "title": title, "category": "Aircraft", "icon": icon, "color": color,
        "description": desc,
        "attribution": "Data: Wikidata (CC0). Text: Wikipedia (CC BY-SA 4.0). Photos: Wikimedia Commons, "
                       "each under the licence shown on its card.",
        "cards": cards,
    }


def build(outdir):
    os.makedirs(outdir, exist_ok=True)
    print("Candidates...")
    items = candidates()
    print(len(items), "aircraft types; classifying...")
    classify(items)
    groups = {"airliners": [], "military": [], "historic": [], "helicopters": []}
    for it in items.values():
        if it["excluded"] or not it["role"]:
            continue
        label, kind = it["role"]
        if kind == "heli":
            groups["helicopters"].append(it)
        elif it["ff"] and it["ff"] < HISTORIC_BEFORE:
            groups["historic"].append(it)
        elif not it["ff"]:
            continue  # undated: can't place it reliably
        elif kind == "mil":
            groups["military"].append(it)
        else:
            groups["airliners"].append(it)
    info = commons_info([file_title(i["img"]) for g in groups.values() for i in g])
    for k in groups:
        ok = [i for i in groups[k] if re.match(OK_LICENSE, info.get(file_title(i["img"]), {}).get("license", ""), re.I)]
        groups[k] = sorted(ok, key=lambda i: -i["sl"])[:CAPS[k]]
        print(k, len(groups[k]))

    wiki_cache = {}
    specs = [
        ("airliners", "deck-aircraft-airliners", "Airliners & Civil Aircraft", "✈️", "#0284c7",
         "Airliners, freighters, business jets and light aircraft since 1946."),
        ("military", "deck-aircraft-military", "Military Aircraft", "🛩️", "#4d7c0f",
         "Fighters, bombers, transports and trainers from the jet age to today."),
        ("historic", "deck-aircraft-historic", "Historic Aircraft", "🛫", "#a16207",
         "From the Wright Flyer to the Second World War: aircraft that first flew before 1946."),
        ("helicopters", "deck-aircraft-helicopters", "Helicopters", "🚁", "#be123c",
         "Military and civil helicopters from the 1940s to today."),
    ]
    index = []
    for key, did, title, icon, color, desc in specs:
        # Sort by first flight so the deck reads as a timeline; study order is the app's job.
        its = sorted(groups[key], key=lambda i: (i["ff"] or 9999, i["name"]))
        cards = [c for c in (make_card(i, info, wiki_cache) for i in its) if c]
        d = pack(did, title, icon, color, desc, cards)
        with open(os.path.join(outdir, did + ".json"), "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=1)
        index.append(did)
        print(f"{title}: {len(cards)} cards")
    return index


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "packs"))
    build(ap.parse_args().out)
