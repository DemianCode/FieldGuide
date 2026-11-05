#!/usr/bin/env python3
"""Build Greater Melbourne bird and plant decks from open data.

Sources (all queried live, responses cached under tools/.cache):
  * iNaturalist  - which species are regularly recorded around Melbourne (research-grade
                   observations within RADIUS_KM of the CBD), their native / introduced
                   status for Australia, and openly licensed photos.
  * Wikipedia    - short intro and "Description" text (CC BY-SA 4.0), always credited.

Only photos licensed CC0, CC BY or CC BY-SA are used, so the decks are safe to publish
with attribution. Usage:  python3 tools/build_nature.py [--out data/packs]
"""
import argparse
import json
import os
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fgnet import get_json  # noqa: E402

INAT = "https://api.inaturalist.org/v1"
WIKI = "https://en.wikipedia.org/w/api.php"
CBD = (-37.8136, 144.9631)
RADIUS_KM = 45  # roughly the Greater Melbourne footprint
AUSTRALIA_PLACE = 6744  # iNaturalist place used for native / introduced flags
OK_LICENSES = {"cc0", "cc-by", "cc-by-sa"}
LICENSE_NAMES = {"cc0": "CC0", "cc-by": "CC BY", "cc-by-sa": "CC BY-SA"}

MIN_BIRD_OBS = 15       # "regulars": at least this many research-grade records nearby
MIN_PLANT_OBS = 20      # wild plants
MIN_PLANTED_TREE_OBS = 40  # street / park trees that are mostly recorded as cultivated


def species_counts(iconic, captive, quality):
    out, page = [], 1
    while True:
        r = get_json(
            f"{INAT}/observations/species_counts",
            {
                "lat": CBD[0], "lng": CBD[1], "radius": RADIUS_KM,
                "iconic_taxa": iconic, "captive": captive, "quality_grade": quality,
                "per_page": 500, "page": page, "locale": "en",
                "preferred_place_id": AUSTRALIA_PLACE,
            },
        )
        out += r["results"]
        if page * 500 >= r["total_results"] or not r["results"]:
            return out
        page += 1


def taxon_details(ids):
    """id -> full taxon record (photos, ancestors, wikipedia url, establishment)."""
    out = {}
    ids = list(ids)
    for i in range(0, len(ids), 30):
        chunk = ids[i:i + 30]
        r = get_json(
            f"{INAT}/taxa/{','.join(map(str, chunk))}",
            {"locale": "en", "preferred_place_id": AUSTRALIA_PLACE},
        )
        for t in r["results"]:
            out[t["id"]] = t
    return out


def pick_photo(taxon):
    for tp in taxon.get("taxon_photos", []):
        p = tp["photo"]
        if p.get("license_code") in OK_LICENSES and p.get("url"):
            return photo_record(p)
    # fall back to the best community-rated, openly licensed observation photo
    r = get_json(
        f"{INAT}/observations",
        {
            "taxon_id": taxon["id"], "photo_license": "cc0,cc-by,cc-by-sa",
            "quality_grade": "research", "order_by": "votes", "per_page": 1,
            "lat": CBD[0], "lng": CBD[1], "radius": 150,
        },
    )
    for o in r.get("results", []):
        for p in o.get("photos", []):
            if p.get("license_code") in OK_LICENSES and p.get("url"):
                return photo_record(p)
    return None


def photo_record(p):
    lic = p["license_code"]
    return {
        "imageUrl": re.sub(r"/(square|small|medium)\.", "/large.", p["url"]),
        "imageCredit": p.get("attribution", ""),
        "imageLicense": LICENSE_NAMES[lic],
        "imageSource": f"https://www.inaturalist.org/photos/{p['id']}",
    }


def wiki_title(taxon):
    url = taxon.get("wikipedia_url") or ""
    if "/wiki/" not in url:
        return None
    return urllib.parse.unquote(url.split("/wiki/", 1)[1]).replace("_", " ")


def wiki_extract(title):
    r = get_json(
        WIKI,
        {"action": "query", "prop": "extracts", "explaintext": 1, "redirects": 1,
         "titles": title, "format": "json", "formatversion": 2},
        gap=0.5,
    )
    pages = r.get("query", {}).get("pages", [])
    if not pages or "extract" not in pages[0]:
        return None
    return pages[0]["title"], pages[0]["extract"]


