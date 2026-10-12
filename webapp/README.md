# Speaker Identification - Azure and Qdrant

Speaker identification with Azure or Qdrant using voice embeddings. Record a microphone sample, upload a WAV, or choose a held-out notebook test file. Match against a persistent embedded Qdrant database or your dedicated Azure AI Search index.

**Author:** serge.retkowsky@microsoft.com · **Version:** 1.0 · **Release date:** 05-10-2026.

For the interactive workflow, use **Documentation** in the app or the [user guide](static/documentation.html). This README covers installation, architecture, dependencies, operations, and developer validation. The app includes a six-step guided demo and HTML/CSV/JSON report exports; it does not automatically compare both backends.

## Run on Windows

Use **Python 3.11** on Windows (validated with 3.11.9), PowerShell, and Edge or Chrome. Keep the supplied `voices embeddings.zip` in the project folder for initial asset preparation. Node.js is needed only for the frontend tests, not to run the app.

From this folder in PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --index-url https://download.pytorch.org/whl/cpu --no-deps torch==2.6.0+cpu torchaudio==2.6.0+cpu
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe prepare_assets.py
.\start.ps1
```

Open the private URL printed by `start.ps1`. It contains a fresh per-launch access token that is exchanged for an HTTP-only browser cookie and then removed from the address bar. Do not share that URL. First startup computes embeddings for the 41 segment-1 reference WAVs and initializes Qdrant; allow time for CPU initialization. Later starts reuse the embedding cache. Stop with Ctrl+C. Use `.\start.ps1 -Port 8766` to choose another port. Embedded Qdrant requires a single app process for this data directory; do not use multiple Uvicorn workers or run two instances against it.

If PowerShell blocks scripts, use a process-scoped bypass so the launcher still creates the private access token:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

Local Qdrant processing needs no Docker, separate database service, Azure account, API key, Node build, or runtime model download. Dependency installation needs internet access. The CPU torch/torchaudio versions are pinned together for SpeechBrain compatibility. The original ZIP and notebook are left unchanged; their environment/credential files are not extracted.

### Dependencies and assets

[requirements.txt](requirements.txt) pins the validated direct Python dependencies, including the directly imported `azure-core`, `pydantic`, and `starlette` APIs rather than leaving their versions entirely to transitive resolution. Existing versions are retained; this is not an automatic upgrade to the newest package releases or a complete transitive lockfile.

- Preinstall the paired **2.6.0+cpu** torch/torchaudio wheels with the command above. The requirements' `==2.6.0` constraints accept those CPU builds and include the checkpoint-loading security fix for CVE-2025-32434. Skipping that step can select different platform builds from the default package index.
- `httpx` is also required for FastAPI's `TestClient`. Python tests use `unittest`; frontend tests use Node's built-in test runner, with no npm packages.
- `prepare_assets.py` copies only model weights and WAV assets. It verifies the model against the app's trusted SHA-256 digest and checks size plus ZIP CRC for existing assets. It refuses to start with substituted model weights or overwrite differing files.
- If assets are missing or reported as different, keep a backup and resolve the affected files explicitly, then rerun asset preparation. Do not delete the speaker databases to repair an audio file.
- SpeechBrain 1.0.3 currently emits a PyTorch AMP deprecation warning on import. It is a third-party warning, not a failed test or a requirement for CUDA. Do not mix torch/torchaudio versions to suppress it.

## Use

- **Analysis reports:** after a completed identification, use **Export analysis** in the result panel to download **Printable HTML**, **CSV**, or **JSON**. HTML is standalone and includes the current Spotlight camera view (2D or 3D); open the downloaded file in a browser and print/save as PDF with Ctrl+P. A missing map is explicitly noted without blocking result export. HTML capture stops spin. Reports use the criteria and server timing from the completed analysis, not subsequent criteria edits, and include the currently displayed Top N candidates, backend, timestamps, audio label, warnings, and expected speaker for held-out tests. CSV keeps signed numeric scores and neutralizes spreadsheet-formula text. JSON uses schema version 1. Audio and raw embeddings are never exported, but names, filenames and derived plots are sensitive: keep downloads private. Export is disabled while recording, loading, analyzing, refreshing, or exporting; it does not create server-side report files.
- **Guided demo:** open the play-circle icon in the top bar for a six-step, non-modal walkthrough: load held-out test audio, identify, inspect the result, explore 3D, export, then optionally try the other backend. **Show control** highlights/focuses the relevant UI; **Next**, **Back**, and **Skip step** let you control progress. The guide never loads audio, submits analysis, switches backends, enrolls, or initializes Azure automatically. Follow the existing explicit controls and consent flow. Close with X or Escape without clearing data or cancelling requests. Opening Speaker library ends the guide; reopening starts at step one. Compare exported reports manually if trying both backends; this is not a side-by-side comparison feature and libraries may differ.
- **Documentation:** open the **Documentation** link in the workspace navigation for the [user guide](static/documentation.html) (English). It opens in a separate tab without clearing the current audio or result. The guide covers setup, recognition, enrollment, Azure, Spotlight controls, privacy, and troubleshooting, and supports browser printing/PDF export. Its styles and existing theme script are served locally to preserve the app's Content Security Policy.
- **Compact toolbar:** backend status, backend selection, **Azure AI Search** (in cloud mode), **Appearance / Apparence**, **EN / FR**, and **Clear / Effacer** stay on the command bar. Open Appearance to change the color palette, font, or background image. The menu closes on an outside click or Escape; Escape returns focus to its button. All existing preference storage, background import/removal, and Clear behavior is preserved.
- **Welcome screen:** every page load opens a themed welcome screen showing **Author : serge.retkowsky@microsoft.com**, **Version 1.0**, and **05-10-2026**. Choose **Get started / Commencer** (or press Escape) to enter the app. Keyboard focus stays in the welcome screen until dismissed, then moves to the Identification navigation button. Connection initialization continues in the background; the welcome screen does not request microphone access or change preferences. Connection refreshes and language/theme changes do not reopen it.
- **Microphone:** select **Allow / refresh microphones** to grant access and reveal device names, then choose an input microphone (or the system default). This permission step releases the microphone immediately without recording audio. The choice lasts for the current page session and is locked while recording. Device lists update when hardware changes; an unavailable selected microphone is reported rather than silently replaced. Record 2-30 seconds, stop, review playback, then select **Identify speaker**. Capture uses an AudioWorklet and encodes mono PCM WAV in the browser; the server resamples to 16 kHz.
- **Recording completion:** stopping waits for the AudioWorklet to flush its final partial buffer before encoding, while keeping the 30-second cap. Failure to acknowledge completion produces an explicit recording error and releases microphone resources instead of silently returning truncated audio.
- **Upload WAV:** browse or drag one WAV file onto the upload area. Input must be 2-30 seconds, mono/stereo, 8-192 kHz, and at most 20 MB. Silence, malformed files, and nonfinite samples are rejected. Heavy clipping produces a warning.
- **Test audio:** the third input tab lists all **41 `_segment_2.wav` files** from `df_samples_2` (cell 58 in the ZIP notebook). Select a file, load it, then identify the speaker. Playback and the expected speaker are provided; the result indicates a correct match, an incorrect match, or rejection as unknown. These files are not automatically enrolled.
- **Backend:** choose **Qdrant / Local** or **Azure AI Search / Cloud** in the header. Embeddings are always computed locally with ECAPA; the selected vector database performs matching. Libraries are separate: enrollment/deletion affects only the selected backend. Changing backend clears the old result, but keeps the selected audio. Azure failures never fall back silently to Qdrant.
- **Azure AI Search panel:** close it with the top-right **X**, then reopen it with **Azure AI Search** in the header. The header button has the same 36-pixel height as neighboring controls. Closing only hides the panel: it does not switch backend, save or discard edits, clear consent, or interrupt requests. It stays closed during connection refreshes and appearance/language changes; selecting Azure again or reloading the page opens it.
- **Enroll yourself:** record clear speech or choose a WAV, select **Enroll this voice**, enter a unique name, and confirm permission. Test with a *different recording* of the same speaker.
- **Name uniqueness:** new enrollments use Unicode case-folding for duplicate-name checks in both backends (for example, accented uppercase/lowercase variants). Existing stored names are not renamed or merged.
- **Speaker library:** search names, listen to bundled references, load them as test samples, or delete your own enrolled speakers. Bundled samples are read-only. A stored reference matched to itself verifies the pipeline, not recognition accuracy.
- **Criteria:** open the sliders icon in the top bar (**Match criteria / Critères de correspondance**) to edit thresholds. Minimum cosine similarity defaults to `0.5`; minimum separation between the top two different speakers defaults to `0.05`. Both are experimental, adjustable values, **not calibrated accuracy guarantees**. Changes apply to the next analysis. Outside click or Escape closes the panel without resetting values; Escape returns focus to the icon. Invalid criteria reopen the panel and focus the invalid field. Criteria and Appearance share a single-open-panel group.
- **Results:** similarity bars run from 0 to 1, filled from the left, with labeled ticks at 0.25, 0.5 and 0.75. Scores and bars strictly below the minimum similarity used for that analysis appear red; scores equal to the threshold do not. The result states the applied threshold; changing match criteria affects the next analysis. Negative similarities have empty bars, not absolute-value bars. The actual signed cosine scores remain visible and matching thresholds are unchanged. Analysis time is shown in seconds and milliseconds from the same server-side measurement (excluding browser/network time).
- **Identify speaker:** the full-width, larger button gently pulses when audio is ready. It stops animating when disabled or analyzing, and respects the system's reduced-motion preference.
- **Clear / Effacer:** clears selected audio, recording visuals and recognition results, stops playback, and clears the match spotlight and its pan/zoom. It does not delete speakers or reset preferences, match criteria, Top N, or the chosen microphone. Clear is disabled during recording or requests; stop recording first.
- **Live visuals:** microphone amplitude drives the glowing orb and signal meter; a live 0-8 kHz spectrogram shows actual frequency intensity. This is not a speaker-confidence or speech-quality measurement. No microphone access is requested just for visuals. Waveform/orb animation and recording share the existing stream, which is stopped on completion, failure or page exit. Reduced-motion mode removes orb movement and result reveals, and replaces the scrolling spectrogram with a slowly refreshed, stationary spectrum.
- **Result reveal:** a new analysis animates the summary and ranked bars into place; changing language, theme or Top N does not replay it. Matched and rejected results have distinct borders without changing the decision rules. A black threshold marker on every bar shows the minimum similarity actually used; negative scores remain empty red bars. Screen readers receive a concise result announcement.
- **Match spotlight (Qdrant and Azure AI Search):** each small dot is a real reference sample, projected from 192 dimensions using PCA. **2D** uses the first two components; **3D** uses the first three with an orthographic camera and subtle depth-sized dots. The third coordinate comes from the embeddings, not artificial depth. The recorded query remains a neutral, labeled diamond. The accepted speaker's highest-cosine reference sample is **green**, with a "Matched sample" label; **all other reference dots are red**, including other samples of that speaker. Unknown/rejected results have no green dot. These colors persist across selection, hover, camera controls, Top N and all themes. The best reference sample for each displayed Top N candidate has a subtle ring and a thin dashed link; the accepted match's link is green and other links are red. Links use full-vector cosine similarity, **not** visual distance. Numeric scores retain their analysis-threshold formatting. No random positions, duplicate dots, or jitter are added. The query uses the same reference-fitted basis. Retained variance and low-rank warnings reflect the selected dimension; either projection can significantly distort relationships. Azure retrieves all references from the selected cloud index, including cloud-only enrollments, and projects them on the app server. The browser receives coordinates and scores, never raw reference vectors. LOCAL / PCA and AZURE / PCA badges identify the source. Cache signatures include backend, endpoint, index and document content; failed retrieval never falls back to local voices or a stale cached plot.
- **Azure Spotlight prerequisites:** new app-managed indexes make `audio_embeddings` retrievable. On first cloud projection, an existing compatible index's hidden vector field is made retrievable with an ETag-conditional schema update; documents are not deleted, re-uploaded, or recreated. This requires index-update permission (Search Service Contributor or an admin key) for that first change. Clients with query access can then request vectors from the index. A field created with `stored=false` cannot be enabled this way: the app reports the limitation without rebuilding the index. Missing/malformed vectors, permission failures and paging errors disable only the plot; recognition results remain visible with an explicit retryable error. Azure indexing is eventually consistent, so enrollment/deletion changes may require another analysis after they become searchable.
- **Spotlight controls:** select **2D** (the default) or **3D**. Zoom from **50% to 300%** using the slider, minus/plus buttons, or mouse wheel. In 3D, **Spin / Stop spin** toggles automatic rotation. **Reset view** stops spinning, restores zoom, centers the map, and resets orientation without changing results or the selected dimension. Switching dimensions also resets the camera and stops spinning. The clean, flat backdrop and selective candidate labels remain; there is no floor or grid. Camera controls clip at the plot boundary and never change scores or rankings.
- **Result-only plot:** the map stays empty until a recognition result is available. Clearing results, starting another analysis, changing audio, or resetting the demo removes every dot, connection and selection, stops spinning, and resets the camera. No reference-only map is fetched on startup or refresh.
- **Map navigation:** in 2D, left-drag or use arrow keys on the focused map to pan. In 3D, left-drag to rotate horizontally and tilt vertically (limited to -85 to +85 degrees); **Shift+drag** pans. Arrow keys rotate the focused 3D map, and **Shift+arrows** pan. Scroll up to zoom in and down to zoom out within the same 50-300% bounds. Wheel/trackpad scrolling over the plot zooms instead of scrolling the page; outside the plot, normal page scrolling is unchanged. Ctrl/Cmd+wheel remains browser zoom. Manual camera controls and point selection stop automatic spin. Dragging does not trigger a click selection. Dragging and spinning stop when the plot clears, the page loses focus, the tab is hidden, or navigation leaves identification; pointer cancellation releases the drag. Automatic spin is disabled with reduced motion, but manual rotation, pan and zoom remain available.
- **Dot labels:** only displayed top candidates and the hovered or selected sample show speaker names and signed cosine scores, keeping other references quiet. Below-threshold scores remain red. Labels avoid other labels, dots, and the query label, and stay inside the plot where space allows. Selected points have priority in crowded areas. Placement updates when rotating, panning, zooming, or resizing. Hover labels pause during automatic spin; clicking or focusing a point stops the spin for inspection. Full names and scores remain accessible through tooltips, keyboard focus, and the reference selector even when a label cannot fit.
- **Top N:** enter the number of ranked speakers in the Recognition result panel (default **5**). Lowering the number immediately trims the displayed list without another request. Increasing it reveals cached matches immediately; if more must be fetched, committing the change (leaving the field) reruns the current audio. **Update results** also explicitly reruns recognition. The count applies to both Qdrant and Azure; fewer results appear if fewer distinct speakers are available. The summary always reflects the selected display count. Top N = 1 still checks the runner-up for ambiguity, so reducing the displayed count does not weaken recognition criteria.
- **Processing badge:** the computer icon with LOCAL means Qdrant; the cloud icon with CLOUD means Azure was selected, not necessarily connected. The separate connection status indicates readiness. Embedding computation remains local in both modes.
- **Unknown speaker:** returned when the strongest match is below the threshold or the top two speakers are too close. This is threshold-based rejection, not a trained open-set detector.
- **Appearance:** the Color palette menu contains exactly eight themes: Amber, Forest, Ocean and Rose, each in Light and Dark variants. Choices are sorted alphabetically in the selected language; there is no separate display-mode button. Ocean is the default color and Tahoma is the default font; previously saved color/mode choices are preserved. The font menu offers Arial, Calibri, Consolas, Georgia, Segoe UI, Tahoma, Times New Roman, and Verdana. Fonts use local installations with standard fallbacks; no web-font requests are made.
- **Resizable sidebar:** drag the divider between navigation and content, or focus it and use Left/Right, Home/End. Width is bounded to 160-420 pixels and saved locally. Double-click resets to 220 pixels. On mobile the divider is hidden and navigation wraps.
- **Background image:** use **Background > Import image** in the top bar; the adjacent remove button restores the plain background. PNG, JPEG and WebP are supported up to 8 MB, 8192 pixels per side and 20 megapixels. The image is stored only in this browser's IndexedDB, never uploaded to the Python server or Azure. A theme-aware overlay and opaque cards preserve readability. Clearing browser site data removes the image and appearance preferences.
- **Language:** switch between English and French in the header. Labels, results, validation messages, and app-generated speaker labels update immediately without clearing your selected audio or results. Your own speaker names and uploaded filenames are preserved. Browser-owned audio controls and file-picker dialogs follow your browser/OS language.

Language, palette, font, backend, sidebar width, and light/dark mode are saved in this browser's local storage. On the first visit, French is selected for a French browser; otherwise English is used. Qdrant is the initial backend. The initial display mode follows the system preference. An explicit `?scoutTheme=light` or `?scoutTheme=dark` URL overrides the saved mode; choosing a theme updates that URL too. Existing `voiceprint.*` preference keys are retained for compatibility with earlier versions. If browser storage is blocked, the app reports that preferences cannot be saved and still applies them for the current visit.

Use Edge or Chrome on localhost for microphone support. A permission denial or disconnected microphone produces an explicit error; WAV upload remains available. Remote access would require HTTPS and additional authentication/security work; this app deliberately binds only to loopback.

## Optional Azure AI Search setup

You need an existing Azure AI Search service with vector-search support; this app creates an **index**, not a Search service. Local mode and the automated tests do not require live Azure access. Explicit cloud initialization, enrollment, and deletion modify the dedicated index; cloud Spotlight may also enable vector retrieval on its existing vector field as described above.

1. Choose **Azure AI Search / Cloud**, enter your service's HTTPS endpoint and a **new dedicated index name**, then choose **Save settings**. Saving validates and persists these non-secret values locally without contacting Azure or creating anything. Do not use the notebook's original index: the app uses its own schema and model fingerprint. Environment variables `AZURE_SEARCH_ENDPOINT` and `AZURE_SEARCH_INDEX` remain defaults for an installation without saved app settings.
2. Prefer Microsoft Entra authentication through `DefaultAzureCredential`, for example `az login` for development. Enable the service's role-based data-plane access and grant your identity **Search Service Contributor** (index management) and **Search Index Data Contributor** (document querying/writing). Alternatively set `AZURE_SEARCH_API_KEY` to a Search **admin key** in `.env`; a query key cannot create indexes or enroll/delete voices. Never put secrets in frontend files or commit `.env`.
3. Restart the Python server only if you changed server credentials. Select **Check connection** after saving settings. Switching to Azure or reloading while Azure is selected also checks the saved connection, but never creates an index. If you use an API key, its service endpoint must also be set in the server `.env`: the app refuses to forward that key to a different endpoint. Use Entra ID to select services in the app without a service-bound key.
4. Read the cloud notice, check the permission box, and select **Initialize / repair reference index**. This creates the app-managed index if missing, then uploads the **41 segment-1 embeddings and speaker labels**. It does not upload test clips, raw audio, or your locally enrolled custom voices. Repeating initialization repairs reference documents without deleting cloud enrollments.
5. Identify, enroll, or delete using the cloud library. Custom enrollment sends the name and embedding; identification sends a query embedding. Raw audio stays on this computer. Index changes can take a few seconds to appear: use **Refresh connection** if necessary.

An incompatible existing index is rejected, never recreated or overwritten. Azure errors and incomplete writes are surfaced explicitly. A partially successful initialization may have saved some reference documents; retrying uses stable IDs. Qdrant and Azure custom libraries are deliberately separate, with no automatic copying between them. The app-managed cloud index uses one document per speaker, 192-dimensional cosine vectors, and exhaustive vector-only queries for the requested number of closest distinct speakers (five by default).

Endpoint and index settings are stored in the existing local SQLite settings table, survive server restarts, and override environment defaults. They are shared by all tabs using this server; credentials are neither saved by this form nor returned to the browser. Saving resets the old result and index-initialization consent, closes cached Azure clients, and requires a new connection check before recognition. Unsaved edits disable cloud recognition and initialization. Clear the endpoint and save to disable cloud processing. Local Qdrant data is unaffected.

Azure returns a transformed vector score, not raw cosine similarity. The app converts it using `cosine = 2 - 1 / @search.score` so the same thresholds and UI scores apply to both providers. See [Azure vector scoring](https://learn.microsoft.com/azure/search/vector-search-ranking#scores-in-a-vector-search-results).

## Model and persistence

[engine.py](engine.py) reproduces the notebook's ECAPA-TDNN feature extraction and sentence-level normalization using the supplied `embedding_model.ckpt`. It loads tensor weights with `weights_only=True`, never fetching a model from Hugging Face. The 192-dimensional embeddings are L2-normalized for cosine matching. [vector_stores.py](vector_stores.py) implements actual Qdrant and Azure queries; SQLite is not used for nearest-neighbor search.

- `data/model/`: bundled weights extracted from the ZIP.
- `data/references/`: all 82 bundled WAVs; 41 segment-1 enrollment references and 41 held-out segment-2 test clips.
- `data/voices.sqlite3`: local names, reference metadata, cached embeddings, a model fingerprint, and non-secret Azure endpoint/index settings. The voice data is sensitive biometric data.
- `data/qdrant/`: persistent local cosine vector collection, synchronized from the local metadata/cache. On startup and before local queries, stale derived points are removed and current embeddings are indexed.
- Uploaded/recorded identification audio is processed in memory, not saved by the server.
- Constellation responses contain reference identifiers/names, three PCA coordinates (`x`, `y`, `z`) and optional query cosine scores, not the raw 192-dimensional vectors. These derived visualizations can still be sensitive: treat screenshots accordingly. The plot lives only in the current result and is discarded on reset; the server does not persist the query. A map-computation failure is reported explicitly without discarding an otherwise valid recognition result.
- Enrollment persists only the name and embedding in the chosen database, not the original recording. Custom enrolled speakers therefore have no audio playback.
- Reference hashes invalidate changed sample embeddings. A changed model fingerprint stops startup rather than mixing incompatible embeddings. Back up the database and rebuild it if intentionally switching models; custom speakers must then be re-enrolled.

**Migration from earlier app versions:** previously, all 82 files were enrolled. Startup now removes only the bundled segment-2 entries from the enrollment cache and rebuilds the Qdrant view. WAV files and your custom enrolled voices are preserved. This restores the notebook's train/test separation; held-out scores will usually be lower than the earlier self-match scores.

**Storage-location caveat:** this workspace is under OneDrive, which may sync local databases and bundled files. Move the app and its `data` folder to a non-synced directory if needed. Qdrant mode makes no cloud inference calls; Azure mode explicitly sends embeddings to your configured Search service. Treat embeddings as sensitive biometric data and protect your machine, Azure service, and backups.

This is a speaker-similarity demo, not authentication, liveness detection, diarization, or verified identity recognition. It cannot reliably distinguish replayed audio, synthetic voices, overlapping speakers, or all unfamiliar speakers. Noise, short clips, and changes in microphone or speaking style affect results. Use consented audio only.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe -m unittest discover -s .\tests -p "test_*.py" -v
node --test .\tests\test_frontend.cjs
```

