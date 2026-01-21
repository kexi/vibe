import React from "react";
import { Sequence } from "remotion";
import { Intro } from "./scenes/Intro";
import { StartCommand } from "./scenes/StartCommand";
import { CleanCommand } from "./scenes/CleanCommand";
import { Outro } from "./scenes/Outro";

// Scene durations in frames (at 30fps)
// YouTube Shorts version: 30 seconds total
const SCENES = {
  intro: { start: 0, duration: 90 }, // 3 sec
  start: { start: 90, duration: 450 }, // 15 sec
  clean: { start: 540, duration: 210 }, // 7 sec
  outro: { start: 750, duration: 150 }, // 5 sec
} as const;

export const Video: React.FC = () => {
  return (
    <>
      <Sequence from={SCENES.intro.start} durationInFrames={SCENES.intro.duration}>
        <Intro />
      </Sequence>

      <Sequence from={SCENES.start.start} durationInFrames={SCENES.start.duration}>
        <StartCommand />
      </Sequence>

      <Sequence from={SCENES.clean.start} durationInFrames={SCENES.clean.duration}>
        <CleanCommand />
      </Sequence>

      <Sequence from={SCENES.outro.start} durationInFrames={SCENES.outro.duration}>
        <Outro />
      </Sequence>
    </>
  );
};

// Total duration: 900 frames = 30 seconds
export const TOTAL_DURATION = 900;
