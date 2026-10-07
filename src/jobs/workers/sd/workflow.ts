// will hold the ComfyUI workflow patcher   
import apiWorkflow from "../../../config/workflows/api-workflow.json" with { type: "json" };

export type WorkflowPatch = {
  artworkFilename: string;    // node 78 - the text-stamped comic page
  childPhotoFilename: string; // node 435 - the child's face
  maskFilename: string;       // node 519 - the head mask
  seed: number;               // node 466 - noise_seed
  steps: number;              // node 471 - steps from Page.steps
  cfg: number;                // node 467 - cfg from Page.cfg
  pagePrompt: string;         // node 111 - positive prompt from Page.pagePrompt
};

/**
 * Deep-clone the workflow template and patch the 7 per-request fields.
 * Never mutates the imported apiWorkflow — that would leak state between jobs.
 */

export function buildWorkflow(patch: WorkflowPatch): object {

    const wf = JSON.parse(JSON.stringify(apiWorkflow)) as any;

    // The three LoadImage nodes — each references an image by filename.
  // The filenames must EXACTLY match the "name" fields in input.images[].
  wf["78"].inputs.image = patch.artworkFilename;
  wf["435"].inputs.image = patch.childPhotoFilename;
  wf["519"].inputs.image = patch.maskFilename;

  // Sampling parameters — random seed and admin-tuned settings.
  wf["466"].inputs.noise_seed = patch.seed;
  wf["471"].inputs.steps = patch.steps;
  wf["467"].inputs.cfg = patch.cfg;

  // Positive prompt — full replacement from admin's Page.pagePrompt.
  // Node 473 (negative prompt) stays untouched — generic quality guardrails.
  wf["111"].inputs.prompt = patch.pagePrompt;

  return wf;
}