"use strict";

// An owned, deterministic analysis fixture. The smoke test reads these bytes;
// neither REA nor the smoke test loads or executes this application module.
const OUTPUT_FORMAT = "mp4";

function createRecordingPlan(windowTitle, seconds) {
  if (typeof windowTitle !== "string" || !windowTitle.trim()) {
    throw new TypeError("A window title is required");
  }
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new RangeError("A positive duration is required");
  }
  return {
    windowTitle,
    durationSeconds: seconds,
    outputFormat: OUTPUT_FORMAT,
    narration: false,
  };
}

function formatOverlay(label) {
  return { kind: "text", text: String(label), position: "bottom" };
}

exports.createRecordingPlan = createRecordingPlan;
exports.formatOverlay = formatOverlay;
exports.OUTPUT_FORMAT = OUTPUT_FORMAT;
