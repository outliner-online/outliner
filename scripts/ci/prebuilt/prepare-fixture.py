"""Image build helper: synthetic, demo-only fixture and no credentials."""
import json
from pathlib import Path
import shutil

root = Path('/prepared/fixture')
(root / 'functions').mkdir(parents=True, exist_ok=True)
(root / 'public').mkdir(exist_ok=True)
(root / 'public/index.html').write_text('prepared-private-fixture\n')
(root / 'firestore.rules').write_text('rules_version = "2"; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read: if true; allow write: if false; } } }\n')
(root / 'functions/package.json').write_text(json.dumps({'name': 'private-prepared-fixture', 'private': True, 'main': 'index.cjs', 'engines': {'node': '22'}, 'dependencies': {'firebase-functions': json.loads(Path('/prepared/source/functions/package-lock.json').read_text())['packages']['node_modules/firebase-functions']['version']}}))
shutil.copy2('/prepared/source/scripts/ci/prebuilt/fixture.cjs', root / 'functions/index.cjs')
shutil.copy2('/prepared/source/scripts/ci/prebuilt/pinned-functions.cjs', root / 'functions/pinned-functions.cjs')
# Firebase's discovery requires installed SDK metadata from this project's module tree.
(root / 'functions/node_modules').symlink_to('/prepared/source/functions/node_modules')
(root / 'firebase.json').write_text(json.dumps({
    'functions': {'source': 'functions', 'runtime': 'nodejs22'},
    'hosting': {'public': 'public', 'rewrites': [{'source': '/api/probe', 'function': 'preparedSmoke'}]},
    'firestore': {'rules': 'firestore.rules'},
    'emulators': {**{name: {'host': '127.0.0.1', 'port': port} for name, port in
                     [('auth', 59199), ('firestore', 58180), ('functions', 57170), ('hosting', 57100), ('hub', 54100), ('logging', 54500)]},
                  'ui': {'enabled': False}, 'singleProjectMode': True},
}))
