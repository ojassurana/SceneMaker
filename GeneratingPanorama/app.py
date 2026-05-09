import asyncio
import logging
import os
import shutil
import subprocess
import threading
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.staticfiles import StaticFiles


BASE_DIR = Path(__file__).resolve().parent
OUTPUT_ROOT = BASE_DIR / "outputs"
SKILL_PATH = Path("/Users/ojassurana/.codex/skills/one-image-panorama/SKILL.md")
CUBEMAP_SCRIPT = Path("/Users/ojassurana/.codex/skills/one-image-panorama/scripts/equirect_to_cubemap.py")
FACE_NAMES = ("front", "right", "back", "left", "top", "bottom")

OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

# Use uvicorn's error logger so Codex lines show in the same console as uvicorn
# (the app module logger often has no handler when uvicorn configures logging).
codex_logger = logging.getLogger("uvicorn.error")

app = FastAPI(title="One Image Panorama API")
app.mount("/outputs", StaticFiles(directory=OUTPUT_ROOT), name="outputs")


def _safe_extension(filename: str | None) -> str:
    suffix = Path(filename or "").suffix.lower()
    if suffix in {".png", ".jpg", ".jpeg", ".webp"}:
        return suffix
    return ".png"


def _build_codex_prompt(image_path: Path, description: str, job_dir: Path) -> str:
    return (
        f"Use the one-image-panorama skill on {image_path}, "
        # f"Additional info would be that {description}. "
        f"Save the final panorama to {job_dir / 'panorama.png'} and the six cubemap faces to {job_dir / 'cubemap'}."
    )


def _run_codex(image_path: Path, description: str, job_dir: Path) -> None:
    last_message_path = job_dir / "codex-last-message.txt"
    prompt = _build_codex_prompt(image_path, description, job_dir)
    timeout_seconds = int(os.getenv("CODEX_TIMEOUT_SECONDS", "900"))

    command = [
        "codex",
        "--ask-for-approval",
        "never",
        "-s",
        "danger-full-access",
        "exec",
        "--skip-git-repo-check",
        "-C",
        str(BASE_DIR),
        "--image",
        str(image_path),
        "-o",
        str(last_message_path),
        prompt,
    ]

    log_path = job_dir / "codex.log"
    collected: list[str] = []

    codex_logger.info("[codex] starting job %s", job_dir.name)

    process = subprocess.Popen(
        command,
        cwd=BASE_DIR,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=1,
    )

    def _stream_stdout() -> None:
        assert process.stdout is not None
        for line in iter(process.stdout.readline, ""):
            collected.append(line)
            chunk = line.rstrip("\r\n")
            if chunk:
                codex_logger.info("[codex] %s", chunk)
        process.stdout.close()

    reader = threading.Thread(target=_stream_stdout)
    reader.start()
    try:
        returncode = process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        process.kill()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        reader.join(timeout=5)
        log_path.write_text(
            f"COMMAND: {' '.join(command)}\n\nSTREAM:\n{''.join(collected)}\n",
            encoding="utf-8",
        )
        raise subprocess.TimeoutExpired(cmd=command, timeout=timeout_seconds) from None
    else:
        reader.join(timeout=10)

    log_path.write_text(
        f"COMMAND: {' '.join(command)}\n\nSTREAM:\n{''.join(collected)}\n",
        encoding="utf-8",
    )

    if returncode != 0:
        raise RuntimeError(f"Codex CLI failed. See {log_path}")

    missing = [
        face
        for face in FACE_NAMES
        if not (job_dir / "cubemap" / f"{face}.png").is_file()
    ]
    if missing:
        raise RuntimeError(f"Codex finished but did not create required faces: {', '.join(missing)}. See {log_path}")


@app.post("/generate-panorama-cubemap")
async def generate_panorama_cubemap(
    request: Request,
    image: UploadFile = File(...),
    description: str = Form(...),
):
    if not description.strip():
        raise HTTPException(status_code=400, detail="description is required")

    job_id = uuid.uuid4().hex
    job_dir = OUTPUT_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=False)

    image_path = job_dir / f"source{_safe_extension(image.filename)}"
    with image_path.open("wb") as output:
        shutil.copyfileobj(image.file, output)

    try:
        await asyncio.to_thread(_run_codex, image_path, description.strip(), job_dir)
    except subprocess.TimeoutExpired as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=504, detail=f"Codex CLI timed out after {exc.timeout} seconds") from exc
    except Exception as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    faces = {
        face: str(request.url_for("outputs", path=f"{job_id}/cubemap/{face}.png"))
        for face in FACE_NAMES
    }
    panorama = str(request.url_for("outputs", path=f"{job_id}/panorama.png"))
    return {"job_id": job_id, "panorama": panorama, "faces": faces}


@app.get("/health")
async def health():
    return {"ok": True}
