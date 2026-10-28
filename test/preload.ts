import { memoryLogSink, setLogSink } from "../src/log.ts";

// A test that asserts on records installs its own sink; the rest stay silent.
setLogSink(memoryLogSink());
