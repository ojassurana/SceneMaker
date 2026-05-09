import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Connect, Plugin } from 'vite';

import {
  cubeFacesFromGeneratedPanorama,
  CubeFaceKey,
  CubeFaceUrls,
  CUBE_FACE_KEYS,
  GeneratedPanoramaCubemapResponse,
  validateCubeFaces,
} from '../src/lib/cubemap';
import {
  createEditMaskSvg,
  pickTargetFromTranscript,
  SceneEditAiVerification,
  SceneEditPlan,
  SceneEditSelectionImage,
  selectAffectedFaces,
  ViewPose,
} from '../src/lib/sceneEditing';

type JsonValue = Record<string, unknown>;
type BufferedResponse = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const IMAGE_MODEL = 'gpt-image-2';
const TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
const PLANNER_MODEL = 'gpt-4.1-mini';
const PANORAMA_API_BASE_URL =
  process.env.PANORAMA_API_BASE_URL?.trim() || 'https://9593-137-132-26-217.ngrok-free.app';
const PANORAMA_STORAGE_DIR = path.join(process.cwd(), '.scenemaker', 'panoramas');
const CUBEMAP_CONVERTER_SCRIPT = path.join(process.cwd(), 'scripts', 'equirect_to_cubemap.py');
const execFileAsync = promisify(execFile);

function sendJson(res: ServerResponse, status: number, payload: JsonValue) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function requestBuffer(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer;
    timeoutMs?: number;
  } = {},
) {
  return new Promise<BufferedResponse>((resolve, reject) => {
    const parsedUrl = new URL(url);
    const request = (parsedUrl.protocol === 'https:' ? httpsRequest : httpRequest)(
      parsedUrl,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
        timeout: options.timeoutMs ?? 600_000,
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('Panorama generator timed out after 10 minutes.'));
    });
    request.on('error', reject);

    if (options.body) {
      request.write(options.body);
    }

    request.end();
  });
}

function getOpenAiKey() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  return apiKey && apiKey !== 'undefined' ? apiKey : undefined;
}

async function readJsonBody(req: Connect.IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonValue;
}

async function readRawBody(req: Connect.IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function requireString(value: unknown, label: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }

  return value;
}

function requirePose(value: unknown): ViewPose {
  if (!value || typeof value !== 'object') {
    return { yaw: 0, pitch: 0, fov: 75 };
  }

  const pose = value as Partial<ViewPose>;

  return {
    yaw: typeof pose.yaw === 'number' ? pose.yaw : 0,
    pitch: typeof pose.pitch === 'number' ? pose.pitch : 0,
    fov: typeof pose.fov === 'number' ? pose.fov : 75,
  };
}

function parseSelectionImages(value: unknown): SceneEditSelectionImage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((candidate) => candidate as Partial<SceneEditSelectionImage>)
    .filter(
      (candidate): candidate is SceneEditSelectionImage =>
        Boolean(candidate.face) &&
        CUBE_FACE_KEYS.includes(candidate.face as CubeFaceKey) &&
        typeof candidate.imageDataUrl === 'string' &&
        candidate.imageDataUrl.startsWith('data:image/'),
    )
    .slice(0, 3);
}

function extensionForMimeType(mimeType: string) {
  if (mimeType.includes('webm')) {
    return 'webm';
  }

  if (mimeType.includes('mp4')) {
    return 'mp4';
  }

  if (mimeType.includes('mpeg')) {
    return 'mp3';
  }

  if (mimeType.includes('wav')) {
    return 'wav';
  }

  if (mimeType.includes('m4a')) {
    return 'm4a';
  }

  if (mimeType.includes('png')) {
    return 'png';
  }

  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) {
    return 'jpg';
  }

  return 'bin';
}

function dataUrlToUpload(dataUrl: string, basename: string) {
  const match = dataUrl.match(/^data:([^;,]+)(?:;[^,]*)*;base64,(.+)$/);

  if (!match) {
    throw new Error(`${basename} must be a data URL.`);
  }

  const [, mimeType, base64] = match;
  const bytes = Buffer.from(base64, 'base64');
  const blob = new Blob([bytes], { type: mimeType });
  return {
    blob,
    filename: `${basename}.${extensionForMimeType(mimeType)}`,
    mimeType,
  };
}

function pngBase64ToBlob(base64: string) {
  return new Blob([Buffer.from(base64, 'base64')], { type: 'image/png' });
}

function dataUrlFromBase64(base64: string, mimeType = 'image/png') {
  return `data:${mimeType};base64,${base64}`;
}

function panoramaDir(panoramaId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(panoramaId)) {
    throw new Error('Invalid panorama id.');
  }

  return path.join(PANORAMA_STORAGE_DIR, panoramaId);
}

