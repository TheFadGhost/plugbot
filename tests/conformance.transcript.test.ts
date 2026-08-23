import { TranscriptAdapter } from "../src/adapter/transcript.js";
import { describeAdapterConformance } from "../src/testing/conformance.js";

const TRANSCRIPT_TEXT = [
  "alice -> #general: hi",
  "bob -> #general: hello there",
  "",
].join("\n");

await describeAdapterConformance(
  "transcript",
  () => new TranscriptAdapter({ transcriptText: TRANSCRIPT_TEXT }),
  { channels: ["general"] },
);
