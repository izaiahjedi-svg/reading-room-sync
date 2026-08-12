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

## GitHub-backed storage
Render now stores sync data in GitHub instead of the local filesystem.

Set these environment variables on Render:
- `GITHUB_TOKEN`: a fine-grained token with read/write access to the sync repository
- `GITHUB_REPOSITORY`: the repo in `owner/name` form
- `GITHUB_BRANCH`: the branch used for sync data, usually `data`
- `GITHUB_DB_PREFIX`: optional folder name inside the branch, defaults to `sync-db`

The app keeps the code on `main` and writes sync data to a separate branch so redeploys do not wipe progress or chapters.

## Direct bulk upload for large TXT sets
If website uploads are too slow for large batches, import directly to the sync branch.

1. Switch to your sync data branch locally (usually `data`).
2. Run the importer script to convert `.txt` files into the same chapter JSON format used by the app.
3. Commit and push once.

Example (PowerShell):

```powershell
cd "c:\Users\izaiah\OneDrive\Desktop\projects\novel project"
git checkout data
python direct_import_to_data_branch.py --sync-key "YOUR_SYNC_KEY" --book "Shadow Slave" --volume "Volume 12" --input-dir "c:\path\to\txt-folder" --recursive
git add sync-db
git commit -m "Bulk import TXT chapters"
git push origin data
```

Notes:
- Use `--dry-run` first to preview counts without writing files.
- The script skips duplicates based on `(book, volume, title)`.
- For very large single files over 50MB, prefer splitting by chapter or using Git LFS.

### Batch import many volumes/books at once
For large backlogs, use a jobs file and import everything in one command.

1. Copy `import_jobs.example.json` to your own file, for example `import_jobs.json`.
2. Fill each job with `book`, `volume`, and `inputDir`.
3. Run a dry run.
4. Run real import.
5. Commit/push to `data`.

Example:

```powershell
cd "c:\Users\izaiah\OneDrive\Desktop\projects\novel project"
python direct_import_to_data_branch.py --jobs-file "import_jobs.json" --dry-run
python direct_import_to_data_branch.py --jobs-file "import_jobs.json"
git switch data-upload
git add sync-db
git commit -m "Bulk import multi-volume backlog"
git push -u origin data-upload:data
```

## Notes
- `reader.html` is the only frontend source file that should be edited for the deployed app.
- Root `server.js`, `render.yaml`, and `package.json` are the only deployment files used by Render.
- `ongoing_sync.py` stays at the repo root because [ongoing-sync.yml](c:/Users/izaiah/OneDrive/Desktop/projects/novel%20project/.github/workflows/ongoing-sync.yml) runs it from GitHub Actions.
