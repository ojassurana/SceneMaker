# GeneratingPanorama — One Image Panorama API

HTTP API that accepts **one photo** + a short **description**, runs **Codex** with the **one-image-panorama** skill, and returns URLs for a full **panorama** plus **six cubemap faces** (front, right, back, left, top, bottom).

For a **fast overview** of how the server works end-to-end, see [quick.md](quick.md).

## Setup

```bash
cd GeneratingPanorama
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

You need **Codex CLI** on your `PATH` and the **one-image-panorama** skill at the paths set in `app.py` (or update those paths for your machine).

## Run

```bash
cd GeneratingPanorama
uvicorn app:app --reload --port 8000
```

## Call the API

```bash
curl -X POST http://localhost:8000/generate-panorama-cubemap \
  -F "image=@/path/to/source.jpg" \
  -F "description=A detailed description of the scene"
```

### Response shape

```json
{
  "job_id": "...",
  "panorama": "http://localhost:8000/outputs/<job_id>/panorama.png",
  "faces": {
    "front": "http://localhost:8000/outputs/<job_id>/cubemap/front.png",
    "right": "http://localhost:8000/outputs/<job_id>/cubemap/right.png",
    "back": "http://localhost:8000/outputs/<job_id>/cubemap/back.png",
    "left": "http://localhost:8000/outputs/<job_id>/cubemap/left.png",
    "top": "http://localhost:8000/outputs/<job_id>/cubemap/top.png",
    "bottom": "http://localhost:8000/outputs/<job_id>/cubemap/bottom.png"
  }
}
```

The handler only returns **after** all six face files exist (or it errors with **502** / **504** on failure or timeout).