function panoramaPath(panoramaId: string) {
  return path.join(panoramaDir(panoramaId), 'panorama.png');
}

async function savePanoramaBytes(bytes: Buffer) {
  const panoramaId = randomUUID();
  const dir = panoramaDir(panoramaId);
  await mkdir(dir, { recursive: true });
  await writeFile(panoramaPath(panoramaId), bytes);
  return panoramaId;
}

async function saveGeneratedPanorama(sourceUrl: string) {
  if (!isAllowedGeneratedAssetUrl(sourceUrl)) {
    throw new Error('Panorama URL is not allowed.');
  }

  const response = await requestBuffer(sourceUrl, {
    headers: {
      'ngrok-skip-browser-warning': 'true',
    },
    timeoutMs: 60_000,
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error('Unable to download generated panorama.');
  }

  return savePanoramaBytes(response.body);
}

async function splitPanoramaToFaces(panoramaId: string): Promise<CubeFaceUrls> {
  const dir = panoramaDir(panoramaId);
  const facesDir = path.join(dir, 'faces');
  await mkdir(facesDir, { recursive: true });
  await execFileAsync('python3', [
    CUBEMAP_CONVERTER_SCRIPT,
    panoramaPath(panoramaId),
    '--out-dir',
    facesDir,
    '--face-size',
    '1024',
  ]);

  const faceEntries = await Promise.all(
    [
      ['front', 'front'],
      ['back', 'back'],
      ['left', 'left'],
      ['right', 'right'],
      ['up', 'top'],
      ['down', 'bottom'],
    ].map(async ([cubeFace, generatedFace]) => {
      const bytes = await readFile(path.join(facesDir, `${generatedFace}.png`));
      return [cubeFace, dataUrlFromBase64(bytes.toString('base64'))] as const;
    }),
  );

  return validateCubeFaces(Object.fromEntries(faceEntries));
}

async function urlToDataUrl(url: string) {
  const response = await fetch(url, {
    headers: {
      'ngrok-skip-browser-warning': 'true',
    },
  });

  if (!response.ok) {
    throw new Error(`Unable to fetch generated cube face ${url}: ${await response.text()}`);
  }

  const mimeType = response.headers.get('content-type')?.split(';')[0] || 'image/png';
  const bytes = Buffer.from(await response.arrayBuffer());
  return dataUrlFromBase64(bytes.toString('base64'), mimeType);
}

function normalizeGeneratedFaces(faces: unknown): CubeFaceUrls {
  if (!faces || typeof faces !== 'object') {
    throw new Error('Panorama API response did not include faces.');
  }

  const candidate = faces as Partial<Record<CubeFaceKey | 'top' | 'bottom', string>>;
  const normalized = {
    front: candidate.front,
    back: candidate.back,
    left: candidate.left,
    right: candidate.right,
    up: candidate.up ?? candidate.top,
    down: candidate.down ?? candidate.bottom,
  };

  return validateCubeFaces(normalized);
}

function parseOpenAiImageData(payload: unknown) {
  const result = payload as { data?: Array<{ b64_json?: string }> };
  const b64Json = result.data?.[0]?.b64_json;

  if (!b64Json) {
    throw new Error('OpenAI image edit did not return image data.');
  }

  return b64Json;
}

function parseResponseText(payload: unknown) {
  const response = payload as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
  };

  if (response.output_text) {
    return response.output_text;
  }

  for (const output of response.output ?? []) {
    for (const content of output.content ?? []) {
      if (typeof content.text === 'string') {
        return content.text;
      }
    }
  }

  return '';
}

function makeHeuristicPlan(transcript: string, pose: ViewPose): SceneEditPlan {
  const target = pickTargetFromTranscript(transcript, pose);
  const affectedFaces = selectAffectedFaces(target).map(({ face, editRole }) => ({
    face,
    editRole,
    maskPngBase64: Buffer.from(createEditMaskSvg(face, target)).toString('base64'),
  }));

  return {
    transcript,
    instruction: transcript,
    scope: 'localized',
    maskMode: 'box',
    target,
    affectedFaces,
  };
}

function getPlannerSystemPrompt() {
  return [
    'You plan localized edits for a six-face cube-map 360 scene. If crop images are provided, they are the selected target area and must be treated as the source of truth.',
    'Return only JSON with keys instruction, targetDescription, preservationInstruction, forbiddenChanges, successCriteria, and target.',
    'instruction must be a concise, target-aware edit instruction suitable for image editing.',
    'targetDescription describes exactly what selected object/person/region should change.',
    'preservationInstruction describes what must not change in the crop.',
    'forbiddenChanges is a short array of mistakes to avoid, especially adding or duplicating people/objects.',
    'successCriteria describes how a verifier should decide whether the edit succeeded.',
    'target must contain yaw, pitch, and radiusDegrees.',
    'Use the provided current view as the default target.',
    'Reject broad whole-room restyles by setting instruction to an explanation that localized edits only are supported.',
  ].join(' ');
}

