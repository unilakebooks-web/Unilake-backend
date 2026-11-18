import { Router } from "express";
import { runSweepsHandler } from "../controllers/sweep.controller.js";

const router = Router();

// Called by Cloud Scheduler, not by browsers. Guarded by the x-sweep-secret header.
router.post("/sweeps", runSweepsHandler);

export default router;
