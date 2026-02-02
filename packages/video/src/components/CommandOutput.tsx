import React from "react";
import { useCurrentFrame, interpolate } from "remotion";
import { COLORS } from "../styles/colors";

interface OutputLine {
  text: string;
  color?: string;
  delay?: number;
}

interface CommandOutputProps {
  lines: OutputLine[];
  startFrame: number;
  lineDelay?: number;
}

export const CommandOutput: React.FC<CommandOutputProps> = ({
  lines,
  startFrame,
  lineDelay = 3,
}) => {
  const frame = useCurrentFrame();
  const relativeFrame = Math.max(0, frame - startFrame);

  return (
    <div style={{ marginTop: 8 }}>
      {lines.map((line, index) => {
        const lineStartFrame = index * lineDelay + (line.delay ?? 0);
        const opacity = interpolate(relativeFrame, [lineStartFrame, lineStartFrame + 2], [0, 1], {
          extrapolateRight: "clamp",
          extrapolateLeft: "clamp",
        });

        const shouldRender = relativeFrame >= lineStartFrame;

        if (!shouldRender) return null;

        return (
          <div
            key={index}
            style={{
              color: line.color ?? COLORS.text,
              opacity,
              whiteSpace: "pre-wrap",
            }}
          >
            {line.text}
          </div>
        );
      })}
    </div>
  );
};
