import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function loadIdentityManifest(pathValue) {
  const path = resolve(pathValue);
  const manifest = await readJson(path);
  if (
    ![1, 2].includes(manifest.schemaVersion) ||
    !["mpp", "x402"].includes(manifest.protocol)
  ) {
    throw new Error(`${path} is not a compatible identity manifest.`);
  }
  if (manifest.schemaVersion === 1) {
    if (!Array.isArray(manifest.segmentFiles)) {
      throw new Error(`${path} is missing identity segment files.`);
    }
    return { ...manifest, path };
  }
  if (!Array.isArray(manifest.sliceManifests)) {
    throw new Error(`${path} is missing daily slice manifests.`);
  }
  const segmentFiles = [];
  const summaries = [];
  for (const sliceFile of manifest.sliceManifests) {
    const slicePath = resolve(dirname(path), sliceFile);
    const slice = await readJson(slicePath);
    if (
      slice.schemaVersion !== 1 ||
      slice.protocol !== manifest.protocol ||
      !Array.isArray(slice.segmentFiles) ||
      !Array.isArray(slice.summaries)
    ) {
      throw new Error(`Invalid daily identity manifest: ${slicePath}`);
    }
    segmentFiles.push(
      ...slice.segmentFiles.map((file) => resolve(dirname(slicePath), file)),
    );
    summaries.push(
      ...slice.summaries.map((summary) => ({
        ...summary,
        sliceStart: slice.rangeStart,
        sliceEnd: slice.rangeEnd,
      })),
    );
  }
  return { ...manifest, path, segmentFiles, summaries };
}
