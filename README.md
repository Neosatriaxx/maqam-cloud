# MAQAM — Mosque Attendance System (v3, Vercel + Supabase)

**MAQAM** is a mosque attendance system. The original v2 ran face-api.js + mobilenet in the browser, which caused overheating and crashes on older phones. This refactor moves **all AI to the backend** (Vercel serverless functions) and uses **Supabase** (PostgreSQL + Storage) for the database and face photos.

- **Frontend**: vanilla HTML/CSS/JS — only camera capture, geolocation, and lightweight API calls. No client-side AI models.
- **Backend**: Vercel Serverless Functions (`/api/*`) run `@vladmandic/face-api` (face detection + 128-d descriptor) and mobilenet-style scene verification on the server.
- **Storage/DB**: Supabase (PostgreSQL + `maqam-faces` Storage bucket for photos).

## Project structure

```
.
├── api/                      # Vercel Serverless Functions
│   ├── face-recognize.js     # POST — face detection + descriptor + match against users
│   ├── register.js           # POST — register a new user (photo upload + descriptor)
│   ├── scene-recognize.js    # POST — scene verification (mosque environment)
│   ├── attendance.js         # POST — record attendance (member + prayer + scene)
│   ├── admin.js              # router — login, members, attendance, standings, chart, toggle, remove, save-address
│   ├── setup.js              # POST — first-time mosque + admin setup
│   └── public-config.js      # GET — public config (mosque name, radius, counts)
├── utils/
│   ├── supabaseClient.js     # Supabase service-role client (reads env vars)
│   ├── faceAiLoader.js       # loads @vladmandic/face-api + mobilenet, decodes images, helpers
│   └── api-helpers.js        # auth, geofencing, response helpers
├── public/
│   ├── index.html            # attendance + registration UI
│   ├── admin.html            # admin panel UI
│   ├── css/                  # extracted styles
│   ├── js/                   # extracted client scripts (no client-side AI in production)
│   ├── img/                  # static images
│   └── models/               # face + mobilenet model weights (served to serverless functions)
├── supabase/
│   └── schema.sql            # Supabase tables + RPCs (run once in SQL Editor)
├── package.json
├── vercel.json
├── .env.example
└── README.md
```

## Prerequisites

- Node.js >= 20
- A Supabase project (free tier is fine): https://supabase.com
- A Vercel account: https://vercel.com
- Vercel CLI (optional but recommended for the first deploy):
  ```bash
  npm install -g vercel
  ```
- The AI model weights must be present in `public/models/` for the serverless functions to load:
  - `public/models/face/` — tiny face detector, face landmark 68 tiny, face recognition net
  - `public/models/mobilenet/` — mobilenet graph + weights (tfjs graph format)

  If you cloned this repo and the models are missing, download them. Canonical sources:
  - Face models: https://github.com/justadudewhohacks/face-api.js/tree/master/weights
  - Mobilenet (tfjs graph format): https://storage.googleapis.com/tfjs-models/tfjs/mobilenet_v1_1.0_224

  On Vercel, the `public/models` folder is bundled into the functions via `vercel.json`'s `includeFiles`, so the functions read them from disk at runtime.

## Step 1 — Create a Supabase project

1. Sign in at https://supabase.com and click **New Project**.
2. Choose a name (e.g. `maqam`), a database password (save it), and a region close to the mosque.
3. Wait for the project to finish provisioning (a few minutes).

## Step 2 — Get the Supabase credentials

1. Open your project and go to **Project Settings → API**.
2. Copy:
   - **Project URL** — this is `SUPABASE_URL`
   - **service_role key** (under "Project API keys") — this is `SUPABASE_SERVICE_ROLE_KEY`
3. The **anon public key** is NOT needed by this app because all DB and Storage access is server-side via the service-role key. You can skip it.

## Step 3 — Create the Supabase Storage bucket for face photos

1. In the Supabase dashboard, go to **Storage → New bucket**.
2. Name: `maqam-faces`
3. Public: **on** (so photos are publicly viewable via URL)
4. Allowed MIME types: `image/*` (or leave open)
5. Click **Save**.

