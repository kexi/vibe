import React from "react";
import { Composition } from "remotion";
import { Video, TOTAL_DURATION } from "./Video";
import { Intro } from "./scenes/Intro";
import { StartCommand } from "./scenes/StartCommand";
import { CleanCommand } from "./scenes/CleanCommand";
import { Outro } from "./scenes/Outro";

const FPS = 30;
// YouTube Shorts: 9:16 vertical
const WIDTH = 1080;
const HEIGHT = 1920;

export const Root: React.FC = () => {
  return (
    <>
      {/* Full video */}
      <Composition
        id="VibeCLIDemo"
        component={Video}
        durationInFrames={TOTAL_DURATION}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />

      {/* Individual scenes for preview/development */}
      <Composition
        id="Intro"
        component={Intro}
        durationInFrames={90}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
      <Composition
        id="StartCommand"
        component={StartCommand}
        durationInFrames={450}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
      <Composition
        id="CleanCommand"
        component={CleanCommand}
        durationInFrames={210}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
      <Composition
        id="Outro"
        component={Outro}
        durationInFrames={150}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
    </>
  );
};
