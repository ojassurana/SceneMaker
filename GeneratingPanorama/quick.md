# How this API works (quick view)

Use this file as a **one-screen cheat sheet**. The full curl examples live in [README.md](README.md).

---

## In one sentence

**Client** uploads an image → **FastAPI** saves it → **`codex exec`** runs the **one-image-panorama** skill → **Codex** writes `panorama.png` + `cubemap/*.png` under `outputs/<job_id>/` → **API** responds with **URLs** to those files (served as static files).

---

## Flow (boxes → next step)

```
POST /generate-panorama-cubemap  (multipart: image + description)
        │
        ▼
  New folder outputs/<job_id>/
        │
        ▼
  asyncio.to_thread(_run_codex)   ← avoids blocking the event loop
        │
        ▼
  subprocess: codex exec … --image <saved file>  (+ sandbox / no approval flags)
        │
        ▼
  Codex must create:
    • panorama.png
    • cubemap/front|right|back|left|top|bottom.png
        │
        ▼
  JSON: job_id, panorama URL, faces{…}
```

Parallel requests are OK: each request gets its **own** `job_id` and directory.

---

## Endpoints

| Method | Path | What it does |
|--------|------|----------------|
| `GET` | `/health` | `{"ok": true}` |
| `POST` | `/generate-panorama-cubemap` | Multipart: `image` (file), `description` (form field). **Waits** until Codex finishes or fails. |
| static | `/outputs/...` | PNGs written under `GeneratingPanorama/outputs/` |

---

## Errors (short)

| HTTP | Meaning |
|------|---------|
| `400` | Empty `description` |
| `502` | Codex failed, bad exit code, or missing cubemap faces |
| `504` | Codex exceeded `CODEX_TIMEOUT_SECONDS` (default 900s) — job folder removed |

---

## Config you should know

| What | Where |
|------|--------|
| Skill path (reference in repo) | `SKILL_PATH` / `CUBEMAP_SCRIPT` in `app.py` |
| Codex working directory for the run | `GeneratingPanorama/` (`BASE_DIR`) |
| Timeout | Env `CODEX_TIMEOUT_SECONDS` |

That’s the whole pipeline: **one POST**, **one Codex run per request**, **static files** for results.