Optional: if you want to store scene snapshots too, create a second bucket `maqam-scenes` (public: on, image/* allowed).

## Step 4 — Run the schema SQL in Supabase

1. Go to **SQL Editor** in the Supabase dashboard.
2. Open `supabase/schema.sql` from this project and paste its contents into the editor.
3. Click **Run** (or press Cmd/Ctrl + Enter).

The script creates:

- `settings` — app configuration (mosque name, lat, lng, radius, address, setup_done)
- `users` — registered jamaah (name, photo_url, descriptors array, is_active, created_at, email, phone, reminders, notes, admin_created_by)
- `admins` — admin users (email, password_hash, role, is_active, created_at)
- `attendance` — attendance records (member_id, member_name, prayer, date, timestamp, face_dist, geo_lat, geo_lng, geo_dist, scene_ref_sim, scene_black_sim, scene_note, server_ts, scene_img_path)
- `scene_refs` — reference embeddings for scene verification (id, photo, embedding, kind, active)
- RPCs:
  - `admin_verify(token)` — verify an admin token
  - `admin_login(username, password)` — admin login (returns a token)
  - `attendance_count_range(date_from, date_to, days)` — attendance counts for chart/standings
  - `attendance_standings(days)` — top members by attendance

### Admin token note

The admin system in this codebase uses a simple token flow:

- `POST /api/admin/login` with `{ username, password }` calls the `admin_login` RPC.
- The RPC looks up the admin by email/username, verifies the bcrypt password, and returns a token.
- The frontend stores the token in `localStorage` and sends it in the `X-Admin-Token` header (or `Authorization: Bearer`) for subsequent admin requests.
- `POST /api/admin` endpoints call `admin_verify` to check the token.

If you want a simpler setup, you can also set a single admin password via `ADMIN_SETUP_PASSWORD` in the env (used by `/api/setup` in some configurations). The `schema.sql` and `/api/setup` together handle first-time setup.

## Step 5 — Set environment variables (local)

1. Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```
2. Edit `.env.local` and fill in:
   ```bash
   SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJ...your-service-role-key...
   ADMIN_SETUP_PASSWORD=               # optional; admin password for first-time setup
   MOSQUE_NAME=                        # mosque name (for display)
   MOSQUE_LAT=                         # mosque GPS latitude
   MOSQUE_LNG=                         # mosque GPS longitude
   MOSQUE_RADIUS_M=                    # geofence radius in meters (e.g. 120)
   SCENE_REF_THRESH=                   # scene similarity threshold (e.g. 0.68)
   SCENE_MARGIN=                       # required margin above non-mosque sim (e.g. 0.10)
   FACE_MATCH_THRESHOLD=               # face match euclidean threshold (e.g. 0.5)
   ```
3. For local dev, make sure `VERCEL` is unset (or `VERCEL=0`) so `@supabase/supabase-js` uses the env vars directly.

## Step 6 — Install dependencies (local)

```bash
npm install
```

This installs:
- `@supabase/supabase-js` — Supabase client
- `@tensorflow/tfjs` + `@tensorflow/tfjs-backend-wasm` — pure-JS TFJS (no native tfjs-node)
- `@vladmandic/face-api` — face-api for Node.js
- `jpeg-js`, `pngjs` — image decoding (replaces the `canvas` native package)

## Step 7 — Run locally (optional but recommended for testing)

```bash
npm run dev
```

This runs `vercel dev` on port 3000.

Open:
- http://localhost:3000 — attendance UI
- http://localhost:3000/admin.html — admin panel

**Important for local dev**: the AI models in `public/models/` must be present, and `vercel dev` serves them from the filesystem. If the models are missing, the functions will fail to load the face-api nets. The `vercel.json` `includeFiles` pattern `public/models/**` ensures they're bundled for Vercel; locally, `vercel dev` reads them from disk.

Test the flow:

1. Open http://localhost:3000/admin.html
2. If setup hasn't been done, you'll be redirected to the setup wizard.
3. Complete setup: mosque name, admin username + password, GPS coordinates, radius.
4. After setup, open http://localhost:3000 and try the attendance flow: grant camera + location, verify geofence, take a face snapshot, scene snapshot.

## Step 8 — Deploy to Vercel (CLI)

1. From the project root:
   ```bash
   vercel
   ```
2. The CLI will ask:
   - **Set up and deploy?** → Yes
   - **Which scope?** → choose your Vercel account
   - **Link to existing project?** → No (unless you already created one in the dashboard)
   - **Project name?** → `maqam` (or your choice)
   - **Directory?** → `.` (root)
   - **Want to modify vercel.json?** → No (the existing one is fine)
3. Vercel detects the project as Node.js, reads `vercel.json`, and deploys.
4. After the deploy, Vercel prints the preview URL (e.g. `https://maqam-xxx.vercel.app`).

To promote to production:
```bash
vercel --prod
```

## Step 9 — Set environment variables on Vercel

1. In the Vercel dashboard, open your project.
2. Go to **Settings → Environment Variables**.
3. Add the same variables from Step 5:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ADMIN_SETUP_PASSWORD` (if used)
   - `MOSQUE_NAME`
   - `MOSQUE_LAT`
   - `MOSQUE_LNG`
   - `MOSQUE_RADIUS_M`
   - `SCENE_REF_THRESH`
   - `SCENE_MARGIN`
   - `FACE_MATCH_THRESHOLD`
4. For each, set the environments:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and the mosque config → **Production** and **Preview**
   - sensitive keys like `SUPABASE_SERVICE_ROLE_KEY` → **Production**, **Preview**, and **Development** if you want local dev to work with the Vercel env
5. After adding, **redploy** so the new env vars take effect:
   ```bash
   vercel --prod
   ```
   or use **Deployments → Redeploy** in the dashboard.

## Step 10 — Deploy to Vercel (GitHub, alternative)

1. Push this repo to GitHub.
2. In the Vercel dashboard, click **Add new project** and import the repo.
3. Vercel auto-detects `vercel.json` and the Node.js runtime.
4. Add the environment variables (Step 9).
5. Click **Deploy**.

## Step 11 — Post-deploy verification

1. Open the production URL (e.g. `https://maqam-xxx.vercel.app`).
2. Go to `/admin.html`.
3. If setup hasn't been done, complete the setup wizard:
   - mosque name
   - admin username + password
   - GPS coordinates (use the "Ambil GPS" button or enter manually)
   - geofence radius
4. After setup, the attendance page (`/`) should show the mosque name and today's count.
5. Test the attendance flow:
   - open `/` on a phone/browser with camera + location
   - grant camera + location permissions
   - the geofence gate should open when you're inside the mosque radius
   - step 1: face snapshot → send to `/api/face-recognize` → if matched, proceed
   - step 2: scene snapshot → send to `/api/scene-recognize` → if pass, proceed
   - step 3: attendance recorded
6. Test admin:
   - `/admin.html` → login with the admin credentials
   - check members, attendance table, standings, chart
   - toggle member active / remove member

## Step 12 — Populate scene references (optional but recommended)

`/api/scene-recognize` uses reference embeddings to decide if a scene looks like a mosque. If the `scene_refs` table is empty, it falls back to a heuristic (which is usable but less accurate).

To populate real references:

1. In Supabase, insert rows into `scene_refs`:
   - `mosque` kind: photos of the actual mosque interior + similar mosque interiors
   - `black` kind: photos of non-mosque interiors (office, home, street, etc.)
2. For each photo, compute a mobilenet embedding (L2-normalized) and store it in the `embedding` column (as a JSON array of floats).
3. Set `active = true` for the ones you want used.

You can compute embeddings with a small script using the same `faceAiLoader.sceneEmbeddingFromDataUrl` helper, or use the mobilenet model directly. The endpoint in `api/scene-recognize.js` uses cosine similarity to the stored embeddings.

## Step 13 — First-time user registration

Registration is admin-only and must be done from inside the mosque geofence.

1. Admin logs in at `/admin.html`.
2. The admin registers a new jamaah (the frontend sends name + face samples to `/api/register`).
3. The server:
   - detects the face in each sample
   - re-derives the 128-d descriptor server-side
   - checks it's not a duplicate of any existing user
   - uploads the photo to `maqam-faces` bucket
   - inserts the user into the `users` table
4. The jamaah can then use the attendance flow.

## Troubleshooting

### "AI belum siap" / 503 from face-recognize or register

The serverless function couldn't load the face models. Causes:

- `public/models/face/` is missing or incomplete in the deployed bundle.
- `vercel.json` `includeFiles` doesn't cover `public/models/**`. Check that the pattern is `public/models/**` (it is in the current `vercel.json`).
- Local dev without models: `vercel dev` needs the models on disk. Download them (see Prerequisites).

On Vercel, check **Deployments → Logs** for the function and look for model-loading errors.

### Geofence errors ("di luar area masjid", "GEO")

- Make sure GPS is enabled on the device and the browser has location permission.
- The `MOSQUE_LAT`, `MOSQUE_LNG`, and `MOSQUE_RADIUS_M` env vars must match the real mosque location.
- The client also sends `accuracy` in the geo payload; if the device accuracy is poor, the geofence may reject even when inside. The server-side check allows some tolerance based on the reported accuracy.
- Test with the phone physically inside the mosque.

### Supabase errors (500, "Gagal membaca...", "Gagal menyimpan...")

- Verify the env vars `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set and correct.
- Check the Supabase dashboard **API → Logs** for errors.
- Make sure the `maqam-faces` bucket exists and is public.
- Make sure the schema SQL has been run (tables + RPCs exist).

### Admin login fails

- The `admin_login` RPC must exist (created by `schema.sql`).
- The admin email/username and password must match what was created during setup.
- The `bcrypt` compare must work — make sure the password was hashed with bcrypt during setup (the `setup.js` endpoint does this).

### Models too large for Vercel bundle

The `public/models/face` (~6.6MB) + `mobilenet` (~16MB) together are within Vercel's per-function bundle limits when compressed, but if you hit size issues:

- Load the models from a public URL instead of bundling them. The `faceAiLoader.js` already has logic to load from a public URL as a fallback (it sets `base` to a CDN URL in some configurations).
- Or use a smaller model set (e.g. just tiny face detector + face recognition net, skip the landmark net).

### Stale cache issues

`vercel.json` sets long cache headers for `/models/*` (1 year, immutable). If you update the models and redeploy, users may still get the old models from cache. To force a refresh, you can change the model filenames or add a query param. In production, consider versioning the model files.

## Architecture notes

- The frontend intentionally retains a small lightweight face detection helper (tiny face detector) only to draw the face box and auto-advance the UI. The actual descriptor used for matching is always re-derived server-side in `/api/face-recognize` and `/api/register`, so a tampered client cannot inject arbitrary descriptors.
- On a real Vercel deployment, the `public/libs/` directory (which would contain tf.min.js, mobilenet.min.js, face-api.min.js for the client) is **not needed** and can be removed — the client runs zero AI. The current `public/js/index.js` contains a dev-only block for local preview; remove it before production if desired (or leave it — it won't load anything because the libs aren't in the public tree).
- The serverless functions use the **pure-JS** TFJS stack (`@tensorflow/tfjs` + `@tensorflow/tfjs-backend-wasm`), not `tfjs-node`. This avoids native binaries and keeps the function bundle small. The `faceAiLoader.js` picks the wasm build when `tfjs-node` isn't available.

## Environment variables summary

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | server-side DB + Storage access |
| `ADMIN_SETUP_PASSWORD` | no | admin password for first-time setup (if used) |
| `MOSQUE_NAME` | recommended | mosque display name |
| `MOSQUE_LAT` | recommended | mosque GPS latitude |
| `MOSQUE_LNG` | recommended | mosque GPS longitude |
| `MOSQUE_RADIUS_M` | recommended | geofence radius in meters |
| `SCENE_REF_THRESH` | no | scene similarity threshold (default 0.68) |
| `SCENE_MARGIN` | no | required margin above non-mosque sim (default 0.10) |
| `FACE_MATCH_THRESHOLD` | no | face match euclidean threshold (default 0.5) |

## API reference (summary)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/setup` | POST | first-time mosque + admin setup |
| `/api/public/config` | GET | public config (mosque name, radius, stats) |
| `/api/face-recognize` | POST | face detection + match |
| `/api/register` | POST | register a new user (admin only) |
| `/api/scene-recognize` | POST | scene verification |
| `/api/attendance` | POST | record attendance |
| `/api/admin/login` | POST | admin login |
| `/api/admin/me` | GET | current admin session |
| `/api/admin/logout` | POST | admin logout |
| `/api/admin/members` | GET | list members |
| `/api/admin/attendance` | GET/POST | attendance records (with filters) |
| `/api/admin/attendance/count` | GET | attendance counts |
| `/api/admin/standings` | GET | attendance standings |
| `/api/admin/chart` | GET | chart data |
| `/api/admin/toggle-member` | POST | toggle member active |
| `/api/admin/remove-member` | POST | remove member |
| `/api/admin/save-address` | POST | save admin address |