Tests use a temporary library with the real model, test held-out speech from the bundled dataset, verify exact-reference matches and unknown/ambiguous outcomes, exercise enrollment persistence/deletion, and check audio constraints and API protections. They do not modify your actual speaker library.

Backend tests cover real embedded Qdrant persistence, migration and failed synchronization, plus Azure SDK request/schema/score/CRUD contracts using mocks. Azure tests do not contact a live service; live cloud authentication, networking, and service compatibility must be verified after configuring your service.

Projection tests verify actual vector distances on planar and three-dimensional fixtures, separate 2D/3D retained variance, stable query projection, deterministic reference ordering, empty/degenerate libraries, invalid vectors, and cache invalidation after enrollment/deletion. Mocked Azure tests exercise paginated vector retrieval, source isolation, retrievability changes, failure handling, and the absence of raw vectors in browser responses. Frontend tests cover rotation/zoom geometry and clearing plot data and animation when results are absent.

Frontend tests parse every runtime JavaScript file and use Node's built-in test runner (no npm install required). Coverage includes bilingual translations, preference storage, themes/contrast, microphone device handling and final-buffer flushing, upload locks, toolbar panels, welcome/documentation, exports and error recovery, guided-demo lifecycle, and map interaction. Asset-preparation tests use a temporary ZIP and verify repeatability, corruption detection, and exclusion of environment files. Translations are maintained in [static/i18n.js](static/i18n.js).