async function planWithOpenAi(transcript: string, pose: ViewPose, selectionImages: SceneEditSelectionImage[] = []) {
  const apiKey = getOpenAiKey();

  if (!apiKey) {
    return makeHeuristicPlan(transcript, pose);
  }

  const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: PLANNER_MODEL,
      input: [
        { role: 'system', content: getPlannerSystemPrompt() },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify({
                transcript,
                currentView: pose,
                selectedFaces: selectionImages.map((image) => image.face),
                defaults: { radiusDegrees: 18, scope: 'localized' },
              }),
            },
            ...selectionImages.map((image) => ({
              type: 'input_image',
              image_url: image.imageDataUrl,
            })),
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'scene_edit_plan',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              instruction: { type: 'string' },
              targetDescription: { type: 'string' },
              preservationInstruction: { type: 'string' },
              forbiddenChanges: {
                type: 'array',
                items: { type: 'string' },
              },
              successCriteria: { type: 'string' },
              target: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  yaw: { type: 'number' },
                  pitch: { type: 'number' },
                  radiusDegrees: { type: 'number' },
                },
                required: ['yaw', 'pitch', 'radiusDegrees'],
              },
            },
            required: [
              'instruction',
              'targetDescription',
              'preservationInstruction',
              'forbiddenChanges',
              'successCriteria',
              'target',
            ],
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI planner failed: ${await response.text()}`);
  }

  const parsed = JSON.parse(parseResponseText(await response.json()) || '{}') as {
    instruction?: string;
    targetDescription?: string;
    preservationInstruction?: string;
    forbiddenChanges?: string[];
    successCriteria?: string;
    target?: SceneEditPlan['target'];
  };
  const fallback = makeHeuristicPlan(transcript, pose);
  const target = parsed.target ?? fallback.target;
  const instruction = parsed.instruction?.trim() || transcript;

  return {
    transcript,
    instruction,
    targetDescription: parsed.targetDescription?.trim(),
    preservationInstruction: parsed.preservationInstruction?.trim(),
    forbiddenChanges: Array.isArray(parsed.forbiddenChanges) ? parsed.forbiddenChanges.slice(0, 6) : [],
    successCriteria: parsed.successCriteria?.trim(),
    scope: 'localized' as const,
    maskMode: 'box' as const,
    target,
    affectedFaces: selectAffectedFaces(target).map(({ face, editRole }) => ({
      face,
      editRole,
      maskPngBase64: Buffer.from(createEditMaskSvg(face, target)).toString('base64'),
    })),
  };
}

async function transcribeAudio(body: JsonValue) {
  const apiKey = getOpenAiKey();

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for transcription.');
  }

  const audioDataUrl = requireString(body.audioBase64, 'audioBase64');
  const audioUpload = dataUrlToUpload(audioDataUrl, 'voice-edit');
  const formData = new FormData();
  formData.set('model', TRANSCRIPTION_MODEL);
  formData.set('file', audioUpload.blob, audioUpload.filename);

  const response = await fetch(`${OPENAI_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`OpenAI transcription failed: ${await response.text()}`);
  }

  const json = (await response.json()) as { text?: string };
  return requireString(json.text, 'transcription text');
}

function validatePlan(plan: unknown): SceneEditPlan {
  if (!plan || typeof plan !== 'object') {
    throw new Error('plan is required.');
  }

  const candidate = plan as SceneEditPlan;
  requireString(candidate.transcript, 'plan.transcript');
  requireString(candidate.instruction, 'plan.instruction');

  if (candidate.scope !== 'localized') {
    throw new Error('Only localized scene edits are supported.');
  }

  if (!candidate.target || typeof candidate.target !== 'object') {
    throw new Error('plan.target is required.');
  }

  if (!Array.isArray(candidate.affectedFaces) || candidate.affectedFaces.length === 0) {
    throw new Error('plan.affectedFaces is required.');
  }

  for (const affectedFace of candidate.affectedFaces) {
    if (!CUBE_FACE_KEYS.includes(affectedFace.face)) {
      throw new Error(`Invalid affected face: ${affectedFace.face}`);
    }
  }

  return candidate;
}

