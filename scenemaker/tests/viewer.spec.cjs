const { expect, test } = require('@playwright/test');
const { PNG } = require('pngjs');
const path = require('node:path');

async function canvasHasVisiblePixels(page) {
  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible();
  const image = PNG.sync.read(await canvas.screenshot());
  let variedPixels = 0;
  const first = image.data.slice(0, 4).join(',');

  for (let index = 4; index < image.data.length; index += 4) {
    if (image.data.slice(index, index + 4).join(',') !== first) {
      variedPixels += 1;
    }

    if (variedPixels > 1000) {
      return true;
    }
  }

  return false;
}

test.describe('Cube-map viewer', () => {
  test('loads the demo scene and renders a nonblank WebGL canvas', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('application', { name: '360 degree cube-map viewer' })).toBeVisible();
    await expect(page.getByText('ready', { exact: true })).toBeVisible();
    expect(await canvasHasVisiblePixels(page)).toBe(true);
  });

  test('switches to calibration assets and supports pointer rotation', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Calibration' }).click();
    await expect(page.getByText('Calibration').first()).toBeVisible();
    await expect(page.getByText('ready', { exact: true })).toBeVisible();

    const canvas = page.locator('canvas').first();
    const before = await canvas.screenshot();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();

    if (!box) {
      return;
    }

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 260, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();

    const after = await canvas.screenshot();
    expect(Buffer.compare(before, after)).not.toBe(0);
  });

  test('creates a blank generation workspace from the add button', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Add scene' }).click();
    await expect(page.getByRole('tab', { name: 'Scene 1' })).toBeVisible();
    await expect(page.getByText('Build a 360 scene')).toBeVisible();
    await expect(page.getByText('Upload one image to start.')).toBeVisible();
  });

  test('selects one source image for generated scene workflow', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Add scene' }).click();

    const upload = path.resolve(__dirname, '..', 'public', 'cubemaps', 'provided', 'front.png');
    await page.locator('input[type="file"]').setInputFiles(upload);

    await expect(page.getByText('front.png')).toBeVisible();
    await expect(page.getByText('Ready to generate from one image.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate 360 scene' })).toBeEnabled();
  });
});