def clean(text):
    text = re.sub(r"\((?:[^()]*?(?:listen|pronounced|IPA|/[^/]+/)[^()]*?)\)", "", text)
    text = re.sub(r"\[\d+\]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return re.sub(r"\s+([,.;:])", r"\1", text)


def sentences(text, max_chars, max_sentences=3):
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z])", clean(text))
    out, total = [], 0
    for s in parts:
        if out and (total + len(s) > max_chars or len(out) >= max_sentences):
            break
        out.append(s)
        total += len(s) + 1
    return " ".join(out)


SECTION_NAMES = ("Description", "Identification", "Appearance", "Morphology", "Characteristics")


def split_extract(extract):
    intro = extract.split("\n==", 1)[0]
    features = ""
    for name in SECTION_NAMES:
        m = re.search(rf"\n==+ {name} ==+\n(.*?)(?=\n==|\Z)", extract, re.S)
        if m and len(m.group(1).strip()) > 60:
            features = m.group(1).strip().split("\n\n")[0]
            break
    return intro, features


def plant_group(intro, features, ancestors):
    first = clean(intro.split(". ")[0]).lower()
    names = {a["name"] for a in ancestors}
    if "Polypodiopsida" in names or "Lycopodiopsida" in names or "Bryophyta" in names:
        return "other"
    if re.search(r"\b(tree|trees)\b", first):
        return "tree"
    if re.search(r"\b(grass|grasses|sedge|rush|tussock|reed|bulrush|restio)\b", first) or names & {"Poaceae", "Cyperaceae", "Juncaceae", "Typhaceae"}:
        return "other"
    if re.search(r"\b(shrub|shrubs|subshrub|climber|vine|creeper|liana|scrambler)\b", first):
        return "shrub"
    if re.search(r"\b(orchid|herb|herbaceous|perennial|annual|biennial|forb|wildflower|lily|daisy|succulent|geophyte|bulb)\b", first) or names & {"Orchidaceae", "Asteraceae"}:
        return "herb"
    t = (features or "").lower()[:200]
    if re.search(r"\b(tree|trees)\b", t):
        return "tree"
    if re.search(r"\b(shrub|shrubs)\b", t):
        return "shrub"
    return "herb"


def family_of(taxon):
    for a in taxon.get("ancestors", []):
        if a["rank"] == "family":
            return a.get("preferred_common_name") or a["name"], a["name"]
    return None, None


def status_of(taxon):
    em = (taxon.get("establishment_means") or {}).get("establishment_means")
    if em in ("native", "endemic"):
        return "Native"
    if em == "introduced":
        return "Introduced"
    return None


def make_card(prefix, count, taxon, wiki_cache):
    common = taxon.get("preferred_common_name")
    if not common:
        return None
    photo = pick_photo(taxon)
    if not photo:
        return None
    title = wiki_title(taxon)
    intro = features = ""
    source_url = f"https://www.inaturalist.org/taxa/{taxon['id']}"
    text_credit = ""
    if title:
        got = wiki_cache.setdefault(title, wiki_extract(title))
        if got:
            real_title, extract = got
            intro, features = split_extract(extract)
            source_url = "https://en.wikipedia.org/wiki/" + urllib.parse.quote(real_title.replace(" ", "_"))
            text_credit = "Text: Wikipedia, CC BY-SA 4.0"
    description = sentences(intro, 420) if intro else f"Recorded {count} times around Greater Melbourne on iNaturalist."
    family_common, family_sci = family_of(taxon)
    status = status_of(taxon)
    card = {
        "id": f"{prefix}-{taxon['id']}",
        "name": common,
        "subtitle": taxon["name"],
        "badge": status or "",
        "family": family_common or family_sci or "",
        "description": description,
        "keyFeatures": sentences(features, 360, 2) if features else "",
        "sourceUrl": source_url,
        "textCredit": text_credit,
        "obs": count,
    }
    card.update(photo)
    return card


