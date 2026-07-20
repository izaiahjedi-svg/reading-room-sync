# Reading Room Sync

A simple reading app with profile-based progress, dark mode, chapter management, and device sync.

## Canonical app layout
- Render deploys from the repository root.
- The live backend is [server.js](c:/Users/izaiah/OneDrive/Desktop/projects/novel%20project/server.js).
- The live frontend is [reader.html](c:/Users/izaiah/OneDrive/Desktop/projects/novel%20project/reader.html).
- [index.html](c:/Users/izaiah/OneDrive/Desktop/projects/novel%20project/index.html) redirects into the canonical frontend.
- Old `/webapp/...` links are preserved as redirects to the root frontend paths.
- Non-website files were moved under [non-website](c:/Users/izaiah/OneDrive/Desktop/projects/novel%20project/non-website).

## Features
- dark mode
- profile switching
- per-profile reading preferences
- chapter title editing and import
- cross-device sync for library metadata, profile state, covers, and chapter bodies

## Run locally
Start the server from the repository root:

```bash
npm install
npm start
```

Then open the app at `http://localhost:3000/`.

## Notes
- `reader.html` is the only frontend source file that should be edited for the deployed app.
- Root `server.js`, `render.yaml`, and `package.json` are the only deployment files used by Render.
- `ongoing_sync.py` stays at the repo root because [ongoing-sync.yml](c:/Users/izaiah/OneDrive/Desktop/projects/novel%20project/.github/workflows/ongoing-sync.yml) runs it from GitHub Actions.