Automated microphone tests use simulated worklet/messages, not a physical device. Browser permissions and a real microphone should also be checked on the target demo machine. Successful tests and `pip check` do not constitute a third-party vulnerability audit or a calibrated recognition-accuracy guarantee.

## API

All browser API calls are same-origin and local. The server contacts Azure only when cloud operations are selected and configured. Status, speaker list, identification, enrollment, and deletion accept `?backend=qdrant` (default) or `?backend=azure`. The audio routes accept a **raw WAV body** with `Content-Type: audio/wav`, not multipart form data.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/status` | Model and library status |
| GET | `/api/speakers` | List speaker profiles |
| GET | `/api/constellation?backend=qdrant` | Reference-only `x/y/z` PCA coordinates, `backend`, `explained_variance` (2D) and `explained_variance_3d`. Use `backend=azure` to retrieve and project Azure references. Available for API clients; the UI uses only identification snapshots. |
| POST | `/api/identify?threshold=0.5&min_gap=0.05&top_n=5` | Return accepted speaker or null, up to `top_n` distinct candidates, requested `top_n`, score gap, audio metadata, `elapsed_seconds` and `elapsed_ms` |
| POST | `/api/speakers?name=Your%20Name` | Persist a named reference embedding |
| DELETE | `/api/speakers/{id}` | Delete a custom speaker and embedding |
| GET | `/api/references/{id}` | Play a bundled reference |
| GET | `/api/test-audio` | List held-out notebook test WAVs and expected speakers |
| GET | `/api/test-audio/{id}` | Play/load a held-out WAV |
| GET | `/api/backends/azure/configuration` | Read non-secret endpoint/index/authentication mode; no Azure call |
| PUT | `/api/backends/azure/configuration` | Save JSON `{"endpoint":"https://your-service.search.windows.net","index_name":"speaker-identification"}` locally; no Azure call |
| POST | `/api/backends/azure/initialize` | Create/check the dedicated cloud index and seed references; requires JSON `{"consent": true}` |

## Code map

| Surface | Implementation |
|---|---|
| FastAPI routes, request validation, local access policy | [app.py](app.py) |
| Audio validation, ECAPA embeddings, metadata and recognition | [engine.py](engine.py) |
| Qdrant and Azure index/query operations | [vector_stores.py](vector_stores.py) |
| Reference-fitted PCA | [projection.py](projection.py) |
| Application layout, controls and state | [static/index.html](static/index.html), [static/app.js](static/app.js), [static/styles.css](static/styles.css) |
| Live audio visuals and 2D/3D Spotlight | [static/demo.js](static/demo.js), [static/demo.css](static/demo.css) |
| Report exports and guided demo | [static/presentation.js](static/presentation.js) |
| AudioWorklet recorder | [static/recorder-worklet.js](static/recorder-worklet.js) |
| Preferences, background image and localization | [static/theme.js](static/theme.js), [static/appearance.js](static/appearance.js), [static/i18n.js](static/i18n.js) |
| Browser-readable guide and printable report styles | [static/documentation.html](static/documentation.html), [static/documentation.css](static/documentation.css) |
| Asset preparation and Windows launcher | [prepare_assets.py](prepare_assets.py), [start.ps1](start.ps1) |

[design-preview.html](design-preview.html) is a legacy design prototype, not the running app. The original notebook and ZIP are source materials; the server does not execute the notebook.

Identification includes a `constellation` snapshot with query coordinates for **both Qdrant and Azure**, or an explicit unavailable reason if projection fails. A map failure preserves an otherwise valid recognition result. Analysis timing includes embedding, database search, reference retrieval and PCA work; it excludes browser/network transfer to the local API. Report completion/export timestamps are added by the browser, not returned as server API timing fields.
