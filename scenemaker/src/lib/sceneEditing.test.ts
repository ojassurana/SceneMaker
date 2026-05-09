import { describe, expect, it } from 'vitest';

import {
  directionToCubeProjection,
  cubeProjectionToDirection,
  directionToScreenPoint,
  screenPointToDirection,
  getAdjacentFaces,
  pickTargetFromTranscript,
  projectViewPose,
  selectionBoxToRegion,
  selectAffectedFaces,
} from './sceneEditing';

describe('scene editing geometry', () => {
  it('maps cardinal view directions to cube faces', () => {
    expect(projectViewPose({ yaw: 0, pitch: 0, radiusDegrees: 18 }).face).toBe('front');
    expect(projectViewPose({ yaw: 90, pitch: 0, radiusDegrees: 18 }).face).toBe('right');
    expect(projectViewPose({ yaw: 180, pitch: 0, radiusDegrees: 18 }).face).toBe('back');
    expect(projectViewPose({ yaw: -90, pitch: 0, radiusDegrees: 18 }).face).toBe('left');
    expect(projectViewPose({ yaw: 0, pitch: 90, radiusDegrees: 18 }).face).toBe('up');
    expect(projectViewPose({ yaw: 0, pitch: -90, radiusDegrees: 18 }).face).toBe('down');
  });

  it('keeps face-center UVs stable', () => {
    expect(directionToCubeProjection({ x: 0, y: 0, z: -1 })).toMatchObject({
      face: 'front',
      u: 0.5,
      v: 0.5,
    });
    expect(directionToCubeProjection({ x: 1, y: 0, z: 0 })).toMatchObject({
      face: 'right',
      u: 0.5,
      v: 0.5,
    });
  });

  it('round trips cube face pixels into screen space for a centered view', () => {
    const screenPoint = directionToScreenPoint(cubeProjectionToDirection('front', 0.5, 0.5), { yaw: 0, pitch: 0, fov: 75 }, 1);

    expect(screenPoint?.x).toBeCloseTo(0);
    expect(screenPoint?.y).toBeCloseTo(0);
  });

  it('treats positive yaw as the right cube face in screen projection helpers', () => {
    expect(directionToCubeProjection(screenPointToDirection({ x: 0, y: 0 }, { yaw: 90, pitch: 0, fov: 75 }, 1)).face).toBe(
      'right',
    );
    expect(directionToCubeProjection(screenPointToDirection({ x: 0, y: 0 }, { yaw: -90, pitch: 0, fov: 75 }, 1)).face).toBe(
      'left',
    );
    const screenPoint = directionToScreenPoint({ x: 1, y: 0, z: 0 }, { yaw: 90, pitch: 0, fov: 75 }, 1);

    expect(screenPoint?.x).toBeCloseTo(0);
    expect(screenPoint?.y).toBeCloseTo(0);
  });

  it('selects adjacent faces near seams', () => {
    expect(getAdjacentFaces({ face: 'front', u: 0.99, v: 0.5 })).toContain('right');
    expect(getAdjacentFaces({ face: 'front', u: 0.5, v: 0.02 })).toContain('up');
    expect(selectAffectedFaces({ yaw: 44, pitch: 0, radiusDegrees: 24 }).map((item) => item.face)).toContain('right');
  });

  it('uses transcript hints before falling back to the current view', () => {
    expect(pickTargetFromTranscript('add a lamp on the ceiling', { yaw: 22, pitch: 0, fov: 75 }).pitch).toBe(72);
    expect(pickTargetFromTranscript('place a table here', { yaw: 22, pitch: -4, fov: 75 })).toMatchObject({
      yaw: 22,
      pitch: -4,
    });
  });

  it('projects screen selection boxes into one or more cube-face regions', () => {
    const centerRegion = selectionBoxToRegion(
      { left: 0.45, top: 0.45, width: 0.1, height: 0.1 },
      { yaw: 0, pitch: 0, fov: 75 },
      1,
    );

    expect(centerRegion.faces.map((region) => region.face)).toEqual(['front']);
    expect(centerRegion.center).toMatchObject({ yaw: 0, pitch: 0 });
    expect(centerRegion.box).toMatchObject({ left: 0.45, top: 0.45 });

    const seamRegion = selectionBoxToRegion(
      { left: 0.38, top: 0.42, width: 0.24, height: 0.16 },
      { yaw: 45, pitch: 0, fov: 95 },
      1.7,
    );

    expect(seamRegion.faces.length).toBeGreaterThan(1);
  });
});