async function editPanorama(panoramaId: string, instruction: string) {
  const apiKey = getOpenAiKey();

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for GPT Image 2 panorama editing.');
  }

  const sourceBytes = await readFile(panoramaPath(panoramaId));
  const formData = new FormData();
  formData.set('model', IMAGE_MODEL);
  formData.set('size', 'auto');
  formData.set('quality', 'high');
  formData.set('output_format', 'png');
  formData.set('prompt', [
    `Apply this requested edit to the provided equirectangular 360 panorama: ${instruction}`,
    'Return a complete edited equirectangular panorama, not a crop or perspective view.',
    'Preserve the exact 2:1 panorama format, full scene coverage, horizon alignment, camera position, lighting, lens character, and 360 continuity.',
    'Change only what the user requested. Keep all unrelated people, objects, architecture, and background details stable.',
    'Avoid introducing seams, black borders, text labels, watermarks, duplicated subjects, or perspective warping.',
  ].filter(Boolean).join(' '));
  formData.set('image', new Blob([sourceBytes], { type: 'image/png' }), 'panorama.png');

  const response = await fetch(`${OPENAI_BASE_URL}/images/edits`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`OpenAI panorama edit failed: ${await response.text()}`);
  }

  const editedBytes = Buffer.from(parseOpenAiImageData(await response.json()), 'base64');
  return savePanoramaBytes(editedBytes);
}

async function applySceneEdit(body: JsonValue) {
  const panoramaId = requireString(body.panoramaId, 'panoramaId');
  const instruction = requireString(body.instruction, 'instruction');
  const editedPanoramaId = await editPanorama(panoramaId, instruction);
  const faces = await splitPanoramaToFaces(editedPanoramaId);

  return {
    faces,
    panoramaId: editedPanoramaId,
    generatedFaces: faces,
    editedFaces: [...CUBE_FACE_KEYS],
  };
}

async function verifySceneEdit(body: JsonValue): Promise<SceneEditAiVerification> {
  const apiKey = getOpenAiKey();

  if (!apiKey) {
    return {
      pass: true,
      confidence: 0,
      reason: 'OPENAI_API_KEY is not available, so AI verification was skipped.',
      warnings: [],
    };
  }

  const instruction = requireString(body.instruction, 'instruction');
  const plan = validatePlan(body.plan);
  const beforeImages = parseSelectionImages(body.beforeImages);
  const afterImages = parseSelectionImages(body.afterImages);

  if (beforeImages.length === 0 || afterImages.length === 0) {
    return {
      pass: true,
      confidence: 0,
      reason: 'No selected crop images were available for AI verification.',
      warnings: [],
    };
  }

  const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: PLANNER_MODEL,
      input: [
        {
          role: 'system',
          content: [
            'You verify localized image edits. Compare the before crop and after crop.',
            'Pass only if the requested selected target changed as requested, no new person/object was added, and important unrequested areas were preserved.',
            'Return only JSON with keys pass, confidence, reason, and warnings.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify({
                requestedChange: instruction,
                editInstructionUsed: plan.instruction,
                targetDescription: plan.targetDescription,
                preservationInstruction: plan.preservationInstruction,
                forbiddenChanges: plan.forbiddenChanges,
                successCriteria: plan.successCriteria,
                beforeCropLabel: 'The next image is the selected crop before editing.',
              }),
            },
            { type: 'input_image', image_url: beforeImages[0].imageDataUrl },
            {
              type: 'input_text',
              text: 'The next image is the selected crop after editing.',
            },
            { type: 'input_image', image_url: afterImages[0].imageDataUrl },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'scene_edit_verification',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              pass: { type: 'boolean' },
              confidence: { type: 'number' },
              reason: { type: 'string' },
              warnings: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['pass', 'confidence', 'reason', 'warnings'],
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI edit verification failed: ${await response.text()}`);
  }

  const parsed = JSON.parse(parseResponseText(await response.json()) || '{}') as Partial<SceneEditAiVerification>;

  return {
    pass: Boolean(parsed.pass),
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    reason: parsed.reason?.trim() || 'AI verifier did not provide a reason.',
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.slice(0, 4) : [],
  };
}

function proxyGeneratedUrl(url: string) {
  return `/api/generated-panorama-asset?url=${encodeURIComponent(url)}`;
}

function isAllowedGeneratedAssetUrl(url: string) {
  try {
    const assetUrl = new URL(url);
    const baseUrl = new URL(PANORAMA_API_BASE_URL);
    return assetUrl.origin === baseUrl.origin && assetUrl.pathname.startsWith('/outputs/');
  } catch {
    return false;
  }
}

async function rewriteGeneratedFaces(payload: GeneratedPanoramaCubemapResponse): Promise<GeneratedPanoramaCubemapResponse> {
  const faces = cubeFacesFromGeneratedPanorama(payload.faces);
  const panoramaId = payload.panorama ? await saveGeneratedPanorama(payload.panorama) : undefined;

  return {
    ...payload,
    panoramaId,
    panorama: payload.panorama ? proxyGeneratedUrl(payload.panorama) : payload.panorama,
    faces: {
      front: proxyGeneratedUrl(faces.front),
      right: proxyGeneratedUrl(faces.right),
      back: proxyGeneratedUrl(faces.back),
      left: proxyGeneratedUrl(faces.left),
      top: proxyGeneratedUrl(faces.up),
      bottom: proxyGeneratedUrl(faces.down),
    },
  };
}

async function generatePanoramaCubemap(req: Connect.IncomingMessage) {
  const contentType = req.headers['content-type'];

  if (!contentType?.startsWith('multipart/form-data')) {
    throw new Error('Image generation requires multipart/form-data.');
  }

  const body = await readRawBody(req);

  if (body.length === 0) {
    throw new Error('Image generation request body is empty.');
  }

  const response = await requestBuffer(`${PANORAMA_API_BASE_URL}/generate-panorama-cubemap`, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'content-length': String(body.length),
      'ngrok-skip-browser-warning': 'true',
    },
    body,
    timeoutMs: 600_000,
  });
  const text = response.body.toString('utf8');

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Panorama generator failed: ${text}`);
  }

  try {
    return await rewriteGeneratedFaces(JSON.parse(text) as GeneratedPanoramaCubemapResponse);
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }

    throw new Error('Panorama generator returned invalid JSON.');
  }
}

