import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { config } from "../config/env.js";
import { downloadFileToLocalPath } from "../lib/r2.js";
import { logger } from "../lib/logger.js";
import fs from "fs/promises";

const execFileAsync = promisify(execFile);

const isWindows = process.platform === "win32";
const PYTHON_EXECUTABLE = path.join(
  process.cwd(),
  "venv",
  isWindows ? "Scripts" : "bin",
  isWindows ? "python.exe" : "python"
);

const VALIDATE_SCRIPT_PATH = path.join(
  process.cwd(),
  "src",
  "scripts",
  "validate_photo.py"
);

async function runPythonValidation(
  photoPath: string
): Promise<{ passed: boolean; reason: string | null }> {
  const { stdout } = await execFileAsync(PYTHON_EXECUTABLE, [
    VALIDATE_SCRIPT_PATH,
    photoPath,
  ]);
  return JSON.parse(stdout);
}

function buildTempPhotoPath(sessionId: string, extension: string): string {
  const fileName = `photo-validation-${sessionId}-${Date.now()}${extension}`;
  return path.join(os.tmpdir(), fileName);
}

async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    logger.warn({ error, filePath }, "Failed to clean up temp photo file");
  }
}

export interface PhotoValidationResult {
  passed: boolean;
  reason: string | null;
}

export async function runPhotoValidation(
  sessionId: string,
  photoKey: string
): Promise<{ passed: boolean; reason: string | null }> {
  const tempPhotoPath = buildTempPhotoPath(sessionId, ".jpg");

  try {
    await downloadFileToLocalPath(
      config.r2.privateBucket,
      photoKey,
      tempPhotoPath
    );
    const result = await runPythonValidation(tempPhotoPath);
    return result;
  } catch (error) {
    logger.error(
      { error, sessionId, photoKey },
      "Photo validation failed unexpectedly"
    );
    return { passed: false, reason: "validation_error" };
  } finally {
    await cleanupTempFile(tempPhotoPath);
  }
}
