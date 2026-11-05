"""Publish an Orchard update.

1. Put the new app files in the app/ folder (and bump "version" in app/package.json).
   Extensions: drop an .html file in extensions/ and add it to extensions/catalog.json
   (id, name, category "game" or "educational", icon, version, file, description).
2. Run:  python make_release.py "what's new in this update"
3. Upload/commit everything to GitHub. Every Orchard checks this repo on start
   and every 4 hours, downloads the files listed in version.json, checks each
   file's SHA-256, and shows a green "Update" button to restart into it.
"""
import hashlib, json, os, sys

root = os.path.dirname(os.path.abspath(__file__))
app = os.path.join(root, "app")
version = json.load(open(os.path.join(app, "package.json"), encoding="utf-8"))["version"]
files = []
for dirpath, _, names in os.walk(app):
    for n in sorted(names):
        full = os.path.join(dirpath, n)
        rel = os.path.relpath(full, app).replace(os.sep, "/")
        files.append({"path": rel, "sha256": hashlib.sha256(open(full, "rb").read()).hexdigest()})
files.sort(key=lambda f: f["path"])
old = {}
try:
    old = json.load(open(os.path.join(root, "version.json"), encoding="utf-8"))
except Exception:
    pass
manifest = {
    "version": version,
    "notes": sys.argv[1] if len(sys.argv) > 1 else old.get("notes", ""),
    "minElectron": old.get("minElectron", "45.0.0"),
    "files": files,
}
json.dump(manifest, open(os.path.join(root, "version.json"), "w", encoding="utf-8"), indent=2)

# keep the extension store's sizes and checksums in sync with the files in extensions/
cat_path = os.path.join(root, "extensions", "catalog.json")
if os.path.exists(cat_path):
    cat = json.load(open(cat_path, encoding="utf-8"))
    for x in cat.get("extensions", []):
        f = os.path.join(root, "extensions", x["file"])
        if os.path.exists(f):
            data = open(f, "rb").read()
            x["size"] = len(data)
            x["sha256"] = hashlib.sha256(data).hexdigest()
    json.dump(cat, open(cat_path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    print(f"extensions/catalog.json updated ({len(cat.get('extensions', []))} extensions).")
print(f"version.json written for Orchard {version} ({len(files)} files). Now upload it all to GitHub.")