async function proxyGeneratedAsset(req: Connect.IncomingMessage, res: ServerResponse) {
  const parsedUrl = new URL(req.url ?? '', 'http://localhost');
  const sourceUrl = parsedUrl.searchParams.get('url') ?? '';

  if (!isAllowedGeneratedAssetUrl(sourceUrl)) {
    sendJson(res, 400, { error: 'Generated asset URL is not allowed.' });
    return;
  }

  const response = await requestBuffer(sourceUrl, {
    headers: {
      'ngrok-skip-browser-warning': 'true',
    },
    timeoutMs: 60_000,
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    sendJson(res, response.statusCode || 502, { error: 'Unable to load generated asset.' });
    return;
  }

  res.statusCode = 200;
  res.setHeader('content-type', String(response.headers['content-type'] ?? 'image/png'));
  res.setHeader('cache-control', String(response.headers['cache-control'] ?? 'private, max-age=300'));
  res.end(response.body);
}

async function getStoredPanoramaCubemap(req: Connect.IncomingMessage, res: ServerResponse) {
  const parsedUrl = new URL(req.url ?? '', 'http://localhost');
  const panoramaId = requireString(parsedUrl.searchParams.get('panoramaId'), 'panoramaId');
  sendJson(res, 200, {
    faces: await splitPanoramaToFaces(panoramaId),
    panoramaId,
  });
}

async function route(req: Connect.IncomingMessage, res: ServerResponse) {
  try {
    if (req.method === 'GET' && req.url?.startsWith('/api/generated-panorama-asset')) {
      await proxyGeneratedAsset(req, res);
      return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/api/panorama-cubemap-faces')) {
      await getStoredPanoramaCubemap(req, res);
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed.' });
      return;
    }

    if (req.url === '/api/generate-panorama-cubemap') {
      sendJson(res, 200, await generatePanoramaCubemap(req));
      return;
    }

    const body = await readJsonBody(req);

    if (req.url === '/api/transcribe') {
      sendJson(res, 200, { transcript: await transcribeAudio(body) });
      return;
    }

    if (req.url === '/api/scene-edits/plan') {
      const transcript = requireString(body.transcript, 'transcript');
      sendJson(res, 200, {
        plan: await planWithOpenAi(transcript, requirePose(body.viewPose), parseSelectionImages(body.selectionImages)),
      });
      return;
    }

    if (req.url === '/api/scene-edits/apply') {
      sendJson(res, 200, await applySceneEdit(body));
      return;
    }

    if (req.url === '/api/scene-edits/verify') {
      sendJson(res, 200, await verifySceneEdit(body));
      return;
    }

    sendJson(res, 404, { error: 'Unknown API route.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Scene edit API failed.';
    sendJson(res, 400, { error: message });
  }
}

export function sceneEditApiPlugin(): Plugin {
  return {
    name: 'scenemaker-scene-edit-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/api/')) {
          void route(req, res);
          return;
        }

        next();
      });
    },
  };
}
