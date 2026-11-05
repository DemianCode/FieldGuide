#!/usr/bin/env python3
"""Write data/packs/index.json from the deck files in data/packs (run after the builders)."""
import json
import os

PACKS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "packs")
ORDER = [
    "deck-mel-birds-native", "deck-mel-birds-introduced", "deck-mel-trees", "deck-mel-shrubs",
    "deck-mel-wildflowers", "deck-mel-weeds", "deck-mel-grasses-ferns",
    "deck-flags-national", "deck-flags-historical", "deck-flags-australia", "deck-flags-us",
    "deck-flags-canada", "deck-flags-regions",
]


def main():
    packs = []
    for name in sorted(os.listdir(PACKS)):
        if not name.startswith("deck-") or not name.endswith(".json"):
            continue
        with open(os.path.join(PACKS, name), encoding="utf-8") as f:
            d = json.load(f)
        packs.append({
            "id": d["id"], "title": d["title"], "icon": d.get("icon", "📚"), "color": d.get("color", "#6366f1"),
            "category": d.get("category", "Library"), "description": d.get("description", ""),
            "region": d.get("region", ""), "count": len(d["cards"]), "file": name,
        })
    packs.sort(key=lambda p: ORDER.index(p["id"]) if p["id"] in ORDER else 99)
    with open(os.path.join(PACKS, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"packs": packs}, f, ensure_ascii=False, indent=1)
    print(f"index.json: {len(packs)} packs, {sum(p['count'] for p in packs)} cards")


if __name__ == "__main__":
    main()