def build(outdir):
    os.makedirs(outdir, exist_ok=True)
    print("Fetching bird list...")
    birds = [r for r in species_counts("Aves", "false", "research") if r["count"] >= MIN_BIRD_OBS]
    print("Fetching plant lists...")
    wild = {r["taxon"]["id"]: r for r in species_counts("Plantae", "false", "research") if r["count"] >= MIN_PLANT_OBS}
    planted = {
        r["taxon"]["id"]: r for r in species_counts("Plantae", "true", "any") if r["count"] >= MIN_PLANTED_TREE_OBS
    }

    def keep(r):
        t = r["taxon"]
        return t["rank"] == "species" and "×" not in t["name"] and " x " not in t["name"]

    birds = [r for r in birds if keep(r)]
    plant_rows = {i: r for i, r in {**planted, **wild}.items() if keep(r)}
    print(f"{len(birds)} birds, {len(plant_rows)} candidate plants")

    details = taxon_details([r["taxon"]["id"] for r in birds] + list(plant_rows))
    wiki_cache = {}

    bird_cards = {"native": [], "introduced": []}
    for r in sorted(birds, key=lambda r: -r["count"]):
        t = details.get(r["taxon"]["id"])
        if not t:
            continue
        card = make_card("mel-bird", r["count"], t, wiki_cache)
        if not card:
            print("  skip bird (no open photo):", r["taxon"]["name"])
            continue
        if not card["badge"]:
            print("  note: no status for", card["name"], "- treating as native")
            card["badge"] = "Native"
        bird_cards["introduced" if card["badge"] == "Introduced" else "native"].append(card)

    groups = {"tree": [], "shrub": [], "herb": [], "other": []}
    for pid, r in sorted(plant_rows.items(), key=lambda kv: -kv[1]["count"]):
        t = details.get(pid)
        if not t:
            continue
        card = make_card("mel-plant", r["count"], t, wiki_cache)
        if not card:
            continue
        title = wiki_title(t)
        intro = features = ""
        if title and wiki_cache.get(title):
            intro, features = split_extract(wiki_cache[title][1])
        group = plant_group(intro, features, t.get("ancestors", []))
        # cultivated-only records only make the cut as trees (street and park trees)
        if pid not in wild and group != "tree":
            continue
        if not card["badge"]:
            card["badge"] = "Introduced" if pid not in wild else "Native"
        groups[group].append(card)

    decks = [
        ("deck-mel-birds-native", "Melbourne Birds: Native", "Nature & Wildlife", "🦜", "#0ea5e9",
         "Native birds regularly seen around Greater Melbourne, from backyards to wetlands.", bird_cards["native"]),
        ("deck-mel-birds-introduced", "Melbourne Birds: Introduced", "Nature & Wildlife", "🐦", "#f97316",
         "Introduced and feral birds you will meet around Greater Melbourne.", bird_cards["introduced"]),
        ("deck-mel-trees", "Melbourne Trees", "Nature & Wildlife", "🌳", "#16a34a",
         "Native and introduced trees of Greater Melbourne's bush, parks and streets.", groups["tree"]),
        ("deck-mel-shrubs", "Melbourne Shrubs & Climbers", "Nature & Wildlife", "🌿", "#65a30d",
         "Shrubs, climbers and scramblers seen across Greater Melbourne.", groups["shrub"]),
        ("deck-mel-wildflowers", "Melbourne Wildflowers & Herbs", "Nature & Wildlife", "🌼", "#eab308",
         "Wildflowers, orchids, daisies and other herbs, native and weedy, around Greater Melbourne.", groups["herb"]),
        ("deck-mel-grasses-ferns", "Melbourne Grasses, Ferns & More", "Nature & Wildlife", "🌾", "#14b8a6",
         "Grasses, sedges, rushes, ferns and other plants of Greater Melbourne.", groups["other"]),
    ]
    index = []
    for did, title, cat, icon, color, desc, cards in decks:
        if not cards:
            continue
        deck = {
            "id": did, "title": title, "category": cat, "icon": icon, "color": color,
            "description": desc, "region": "Greater Melbourne, Australia",
            "attribution": "Species lists and photos: iNaturalist contributors (CC0, CC BY, CC BY-SA). "
                           "Text: Wikipedia contributors (CC BY-SA 4.0).",
            "cards": cards,
        }
        with open(os.path.join(outdir, did + ".json"), "w", encoding="utf-8") as f:
            json.dump(deck, f, ensure_ascii=False, indent=1)
        index.append({"id": did, "title": title, "icon": icon, "color": color, "category": cat,
                      "description": desc, "count": len(cards), "file": did + ".json"})
        print(f"{title}: {len(cards)} cards")
    return index


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "packs"))
    args = ap.parse_args()
    idx = build(args.out)
    with open(os.path.join(args.out, "_nature_index.json"), "w") as f:
        json.dump(idx, f, indent=1)
